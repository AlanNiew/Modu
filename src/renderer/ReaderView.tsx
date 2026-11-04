import { useCallback, useEffect, useRef } from 'react'
import './vendor/foliate/view.js'
import type { FoliateRelocateDetail, FoliateView } from './vendor/foliate/view.js'
import type { OpenedBookInfo } from '../lib/types'
import { createFoliateBook, type FoliateBook } from './foliateBook'
import { buildReadingCss, type ReadingSettings } from './theme'

export interface ReaderApi {
  /** 跳转到 href / `path#anchor` / CFI 等 foliate 能解析的目标 */
  goTo(target: unknown): Promise<unknown>
  /** 跳到指定 spine 章节，并落在章内 fraction（0..1）处 */
  goToChapter(index: number, fraction?: number): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  goToFraction(fraction: number): Promise<void>
  /** 当前章节的可视文本，用于书签摘录 */
  getVisibleText(maxLength?: number): string
  /** 跳到某章并高亮/滚动到一段引文（全文搜索用）；找不到返回 false */
  revealText(index: number, quote: string): Promise<boolean>
  /** 仅供 dev 自检：向当前章节文档派发一次滚轮事件，返回是否派发成功 */
  dispatchWheel(deltaY: number): boolean
}

export interface RelocateState {
  index: number
  /** 章内相对位置 0..1 */
  fraction: number
  /** 当前页（1 起） */
  page: number
  /** 本章总页数 */
  pages: number
  /** 当前可见文本开头，供书签/搜索预览 */
  excerpt: string
}

interface ReaderViewProps {
  book: OpenedBookInfo
  settings: ReadingSettings
  onReady?: (api: ReaderApi) => void
  onRelocate?: (state: RelocateState) => void
  onLoad?: (state: { index: number }) => void
  onExternalLink?: (href: string) => void
  onError?: (error: unknown) => void
}

