import { useLayoutEffect, useEffect, useRef, useState } from 'react'

import { cn } from '../lib/cn'

export interface ContextMenuItem {
  id: string
  label: string
  /** 右侧快捷键提示（纯展示）。 */
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

interface ContextMenuProps {
  /** 视口坐标（clientX/clientY）。 */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

const FALLBACK_WIDTH = 184
const EDGE = 8

/**
 * 应用内的右键菜单。
 *
 * 为什么需要它：WebView2 默认右键菜单是浏览器的（返回/刷新/另存为/打印），
 * 在阅读器里既没用又突兀。App 里统一 `preventDefault` 掉原生菜单，
 * 用这个组件按上下文给真正的操作。
 *
 * 交互细节：点空白 / Esc / 滚动 / 窗口尺寸变化都关闭；贴边时自动翻到内侧，
 * 不会跑出视口；挂载后先量真实尺寸再定位（首帧不可见，避免闪一下）。
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const width = el.offsetWidth || FALLBACK_WIDTH
    const height = el.offsetHeight
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    })
  }, [x, y])

  useEffect(() => {
    // 捕获阶段拦：点在菜单外就关，不等冒泡到业务代码。
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  const select = (item: ContextMenuItem) => {
    if (item.disabled) return
    onClose()
    // 先关菜单再执行，避免动作里弹的对话框被菜单的 mousedown 吃掉。
    window.setTimeout(() => item.onSelect(), 0)
  }

  return (
    <div
      ref={ref}
      role="menu"
      data-context-menu="1"
      className={cn(
        'fixed z-[2147483000] min-w-[184px] overflow-hidden rounded-lg border border-surface1 bg-mantle py-1 shadow-2xl shadow-black/40',
        !pos && 'invisible',
      )}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => select(item)}
          className={cn(
            'flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[12px] transition',
            item.disabled
              ? 'cursor-default text-overlay0/60'
              : item.danger
                ? 'text-subtext hover:bg-surface0 hover:text-red'
                : 'text-subtext hover:bg-surface0 hover:text-text',
          )}
        >
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="shrink-0 font-mono text-[10.5px] text-overlay0/70">
              {item.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
