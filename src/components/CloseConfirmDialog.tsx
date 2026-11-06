import * as Dialog from '@radix-ui/react-dialog'
import { Minimize2, Power, X } from 'lucide-react'
import { useCallback, useState } from 'react'

import { closePolicySet, hideToTray, quitApp } from '../lib/ipc'
import type { CloseAction } from '../lib/types'

interface CloseConfirmDialogProps {
  /**
   * 由 Rust 的 CloseRequested 拦截事件驱动（App 侧监听后置 true）。
   * 关闭（Esc / 右上角 ×）＝ 取消：Rust 已经 prevent_close，窗口保持原样。
   */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 关闭主窗口时的一次性询问框（P5）。
 *
 * 设计取舍：
 * - 主按钮是「最小化到托盘」（推荐），因为阅读器的常见预期是「关掉窗口但别停」；
 * - 副按钮「退出程序」；
 * - 「不再询问」勾选后把选择写进 Rust 侧偏好（preferences.json），
 *   之后可直接在设置-行为或托盘菜单里修改。
 */
export function CloseConfirmDialog({ open, onOpenChange }: CloseConfirmDialogProps) {
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 每次重新弹出时重置勾选/错误：避免上次取消留下的状态误导本次选择。
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setRemember(false)
        setError('')
        setBusy(false)
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const run = useCallback(
    async (action: Exclude<CloseAction, 'ask'>) => {
      setBusy(true)
      setError('')
      try {
        if (remember) await closePolicySet(action)
        if (action === 'tray') {
          await hideToTray()
        } else {
          await quitApp()
        }
        onOpenChange(false)
      } catch (err) {
        setError(String(err))
        setBusy(false)
      }
    },
    [remember, onOpenChange],
  )

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface1 bg-base p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-[14px] font-semibold text-text">
                关闭墨读？
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-subtext">
                可以最小化到系统托盘继续在后台运行（托盘图标右键可再打开或退出），也可以直接退出程序。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="取消"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-overlay0 transition hover:bg-surface0 hover:text-text"
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-4 space-y-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('tray')}
              className="flex w-full items-center gap-2.5 rounded-lg bg-blue px-3 py-2.5 text-left text-[12.5px] font-medium text-crust transition hover:brightness-110 disabled:opacity-60"
            >
              <Minimize2 size={15} className="shrink-0" />
              最小化到托盘
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('quit')}
              className="flex w-full items-center gap-2.5 rounded-lg border border-surface1 px-3 py-2.5 text-left text-[12.5px] text-text transition hover:border-red hover:text-red disabled:opacity-60"
            >
              <Power size={15} className="shrink-0" />
              退出程序
            </button>
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11.5px] text-subtext">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-3.5 w-3.5 accent-blue"
            />
            不再询问（之后可在「设置 → 行为」或托盘菜单里修改）
          </label>

          {error && <p className="mt-2 text-[11px] text-red">{error}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
