import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useState } from 'react'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（删除/移出）用红色确认按钮。 */
  danger?: boolean
  /** 点确认后执行；抛错会把错误显示在框内且不关闭。 */
  onConfirm: () => void | Promise<void>
}

/**
 * 应用内确认框。
 *
 * 为什么不用 `window.confirm`：Tauri 的 WebView 把 `confirm()` 换成了
 * 异步 polyfill（返回 Promise），`if (confirm(...))` 永远为真——结果是
 * 「先执行了动作、后弹出对话框」，确认按钮变得毫无意义（v0.4 反馈的实际 bug）。
 * 这里用 Radix 对话框 + await，保证「确认之后才执行」。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (busy) return
      if (!next) setError(null)
      onOpenChange(next)
    },
    [busy, onOpenChange],
  )

  const handleConfirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }, [onConfirm, onOpenChange])

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,24rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface1 bg-base p-4 shadow-2xl">
          <Dialog.Title className="text-[13.5px] font-semibold text-text">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-1.5 text-[12px] leading-relaxed text-subtext">
              {description}
            </Dialog.Description>
          )}
          {error && <p className="mt-2 text-[11px] text-red">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className="rounded-md border border-surface1 px-3 py-1.5 text-[12px] text-subtext transition hover:bg-surface0 hover:text-text disabled:opacity-60"
              >
                {cancelLabel}
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleConfirm()}
              className={
                danger
                  ? 'rounded-md bg-red px-3 py-1.5 text-[12px] font-medium text-crust transition hover:brightness-110 disabled:opacity-60'
                  : 'rounded-md bg-blue px-3 py-1.5 text-[12px] font-medium text-crust transition hover:brightness-110 disabled:opacity-60'
              }
            >
              {busy ? '处理中…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
