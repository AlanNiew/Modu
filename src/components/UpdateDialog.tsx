import * as Dialog from '@radix-ui/react-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { CheckCircle2, Download, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  RELEASES_URL,
  UPDATER_AVAILABLE,
  checkForUpdates,
  describeUpdateError,
  downloadAndInstall,
  restartApp,
  type AvailableUpdate,
  type UpdateErrorInfo,
} from '../lib/updater'

interface UpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 启动时自动检查发现的更新：打开即直接进入「可更新」状态，不重复请求。 */
  initialUpdate?: AvailableUpdate | null
}

type Stage = 'checking' | 'latest' | 'available' | 'downloading' | 'installing' | 'done' | 'error'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateDialog({ open, onOpenChange, initialUpdate }: UpdateDialogProps) {
  const [stage, setStage] = useState<Stage>('checking')
  const [update, setUpdate] = useState<AvailableUpdate | null>(null)
  const [currentVersion, setCurrentVersion] = useState('')
  const [progress, setProgress] = useState({ downloaded: 0, total: null as number | null })
  // 结构化错误：主因 + 可执行建议（原始报错另存，便于反馈时复制）。
  const [failure, setFailure] = useState<{ info: UpdateErrorInfo; raw: string } | null>(null)
  const runIdRef = useRef(0)

  const runCheck = useCallback(async () => {
    const runId = ++runIdRef.current
    setStage('checking')
    setFailure(null)
    setUpdate(null)
    try {
      const found = await checkForUpdates()
      if (runId !== runIdRef.current) return
      setCurrentVersion(found?.currentVersion ?? (await getVersion()))
      if (found) {
        setUpdate(found)
        setStage('available')
      } else {
        setStage('latest')
      }
    } catch (err) {
      if (runId !== runIdRef.current) return
      const version = await getVersion().catch(() => '')
      setCurrentVersion(version)
      setFailure({ info: describeUpdateError(err), raw: String(err) })
      setStage('error')
    }
  }, [])

  // 打开时：有启动检查预先拿到的更新就直接展示，否则现场检查一次。
  // 「启动时自动检查更新」开关自 P2 起在 设置 → 行为 分组。
  useEffect(() => {
    if (!open) return
    if (!UPDATER_AVAILABLE) {
      setStage('error')
      setFailure({
        info: {
          summary: '开发模式不检查更新（更新只在安装版中生效）。',
          hint: '请用安装版验证更新链路。',
          retryable: false,
        },
        raw: 'UPDATER_AVAILABLE=false（DEV）',
      })
      return
    }
    if (initialUpdate) {
      setUpdate(initialUpdate)
      setCurrentVersion(initialUpdate.currentVersion)
      setStage('available')
      return
    }
    void runCheck()
  }, [open, initialUpdate, runCheck])

  const handleInstall = useCallback(async () => {
    if (!update) return
    setStage('downloading')
    setProgress({ downloaded: 0, total: null })
    setFailure(null)
    try {
      await downloadAndInstall(update, (next) => setProgress(next))
      setStage('done')
    } catch (err) {
      setFailure({ info: describeUpdateError(err), raw: String(err) })
      setStage('error')
    }
  }, [update])

  const percent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-crust/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-surface0 bg-mantle p-5 shadow-2xl shadow-black/50 outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-text">软件更新</Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] text-overlay0">
                {currentVersion ? `当前版本 v${currentVersion}` : '正在读取版本信息…'}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭更新面板"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-subtext transition hover:bg-surface0 hover:text-text"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-4">
            {stage === 'checking' && (
              <p className="flex items-center gap-2 text-[12px] text-subtext">
                <RefreshCw size={14} className="animate-spin" />
                正在检查更新…
              </p>
            )}

            {stage === 'latest' && (
              <div className="flex items-start gap-2 rounded-lg bg-surface0/30 px-3 py-2.5 text-[12px] text-subtext">
                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green" />
                已是最新版本，没有可用更新。
              </div>
            )}

            {stage === 'available' && update && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-lg bg-blue/10 px-3 py-2.5">
                  <Download size={15} className="shrink-0 text-blue" />
                  <span className="text-[12px] text-text">
                    发现新版本 <span className="font-semibold">v{update.version}</span>
                    {update.date ? (
                      <span className="text-overlay0"> · {update.date.slice(0, 10)}</span>
                    ) : null}
                  </span>
                </div>
                {update.notes ? (
                  <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-surface0/70 bg-crust/40 px-3 py-2 text-[11.5px] leading-relaxed text-subtext">
                    {update.notes}
                  </div>
                ) : null}
                <p className="text-[11px] leading-relaxed text-overlay0">
                  更新包会先校验签名再静默安装，完成后自动重启，不弹安装向导。
                </p>
              </div>
            )}

            {stage === 'downloading' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[12px] text-subtext">
                  <span>正在下载更新…</span>
                  <span className="font-mono text-[11px] text-overlay0">
                    {percent != null
                      ? `${percent}%`
                      : `${formatBytes(progress.downloaded)}${
                          progress.total ? ` / ${formatBytes(progress.total)}` : ''
                        }`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface0">
                  <div
                    className="h-full rounded-full bg-blue transition-[width]"
                    style={{ width: `${percent ?? 30}%` }}
                  />
                </div>
                <p className="text-[11px] text-overlay0">下载完成后会自动安装并重启。</p>
              </div>
            )}

            {stage === 'installing' && (
              <p className="flex items-center gap-2 text-[12px] text-subtext">
                <RefreshCw size={14} className="animate-spin" />
                正在安装更新，应用即将重启…
              </p>
            )}

            {stage === 'done' && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-lg bg-green/10 px-3 py-2.5 text-[12px] text-text">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green" />
                  <span>
                    更新已安装。重启后生效
                    {update?.version ? `（v${update.version}）` : ''}。
                  </span>
                </div>
                <p className="text-[11px] text-overlay0">书架、进度、书签与批注都会保留。</p>
              </div>
            )}

            {stage === 'error' && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 rounded-lg bg-red/10 px-3 py-2.5 text-[12px] text-text">
                  <TriangleAlert size={15} className="mt-0.5 shrink-0 text-red" />
                  <span>{failure?.info.summary ?? '检查或安装更新失败。'}</span>
                </div>
                <p className="text-[11px] leading-relaxed text-subtext">
                  {failure?.info.hint ??
                    '可以稍后重试；如果一直失败，请到发布页手动下载安装包覆盖安装（数据不会丢失）。'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openUrl(RELEASES_URL)}
                    className="rounded-md border border-surface1 px-2.5 py-1 text-[11px] text-subtext transition hover:bg-surface0 hover:text-text"
                  >
                    打开发布页手动下载
                  </button>
                </div>
                {failure?.raw && (
                  <details className="text-[10.5px] text-overlay0">
                    <summary className="cursor-pointer select-none">错误详情（反馈时请复制）</summary>
                    <p className="mt-1 break-all rounded border border-surface0/70 bg-crust/40 px-2 py-1.5 font-mono">
                      {failure.raw}
                    </p>
                  </details>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            {(stage === 'error' || stage === 'latest') && (
              <button
                type="button"
                onClick={() => void runCheck()}
                className="rounded-md border border-surface1 px-2.5 py-1 text-[11px] text-subtext transition hover:bg-surface0 hover:text-text"
              >
                重新检查
              </button>
            )}
            {stage === 'available' && (
              <button
                type="button"
                onClick={() => void handleInstall()}
                className="rounded-md bg-blue px-3 py-1.5 text-[12px] font-medium text-crust transition hover:brightness-110"
              >
                立即更新
              </button>
            )}
            {stage === 'done' && (
              <button
                type="button"
                onClick={() => void restartApp()}
                className="rounded-md bg-blue px-3 py-1.5 text-[12px] font-medium text-crust transition hover:brightness-110"
              >
                重启应用
              </button>
            )}
            {stage === 'error' && (
              <button
                type="button"
                onClick={() => void openUrl(RELEASES_URL)}
                className="rounded-md bg-surface0 px-2.5 py-1 text-[11px] text-text transition hover:bg-surface1"
              >
                手动下载
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
