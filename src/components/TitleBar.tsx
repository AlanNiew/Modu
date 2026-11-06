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
import { MenuBar, type MenuSectionSpec } from './MenuBar'

interface TitleBarProps {
  title: string
  subtitle?: string
  /** 全局固定菜单栏（文件/阅读/视图/帮助），与具体页面无关。 */
  menuSections: MenuSectionSpec[]
  /** 页面级快捷按钮：只有少量高频动作（侧栏开关/排版快速面板）。 */
  actions?: ReactNode
  /** 传了才显示返回按钮（阅读页 → 书架 / 设置页 → 上一视图）。 */
  backLabel?: string
  onBack?: () => void
  className?: string
}

/**
 * 自绘标题栏（全局唯一实例，由 App 渲染）。
 *
 * Windows 原生标题栏没法跟主题一体（永远是系统色），窗口在
 * tauri.conf.json 里设 `decorations: false`，标题栏完全自绘：
 * - `data-tauri-drag-region` 标出可拖动区域（Tauri 内置脚本处理拖动 + 双击最大化），
 *   注意 只有带该属性的元素才会触发拖动，菜单/按钮不受影响
 * - 窗口按钮放在拖拽区之外，点得到
 * - 窗口缩放由 WindowResizeHandles 负责
 *
 * 布局（书架 / 阅读器 / 设置保持一致）：
 *   ┌ 左：品牌图标 + 固定菜单栏
 *   ├ 中：标题 + 副标题（绝对居中，不参与左右两组的宽度竞争）
 *   └ 右：返回 + 页面快捷按钮 → 分隔线 → 窗口按键
 *
 * 为什么标题要绝对居中而不是夹在中间靠 flex：菜单位置固定、动作按钮数量
 * 又随页面变化（书架 1 个、阅读页 3 个），用 flex 会让标题被推着左右跑。
 * 居中后各组互不影响：菜单位置不动，标题永远在窗口正中，动作区从右往左排。
 *
 * 标题层是 `pointer-events-none`：既不抢按钮点击，又能让整条标题栏继续作为
 * `data-tauri-drag-region` 拖动（事件落到父层）。
 *
 * 菜单放在最左侧（Logo 右边）是 Windows 桌面应用的习惯位置。
 *
 * 「菜单栏固定」的含义：书架与阅读页之间切换时，菜单栏不变；
 * 沉浸/全屏是显式隐藏整个界面（含标题栏）的模式，不在该保证范围内。
 */
export function TitleBar({
  title,
  subtitle,
  menuSections,
  actions,
  backLabel = '返回',
  onBack,
  className,
}: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        'relative flex h-11 shrink-0 select-none items-center gap-1 border-b border-surface0/60 bg-mantle pl-1.5',
        className,
      )}
    >
      {/* 左：品牌 + 菜单（位置固定，不随标题/动作变化） */}
      <div className="flex min-w-0 shrink-0 items-center gap-1">
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
        <MenuBar sections={menuSections} />
      </div>

      {/* 中：标题绝对居中，左右两组宽度变化不会推动它。
          宽度上限同时受窗口占比与「两侧预留」约束，窗口缩到 900px 最小宽时
          也不会压到菜单或返回/动作按钮 */}
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute left-1/2 flex h-full max-w-[min(42%,calc(100%-40rem))] -translate-x-1/2 items-center gap-2 overflow-hidden"
      >
        <span
          data-tauri-drag-region
          className="truncate text-[13px] font-medium leading-none text-text"
        >
          {title}
        </span>
        {subtitle && (
          <span
            data-tauri-drag-region
            className="hidden shrink-0 truncate text-[11px] leading-none text-overlay0 sm:inline"
          >
            {subtitle}
          </span>
        )}
      </div>

      {/* 右：返回 → 页面快捷按钮 → 窗口按键，从右往左排 */}
      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-0.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={`返回${backLabel}`}
            className="flex h-7 max-w-[9rem] shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11px] text-subtext transition hover:bg-surface0/80 hover:text-text"
          >
            <ChevronLeft size={15} className="shrink-0" />
            <span className="truncate">{backLabel}</span>
          </button>
        )}
        {actions}
      </div>

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
      aria-pressed={active}
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