export function ReaderView({
  book,
  settings,
  onReady,
  onRelocate,
  onLoad,
  onExternalLink,
  onError,
}: ReaderViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateView | null>(null)
  const settingsRef = useRef(settings)
  const callbacksRef = useRef({ onReady, onRelocate, onLoad, onExternalLink, onError })

  settingsRef.current = settings
  callbacksRef.current = { onReady, onRelocate, onLoad, onExternalLink, onError }

  const applySettings = useCallback((view: FoliateView, next: ReadingSettings) => {
    const renderer = view.renderer
    if (!renderer) return
    // 布局属性必须设在 renderer（<foliate-paginator>）上：
    // foliate-view 只是 closed shadow root 外壳，不会把属性转发给 renderer。
    renderer.setAttribute('flow', next.flow)
    if (next.flow === 'paginated') {
      renderer.setAttribute('max-column-count', '1')
    } else {
      // 滚动模式不需要限列；留着会让内容被拆成多列
      renderer.removeAttribute('max-column-count')
    }
    // 上下留白固定 24px：正文贴边不好看，又不值得做成用户选项
    renderer.setAttribute('margin', '24px')
    // 行宽（版心）是用户可调的，直接交给 paginator 的 max-inline-size
    renderer.setAttribute('max-inline-size', `${next.pageWidth}px`)
    renderer.setStyles(buildReadingCss(next))
    // 字号/行高/版心变了要重新分栏；render() 会保留当前锚点
    renderer.render?.()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let foliateBook: FoliateBook | null = null
    const view = document.createElement('foliate-view') as unknown as FoliateView
    host.replaceChildren(view)
    viewRef.current = view

    const goToChapter = (index: number, fraction = 0) =>
      Promise.resolve(
        view.renderer?.goTo({ index, anchor: fraction }) ?? view.goTo({ index }),
      )

    const api: ReaderApi = {
      goTo: (target) => Promise.resolve(view.goTo(target)),
      goToChapter,
      next: () => Promise.resolve(view.next()),
      prev: () => Promise.resolve(view.prev()),
      goToFraction: (fraction) => Promise.resolve(view.goToFraction(fraction)),
      getVisibleText: (maxLength = 120) => {
        const contents = view.renderer?.getContents?.() ?? []
        const doc = contents[0]?.doc
        if (!doc) return ''
        return (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
      },
      dispatchWheel: (deltaY) => {
        const doc = view.renderer?.getContents?.()[0]?.doc
        const target = (doc?.body ?? doc?.documentElement) as EventTarget | undefined
        if (!target) return false
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }),
        )
        return true
      },
      revealText: async (index, quote) => {
        await goToChapter(index)
        // goTo 返回时新章节可能还在排版，轮询到内容确实换成目标章再找文本
        let doc: Document | undefined
        for (let i = 0; i < 20; i += 1) {
          const contents = view.renderer?.getContents?.() ?? []
          const current = contents[0]
          if (current?.doc && Number(current.index) === index) {
            doc = current.doc
            break
          }
          await new Promise((resolve) => window.setTimeout(resolve, 100))
        }
        const target = doc ?? view.renderer?.getContents?.()[0]?.doc
        if (!target) return false
        const range = findQuoteRange(target, quote)
        if (!range) return false
        // scrollToAnchor 接受 Range：分页模式下会算出它落在第几列并翻过去
        await view.renderer?.scrollToAnchor?.(range)
        // 翻页后 paginator 可能重建/重新排版文档，Range 会失效；
        // 重新取当前文档、重新定位后再上高亮。
        await new Promise((resolve) => window.setTimeout(resolve, 220))
        const after = view.renderer?.getContents?.()[0]?.doc
        const finalRange =
          after && after !== target ? (findQuoteRange(after, quote) ?? range) : range
        markQuote(after && after !== target ? after : target, finalRange)
        return true
      },
    }

    // 滚轮翻页：分页模式下正文本身不滚动，滚轮累积到阈值就翻一页。
    // - 触控板惯性会连续发很多小 delta，必须累积 + 冷却，否则一滑翻好几页
    // - deltaMode 1=行、2=页，要换算成像素量级再比较
    let wheelAccum = 0
    let wheelLockedUntil = 0
    const onDocWheel = (event: WheelEvent) => {
      // 滚动模式交给浏览器原生滚动
      if (settingsRef.current.flow !== 'paginated') return
      // ctrl/⌘ + 滚轮保留给缩放手势，不拦截
      if (event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) return
      event.preventDefault()

      const now = performance.now()
      if (now < wheelLockedUntil) return

      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      // 触控板横向滑动（deltaX 占主导）也算翻页
      const dominant = Math.abs(event.deltaX * unit) > Math.abs(event.deltaY * unit)
        ? event.deltaX * unit
        : event.deltaY * unit
      wheelAccum += dominant
      if (Math.abs(wheelAccum) < 50) return

      const forward = wheelAccum > 0
      wheelAccum = 0
      wheelLockedUntil = now + 320
      void (forward ? view.next() : view.prev())
    }

    const handleExternal = (event: Event) => {
      const detail = (event as CustomEvent<{ href_?: string }>).detail
      // 阻止 foliate 默认的 window.open，交给系统浏览器
      event.preventDefault()
      if (detail?.href_) callbacksRef.current.onExternalLink?.(detail.href_)
    }
    view.addEventListener('external-link', handleExternal)

    ;(async () => {
      try {
        foliateBook = createFoliateBook(book)
        await view.open(foliateBook)
        if (cancelled) return

        const renderer = view.renderer
        renderer.addEventListener('relocate', ((event: CustomEvent<FoliateRelocateDetail>) => {
          const detail = event.detail
          const range = detail.range as Range | undefined
          callbacksRef.current.onRelocate?.({
            index: Number(detail.index ?? 0),
            fraction: Number(detail.fraction ?? 0),
            page: Number(renderer.page ?? 1),
            pages: Number(renderer.pages ?? 1),
            excerpt: (range?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
          })
        }) as EventListener)

        // 左右两侧点按翻页（foliate 本身只处理链接点击）。
        const onDocClick = (event: MouseEvent, doc: Document) => {
          if (event.defaultPrevented || event.button !== 0) return
          const target = event.target as HTMLElement | null
          if (target?.closest('a, button, input, textarea, select')) return
          const selection = doc.defaultView?.getSelection()?.toString() ?? ''
          if (selection.length > 0) return
          const rect = view.getBoundingClientRect()
          if (rect.width <= 0) return
          const ratio = (event.clientX - rect.left) / rect.width
          if (ratio < 0.3) void view.prev()
          else if (ratio > 0.7) void view.next()
        }

        view.addEventListener('load', ((event: CustomEvent<{ index: number; doc: Document }>) => {
          const detail = event.detail
          callbacksRef.current.onLoad?.({ index: Number(detail.index ?? 0) })
          detail.doc?.addEventListener('click', (clickEvent) => onDocClick(clickEvent, detail.doc))
          // passive: false —— 需要 preventDefault 阻止 iframe 自身滚动
          detail.doc?.addEventListener('wheel', onDocWheel, { passive: false })
        }) as EventListener)

        applySettings(view, settingsRef.current)
        await view.init({ showTextStart: true })
        if (cancelled) return
        callbacksRef.current.onReady?.(api)
      } catch (error) {
        if (!cancelled) callbacksRef.current.onError?.(error)
        console.error('[reader] 初始化失败', error)
      }
    })()

    return () => {
      cancelled = true
      view.removeEventListener('external-link', handleExternal)
      try {
        view.close()
      } catch (error) {
        console.warn('[reader] close 失败', error)
      }
      foliateBook?.dispose()
      view.remove()
      viewRef.current = null
    }
  }, [book.id, applySettings])

  // 阅读设置变化：重新注入 CSS 并重排
  useEffect(() => {
    const view = viewRef.current
    if (view?.renderer) applySettings(view, settings)
  }, [settings, applySettings])

  // 键盘翻页：左右方向键 / PageUp / PageDown / 空格
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const view = viewRef.current
      if (!view) return
      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          event.preventDefault()
          void view.next()
          break
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault()
          void view.prev()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="reader-host h-full w-full overflow-hidden"
      // 阅读页背景跟主题同色：宿主边框和正文之间不再有一条突兀的色带
      style={{ background: 'var(--reader-page-bg, #1e1e2e)' }}
    >
      {/* 阅读栏宽度由这里控制：paginator 会把自己的内容在这个容器里居中，
          再用 max-inline-size 限制行宽（默认 720px → 中文约 35 字/行）。 */}
      <div
        ref={hostRef}
        className="mx-auto h-full w-full"
        style={{ maxWidth: settings.pageWidth + 48 }}
      />
    </div>
  )
}

