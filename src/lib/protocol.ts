import { encodePath } from './path'
import type { InstalledFont } from './types'

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

/**
 * 用户自定义字体：走协议的 `__fonts/` 保留前缀（P3，Rust 从数据目录读）。
 * 文件名必须已是「纯文件名」——安装/列表都在 Rust 侧校验过。
 */
export function fontUrl(file: string): string {
  const name = file.split('/').pop() as string
  return `${RESOURCE_ORIGIN}/__fonts/${encodePath(name)}`
}

/** 根据扩展名给出 @font-face 的 format 提示（webkit 两类就够）。 */
function fontFormatHint(file: string): string {
  const ext = file.toLowerCase().split('.').pop() ?? ''
  if (ext === 'otf') return 'opentype'
  if (ext === 'ttc') return 'collection'
  if (ext === 'woff') return 'woff'
  if (ext === 'woff2') return 'woff2'
  return 'truetype'
}

/**
 * 把已安装 自定义字体注册进章节文档的 @font-face。
 *
 * - 家族名写进 CSS 字符串要做引号/反斜杠转义（名字来自字体文件，宁可靠点）；
 * - URL 一律加引号：`url("...")`，避免文件名里出现 `(`/`)` 等 CSS 特殊
 *   字符截断地址（Windows 文件名合法字符很多）；
 * - 文件名只保留纯名（去掉目录成分）后再交给协议层二次校验。
 */
export function customFontFaces(fonts: readonly InstalledFont[] | undefined): string {
  if (!fonts?.length) return ''
  return fonts
    .map(({ file, family }) => {
      const name = file.split('/').pop()
      if (!name || !family) return ''
      const safeFamily = family
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
      return [
        '@font-face {',
        `  font-family: "${safeFamily}";`,
        `  src: url("${fontUrl(name)}") format("${fontFormatHint(name)}");`,
        '}',
      ].join('\n')
    })
    .filter(Boolean)
    .join('\n')
}
