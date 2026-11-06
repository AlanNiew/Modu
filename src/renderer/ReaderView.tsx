import { useCallback, useEffect, useRef } from 'react'
import './vendor/foliate/view.js'
import type { FoliateRelocateDetail, FoliateView } from './vendor/foliate/view.js'
import type { Annotation, AnnotationDraft, OpenedBookInfo } from '../lib/types'
import type { LocatorAnchor, ReaderLocator } from '../lib/locator'
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
  /** 跳转到某条批注：切章 + 滚动到引文 + 选中它 */
  revealAnnotation(annotation: Annotation): Promise<boolean>
  /** 仅供 dev 自检：向当前章节文档派发一次滚轮事件，返回是否派发成功 */
  dispatchWheel(deltaY: number): boolean
  /** 当前阅读位置的文本锚点（引文 + 前后文），随进度一起存 */
  getAnchor(): LocatorAnchor | null
  /** 按 Locator 恢复位置：先按章/分数跳，再用文本锚点校正（找不到返回 false） */
  goToLocator(locator: ReaderLocator): Promise<boolean>
}

export interface RelocateState {
  index: number
  /** 章内相对位置 0..1 */
  fraction: number
  /** 当前页（1 起） */
  page: number
  /** 本章总页数 */
  pages: number
  /** 当前页起点所在元素的 id（脚注/小节锚点），用于目录高亮精确到小节 */
  fragment: string | null
  /** 当前可见文本开头，供书签/搜索预览 */
  excerpt: string
}

interface ReaderViewProps {
  book: OpenedBookInfo
  settings: ReadingSettings
  /** 本书全部批注；按当前章节过滤后画在正文上 */
  annotations?: Annotation[]
  onReady?: (api: ReaderApi) => void
  onRelocate?: (state: RelocateState) => void
  onLoad?: (state: { index: number }) => void
  onExternalLink?: (href: string) => void
  onError?: (error: unknown) => void
  /** 用户在正文里划线/写批注。mode=note 表示希望直接进备注编辑 */
  onAnnotate?: (draft: AnnotationDraft, mode: 'highlight' | 'note') => void
  /** 点了已有划线 */
  onAnnotationActivate?: (id: number) => void
}

