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
    renderer.setAttribute('flow', 'paginated')
    renderer.setAttribute('max-column-count', '1')
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
    }

    // 滚轮翻页：分页模式下正文本身不滚动，滚轮累积到阈值就翻一页。
    // - 触控板惯性会连续发很多小 delta，必须累积 + 冷却，否则一滑翻好几页
    // - deltaMode 1=行、2=页，要换算成像素量级再比较
    let wheelAccum = 0
    let wheelLockedUntil = 0
    const onDocWheel = (event: WheelEvent) => {
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
