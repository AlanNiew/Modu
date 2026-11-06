import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Loader2, PanelLeft, Settings2 } from 'lucide-react'

import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { HelpDialog } from './components/HelpDialog'
import { TitleBar, TitleBarButton } from './components/TitleBar'
import { UpdateDialog } from './components/UpdateDialog'
import { WindowResizeHandles } from './components/WindowResizeHandles'
import { ReadingSettingsPanel } from './features/reader/ReadingSettingsPanel'
import { ReaderPage } from './features/reader/ReaderPage'
import { SettingsPage, type SettingsTabId } from './features/settings/SettingsPage'
import { ShelfPage } from './features/shelf/ShelfPage'
import { CMD, registerCommand, runCommand, unregisterAll } from './lib/commands'
import {
  closeBook,
  listLibrary,
  openBook,
  openFromLibrary,
  revealDataDir,
} from './lib/ipc'
import { buildMenuSections } from './lib/menuSpec'
import { isOverlayOpen } from './lib/overlay'
import type { BookSummary, OpenedBookInfo } from './lib/types'
import {
  UPDATER_AVAILABLE,
  checkForUpdates,
  type AvailableUpdate,
} from './lib/updater'
import {
  applyChromeTheme,
  THEME_OPTIONS,
} from './renderer/theme'
import { DEFAULT_CHROME_SUBTITLE, DEFAULT_CHROME_TITLE, useChromeStore } from './store/chrome'
import { useLibrary } from './store/library'
import { useReaderSettings } from './store/settings'

type View = 'shelf' | 'reader' | 'settings'

/** 任务书 §1.3/§4.3 的口径：正文字号 14–32px（P1 审查后统一）。 */
const FONT_SIZE_MIN = 14
const FONT_SIZE_MAX = 32

/**
 * 打开/重开书时当前「繁转简」开关的即时值。
 *
 * 不在组件里用 hook 包裹：Rust 侧按「打开时刻」定格转换（正文/目录/搜索
 * 都带上该标志），所以这里只需要调用时的最新值，不需要触发重渲染。
 */
function currentConvertTraditional(): boolean {
  return useReaderSettings.getState().settings.simplifyTraditional
}

/**
 * 应用外壳（P1 起改为「标题栏由本组件统一渲染一次」的模型）：
 *
 * - 标题栏全局固定：菜单栏（文件/阅读/视图/帮助）不随书架↔阅读切换；
 *   沉浸模式是显式隐藏整个界面（含标题栏）的特例。
 * - 页面（书架/阅读/设置）只填内容区；书名、章节副标题通过 chrome store
 *   由 Reader 页写入。
 * - 菜单能力分两层：当前页面直接可做的（导入/设置/退出）在本组件注册；
 *   阅读页专属的（加书签/目录/搜索/侧栏/沉浸等）由 ReaderPage 挂载时注册
 *   （见 lib/commands.ts 的命令总线）。
 */