export function ReaderView({
  book,
  settings,
  annotations,
  onReady,
  onRelocate,
  onLoad,
  onExternalLink,
  onError,
  onAnnotate,
  onAnnotationActivate,
}: ReaderViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateView | null>(null)
  // 最近一次阅读位置：重排（字号/行高/版心变化）后要用它把读者放回原处
  const lastPositionRef = useRef<{ index: number; fraction: number } | null>(null)
  const settingsRef = useRef(settings)
  const annotationsRef = useRef<Annotation[]>(annotations ?? [])
  const docRef = useRef<Document | null>(null)
  const renderAnnotationsRef = useRef<((doc: Document) => void) | null>(null)
  const callbacksRef = useRef({
    onReady,
    onRelocate,
    onLoad,
    onExternalLink,
    onError,
    onAnnotate,
    onAnnotationActivate,
  })

  settingsRef.current = settings
  callbacksRef.current = {
    onReady,
    onRelocate,
    onLoad,
    onExternalLink,
    onError,
    onAnnotate,
    onAnnotationActivate,
  }

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
    // 页边距是用户可调的（v0.4 重新独立出来），映射到 paginator 的 margin
    renderer.setAttribute('margin', `${next.pagePadding}px`)
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
    // foliate 把章节文档藏在 closed shadow root 的 iframe 里，只有这一个入口能拿到。
    const currentDoc = (): Document | null => view.renderer?.getContents?.()[0]?.doc ?? null

    const api: ReaderApi = {
      goTo: (target) => Promise.resolve(view.goTo(target)),
      goToChapter,
      next: () => Promise.resolve(view.next()),
      prev: () => Promise.resolve(view.prev()),
      goToFraction: (fraction) => Promise.resolve(view.goToFraction(fraction)),
      getVisibleText: (maxLength = 120) => {
        const doc = currentDoc()
        if (!doc) return ''
        return (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
      },
      revealAnnotation: async (annotation) => {
        let index: number
        try {
          index = Number((JSON.parse(annotation.locator) as { index?: number }).index ?? 0)
        } catch {
          index = 0
        }
        await goToChapter(index)
        const doc = await waitForChapterDoc(view, index)
        if (!doc) return false
        const docIndex = buildDocIndex(doc)
        if (!docIndex) return false
        const range = locateQuote(
          doc,
          docIndex,
          annotation.quote,
          annotation.prefix,
          annotation.suffix,
          annotation.occurrence,
        )
        if (!range) return false
        await view.renderer?.scrollToAnchor?.(range)
        await new Promise((resolve) => window.setTimeout(resolve, 220))
        const after = currentDoc()
        renderAnnotationsRef.current?.(after ?? doc)
        return true
      },
      dispatchWheel: (deltaY) => {
        const doc = currentDoc()
        const target = (doc?.body ?? doc?.documentElement) as EventTarget | undefined
        if (!target) return false
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }),
        )
        return true
      },
      getAnchor: () => lastAnchor,
      goToLocator: async (locator) => {
        await goToChapter(locator.index, locator.fraction)
        if (!locator.quote) return false
        const doc = await waitForChapterDoc(view, locator.index)
        if (!doc) return false
        const docIndex = buildDocIndex(doc)
        if (!docIndex) return false
        const range = locateQuote(
          doc,
          docIndex,
          locator.quote,
          locator.prefix ?? null,
          locator.suffix ?? null,
          0,
        )
        if (!range) return false
        await view.renderer?.scrollToAnchor?.(range)
        await new Promise((resolve) => window.setTimeout(resolve, 220))
        const after = currentDoc()
        renderAnnotationsRef.current?.(after ?? doc)
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
        const target = doc ?? currentDoc()
        if (!target) return false
        const range = findQuoteRange(target, quote)
        if (!range) return false
        // scrollToAnchor 接受 Range：分页模式下会算出它落在第几列并翻过去
        await view.renderer?.scrollToAnchor?.(range)
        // 翻页后 paginator 可能重建/重新排版文档，Range 会失效；
        // 重新取当前文档、重新定位后再上高亮。
        await new Promise((resolve) => window.setTimeout(resolve, 220))
        const after = currentDoc()
        const finalRange =
          after && after !== target ? (findQuoteRange(after, quote) ?? range) : range
        markQuote(after && after !== target ? after : target, finalRange)
        return true
      },
    }

    // ------------------------------------------------------------------
    // 批注：正文渲染色块、选区工具条、点击命中
    // ------------------------------------------------------------------
    let lastRelocate = { index: 0, fraction: 0 }
    // 当前位置的文本锚点：进度恢复时用它把位置从「页分数」校正回原句。
    let lastAnchor: LocatorAnchor | null = null
    const captureAnchor = (doc: Document, range: Range | undefined) => {
      if (!range) return
      const docIndex = buildDocIndex(doc)
      if (!docIndex) return
      const start = rawOffset(docIndex, range.startContainer, range.startOffset)
      const end = rawOffset(docIndex, range.endContainer, range.endOffset)
      if (start == null || end == null || end <= start) return
      const flat = docIndex.flat
      lastAnchor = {
        quote: flat.slice(start, Math.min(flat.length, start + 60)).trim(),
        prefix: flat.slice(Math.max(0, start - 32), start).trim() || undefined,
        suffix: flat.slice(end, Math.min(flat.length, end + 32)).trim() || undefined,
      }
    }
    let annoRanges = new Map<number, { startRaw: number; endRaw: number }>()
    let lastRenderedDoc: Document | null = null
    let toolbar: HTMLDivElement | null = null

    const hideToolbar = () => {
      toolbar?.remove()
      toolbar = null
    }

    const spinePath = (index: number) => book.package.spine[index]?.path ?? ''

    const renderAnnotations = (doc: Document) => {
      docRef.current = doc
      lastRenderedDoc = doc
      const docIndex = buildDocIndex(doc)
      const win = doc.defaultView as (Window & typeof globalThis) | null
      if (!docIndex || !win) return
      ensureAnnotationStyles(doc)
      annoRanges = new Map()
      const grouped = new Map<string, Range[]>()
      const chapterPath = spinePath(lastRelocate.index)
      for (const annotation of annotationsRef.current) {
        if (annotation.chapterHref !== chapterPath) continue
        const range = locateQuote(
          doc,
          docIndex,
          annotation.quote,
          annotation.prefix,
          annotation.suffix,
          annotation.occurrence,
        )
        if (!range) continue
        const startRaw = rawOffset(docIndex, range.startContainer, range.startOffset)
        const endRaw = rawOffset(docIndex, range.endContainer, range.endOffset)
        if (startRaw == null || endRaw == null) continue
        annoRanges.set(annotation.id, { startRaw, endRaw })
        const list = grouped.get(annotation.color) ?? []
        list.push(range)
        grouped.set(annotation.color, list)
      }
      const css = win.CSS as typeof CSS | undefined
      if (css?.highlights && typeof win.Highlight === 'function') {
        for (const color of ANNOTATION_COLORS) css.highlights.delete(`modu-anno-${color}`)
        for (const [color, ranges] of grouped) {
          css.highlights.set(`modu-anno-${color}`, new win.Highlight(...ranges))
        }
      }
    }
    renderAnnotationsRef.current = renderAnnotations

    // 开发期自动化探针：CDP 拿不到 closed shadow root 里的 iframe 文档，
    // 所以把「划线→工具条→点颜色」这条链路暴露成普通函数供 CDP 调用。
    if (import.meta.env.DEV) {
      const probe = {
        selectQuote(needle: string): string {
          const doc = docRef.current
          if (!doc) return 'no-doc'
          const docIndex = buildDocIndex(doc)
          if (!docIndex) return 'no-index'
          const at = docIndex.flat.indexOf(needle)
          if (at < 0) return 'not-found'
          const range = rangeFromFlat(doc, docIndex, at, at + needle.length)
          if (!range) return 'no-range'
          const win = doc.defaultView
          const selection = win?.getSelection()
          if (!win || !selection) return 'no-selection'
          selection.removeAllRanges()
          selection.addRange(range)
          const rect = range.getBoundingClientRect()
          onDocMouseUp(
            new win.MouseEvent('mouseup', {
              bubbles: true,
              button: 0,
              clientX: Math.round(rect.left + 1),
              clientY: Math.round(rect.bottom - 1),
            }),
            doc,
          )
          return `ok:${docIndex.flat.slice(at, at + needle.length)}`
        },
        toolbar(): string | null {
          const box = docRef.current?.querySelector('[data-modu-toolbar]')
          return box ? (box.textContent ?? '') : null
        },
        clickToolbar(color: string): string {
          const box = docRef.current?.querySelector('[data-modu-toolbar]')
          if (!box) return 'no-toolbar'
          const order = ['yellow', 'green', 'blue', 'pink', 'note'] as const
          const index = order.indexOf(color as (typeof order)[number])
          if (index < 0) return 'bad-color'
          const button = box.querySelectorAll('button')[index] as HTMLButtonElement | undefined
          if (!button) return 'no-button'
          button.click()
          return 'clicked'
        },
        highlights(): unknown {
          const win = docRef.current?.defaultView as
            | (Window & { CSS?: { highlights?: Map<string, unknown> } })
            | undefined
          return {
            registered: Array.from(win?.CSS?.highlights?.keys?.() ?? []),
            ranges: annoRanges.size,
          }
        },
        clear(): void {
          hideToolbar()
        },
        debugAnnotation(id: number): unknown {
          const doc = docRef.current
          if (!doc) return 'no-doc'
          const docIndex = buildDocIndex(doc)
          const annotation = annotationsRef.current.find((item) => item.id === id)
          const chapterPath = spinePath(lastRelocate.index)
          if (!docIndex || !annotation) {
            return { hasIndex: !!docIndex, hasAnnotation: !!annotation }
          }
          const range = locateQuote(
            doc,
            docIndex,
            annotation.quote,
            annotation.prefix,
            annotation.suffix,
            annotation.occurrence,
          )
          return {
            chapterPath,
            annHref: annotation.chapterHref,
            sameChapter: annotation.chapterHref === chapterPath,
            located: !!range,
            quote: annotation.quote,
            occurrence: annotation.occurrence,
            total: annotationsRef.current.length,
            lastRelocate,
          }
        },
      }
      ;(window as unknown as { __moduAnno?: typeof probe }).__moduAnno = probe
    }

    const hitAnnotation = (doc: Document, docIndex: DocIndex, x: number, y: number) => {
      const caret = (
        doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint?.(x, y)
      if (!caret) return null
      const at = rawOffset(docIndex, caret.startContainer, caret.startOffset)
      if (at == null) return null
      for (const [id, span] of annoRanges) {
        if (at >= span.startRaw && at <= span.endRaw) return id
      }
      return null
    }

    const onDocMouseUp = (event: MouseEvent, doc: Document) => {
      if (event.button !== 0) return
      // 点在工具条上不要重建（工具条自己的 mousedown 已 preventDefault）
      if (toolbar && toolbar.contains(event.target as Node)) return
      hideToolbar()
      const win = doc.defaultView
      const selection = win?.getSelection()
      if (!win || !selection || selection.isCollapsed) return
      const text = selection.toString()
      if (!text.trim()) return
      const docIndex = buildDocIndex(doc)
      if (!docIndex) return
      const range = selection.getRangeAt(0)
      const startRaw = rawOffset(docIndex, range.startContainer, range.startOffset)
      const endRaw = rawOffset(docIndex, range.endContainer, range.endOffset)
      if (startRaw == null || endRaw == null || endRaw <= startRaw) return

      const flatStart = flatIndexOfRaw(docIndex.map, startRaw)
      const flatEnd = flatIndexOfRaw(docIndex.map, endRaw)
      const quote = docIndex.flat.slice(flatStart, flatEnd).trim()
      if (!quote) return
      const prefix = docIndex.flat.slice(Math.max(0, flatStart - 32), flatStart)
      const suffix = docIndex.flat.slice(flatEnd, Math.min(docIndex.flat.length, flatEnd + 32))
      let occurrence = 0
      for (let at = docIndex.flat.indexOf(quote); at >= 0 && at < flatStart; ) {
        occurrence += 1
        at = docIndex.flat.indexOf(quote, at + quote.length)
      }

      const draft: AnnotationDraft = {
        locator: JSON.stringify({
          v: 1,
          index: lastRelocate.index,
          fraction: lastRelocate.fraction,
        }),
        chapterHref: spinePath(lastRelocate.index),
        quote,
        prefix: prefix || null,
        suffix: suffix || null,
        occurrence,
        color: 'yellow',
      }

      const rect = range.getBoundingClientRect()
      const box = doc.createElement('div')
      box.setAttribute('data-modu-toolbar', '1')
      box.style.cssText = [
        'position:fixed',
        `left:${Math.round(rect.left + rect.width / 2)}px`,
        `top:${Math.round(rect.bottom + 10)}px`,
        'transform:translateX(-50%)',
        'display:flex',
        'align-items:center',
        'gap:6px',
        'padding:6px 8px',
        'border-radius:10px',
        'background:rgba(24,24,37,.96)',
        'box-shadow:0 6px 20px rgba(0,0,0,.45)',
        'border:1px solid rgba(255,255,255,.10)',
        'z-index:2147483000',
        'font:12px/1 system-ui, sans-serif',
        'color:#cdd6f4',
        'user-select:none',
      ].join(';')
      box.addEventListener('mousedown', (e) => e.preventDefault())

      for (const color of ANNOTATION_COLORS) {
        const dot = doc.createElement('button')
        dot.type = 'button'
        dot.title = ANNOTATION_LABELS[color]
        dot.style.cssText = `width:18px;height:18px;border-radius:9999px;border:1px solid rgba(0,0,0,.25);background:${ANNOTATION_SWATCHES[color]};cursor:pointer`
        dot.addEventListener('click', () => {
          callbacksRef.current.onAnnotate?.({ ...draft, color }, 'highlight')
          hideToolbar()
          selection.removeAllRanges()
        })
        box.appendChild(dot)
      }

      const noteButton = doc.createElement('button')
      noteButton.type = 'button'
      noteButton.textContent = '写批注'
      noteButton.style.cssText =
        'height:20px;padding:0 8px;border-radius:6px;border:1px solid rgba(137,180,250,.45);background:rgba(137,180,250,.16);color:#cdd6f4;font:12px/1 system-ui, sans-serif;cursor:pointer'
      noteButton.addEventListener('click', () => {
        callbacksRef.current.onAnnotate?.({ ...draft, color: 'yellow' }, 'note')
        hideToolbar()
        selection.removeAllRanges()
      })
      box.appendChild(noteButton)

      doc.body.appendChild(box)
      toolbar = box
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
      hideToolbar()

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
          lastRelocate = {
            index: Number(detail.index ?? 0),
            fraction: Number(detail.fraction ?? 0),
          }
          lastPositionRef.current = {
            index: lastRelocate.index,
            fraction: lastRelocate.fraction,
          }
          const anchorDoc = currentDoc()
          if (anchorDoc && range) captureAnchor(anchorDoc, range)
          callbacksRef.current.onRelocate?.({
            index: lastRelocate.index,
            fraction: lastRelocate.fraction,
            page: Number(renderer.page ?? 1),
            pages: Number(renderer.pages ?? 1),
            fragment: rangeFragment(range),
            excerpt: (range?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
          })
          // 换章后按新的章节 path 重新画批注（同章翻页不重复走文本树）
          const docNow = currentDoc()
          if (docNow && docNow !== lastRenderedDoc) renderAnnotations(docNow)
        }) as EventListener)

        // 左右两侧点按翻页（foliate 本身只处理链接点击）。
        const onDocClick = (event: MouseEvent, doc: Document) => {
          if (event.defaultPrevented || event.button !== 0) return
          const target = event.target as HTMLElement | null
          if (target?.closest('a, button, input, textarea, select, [data-modu-toolbar]')) return
          const selection = doc.defaultView?.getSelection()?.toString() ?? ''
          if (selection.length > 0) return
          // 先看是不是点在已有划线上：命中就打开那条批注，不翻页
          const docIndex = buildDocIndex(doc)
          if (docIndex) {
            const hit = hitAnnotation(doc, docIndex, event.clientX, event.clientY)
            if (hit != null) {
              callbacksRef.current.onAnnotationActivate?.(hit)
              return
            }
          }
          const rect = view.getBoundingClientRect()
          if (rect.width <= 0) return
          const ratio = (event.clientX - rect.left) / rect.width
          if (ratio < 0.3) void view.prev()
          else if (ratio > 0.7) void view.next()
        }

        view.addEventListener('load', ((event: CustomEvent<{ index: number; doc: Document }>) => {
          const detail = event.detail
          callbacksRef.current.onLoad?.({ index: Number(detail.index ?? 0) })
          hideToolbar()
          const doc = detail.doc
          doc?.addEventListener('click', (clickEvent) => onDocClick(clickEvent, doc))
          // passive: false —— 需要 preventDefault 阻止 iframe 自身滚动
          doc?.addEventListener('wheel', onDocWheel, { passive: false })
          doc?.addEventListener('mouseup', (upEvent) => onDocMouseUp(upEvent, doc))
          doc?.addEventListener('keydown', (keyEvent) => {
            if (keyEvent.key === 'Escape') hideToolbar()
          })
          if (doc) {
            docRef.current = doc
            // 章节刚加载时 relocate 还没发，先用上一章位置渲染一版；
            // 随后 relocate 到达会再渲染一次（见 onRelocate 里的调用）。
            renderAnnotations(doc)
          }
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
  }, [book, applySettings])

  // 阅读设置变化：重新注入 CSS 并重排。
  // 拖动滑杆会连续触发 settings，重排本身很贵（要重新分页），
  // 因此做 100ms 防抖；重排后按最近位置复位，避免「一调字号就被扔回章首」。
  useEffect(() => {
    const view = viewRef.current
    if (!view?.renderer) return
    const timer = window.setTimeout(() => {
      const position = lastPositionRef.current
      applySettings(view, settings)
      if (position) {
        void Promise.resolve(
          view.renderer?.goTo?.({ index: position.index, anchor: position.fraction }),
        ).catch(() => undefined)
      }
    }, 100)
    return () => window.clearTimeout(timer)
  }, [settings, applySettings])

  // 批注增删改后重画当前章节（不用重建阅读器）
  useEffect(() => {
    annotationsRef.current = annotations ?? []
    const doc = docRef.current
    if (doc) renderAnnotationsRef.current?.(doc)
  }, [annotations])

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
          再用 max-inline-size 限制行宽（默认 720px → 中文约 35 字/行）。
          容器宽需要覆盖「版心 + 两侧页边距」，否则页边距调大后
          paginator 拿到的容器反而变窄，行宽悄悄小于版心设定。 */}
      <div
        ref={hostRef}
        className="mx-auto h-full w-full"
        style={{ maxWidth: settings.pageWidth + settings.pagePadding * 2 }}
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
  const needle = normalizeQuote(quote)
  if (!needle) return null
  const index = buildDocIndex(doc)
  if (!index) return null

  let at = index.flat.indexOf(needle)
  if (at < 0 && needle.length > 10) {
    // 跨节点丢字/异体标点时退一步：用前 10 个字定位
    at = index.flat.indexOf(needle.slice(0, 10))
  }
  if (at < 0) return null
  return rangeFromFlat(doc, index, at, at + needle.length)
}

