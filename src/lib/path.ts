// zip 内路径（POSIX 风格，无前导斜杠）工具集。
// 与 Rust 侧 normalize_path / resolve_href 保持同一语义。

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** 折叠 `.` / `..` / 重复斜杠，去掉前导斜杠与尾部斜杠。 */
export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return '' // 越界：上层目录不存在
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

export function splitHref(href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf('#')
  if (hash < 0) return { path: href, fragment: null }
  const raw = href.slice(hash + 1)
  return { path: href.slice(0, hash), fragment: raw || null }
}

/** 把章节内的 href（相对该章节所在目录）解析成 zip 绝对路径 + fragment。 */
export function resolveHref(
  basePath: string,
  href: string,
): { path: string; fragment: string | null } {
  const { path, fragment } = splitHref(href)
  const clean = decodeMaybe(path).split('?')[0]
  const absolute = clean.startsWith('/')
    ? normalizePath(clean)
    : normalizePath(`${dirname(basePath)}/${clean}`)
  return { path: absolute, fragment }
}

/** 绝对路径（zip 根开头）→ zip 内路径。 */
export function resolveFromRoot(href: string): { path: string; fragment: string | null } {
  const { path, fragment } = splitHref(href)
  return { path: normalizePath(decodeMaybe(path)), fragment }
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 逐段 encodeURIComponent，保留 `/` 分隔。 */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

export function isExternalHref(href: string): boolean {
  return /^(?:https?:|mailto:|tel:)/i.test(href.trim())
}

/** 是否页内锚点（`#fn3`）。 */
export function isFragmentOnly(href: string): boolean {
  return href.trim().startsWith('#')
}