export default function App() {
  const [reader, setReader] = useState<OpenedBookInfo | null>(null)
  // 重新加载本书 / 重开同类书时递增，强制 ReaderPage 重挂载（重置内部状态）。
  const [readerEpoch, setReaderEpoch] = useState(0)
  const [view, setView] = useState<View>('shelf')
  const viewRef = useRef<View>('shelf')
  viewRef.current = view
  /** 设置页返回时回去的视图（从阅读页进设置 → 回阅读页；否则回书架）。 */
  const settingsReturnRef = useRef<View>('shelf')
  /** 从「关于墨读」等入口进设置时要直接落在哪个分组；null = 默认。 */
  const settingsTabRef = useRef<SettingsTabId | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [dragging, setDragging] = useState(false)
  // dev spike 打开的书会跑一遍阅读器自检（见 ReaderPage 注释）。
  const [spikeAuto, setSpikeAuto] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  // 软件更新：启动静默检查到的结果先存着，打开面板时直接展示，避免重复请求。
  const [updateOpen, setUpdateOpen] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null)
  // 关闭询问（P5）：Rust 拦截 CloseRequested 后发事件，这里弹一次性对话框。
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)

  const importPaths = useLibrary((state) => state.importPaths)
  const chromeTitle = useChromeStore((state) => state.title)
  const chromeSubtitle = useChromeStore((state) => state.subtitle)
  const immersive = useChromeStore((state) => state.immersive)
  const readingSettings = useReaderSettings((state) => state.settings)

  const inReader = view === 'reader'
  const inShelf = view === 'shelf'
  const showChrome = !inReader || !immersive
  const title = view === 'settings' ? '设置' : chromeTitle
  const subtitle = view === 'settings' ? null : chromeSubtitle

  // reader 的最新引用，供 reload 等命令读取（避免闭包里持 stale state）。
  const readerRef = useRef<OpenedBookInfo | null>(null)
  readerRef.current = reader

  // -------------------------------------------------------------------------
  // 主题
  // -------------------------------------------------------------------------

  // 主题全局注入：外壳色板写进 CSS 变量，整个界面随之切换。
  useEffect(() => {
    applyChromeTheme(readingSettings.theme)
  }, [readingSettings.theme])

  // auto 主题要跟着系统深浅色实时变化（Windows 设置里切换即刻生效）。
  useEffect(() => {
    if (readingSettings.theme !== 'auto') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyChromeTheme('auto')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [readingSettings.theme])

  // -------------------------------------------------------------------------
  // 视图切换
  // -------------------------------------------------------------------------

  // 书架/设置的标题默认值：阅读页的标题由 ReaderPage 自己写 chrome store，
  // 这里只在进入书架时复位（防止上一本书的标题残留），设置页在渲染层覆盖。
  useEffect(() => {
    if (view === 'shelf') {
      useChromeStore.getState().reset(DEFAULT_CHROME_TITLE, DEFAULT_CHROME_SUBTITLE)
    }
  }, [view])

  /** 打开设置页；已在设置页时不动返回目标（否则会丢“返回阅读”）。 */
  const openSettings = useCallback((tab: SettingsTabId | null = null) => {
    if (viewRef.current === 'settings') return
    settingsReturnRef.current = viewRef.current === 'reader' ? 'reader' : 'shelf'
    settingsTabRef.current = tab
    setView('settings')
  }, [])

  const closeSettings = useCallback(() => {
    setView(settingsReturnRef.current)
  }, [])

  // 桌面集成（P5）：Rust 侧拦截关闭请求 / 托盘菜单动作 → 驱动前端弹窗与路由。
  useEffect(() => {
    const unlisteners: Array<() => void> = []
    let disposed = false
    void (async () => {
      const close = await listen('modu://close-requested', () => {
        setCloseConfirmOpen(true)
      })
      const trayAction = await listen<string>('modu://tray-action', (event) => {
        const action = event.payload
        if (action === 'settings') {
          openSettings(null)
        } else if (action === 'check-update') {
          setUpdateOpen(true)
        }
        // 'autostart-changed'：状态由 Rust/设置页各自刷新，前端无需额外动作。
      })
      if (disposed) {
        close()
        trayAction()
        return
      }
      unlisteners.push(close, trayAction)
    })()
    return () => {
      disposed = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [openSettings])

  const toggleFullscreen = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow()
      const next = !(await appWindow.isFullscreen())
      await appWindow.setFullscreen(next)
      setFullscreen(next)
    } catch (err) {
      console.error('[app] 切换全屏失败', err)
    }
  }, [])

  // 全局快捷键：F11 全屏、F1 帮助。输入框里也允许，避免「按了没反应」。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault()
        void toggleFullscreen()
        return
      }
      if (event.key === 'F1') {
        event.preventDefault()
        setHelpOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleFullscreen])

  // 从系统全屏按钮（或 F11）退出时同步状态
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      unlisten = await getCurrentWindow().onResized(async () => {
        try {
          const value = await getCurrentWindow().isFullscreen()
          if (!disposed) setFullscreen(value)
        } catch {
          // 窗口已销毁时忽略
        }
      })
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // 设置页 Esc：先退全屏，再退回上一视图（弹层打开时交给弹层自己）。
  const fullscreenRef = useRef(fullscreen)
  fullscreenRef.current = fullscreen

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (viewRef.current !== 'settings') return
      // 菜单/对话框打开时不接管，交给 Radix 关闭它。
      if (isOverlayOpen()) return
      event.preventDefault()
      if (fullscreenRef.current) {
        void toggleFullscreen()
        return
      }
      closeSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSettings, toggleFullscreen])

  // -------------------------------------------------------------------------
  // 打开 / 关闭 / 重新加载一本书
  // -------------------------------------------------------------------------

  const handleOpenBook = useCallback(async (book: BookSummary) => {
    setOpenError(null)
    setOpening(true)
    try {
      const info = await openFromLibrary(book.id, currentConvertTraditional())
      setReader(info)
      setReaderEpoch((epoch) => epoch + 1)
      setView('reader')
      // 打开后刷新书架，让「最近阅读」顺序与进度跟上。
      void useLibrary.getState().load()
    } catch (err) {
      setOpenError(`打开《${book.title}》失败：${String(err)}`)
    } finally {
      setOpening(false)
    }
  }, [])

  /** ReaderPage 的返回回调：书已在页内关好，这里只负责回到书架。 */
  const handleReaderClosed = useCallback(() => {
    setReader(null)
    setSpikeAuto(false)
    setView('shelf')
  }, [])

  /** 重新加载本书：释放句柄 → 重新解析 → 换个 key 重挂载。 */
  const reloadReader = useCallback(async () => {
    const current = readerRef.current
    if (!current) return
    if (current.libraryId == null) {
      setOpenError('通过命令行打开的书暂不支持重新加载，请从书架打开。')
      return
    }
    try {
      await closeBook(current.id)
      const info = await openFromLibrary(current.libraryId, currentConvertTraditional())
      setReader(info)
      setReaderEpoch((epoch) => epoch + 1)
    } catch (err) {
      setOpenError(`重新加载失败：${String(err)}`)
    }
  }, [])
  const reloadReaderRef = useRef(reloadReader)
  reloadReaderRef.current = reloadReader

  /** 文件菜单：在资源管理器中打开数据目录。 */
  const openDataDir = useCallback(async () => {
    try {
      await revealDataDir()
    } catch (err) {
      setOpenError(`打开数据目录失败：${String(err)}`)
    }
  }, [])

  // -------------------------------------------------------------------------
  // 全局命令（菜单里「各页面都能用」的部分；阅读页专属命令在 ReaderPage 注册）
  // -------------------------------------------------------------------------

  // 字号步进（视图菜单；任务书口径 14–32px）。
  const bumpFontSize = useCallback((delta: number) => {
    const { settings, patch: patchSettings } = useReaderSettings.getState()
    const next = Math.min(
      FONT_SIZE_MAX,
      Math.max(FONT_SIZE_MIN, Math.round((settings.fontSize + delta) * 2) / 2),
    )
    if (next !== settings.fontSize) patchSettings({ fontSize: next })
  }, [])

  useEffect(() => {
    return unregisterAll(
      registerCommand(CMD.appImportBooks, () => {
        void useLibrary.getState().importFromDialog()
      }),
      // 主题单选：每一个主题一个命令 id（含 auto）。
      ...THEME_OPTIONS.map((option) =>
        registerCommand(CMD.theme(option.id), () => {
          useReaderSettings.getState().setTheme(option.id)
        }),
      ),
      registerCommand(CMD.viewFontSizeUp, () => bumpFontSize(1)),
      registerCommand(CMD.viewFontSizeDown, () => bumpFontSize(-1)),
      registerCommand(CMD.appSettings, () => openSettings()),
      registerCommand(CMD.appAbout, () => openSettings('about')),
      registerCommand(CMD.appHelp, () => setHelpOpen((open) => !open)),
      registerCommand(CMD.appCheckUpdate, () => setUpdateOpen(true)),
      registerCommand(CMD.appDataDir, () => void openDataDir()),
      registerCommand(CMD.appQuit, () => void getCurrentWindow().close()),
      registerCommand(CMD.viewFullscreen, () => void toggleFullscreen()),
      registerCommand(CMD.readerReload, () => void reloadReaderRef.current()),
    )
  })

  // -------------------------------------------------------------------------
  // 全局固定菜单栏
  // -------------------------------------------------------------------------

  const menuSections = useMemo(
    () =>
      buildMenuSections({
        inShelf,
        inReader,
        fullscreen,
        theme: readingSettings.theme,
      }),
    [fullscreen, inReader, inShelf, readingSettings.theme],
  )

  /** 阅读页标题栏保留的两个高频动作：排版快速面板 + 侧栏开关（无选中态）。 */
  const readerActions: ReactNode | undefined = inReader ? (
    <>
      <ReadingSettingsPanel>
        <TitleBarButton title="阅读排版（常用）">
          <Settings2 size={15} />
        </TitleBarButton>
      </ReadingSettingsPanel>
      <TitleBarButton
        title="侧栏（Ctrl+B，点一下切换）"
        onClick={() => runCommand(CMD.readerSidebar)}
      >
        <PanelLeft size={15} />
      </TitleBarButton>
    </>
  ) : undefined

  // -------------------------------------------------------------------------
  // 启动静默检查更新（保留原有行为）
  // -------------------------------------------------------------------------

  useEffect(() => {
    // autoCheck 自 P2 起并入设置 store（设置-行为分组，含旧 localStorage 键迁移）。
    if (!UPDATER_AVAILABLE || !useReaderSettings.getState().autoCheck) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const found = await checkForUpdates()
          if (!cancelled && found) {
            setAvailableUpdate(found)
            setUpdateOpen(true)
          }
        } catch (err) {
          // 更新检查失败不打扰用户：网络问题很常见，等用户手动点「检查更新」再报。
          console.warn('[updater] 启动检查失败', err)
        }
      })()
    }, 2500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  // -------------------------------------------------------------------------
  // 原生拖拽导入（只有书架视图接收，避免打断阅读）
  // -------------------------------------------------------------------------

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') {
          if (viewRef.current === 'shelf') setDragging(true)
          return
        }
        if (payload.type === 'leave') {
          setDragging(false)
          return
        }
        setDragging(false)
        if (viewRef.current !== 'shelf') return
        if (payload.paths.length > 0) {
          void importPaths(payload.paths)
        }
      })
      if (disposed) stop()
      else unlisten = stop
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [importPaths])

  // 开发期链路自检：VITE_SPIKE_IMPORT=<epub 绝对路径> 时自动导入到书架，
  // 跳过系统文件对话框（CDP 派发不了点击），用来验证书架/封面/元数据渲染。
  useEffect(() => {
    const spikeImport = import.meta.env.VITE_SPIKE_IMPORT as string | undefined
    if (!import.meta.env.DEV || !spikeImport) return
    void useLibrary.getState().importPaths([spikeImport])
  }, [])

  // 开发期链路自检：设置 VITE_SPIKE_BOOK=<epub 绝对路径> 时自动打开，
  // 跳过系统文件对话框，方便用 CDP 截图/检查渲染结果。生产构建不生效。
  useEffect(() => {
    const spike = import.meta.env.VITE_SPIKE_BOOK as string | undefined
    if (!import.meta.env.DEV || !spike) return
    let cancelled = false
    void (async () => {
      try {
        // 先确保书在书库里，再从书架打开：这样能覆盖 M2 的进度/书签链路
        // （book_open 直接打开的书没有 libraryId，不会持久化）。
        await useLibrary.getState().importPaths([spike])
        const books = await listLibrary()
        const match = books.find((item) => item.path.endsWith('.epub')) ?? books[0]
        // 标记本次是 spike 打开：ReaderPage 会据此跑一遍 dev 自检。
        setSpikeAuto(true)
        const info = match
          ? await openFromLibrary(match.id, currentConvertTraditional())
          : await openBook(spike, currentConvertTraditional())
        if (!cancelled) {
          setReader(info)
          setReaderEpoch((epoch) => epoch + 1)
          setView('reader')
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) setOpenError(String(err))
      }
    })()
    return () => {
      cancelled = true
    }
    // 仅 dev spike 自检路径：一次性运行（繁简开关从 store 现读）
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-crust text-text">
      <WindowResizeHandles />

      {showChrome && (
        <TitleBar
          title={title}
          subtitle={subtitle ?? undefined}
          menuSections={menuSections}
          actions={readerActions}
          backLabel={inReader ? '书架' : '返回'}
          onBack={
            inReader
              ? () => runCommand(CMD.readerBack)
              : view === 'settings'
                ? closeSettings
                : undefined
          }
        />
      )}

      {/* 阅读页在「设置 → 返回阅读」往返之间保持挂载（隐藏而非卸载）：
          书籍句柄和阅读器内部状态都保住，回到阅读时进度与滚动位置原样恢复。 */}
      {reader && (
        <div className={view === 'reader' ? 'contents' : 'hidden'}>
          <ReaderPage
            key={readerEpoch}
            book={reader}
            devSpike={spikeAuto}
            suspended={view !== 'reader'}
            fullscreen={fullscreen}
            onToggleFullscreen={() => void toggleFullscreen()}
            onBack={handleReaderClosed}
          />
        </div>
      )}

      {!reader && inShelf && (
        <ShelfPage
          onOpenBook={(book) => void handleOpenBook(book)}
        />
      )}

      {view === 'settings' && (
        <SettingsPage
          initialTab={settingsTabRef.current}
          onCheckUpdate={() => setUpdateOpen(true)}
        />
      )}

      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />

      <CloseConfirmDialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen} />

      <UpdateDialog
        open={updateOpen}
        onOpenChange={(open) => {
          setUpdateOpen(open)
          // 关闭后丢弃启动检查留下的一次性结果，避免下次打开显示旧信息。
          if (!open) setAvailableUpdate(null)
        }}
        initialUpdate={availableUpdate}
      />

      {(openError || opening) && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-surface1 bg-mantle px-4 py-2 text-xs text-subtext shadow-xl">
          {opening ? (
            <span className="flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" />
              正在解析书籍…
            </span>
          ) : (
            <span className="flex items-center gap-3 text-red">
              {openError}
              <button
                type="button"
                onClick={() => setOpenError(null)}
                className="pointer-events-auto underline"
              >
                关闭
              </button>
            </span>
          )}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-crust/85 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-blue/70 px-12 py-10 text-center">
            <p className="text-base font-medium text-text">松手导入到书架</p>
            <p className="mt-1 text-xs text-overlay0">只接受 .epub 文件，支持多选</p>
          </div>
        </div>
      )}
    </div>
  )
}
