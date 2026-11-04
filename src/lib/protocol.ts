import { encodePath } from './path'

/**
 * Tauri 自定义协议在 Windows/Android 上被托管为 `http://<scheme>.localhost`，
 * macOS/Linux 才是 `<scheme>://localhost`。章节 HTML 本身必须走 blob:（同源），
 * 这个 origin 只用于 img / link / @font-face 之类的子资源。
 */
const IS_WINDOWS =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

export const RESOURCE_ORIGIN = IS_WINDOWS ? 'http://epub.localhost' : 'epub://localhost'

export function resourceUrl(bookId: string, path: string): string {
  return `${RESOURCE_ORIGIN}/${bookId}/${encodePath(path)}`
}

/** 图片等资源的 <img src> 用；封面是 zip 内路径。 */
export function coverUrl(bookId: string, coverPath: string | null): string | null {
  return coverPath ? resourceUrl(bookId, coverPath) : null
}

/**
 * 书架封面：不是 zip 内资源（书可能没打开），走协议的 `__covers/` 保留前缀，
 * Rust 侧直接从数据目录读文件。
 */
export function shelfCoverUrl(coverFile: string | null): string | null {
  if (!coverFile) return null
  const name = coverFile.split('/').pop()
  return name ? `${RESOURCE_ORIGIN}/__covers/${encodePath(name)}` : null
}