// ---------------------------------------------------------------------------
// 批注：文本索引与定位
// ---------------------------------------------------------------------------

const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink'] as const

const ANNOTATION_LABELS: Record<string, string> = {
  yellow: '黄色划线',
  green: '绿色划线',
  blue: '蓝色划线',
  pink: '粉色划线',
}

const ANNOTATION_SWATCHES: Record<string, string> = {
  yellow: 'rgba(249, 226, 175, .95)',
  green: 'rgba(166, 227, 161, .95)',
  blue: 'rgba(137, 180, 250, .95)',
  pink: 'rgba(245, 194, 231, .95)',
}

interface DocIndex {
  nodes: { node: Text; start: number; end: number }[]
  /** 压缩后每个字符对应的原始字符下标 */
  map: number[]
  /** 压缩空白后的全文 */
  flat: string
}

/**
 * 当前页起点所在的锚点 id。
 * 目录里同一章可能挂多个 fragment（小节/脚注），靠它把高亮精确到小节；
 * 找不到时返回 null，调用方回退到「本章第一个目录项」。
 */
function rangeFragment(range: Range | undefined | null): string | null {
  if (!range) return null
  let node: Node | null = range.startContainer
  if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement
  const el = node as Element | null
  return el?.closest('[id]')?.id || null
}

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function buildDocIndex(doc: Document): DocIndex | null {
  if (!doc.body) return null
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const nodes: DocIndex['nodes'] = []
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
  return { nodes, map, flat }
}

