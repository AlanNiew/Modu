import { getCurrentWindow } from '@tauri-apps/api/window'
import { ChevronLeft, Copy, Minus, Square, X } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'

import logoUrl from '../assets/logo.svg'
import { cn } from '../lib/cn'

interface TitleBarProps {
  title: string
  subtitle?: string
  /** 传了才显示返回按钮（阅读页 → 书架） */
  onBack?: () => void
  backLabel?: string
  /** 右侧菜单按钮（书签/目录/排版/导入…），窗口控制按钮永远在最右 */
  actions?: ReactNode
  /** 沉浸模式：整条标题栏不渲染（由调用方决定是否挂载） */
  className?: string
}

/**
 * 自绘标题栏。
 *
 * Windows 原生标题栏没法跟主题一体（永远是系统色），所以窗口在
 * tauri.conf.json 里设了 `decorations: false`，标题栏完全由我们画：
 * - `data-tauri-drag-region` 标出可拖动区域（Tauri 内置脚本处理拖动 + 双击最大化）
 * - 窗口按钮放在拖拽区之外，否则点不到
 * - 拖动逻辑不依赖 JS，窗口缩放由 App 里的 WindowResizeHandles 负责
 */
export function TitleBar({
  title,
  subtitle,
  onBack,
  backLabel = '书架',
  actions,
  className,
}: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        'flex h-11 shrink-0 select-none items-center gap-1 border-b border-surface0/60 bg-mantle pl-1.5',
        className,
      )}
    >
      <div
        data-tauri-drag-region
        className="flex h-7 w-7 shrink-0 items-center justify-center"
      >
        {/* 应用图标同时充当品牌标记：墨滴落进摊开的书里 */}
        <img
          src={logoUrl}
          alt="墨读"
          draggable={false}
          className="h-6 w-6 rounded-[7px] shadow-sm shadow-black/30"
        />
      </div>

      {onBack && (
        <button
          type="button"
          onClick={onBack}
          title={`返回${backLabel}（Esc）`}
          className="ml-1 flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11px] text-subtext transition hover:bg-surface0/80 hover:text-text"
        >
          <ChevronLeft size={15} />
          {backLabel}
        </button>
      )}

      <div data-tauri-drag-region className="ml-1 flex min-w-0 flex-1 items-baseline gap-2 px-1">
        <span
          data-tauri-drag-region
          className="max-w-[45%] truncate text-[13px] font-medium leading-7 text-text"
        >
          {title}
        </span>
        {subtitle && (
          <span data-tauri-drag-region className="truncate text-[11px] text-overlay0">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">{actions}</div>

      <div className="mx-1 h-5 w-px shrink-0 bg-surface0/70" />
      <WindowControls />
    </div>
  )
}

/**
 * 标题栏右侧的小按钮：统一 28×28、hover 底色。
 *
 * 必须支持 ref 与透传 props：Radix 的 `Popover.Trigger asChild` 会 clone
 * 这个按钮，把 onPointerDown/aria-expanded/data-state 等塞进来；如果按钮
 * 只接收固定几个 props，这些事件会被丢掉，表现为「点排版按钮没反应」。
 */
export const TitleBarButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    title: string
    active?: boolean
    children: ReactNode
  }
>(function TitleBarButton({ title, active, children, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={title}
      {...rest}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md transition',
        active
          ? 'bg-surface0 text-text'
          : 'text-subtext hover:bg-surface0/80 hover:text-text',
        className,
      )}
    >
      {children}
    </button>
  )
})


function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined

    void appWindow.isMaximized().then((value) => {
      if (!disposed) setMaximized(value)
    })
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then((value) => {
        if (!disposed) setMaximized(value)
      })
    }).then((stop) => {
      if (disposed) stop()
      else unlisten = stop
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const appWindow = getCurrentWindow()

  return (
    <div className="flex h-full shrink-0 items-center">
      <button
        type="button"
        title="最小化"
        aria-label="最小化"
        onClick={() => void appWindow.minimize()}
        className="flex h-11 w-[46px] items-center justify-center text-subtext transition hover:bg-surface0/80 hover:text-text"
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        title={maximized ? '向下还原' : '最大化'}
        aria-label={maximized ? '向下还原' : '最大化'}
        onClick={() => void appWindow.toggleMaximize()}
        className="flex h-11 w-[46px] items-center justify-center text-subtext transition hover:bg-surface0/80 hover:text-text"
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        title="关闭"
        aria-label="关闭"
        onClick={() => void appWindow.close()}
        className="flex h-11 w-[46px] items-center justify-center text-subtext transition hover:bg-[#e81123] hover:text-white"
      >
        <X size={16} />
      </button>
    </div>
  )
}
