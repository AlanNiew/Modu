import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookmarkPlus,
  BookOpen,
  ListTree,
  Maximize2,
  Minimize2,
  PanelLeft,
  Settings2,
  Bookmark as BookmarkIcon,
} from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { TitleBar, TitleBarButton } from '../../components/TitleBar'
import { cn } from '../../lib/cn'
import {
  addBookmark,
  closeBook,
  getProgress,
  listBookmarks,
  removeBookmark,
  saveProgress,
} from '../../lib/ipc'
import { decodeLocator, encodeLocator } from '../../lib/locator'
import { coverUrl } from '../../lib/protocol'
import type { Bookmark, OpenedBookInfo, SpineItem, TocItem } from '../../lib/types'
import { useLibrary } from '../../store/library'
import { useReaderSettings } from '../../store/settings'
import { ReaderView, type ReaderApi, type RelocateState } from '../../renderer/ReaderView'
import { BookmarksPanel } from './BookmarksPanel'
import { ReadingSettingsPanel } from './ReadingSettingsPanel'
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
  /** dev spike 打开时自动跑一遍交互自检（生产构建不生效）。 */
  devSpike?: boolean
}

type SidebarTab = 'toc' | 'bookmarks'

/**
 * 阅读器页面。
 *
 * M2 的几条主线都在这里汇合：
 * - 进度：打开时读 `progress` 表并 `goToChapter(index, fraction)` 恢复；
 *   每次 reloc 防抖 700ms 写回。换字号/窗口大小都不会失准（不是像素）。
 * - 目录：depth 还原成树，可折叠，当前章节高亮。
 * - 书签：记录同构 locator + 章节名 + 摘录。
 * - 排版：主题/字体/字号/行高/版心/页边距，走 localStorage 持久化。
 * - 沉浸：隐藏顶栏、侧栏、底栏，只留正文。
 */
export function ReaderPage({ book, onBack, devSpike = false }: ReaderPageProps) {
  const { settings, patch, setFontFamilyKind, reset } = useReaderSettings()

  const [error, setError] = useState<string | null>(null)
  const [relocate, setRelocate] = useState<RelocateState>({
    index: 0,
    fraction: 0,
    page: 1,
    pages: 1,
    excerpt: '',
  })
  const [loadedIndex, setLoadedIndex] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('toc')
  const [immersive, setImmersive] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [bookmarksLoading, setBookmarksLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const apiRef = useRef<ReaderApi | null>(null)
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
            await api.goToChapter(locator.index, locator.fraction)
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
    [libraryId, spine, spineTotal],
  )

  // 进度写回：防抖 700ms，避免每翻一页都打数据库。
  useEffect(() => {
    if (!ready || libraryId == null || spineTotal === 0) return
    const timer = window.setTimeout(() => {
      const percent = (relocate.index + relocate.fraction) / spineTotal
      void saveProgress(
        libraryId,
        encodeLocator(relocate.index, relocate.fraction),
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
        encodeLocator(relocate.index, relocate.fraction),
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
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

  const toggleImmersive = useCallback(() => setImmersive((value) => !value), [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-text">
      {!immersive && (
        <TitleBar
          title={book.package.title}
          subtitle={currentChapterLabel}
          onBack={() => void handleBack()}
          actions={
            <>
              <TitleBarButton title="添加书签" onClick={() => void handleAddBookmark()}>
                <BookmarkPlus size={15} />
              </TitleBarButton>
              <ReadingSettingsPanel
                settings={settings}
                onPatch={patch}
                onFontKind={setFontFamilyKind}
                onReset={reset}
              >
                <TitleBarButton title="阅读排版设置">
                  <Settings2 size={15} />
                </TitleBarButton>
              </ReadingSettingsPanel>
              <TitleBarButton
                title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
                active={sidebarOpen}
                onClick={() => setSidebarOpen((value) => !value)}
              >
                <PanelLeft size={15} />
              </TitleBarButton>
              <TitleBarButton title="沉浸模式" onClick={toggleImmersive}>
                <Maximize2 size={15} />
              </TitleBarButton>
            </>
          }
        />
      )}

      {immersive && (
        <div className="pointer-events-none fixed right-3 top-3 z-40">
          <button
            type="button"
            onClick={toggleImmersive}
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-md bg-mantle/70 text-overlay0 opacity-30 backdrop-blur transition hover:opacity-100 hover:text-text"
            title="退出沉浸模式（Esc）"
          >
            <Minimize2 size={15} />
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
              <button
                type="button"
                onClick={() => setSidebarTab('toc')}
                className={cn(
                  'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] transition',
                  sidebarTab === 'toc'
                    ? 'bg-surface0 text-text'
                    : 'text-overlay0 hover:text-text',
                )}
              >
                <ListTree size={12} />
                目录
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('bookmarks')}
                className={cn(
                  'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] transition',
                  sidebarTab === 'bookmarks'
                    ? 'bg-surface0 text-text'
                    : 'text-overlay0 hover:text-text',
                )}
              >
                <BookmarkIcon size={12} />
                书签
                {bookmarks.length > 0 && (
                  <span className="tabular-nums text-overlay0">{bookmarks.length}</span>
                )}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {sidebarTab === 'toc' ? (
                <TocTree items={toc} activePath={activePath} onSelect={jumpToToc} />
              ) : (
                <BookmarksPanel
                  bookmarks={bookmarks}
                  loading={bookmarksLoading}
                  onJump={jumpToBookmark}
                  onRemove={(bookmark) => void handleRemoveBookmark(bookmark)}
                />
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