/**
 * 在章节文档里定位一段引文，滚动到可见区并做高亮。
 *
 * 匹配前把连续空白压成单个空格（书里换行/缩进到处都是），
 * 并保留「压缩后字符 → 原始字符下标」的映射，才能反推回 DOM 范围。
 *
 * 高亮用 CSS Custom Highlight API（Chromium 105+，WebView2 满足）：
 * 它不改 DOM，不会破坏 foliate 的分页测量；旧内核退回 <mark> 包裹。
 */
function findQuoteRange(doc: Document, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, ' ').trim()
  if (!needle || !doc.body) return null

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; start: number; end: number }[] = []
  const map: number[] = []
  let raw = ''
  let flat = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    const offset = raw.length
    nodes.push({ node: text, start: offset, end: offset + text.data.length })
    raw += text.data
    for (let i = 0; i < text.data.length; i += 1) {
      const ch = text.data[i]
      if (/\s/.test(ch)) {
        if (flat.length > 0 && flat[flat.length - 1] !== ' ') {
          flat += ' '
          map.push(offset + i)
        }
      } else {
        flat += ch
        map.push(offset + i)
      }
    }
  }

  let at = flat.indexOf(needle)
  if (at < 0 && needle.length > 10) {
    // 跨节点丢字/异体标点时退一步：用前 10 个字定位
    at = flat.indexOf(needle.slice(0, 10))
  }
  if (at < 0) return null

  const startRaw = map[at]
  const endRaw = map[Math.min(at + needle.length - 1, map.length - 1)] + 1
  const startNode = nodes.find((n) => startRaw >= n.start && startRaw < n.end)
  const endNode = nodes.find((n) => endRaw > n.start && endRaw <= n.end)
  if (!startNode || !endNode) return null

  const range = doc.createRange()
  range.setStart(startNode.node, startRaw - startNode.start)
  range.setEnd(endNode.node, endRaw - endNode.start)
  return range
}

function markQuote(doc: Document, range: Range): void {
  const style = doc.getElementById('modu-hit-style')
  if (!style) {
    const el = doc.createElement('style')
    el.id = 'modu-hit-style'
    el.textContent =
      '::highlight(modu-hit) { background-color: rgba(249, 190, 80, .7); color: inherit; }'
    doc.head.appendChild(el)
  }

  // 注意：CSS.highlights 是「每个 window 一份」的注册表，
  // 章节在 iframe 里，必须用 iframe 自己的 window 注册才会渲染。
  const win = doc.defaultView as (Window & typeof globalThis) | null
  if (win?.CSS?.highlights && typeof win.Highlight === 'function') {
    win.CSS.highlights.set('modu-hit', new win.Highlight(range))
    if (import.meta.env.DEV) {
      // 调试探针：父窗口留一份最近命中信息，供自动化验证（仅开发期）
      ;(win.parent as unknown as { __moduHit?: unknown }).__moduHit = {
        text: range.toString().slice(0, 24),
        at: Date.now(),
      }
    }
    win.setTimeout(() => win.CSS.highlights.delete('modu-hit'), 5000)
    return
  }

  // 老内核兜底：range 起止都在文本节点里，surroundContents 通常会成功
  const mark = doc.createElement('mark')
  mark.setAttribute('data-modu-hit', '1')
  mark.style.cssText = 'background: rgba(249, 190, 80, .7); color: inherit;'
  try {
    range.surroundContents(mark)
    win?.setTimeout(() => {
      const parent = mark.parentNode
      if (!parent) return
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
      parent.removeChild(mark)
    }, 5000)
  } catch {
    // 跨元素时放弃包裹，仅保留定位
  }
}
