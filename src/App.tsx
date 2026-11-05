import { useCallback, useEffect, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Loader2 } from 'lucide-react'

import { HelpDialog } from './components/HelpDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { WindowResizeHandles } from './components/WindowResizeHandles'
import { ReaderPage } from './features/reader/ReaderPage'
import { ShelfPage } from './features/shelf/ShelfPage'
import { listLibrary, openBook, openFromLibrary } from './lib/ipc'
import type { BookSummary, OpenedBookInfo } from './lib/types'
import {
  UPDATER_AVAILABLE,
  autoCheckEnabled,
  checkForUpdates,
  type AvailableUpdate,
} from './lib/updater'
import { applyChromeTheme } from './renderer/theme'
import { useLibrary } from './store/library'
import { useReaderSettings } from './store/settings'

/**
 * 应用外壳：书架 → 阅读器。
 *
 * 书籍解析句柄由 Rust 持有，reader 关闭即释放；这里只做视图切换与
 * 全局交互（拖拽导入、主题注入、无边框窗口缩放、dev 自检入口）。
 *
 * 窗口是自绘的（decorations: false）：标题栏由各页面自己渲染，
 * 这样「书架」和「阅读器」可以把各自的菜单按钮放进同一条标题栏里。
 */
export default function App() {
  const [reader, setReader] = useState<OpenedBookInfo | null>(null)
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

  const importPaths = useLibrary((state) => state.importPaths)
  const theme = useReaderSettings((state) => state.settings.theme)

  // 主题全局注入：外壳色板写进 CSS 变量，整个界面随之切换。
  useEffect(() => {
    applyChromeTheme(theme)
  }, [theme])

  // auto 主题要跟着系统深浅色实时变化（Windows 设置里切换即刻生效）。
  useEffect(() => {
    if (theme !== 'auto') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyChromeTheme('auto')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [theme])

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

  // 启动时静默检查更新：延迟几秒，避免和书架首屏加载抢带宽。
  // 开发构建没有签名产物与安装上下文，直接跳过。
  useEffect(() => {
    if (!UPDATER_AVAILABLE || !autoCheckEnabled()) return
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

  const handleOpenBook = useCallback(async (book: BookSummary) => {
    setOpenError(null)
    setOpening(true)
    try {
      const info = await openFromLibrary(book.id)
      setReader(info)
      // 打开后刷新书架，让「最近阅读」顺序与进度跟上。
      void useLibrary.getState().load()
    } catch (err) {
      setOpenError(`打开《${book.title}》失败：${String(err)}`)
    } finally {
      setOpening(false)
    }
  }, [])

  // 原生拖拽导入：Tauri 的 DragDropEvent 直接给文件绝对路径，
  // 比 HTML5 拖放可靠（后者要把 dragDropEnabled 关掉，反而失去原生路径）。
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === 'enter' || payload.type === 'over') {
          setDragging(true)
          return
        }
        if (payload.type === 'leave') {
          setDragging(false)
          return
        }
        // drop：只有在书架页才导入，阅读中不打断。
        setDragging(false)
        if (reader) return
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
  }, [importPaths, reader])

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
        const info = match ? await openFromLibrary(match.id) : await openBook(spike)
        if (!cancelled) setReader(info)
      } catch (err) {
        console.error(err)
        if (!cancelled) setOpenError(String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-crust text-text">
      <WindowResizeHandles />

      {reader ? (
        <ReaderPage
          book={reader}
          devSpike={spikeAuto}
          onOpenHelp={() => setHelpOpen(true)}
          fullscreen={fullscreen}
          onToggleFullscreen={() => void toggleFullscreen()}
          onBack={() => {
            setReader(null)
            setSpikeAuto(false)
          }}
        />
      ) : (
        <ShelfPage
          onOpenBook={(book) => void handleOpenBook(book)}
          onOpenHelp={() => setHelpOpen(true)}
          onCheckUpdate={() => setUpdateOpen(true)}
        />
      )}

      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />

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
