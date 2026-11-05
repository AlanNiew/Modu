import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

/**
 * 自动更新的前端包装。
 *
 * 更新链路由 Rust 侧的 tauri-plugin-updater 完成：HTTP 拉 latest.json →
 * 比对版本 → 下载 NSIS 安装包 → 用编译进二进制的公钥验签 →
 * 静默安装（tauri.conf.json 里 installMode: "quiet"）→ 由 process 插件重启。
 *
 * 前端只负责呈现进度与触发时机，不做任何信任判断：
 * 验签失败时插件直接抛错，安装包不会被执行。
 */

/** 一次可用的更新。`update` 句柄要保留给下载阶段使用。 */
export interface AvailableUpdate {
  version: string
  currentVersion: string
  notes: string
  date: string
  update: Update
}

export interface DownloadProgress {
  downloaded: number
  total: number | null
}

/** 开发模式下插件不可用（没有签名产物、也没有安装上下文）。 */
export const UPDATER_AVAILABLE = !import.meta.env.DEV

/** 检查是否有新版本；无更新返回 null。 */
export async function checkForUpdates(): Promise<AvailableUpdate | null> {
  const update = await check()
  if (!update) return null
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: (update.body ?? '').trim(),
    date: update.date ?? '',
    update,
  }
}

/**
 * 下载并安装更新。安装会在下载完成后自动开始，
 * 成功返回后调用方应提示用户重启（安装完的 exe 已在磁盘上）。
 */
export async function downloadAndInstall(
  update: AvailableUpdate,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  let total: number | null = null
  let downloaded = 0

  await update.update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null
        downloaded = 0
        onProgress({ downloaded, total })
        break
      case 'Progress':
        downloaded += event.data.chunkLength
        onProgress({ downloaded, total })
        break
      case 'Finished':
        onProgress({ downloaded: total ?? downloaded, total })
        break
      default:
        break
    }
  })
}

/** 安装完成后重启到新版本。 */
export async function restartApp(): Promise<void> {
  await relaunch()
}

const AUTO_CHECK_KEY = 'modu:update:auto-check'

/** 启动时是否静默检查更新（默认开启）。 */
export function autoCheckEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(AUTO_CHECK_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

export function setAutoCheckEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTO_CHECK_KEY, enabled ? '1' : '0')
  } catch {
    // 隐私模式等场景下 localStorage 不可用：忽略，保持默认行为。
  }
}

/** 发布页地址：更新失败时给用户的手动下载出口。 */
export const RELEASES_URL = 'https://github.com/AlanNiew/Modu/releases/latest'
