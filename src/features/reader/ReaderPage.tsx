import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Highlighter,
  ListTree,
  Focus,
  Search,
  Bookmark as BookmarkIcon,
} from 'lucide-react'
import { save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'

import { cn } from '../../lib/cn'
import { CMD, registerCommand, unregisterAll } from '../../lib/commands'
import { isOverlayOpen } from '../../lib/overlay'
import {
  addAnnotation,
  addBookmark,
  closeBook,
  exportAnnotationsMarkdown,
  getProgress,
  listAnnotations,
  listBookmarks,
  removeAnnotation,
  removeBookmark,
  saveProgress,
  searchBook,
  setBookmarkNote,
  updateAnnotation,
  writeTextFile,
} from '../../lib/ipc'
import { decodeLocator, encodeLocator } from '../../lib/locator'
import { coverUrl } from '../../lib/protocol'
import type {
  Annotation,
  AnnotationDraft,
  Bookmark,
  OpenedBookInfo,
  SearchHit,
  SpineItem,
  TocItem,
} from '../../lib/types'
import { useLibrary } from '../../store/library'
import { useChromeStore } from '../../store/chrome'
import { useReaderSettings } from '../../store/settings'
import { ReaderView, type ReaderApi, type RelocateState } from '../../renderer/ReaderView'
import { AnnotationsPanel } from './AnnotationsPanel'
import { BookmarksPanel } from './BookmarksPanel'
import { TocTree } from './TocTree'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 开发期交互自检。
 *
 * CDP 的 playwright scenario provider 对 Tauri/WebView2 页面持续失败，没法把
 * 点击/按键派发进窗口；所以翻页、跨章跳转这类交互改成在 reader ready 之后
 * 自动跑一遍，把每步结果写进页脚浮层，再用截图核对。
 */
async function runSmokeTest(
  api: ReaderApi,
  spine: SpineItem[],
  getIndex: () => number | null,
  getPageKey: () => string,
  push: (line: string) => void,
) {
  const expect = (actual: number | null, want: number, label: string) =>
    push(`${label}: ${actual ?? '—'} ${actual === want ? '✓' : `✗ 期望 ${want}`}`)

  push(`初始化: 第 ${(getIndex() ?? 0) + 1} 章`)
  if (spine.length < 2) {
    push('spine 不足 2 章，跳过跨章检查')
    return
  }

  const target = spine[spine.length - 1]
  await api.goTo(target.path)
  await sleep(450)
  expect(getIndex(), spine.length - 1, `跨章跳转 ${target.path}`)

  await api.next()
  await sleep(300)
  push(`下一页: 仍为第 ${(getIndex() ?? 0) + 1} 章`)

  // 章内比例定位要挑一个「够长、一定多页」的章节：短章节（封面/版权页）
  // 只有 1 页，0.5 的比例没有可落点，folio 的取整会顺延到下一章。
  const longest = spine.reduce((best, item) => (item.size > best.size ? item : best), spine[0])
  await api.goToChapter(longest.index, 0.5)
  await sleep(450)
  expect(getIndex(), longest.index, `章内分数定位 (${longest.path})`)

  await api.prev()
  await sleep(250)

  // 滚轮翻页：分页模式下正文不滚动，滚轮应切页（合成 wheel 事件绕过 CDP 限制）
  const beforeWheel = getPageKey()
  const wheelSent = api.dispatchWheel(120)
  await sleep(420)
  const afterWheel = getPageKey()
  push(
    `滚轮翻页: ${wheelSent ? (afterWheel !== beforeWheel ? '✓' : '✗ 页码未变') : '✗ 派发失败'}`,
  )

  push('自检结束')
}

/**
 * M2 功能自检：书签写入/读取/删除。
 *
 * 只在 dev + spike 模式下跑，结果写进浮层，避免依赖 CDP 派发点击。
 */
async function runBookmarkSmoke(
  libraryId: number,
  locator: string,
  chapterLabel: string,
  push: (line: string) => void,
) {
  try {
    const bookmark = await addBookmark(libraryId, locator, chapterLabel, '自检书签')
    push(`书签写入: #${bookmark.id} ✓`)
    const saved = await listBookmarks(libraryId)
    push(`书签读取: ${saved.length} 条 ${saved.some((item) => item.id === bookmark.id) ? '✓' : '✗ 未命中'}`)
    await removeBookmark(bookmark.id)
    const after = await listBookmarks(libraryId)
    push(`书签删除: ${after.some((item) => item.id === bookmark.id) ? '✗ 仍存在' : '✓'}`)
  } catch (err) {
    push(`书签自检失败: ${String(err)}`)
  }
}

interface ReaderPageProps {
  book: OpenedBookInfo
  onBack: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  /**
   * 阅读页暂时进入后台（打开设置页等）时为 true：暂停本页的所有键盘
   * 快捷键，避免在设置页按 Esc/快捷键时把阅读页的状态一起切了。
   */
  suspended?: boolean
  /** dev spike 打开时自动跑一遍交互自检（生产构建不生效）。 */
  devSpike?: boolean
}

type SidebarTab = 'toc' | 'bookmarks' | 'annotations' | 'search'

/**
 * 阅读器页面。
 *
 * P1 重构后本页不再渲染标题栏：标题栏由 App 统一渲染，本页只向
 * chrome store 写「书名 / 当前章节 / 沉浸态」，并把自己的动作
 * （加书签、目录、搜索、侧栏、沉浸、返回、批注导出）注册进命令总线，
 * 供全局菜单触发。
 *
 * M2 的几条主线都在这里汇合：
 * - 进度：打开时读 `progress` 表并 `goToChapter(index, fraction)` 恢复；
 *   每次 reloc 防抖 700ms 写回。换字号/窗口大小都不会失准（不是像素）。
 * - 目录：depth 还原成树，可折叠，当前章节高亮。
 * - 书签：记录同构 locator + 章节名 + 摘录。
 * - 排版：主题/字体/字号/行高/版心/页边距，走 localStorage 持久化。
 * - 沉浸：隐藏顶栏、侧栏、底栏，只留正文。
 */
export function ReaderPage({
  book,
  onBack,
  fullscreen,
  onToggleFullscreen,
  suspended = false,
  devSpike = false,
}: ReaderPageProps) {
  // 只取 settings/customFonts：排版调整入口已迁到 App 的标题栏快速面板。
  const { settings } = useReaderSettings()
  const customFonts = useReaderSettings((state) => state.customFonts)
  const simplifyTraditional = useReaderSettings((state) => state.settings.simplifyTraditional)

  const [error, setError] = useState<string | null>(null)
  const [relocate, setRelocate] = useState<RelocateState>({
    index: 0,
    fraction: 0,
    page: 1,
    pages: 1,
    fragment: null,
    excerpt: '',
  })
  const [loadedIndex, setLoadedIndex] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('toc')
  const [immersive, setImmersive] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [bookmarksLoading, setBookmarksLoading] = useState(false)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [annotationsLoading, setAnnotationsLoading] = useState(false)
  // 面板里高亮/展开的那条批注（点正文划线或刚新建时设置）
  const [activeAnnotationId, setActiveAnnotationId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const apiRef = useRef<ReaderApi | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [smokeLog, setSmokeLog] = useState<string[]>([])
  const smokeRan = useRef(false)
  const loadedIndexRef = useRef<number | null>(null)
  // 当前「章节:页码」，供滚轮自检判断是否真的翻页
  const pageKeyRef = useRef('')

  const libraryId = book.libraryId
  const spine = book.package.spine
  const spineTotal = spine.length
  const toc = book.package.toc
  const cover = coverUrl(book.id, book.package.coverPath)
  const activePath = spine[relocate.index]?.path ?? null

  const progress = spineTotal > 0 ? (relocate.index + relocate.fraction) / spineTotal : 0

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 1800)
  }, [])

  const currentChapterLabel = useMemo(() => {
    if (!activePath) return '—'
    const matched = toc.find((item) => item.path === activePath)
    if (matched?.label) return matched.label
    const name = (activePath.split('/').pop() ?? activePath).replace(/\.x?html?$/i, '')
    // 目录里通常不收录封面/扉页/导航页，回退到文件名时给个像样的中文名。
    const common: Record<string, string> = {
      cover: '封面',
      'cover-page': '封面',
      coverpage: '封面',
      titlepage: '扉页',
      'title-page': '扉页',
      toc: '目录',
      nav: '目录',
      contents: '目录',
      copyright: '版权信息',
    }
    return common[name.toLowerCase()] ?? name
  }, [activePath, toc])

  const loadBookmarks = useCallback(async () => {
    if (!libraryId) return
    setBookmarksLoading(true)
    try {
      setBookmarks(await listBookmarks(libraryId))
    } catch (err) {
      console.error('[reader] 读取书签失败', err)
    } finally {
      setBookmarksLoading(false)
    }
  }, [libraryId])

  useEffect(() => {
    void loadBookmarks()
  }, [loadBookmarks])

  // 恢复上次阅读位置：必须在 reader ready 之后，此时 renderer 已能定位。
  const handleReady = useCallback(
    async (api: ReaderApi) => {
      apiRef.current = api
      setReady(true)

      if (libraryId != null) {
        try {
          const record = await getProgress(libraryId)
          const locator = decodeLocator(record?.locator)
          if (locator && locator.index < spineTotal) {
            // v2 locator 带文本锚点：先按章/分数跳到附近，再用引文校正回原句。
            // 锚点失效（书被替换/改排版后找不到原句）时停在章/分数位置，不至于回到开头。
            const located = await api.goToLocator(locator)
            if (!located) await api.goToChapter(locator.index, locator.fraction)
          }
        } catch (err) {
          console.error('[reader] 读取进度失败', err)
        }
      }

      // dev 自检：spike 打开的书（或显式 VITE_SMOKE=1）自动跑一遍交互，
      // 结果写进右上角浮层，用截图核对——CDP 无法派发点击/按键。
      const smoke = import.meta.env.VITE_SMOKE as string | undefined
      // VITE_SMOKE=0 可强制关掉自检（截正常阅读状态时用）
      if (!import.meta.env.DEV || smoke === '0' || (!devSpike && smoke !== '1') || smokeRan.current)
        return
      smokeRan.current = true
      const lines: string[] = []
      const push = (line: string) => {
        lines.push(line)
        setSmokeLog((prev) => [...prev, line])
        // 同时写进 title：CDP 只能看到 target title，截图又常被窗口遮挡。
        document.title = '墨读 · ' + lines.join(' | ')
      }
      void (async () => {
        await runSmokeTest(
          api,
          spine,
          () => loadedIndexRef.current,
          () => pageKeyRef.current,
          push,
        )
        if (libraryId != null) {
          await runBookmarkSmoke(
            libraryId,
            encodeLocator(loadedIndexRef.current ?? 0, 0),
            '自检位置',
            push,
          )
        }
      })()
    },
    [devSpike, libraryId, spine, spineTotal],
  )

  // 进度写回：防抖 700ms，避免每翻一页都打数据库。
  useEffect(() => {
    if (!ready || libraryId == null || spineTotal === 0) return
    const timer = window.setTimeout(() => {
      const percent = (relocate.index + relocate.fraction) / spineTotal
      void saveProgress(
        libraryId,
        encodeLocator(relocate.index, relocate.fraction, apiRef.current?.getAnchor?.() ?? null),
        percent,
      ).catch((err) => console.error('[reader] 保存进度失败', err))
    }, 700)
    return () => window.clearTimeout(timer)
  }, [ready, libraryId, relocate.index, relocate.fraction, spineTotal])

  const handleBack = useCallback(async () => {
    // 返回前立刻落一次进度，不等防抖。
    if (libraryId != null && spineTotal > 0) {
      const percent = (relocate.index + relocate.fraction) / spineTotal
      await saveProgress(
        libraryId,
        encodeLocator(relocate.index, relocate.fraction, apiRef.current?.getAnchor?.() ?? null),
        percent,
      ).catch(() => undefined)
      void useLibrary.getState().load()
    }
    apiRef.current = null
    await closeBook(book.id).catch(() => undefined)
    onBack()
  }, [book.id, libraryId, onBack, relocate.fraction, relocate.index, spineTotal])

  // 不在卸载时无条件 closeBook：React 严格模式会「挂载→卸载→再挂载」，
  // 第二次挂载拿到的还是同一个 OpenedBookInfo，句柄却已被释放，导致
  // paginator 报「书籍未打开」。句柄统一由 handleBack 关闭。

  // Esc：先退沉浸，再返书架。
  // 用 ref 读状态，而不是在 setState 的 updater 里做副作用——
  // StrictMode 会重复调用 updater，副作用会被执行两次（会多退一次到书架）。
  const immersiveRef = useRef(false)
  immersiveRef.current = immersive
  // 设置页在后台时（suspended）整页快捷键全部暂停，键盘事件属于上层视图。
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  // Esc 阶梯要读全屏状态，但不能因为 fullscreen 变化而重绑监听
  const fullscreenRef = useRef(fullscreen)
  fullscreenRef.current = fullscreen
  const onToggleFullscreenRef = useRef(onToggleFullscreen)
  onToggleFullscreenRef.current = onToggleFullscreen
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (suspendedRef.current) return
      // 帮助面板等 Radix 弹层自己也吃 Esc：弹层打开时交给它关，
      // 否则一次 Esc 会「关面板 + 退回书架」两件事一起做。
      if (isOverlayOpen()) return
      // Esc 阶梯：全屏 → 沉浸 → 书架（任务书 F-15）
      if (fullscreenRef.current) {
        onToggleFullscreenRef.current()
        return
      }
      if (immersiveRef.current) {
        setImmersive(false)
        return
      }
      void handleBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleBack])

  const jumpToToc = useCallback((item: TocItem) => {
    const target = item.path
      ? item.fragment
        ? `${item.path}#${item.fragment}`
        : item.path
      : item.href
    void apiRef.current?.goTo(target)
  }, [])

  const jumpToBookmark = useCallback((bookmark: Bookmark) => {
    const locator = decodeLocator(bookmark.locator)
    if (!locator) {
      showToast('这条书签的位置数据已失效')
      return
    }
    void apiRef.current?.goToChapter(locator.index, locator.fraction)
  }, [showToast])

  const handleAddBookmark = useCallback(async () => {
    if (libraryId == null) {
      showToast('从书架打开的书才能加书签')
      return
    }
    try {
      const bookmark = await addBookmark(
        libraryId,
        encodeLocator(relocate.index, relocate.fraction),
        currentChapterLabel,
        relocate.excerpt || apiRef.current?.getVisibleText(120) || null,
      )
      setBookmarks((prev) => [bookmark, ...prev])
      setSidebarTab('bookmarks')
      setSidebarOpen(true)
      showToast('已添加书签')
    } catch (err) {
      console.error('[reader] 添加书签失败', err)
      showToast('添加书签失败')
    }
  }, [currentChapterLabel, libraryId, relocate.excerpt, relocate.fraction, relocate.index, showToast])

  const handleRemoveBookmark = useCallback(
    async (bookmark: Bookmark) => {
      try {
        await removeBookmark(bookmark.id)
        setBookmarks((prev) => prev.filter((item) => item.id !== bookmark.id))
      } catch (err) {
        console.error('[reader] 删除书签失败', err)
      }
    },
    [],
  )

  // 全书搜索：输入停顿 280ms 再查，避免每个按键都打一次 IPC。
  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || libraryId == null) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await searchBook(book.id, libraryId, query, 80, simplifyTraditional)
          setSearchResults(hits)
        } catch (err) {
          console.error('[reader] 搜索失败', err)
          showToast('搜索失败')
        } finally {
          setSearching(false)
        }
      })()
    }, 280)
    return () => window.clearTimeout(timer)
  }, [searchQuery, book.id, libraryId, simplifyTraditional, showToast])

  const handleJumpSearch = useCallback(async (hit: SearchHit) => {
    const match = hit.snippet.split('\u0001')[1]?.split('\u0002')[0] ?? ''
    try {
      if (match) {
        const found = await apiRef.current?.revealText(hit.index, match)
        if (!found) await apiRef.current?.goToChapter(hit.index)
      } else {
        await apiRef.current?.goToChapter(hit.index)
      }
    } catch (err) {
      console.error('[reader] 跳转搜索结果失败', err)
    }
  }, [])

  const handleBookmarkNote = useCallback(
    async (bookmark: Bookmark, note: string) => {
      try {
        await setBookmarkNote(bookmark.id, note)
        setBookmarks((prev) =>
          prev.map((item) =>
            item.id === bookmark.id ? { ...item, note: note.trim() || null } : item,
          ),
        )
        showToast('备注已保存')
      } catch (err) {
        console.error('[reader] 保存备注失败', err)
        showToast('保存备注失败')
      }
    },
    [showToast],
  )

  const toggleImmersive = useCallback(() => setImmersive((value) => !value), [])

  /** Ctrl+K：打开侧栏搜索并聚焦；侧栏收起时一并展开。 */
  const focusSearch = useCallback(() => {
    setSidebarTab('search')
    setSidebarOpen(true)
    window.setTimeout(() => searchInputRef.current?.focus(), 60)
  }, [])

  /**
   * 正文右键菜单「搜索选中文字」：把选中的词填进侧栏搜索并立即执行。
   * 截断到 40 字——整段选中多半不是要搜的词，太长会让搜索无意义。
   */
  const handleContextSearch = useCallback((text: string) => {
    const query = text.trim().slice(0, 40)
    if (!query) return
    setSidebarTab('search')
    setSidebarOpen(true)
    setSearchQuery(query)
    window.setTimeout(() => searchInputRef.current?.focus(), 60)
  }, [])

  // 阅读器快捷键：Ctrl+B 侧栏、Ctrl+K 搜索、Ctrl+D 书签（F1/F11 由 App 处理）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) return
      if (!event.ctrlKey && !event.metaKey) return
      // 弹层（帮助/设置）打开时不响应页面快捷键
      if (document.querySelector('[role="dialog"]')) return
      const target = event.target as HTMLElement | null
      const inField = !!target && /^(INPUT|TEXTAREA)$/.test(target.tagName)
      if (inField && event.key.toLowerCase() !== 'b') return
      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        setSidebarOpen((value) => !value)
      } else if (key === 'k') {
        event.preventDefault()
        focusSearch()
      } else if (key === 'd') {
        event.preventDefault()
        void handleAddBookmark()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusSearch, handleAddBookmark])

  // -------------------------------------------------------------------------
  // 批注（M4）
  // -------------------------------------------------------------------------

  const loadAnnotations = useCallback(async () => {
    if (libraryId == null) return
    setAnnotationsLoading(true)
    try {
      setAnnotations(await listAnnotations(libraryId))
    } catch (err) {
      console.error('[reader] 读取批注失败', err)
    } finally {
      setAnnotationsLoading(false)
    }
  }, [libraryId])

  useEffect(() => {
    void loadAnnotations()
  }, [loadAnnotations])

  /** 正文里划线/写批注：落库后由 annotations state 触发重画。 */
  const handleAnnotate = useCallback(
    async (draft: AnnotationDraft, mode: 'highlight' | 'note') => {
      if (libraryId == null) {
        showToast('从书架打开的书才能加批注')
        return
      }
      try {
        const created = await addAnnotation(libraryId, {
          ...draft,
          chapterTitle: currentChapterLabel,
          color: draft.color ?? 'yellow',
          note: null,
        })
        setAnnotations((prev) => [created, ...prev])
        setSidebarTab('annotations')
        setSidebarOpen(true)
        setActiveAnnotationId(created.id)
        showToast(mode === 'note' ? '写下你的想法' : '已划线')
      } catch (err) {
        console.error('[reader] 新建批注失败', err)
        showToast('划线失败')
      }
    },
    [currentChapterLabel, libraryId, showToast],
  )

  const handleAnnotationNote = useCallback(
    async (annotation: Annotation, note: string) => {
      try {
        const updated = await updateAnnotation(annotation.id, note)
        setAnnotations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
        // 保存后收起编辑态；清掉 activeId，面板就不会因为列表刷新再次展开。
        setActiveAnnotationId((current) => (current === annotation.id ? null : current))
        showToast(note.trim() ? '批注已保存' : '批注已清空')
      } catch (err) {
        console.error('[reader] 保存批注失败', err)
        showToast('保存批注失败')
      }
    },
    [showToast],
  )

  const handleRemoveAnnotation = useCallback(
    async (annotation: Annotation) => {
      try {
        await removeAnnotation(annotation.id)
        setAnnotations((prev) => prev.filter((item) => item.id !== annotation.id))
        setActiveAnnotationId((current) => (current === annotation.id ? null : current))
      } catch (err) {
        console.error('[reader] 删除批注失败', err)
        showToast('删除批注失败')
      }
    },
    [showToast],
  )

  /** 点正文里的划线：切到批注页并选中那一条。 */
  const handleAnnotationActivate = useCallback((id: number) => {
    setActiveAnnotationId(id)
    setSidebarTab('annotations')
    setSidebarOpen(true)
  }, [])

  const jumpToAnnotation = useCallback(async (annotation: Annotation) => {
    setActiveAnnotationId(annotation.id)
    await apiRef.current?.revealAnnotation(annotation)
  }, [])

  // 导出批注：Rust 只负责拼 Markdown，落盘位置由系统保存对话框决定
  //（不开 fs 插件 scope，路径来自用户显式选择）。
  const handleExportAnnotations = useCallback(async () => {
    if (libraryId == null) return
    try {
      const markdown = await exportAnnotationsMarkdown(libraryId)
      const path = await save({
        defaultPath: `${book.package.title} · 批注.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (path === null) return
      await writeTextFile(path, markdown)
      showToast('批注已导出')
    } catch (err) {
      console.error('[reader] 导出批注失败', err)
      showToast('导出失败')
    }
  }, [book.package.title, libraryId, showToast])

  // -------------------------------------------------------------------------
  // chrome 同步与全局命令注册（标题栏/菜单由 App 渲染，能力在这里）
  // -------------------------------------------------------------------------

  // 书名进标题（打开即写一次；换书不会复用本页实例）。
  useEffect(() => {
    useChromeStore.getState().set({ title: book.package.title })
  }, [book.package.title])

  // 当前章节进标题副文本。
  useEffect(() => {
    useChromeStore.getState().set({ subtitle: currentChapterLabel })
  }, [currentChapterLabel])

  // 沉浸态交给 App 决定是否隐藏标题栏。
  useEffect(() => {
    useChromeStore.getState().set({ immersive })
  }, [immersive])

  // 卸载时恢复默认沉浸态（防止下次打开书时标题栏被隐藏）。标题/章节
  // 交给下一次挂载的页面覆盖，这里不做复位以避免 StrictMode 双挂载闪烁。
  useEffect(() => {
    return () => {
      useChromeStore.getState().set({ immersive: false })
    }
  }, [])

  // 注册本页能力到命令总线：每次渲染重新注册（捕获最新闭包），开销可忽略。
  // 清理时先注销本页的口径，避免旧闭包残留。
  useEffect(() => {
    return unregisterAll(
      registerCommand(CMD.readerAddBookmark, () => void handleAddBookmark()),
      registerCommand(CMD.readerToc, () => {
        setSidebarTab('toc')
        setSidebarOpen(true)
      }),
      registerCommand(CMD.readerBookmarks, () => {
        setSidebarTab('bookmarks')
        setSidebarOpen(true)
      }),
      registerCommand(CMD.readerSearch, () => focusSearch()),
      registerCommand(CMD.readerSidebar, () => setSidebarOpen((value) => !value)),
      registerCommand(CMD.readerImmersive, () => toggleImmersive()),
      registerCommand(CMD.readerExportAnnotations, () => void handleExportAnnotations()),
      registerCommand(CMD.readerBack, () => void handleBack()),
    )
  })

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-text">

      {immersive && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40">
          <div className="mx-auto flex max-w-[520px] items-center gap-2 px-4 pb-2 text-[10px] tabular-nums text-overlay0/70">
            <span className="truncate">{currentChapterLabel}</span>
            <span className="h-px flex-1 bg-surface0/60">
              <span
                className="block h-px bg-blue/70"
                style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
              />
            </span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
        </div>
      )}

      {immersive && (
        <div className="pointer-events-none fixed right-3 top-3 z-40">
          <button
            type="button"
            onClick={toggleImmersive}
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-md bg-mantle/70 text-overlay0 opacity-30 backdrop-blur transition hover:opacity-100 hover:text-text"
            title="退出专注阅读（Esc）"
          >
            <Focus size={15} />
          </button>
        </div>
      )}

      {error && (
        <div className="shrink-0 border-b border-red/30 bg-red/10 px-4 py-2 text-xs text-red">
          渲染失败：{error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && !immersive && (
          <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-surface0/70 bg-mantle/40">
            <div className="shrink-0 border-b border-surface0/60 p-3">
              {cover ? (
                <img
                  src={cover}
                  alt="封面"
                  className="mx-auto max-h-36 rounded-md object-contain shadow-lg shadow-black/30"
                />
              ) : (
                <div className="mx-auto flex h-36 w-24 items-center justify-center rounded-md bg-surface0/60 text-overlay0">
                  <BookOpen size={24} />
                </div>
              )}
              <div className="mt-2 line-clamp-2 text-[13px] font-medium text-text">
                {book.package.title}
              </div>
              <div className="mt-0.5 text-[11px] text-overlay0">
                {book.package.authors.join('、') || '未知作者'}
              </div>
            </div>

            <div className="flex shrink-0 gap-1 border-b border-surface0/60 p-2">
              {(
                [
                  { id: 'toc', label: '目录', icon: <ListTree size={12} />, count: 0 },
                  {
                    id: 'bookmarks',
                    label: '书签',
                    icon: <BookmarkIcon size={12} />,
                    count: bookmarks.length,
                  },
                  {
                    id: 'annotations',
                    label: '批注',
                    icon: <Highlighter size={12} />,
                    count: annotations.length,
                  },
                  { id: 'search', label: '搜索', icon: <Search size={12} />, count: 0 },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSidebarTab(tab.id)}
                  title={tab.label}
                  className={cn(
                    'flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[11px] transition',
                    sidebarTab === tab.id
                      ? 'bg-surface0 text-text'
                      : 'text-overlay0 hover:text-text',
                  )}
                >
                  {tab.icon}
                  <span className="truncate">{tab.label}</span>
                  {tab.count > 0 && (
                    <span className="tabular-nums text-overlay0">{tab.count}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {sidebarTab === 'toc' && (
                <TocTree
                  items={toc}
                  activePath={activePath}
                  activeFragment={relocate.fragment}
                  onSelect={jumpToToc}
                />
              )}

              {sidebarTab === 'bookmarks' && (
                <BookmarksPanel
                  bookmarks={bookmarks}
                  loading={bookmarksLoading}
                  onJump={jumpToBookmark}
                  onRemove={(bookmark) => void handleRemoveBookmark(bookmark)}
                  onNote={(bookmark, note) => void handleBookmarkNote(bookmark, note)}
                />
              )}

              {sidebarTab === 'annotations' && (
                <AnnotationsPanel
                  annotations={annotations}
                  loading={annotationsLoading}
                  activeId={activeAnnotationId}
                  onJump={(annotation) => void jumpToAnnotation(annotation)}
                  onRemove={(annotation) => void handleRemoveAnnotation(annotation)}
                  onNote={(annotation, note) => void handleAnnotationNote(annotation, note)}
                  onExport={() => void handleExportAnnotations()}
                />
              )}

              {sidebarTab === 'search' && (
                <div className="flex h-full flex-col">
                  <div className="shrink-0 border-b border-surface0/60 p-2">
                    <div className="flex items-center gap-1.5 rounded-md bg-surface0/50 px-2">
                      <Search size={12} className="text-overlay0" />
                      <input
                        ref={searchInputRef}
                        autoFocus
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="搜索全书"
                        className="h-8 w-full min-w-0 bg-transparent text-[12px] text-text outline-none placeholder:text-overlay0/70"
                      />
                    </div>
                    <div className="mt-1 px-1 text-[10px] tabular-nums text-overlay0/70">
                      {searching
                        ? '搜索中…'
                        : searchQuery.trim()
                          ? `${searchResults.length} 处结果`
                          : '输入至少 1 个字'}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-1">
                    {searchResults.map((hit) => {
                      const [before, rest = ''] = hit.snippet.split('\u0001')
                      const [match, after = ''] = rest.split('\u0002')
                      return (
                        <button
                          key={`${hit.index}-${hit.offset}`}
                          type="button"
                          onClick={() => void handleJumpSearch(hit)}
                          className="block w-full rounded-md px-2 py-1.5 text-left transition hover:bg-surface0/60"
                        >
                          <div className="truncate text-[11px] font-medium text-subtext">
                            {hit.chapterTitle || hit.href.split('/').pop()}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-overlay0">
                            {before}
                            <mark className="rounded-sm bg-yellow/35 px-0.5 text-text">
                              {match}
                            </mark>
                            {after}
                          </div>
                        </button>
                      )
                    })}
                    {!searching && searchQuery.trim() && searchResults.length === 0 && (
                      <div className="p-3 text-center text-[11px] text-overlay0/70">
                        没有找到匹配内容
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-surface0/60 px-3 py-2 text-[10px] tabular-nums text-overlay0/70">
              {spineTotal} 章 · 已读 {Math.round(progress * 100)}%
            </div>
          </aside>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <ReaderView
              book={book}
              settings={settings}
              customFonts={customFonts}
              convertTraditional={simplifyTraditional}
              annotations={annotations}
              onAnnotate={(draft, mode) => void handleAnnotate(draft, mode)}
              onAnnotationActivate={handleAnnotationActivate}
              onContextSearch={handleContextSearch}
              onReady={(api) => void handleReady(api)}
              onRelocate={(state) => {
                pageKeyRef.current = `${state.index}:${state.page}`
                setRelocate(state)
              }}
              onLoad={({ index }) => {
                loadedIndexRef.current = index
                setLoadedIndex(index)
              }}
              onExternalLink={(href) => {
                void openUrl(href).catch((err) => console.error(err))
              }}
              onError={(err) => setError(String(err))}
            />
          </div>

          {!immersive && (
            <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-surface0/70 px-4 text-[11px] text-overlay0">
              <span className="truncate">
                第 {(loadedIndex ?? 0) + 1} / {spineTotal} 章
              </span>
              <span className="tabular-nums">
                {relocate.pages > 1 ? `${relocate.page} / ${relocate.pages} 页 · ` : ''}
                {Math.round(progress * 100)}%
              </span>
              <div className="h-1 w-28 overflow-hidden rounded-full bg-surface0">
                <div
                  className="h-full rounded-full bg-blue/80"
                  style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
                />
              </div>
              <span className="ml-auto truncate text-overlay0/50">{activePath ?? ''}</span>
            </footer>
          )}

          {smokeLog.length > 0 && (
            <div className="pointer-events-none absolute right-4 top-16 z-50 max-w-2xl rounded-lg border border-surface0 bg-mantle/95 p-3 font-mono text-[11px] leading-relaxed text-subtext shadow-xl">
              <div className="mb-1 text-[10px] uppercase tracking-widest text-overlay0">
                dev smoke
              </div>
              {smokeLog.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}

          {toast && (
            <div className="pointer-events-none absolute bottom-12 left-1/2 -translate-x-1/2 rounded-lg border border-surface0 bg-mantle/95 px-3 py-1.5 text-[11px] text-text shadow-xl">
              {toast}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