/** flat 区间 → DOM Range；跨节点也能正确拼出来 */
function rangeFromFlat(
  doc: Document,
  index: DocIndex,
  start: number,
  endExclusive: number,
): Range | null {
  if (start < 0 || endExclusive > index.map.length || endExclusive <= start) return null
  const startRaw = index.map[start]
  const endRaw = index.map[endExclusive - 1] + 1
  const startNode = index.nodes.find((n) => startRaw >= n.start && startRaw < n.end)
  const endNode = index.nodes.find((n) => endRaw > n.start && endRaw <= n.end)
  if (!startNode || !endNode) return null
  const range = doc.createRange()
  range.setStart(startNode.node, startRaw - startNode.start)
  range.setEnd(endNode.node, endRaw - endNode.start)
  return range
}

function rawOffset(index: DocIndex, node: Node, offset: number): number | null {
  const entry = index.nodes.find((n) => n.node === node)
  return entry ? entry.start + offset : null
}

/** map 是单调递增数组：返回第一个 map[i] >= raw 的 i */
function flatIndexOfRaw(map: number[], raw: number): number {
  let low = 0
  let high = map.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (map[mid] < raw) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * 按批注存的选择器重新定位：引文 + 前后文 + 同章第几次出现。
 *
 * 先找全部出现位置，用前后文筛一遍，再按 occurrence 取第 N 个；
 * 前后文对不上（书被改过、排版插入异体字）时退化为纯出现序号。
 */
function locateQuote(
  doc: Document,
  index: DocIndex,
  quote: string,
  prefix: string | null,
  suffix: string | null,
  occurrence: number,
): Range | null {
  const needle = normalizeQuote(quote)
  if (!needle) return null
  const positions: number[] = []
  for (
    let at = index.flat.indexOf(needle);
    at >= 0;
    at = index.flat.indexOf(needle, at + needle.length)
  ) {
    positions.push(at)
  }
  if (positions.length === 0) {
    if (needle.length > 10) {
      return locateQuote(doc, index, needle.slice(0, 10), prefix, suffix, 0)
    }
    return null
  }
  const before = normalizeQuote(prefix ?? '')
  const after = normalizeQuote(suffix ?? '')
  const matched = positions.filter((at) => {
    const okPrefix = !before || index.flat.slice(Math.max(0, at - before.length), at) === before
    const okSuffix =
      !after ||
      index.flat.slice(at + needle.length, at + needle.length + after.length) === after
    return okPrefix && okSuffix
  })
  const pool = matched.length > 0 ? matched : positions
  const pick = pool[occurrence] ?? pool[0]
  if (pick == null) return null
  return rangeFromFlat(doc, index, pick, pick + needle.length)
}

async function waitForChapterDoc(
  view: FoliateView,
  index: number,
  attempts = 20,
): Promise<Document | null> {
  for (let i = 0; i < attempts; i += 1) {
    const contents = view.renderer?.getContents?.() ?? []
    const current = contents[0]
    if (current?.doc && Number(current.index) === index) return current.doc
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return null
}

function ensureAnnotationStyles(doc: Document): void {
  if (doc.getElementById('modu-anno-style')) return
  const style = doc.createElement('style')
  style.id = 'modu-anno-style'
  style.textContent = [
    '::highlight(modu-anno-yellow) { background-color: rgba(249, 226, 175, .42); }',
    '::highlight(modu-anno-green) { background-color: rgba(166, 227, 161, .42); }',
    '::highlight(modu-anno-blue) { background-color: rgba(137, 180, 250, .40); }',
    '::highlight(modu-anno-pink) { background-color: rgba(245, 194, 231, .42); }',
  ].join('\n')
  doc.head.appendChild(style)
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
