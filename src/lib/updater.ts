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

/** 发布页地址：更新失败时给用户的手动下载出口。 */
export const RELEASES_URL = 'https://github.com/AlanNiew/Modu/releases/latest'

/**
 * 更新失败时给用户看的说明。
 *
 * 背景：tauri-plugin-updater 把失败原因原样抛上来（常见的是
 * `Could not fetch a valid release JSON from the remote`），对用户没有任何
 * 可执行信息。这里按最常见的几类失败给出「发生了什么 + 怎么处理」，
 * 匹配不到时退回原文（不隐藏真实错误，便于反馈问题）。
 */
export interface UpdateErrorInfo {
  /** 一句话主因（给普通用户）。 */
  summary: string
  /** 怎么办（可执行建议）。 */
  hint: string
  /** 是否值得原样重试（网络类 true，清单/签名类 false）。 */
  retryable: boolean
}

export function describeUpdateError(error: unknown): UpdateErrorInfo {
  const raw = error instanceof Error ? error.message : String(error)
  const text = raw.toLowerCase()

  // 1) 发布侧缺少/损坏 latest.json——v0.3.2 的真实故障。
  if (
    text.includes('valid release json') ||
    text.includes('latest.json') ||
    (text.includes('404') && text.includes('releases'))
  ) {
    return {
      summary: '发布页缺少更新清单（latest.json），暂时无法检查更新。',
      hint: '这是发布配置问题，不是你机器的问题。可到发布页手动下载最新安装包覆盖安装。',
      retryable: false,
    }
  }

  // 2) 网络不可达（公司代理、DNS、离线）。
  if (
    text.includes('dns') ||
    text.includes('network') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('connect') ||
    text.includes('unreachable') ||
    text.includes('振荡') ||
    text.includes('os error 100') || // 100xx：Windows socket 错误
    text.includes('handshake')
  ) {
    return {
      summary: '连不上更新服务器（网络或代理问题）。',
      hint: '检查网络后重试；若用了代理/加速器，可能需要允许墨读访问 github.com。',
      retryable: true,
    }
  }

  // 3) 验签失败：安装包被篡改或公钥不匹配。
  if (
    text.includes('signature') ||
    text.includes('minisign') ||
    text.includes('verify') ||
    text.includes('public key')
  ) {
    return {
      summary: '更新包签名校验失败，已阻止安装。',
      hint: '为安全起见不会安装这个包；请到发布页手动下载，或等我们重新发布。',
      retryable: false,
    }
  }

  // 4) 权限不足（安装目录只读、被其他进程占用、企业策略）。
  if (
    text.includes('permission') ||
    text.includes('denied') ||
    text.includes('access is denied') ||
    text.includes('os error 5') ||
    text.includes('error 740') ||
    text.includes('elevat')
  ) {
    return {
      summary: '没有权限写入安装目录，更新未能安装。',
      hint: '关闭正在运行的墨读后重试；仍失败请用安装包手动覆盖安装（会请求提权）。',
      retryable: true,
    }
  }

  // 5) 平台/环境不支持（开发模式、便携版被移动到不可写位置等）。
  if (text.includes('not supported') || text.includes('not enabled') || text.includes('unsupported')) {
    return {
      summary: '当前运行环境不支持应用内更新。',
      hint: '便携版或开发模式请到发布页下载新包覆盖；安装版请确认是从安装目录启动的。',
      retryable: false,
    }
  }

  // 兜底：保留原文，方便用户反馈时报给我们。
  return {
    summary: '检查或安装更新时出错。',
    hint: '可以先重试一次；一直失败请把下面的错误原文反馈给我们，或到发布页手动下载。',
    retryable: true,
  }
}
