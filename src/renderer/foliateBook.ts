// foliate-js 的 book 适配层：把 Rust 解析结果包装成 foliate View 认识的 book 对象。
//
// foliate paginator 需要的最小接口：
//   book.dir, book.sections[i].{ load(), unload?, size, linear },
//   book.toc[{ label, href, subitems }], book.resolveHref(), book.isExternal()
//
// 章节 load() 必须返回**同源** URL 字符串（paginator 会 iframe.src = 它，
// 然后用 contentDocument 访问），所以这里统一产出 blob: URL，并在 unload 时回收。

import { getSectionHtml } from '../lib/ipc'
import { dirname, isExternalHref, normalizePath, resolveHref, splitHref } from '../lib/path'
import type { BookPackage, OpenedBookInfo, TocItem } from '../lib/types'
import { rewriteSectionHtml } from './sectionLoader'

export interface FoliateTocItem {
  label: string
  href: string
  subitems: FoliateTocItem[]
}

interface FoliateSection {
  id: string
  load(): Promise<string>
  unload(): void
  size: number
  linear: string
  resolveHref(href: string): string
}

export interface FoliateBook {
  dir: string
  sections: FoliateSection[]
  toc: FoliateTocItem[]
  metadata: Record<string, unknown>
  rendition: Record<string, unknown>
  resolveHref(href: string): { index: number; anchor?: (doc: Document) => Node | null } | undefined
  isExternal(href: string): boolean
  /** 释放所有 blob URL */
  dispose(): void
}

export function createFoliateBook(info: OpenedBookInfo): FoliateBook {
  const pkg: BookPackage = info.package
  const blobUrls = new Map<number, string>()
  const byPath = new Map<string, number>()
  pkg.spine.forEach((item) => byPath.set(item.path, item.index))

  const lookupIndex = (path: string): number => {
    const normalized = normalizePath(path)
    const exact = byPath.get(normalized)
    if (exact != null) return exact
    const lower = normalized.toLowerCase()
    for (const [p, i] of byPath) {
      if (p.toLowerCase() === lower) return i
    }
    return 0
  }

  const sections: FoliateSection[] = pkg.spine.map((item) => ({
    id: item.path,
    size: item.size,
    linear: item.linear ? 'yes' : 'no',
    async load() {
      const { html, path } = await getSectionHtml(info.id, item.index)
      const rewritten = rewriteSectionHtml(html, path, info.id)
      const url = URL.createObjectURL(
        new Blob([rewritten], { type: 'text/html;charset=utf-8' }),
      )
      const prev = blobUrls.get(item.index)
      if (prev) URL.revokeObjectURL(prev)
      blobUrls.set(item.index, url)
      return url
    },
    unload() {
      const url = blobUrls.get(item.index)
      if (url) {
        URL.revokeObjectURL(url)
        blobUrls.delete(item.index)
      }
    },
    // foliate 链接点击时先问 section：把章节内相对 href 规范化成 zip 路径
    resolveHref(href: string) {
      const trimmed = href.trim()
      if (!trimmed || trimmed.startsWith('#')) return trimmed
      if (isExternalHref(trimmed)) return trimmed
      const { path, fragment } = resolveHref(item.path, trimmed)
      return fragment ? `${path}#${fragment}` : path
    },
  }))

  return {
    dir: pkg.direction === 'rtl' ? 'rtl' : 'ltr',
    sections,
    toc: buildTocTree(pkg.toc),
    metadata: {
      title: pkg.title,
      author: pkg.authors.join('、'),
      language: pkg.language || 'zh-CN',
    },
    rendition: {},
    resolveHref(href: string) {
      const { path, fragment } = splitHref(href)
      if (!path) return undefined
      const index = lookupIndex(path)
      return {
        index,
        anchor: fragment
          ? (doc: Document) => doc.getElementById(safeDecode(fragment)) ?? null
          : undefined,
      }
    },
    isExternal(href: string) {
      return isExternalHref(href)
    },
    dispose() {
      for (const url of blobUrls.values()) URL.revokeObjectURL(url)
      blobUrls.clear()
    },
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Rust 返回的是扁平列表 + depth，这里还原成 foliate 需要的树。 */
export function buildTocTree(items: TocItem[]): FoliateTocItem[] {
  const root: FoliateTocItem[] = []
  const stack: { node: FoliateTocItem; depth: number }[] = []
  for (const item of items) {
    const href = item.path
      ? item.fragment
        ? `${item.path}#${item.fragment}`
        : item.path
      : item.href
    const node: FoliateTocItem = {
      label: item.label || '未命名',
      href,
      subitems: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) stack.pop()
    if (stack.length > 0) stack[stack.length - 1].node.subitems.push(node)
    else root.push(node)
    stack.push({ node, depth: item.depth })
  }
  return root
}

/** 封面在 zip 内可能相对 OPF 目录，Rust 已归一化为根相对路径。 */
export function opfDir(pkg: BookPackage): string {
  return dirname(pkg.opfPath)
}
