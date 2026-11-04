// 章节 XHTML 的资源改写。
//
// foliate 的 paginator 把 `section.load()` 返回的 URL 塞进 iframe.src，且必须同源
// （它通过 contentDocument 访问文档），所以这里把章节序列化成 blob: HTML。
// 代价是相对路径失去意义：所有子资源都必须在上传前改写成 epub 协议绝对地址。
//
// 注意：外链样式表（<link rel=stylesheet>）不需要改写 —— 它的 URL 直接指向协议地址，
// CSS 内部的 url() 由浏览器相对该 CSS 的 URL 解析，而 URL 层级与 zip 层级一致。

import { dirname, isExternalHref, normalizePath, resolveHref, resolveFromRoot } from '../lib/path'
import { resourceUrl } from '../lib/protocol'

const DROP_TAGS = ['script', 'base', 'iframe', 'object', 'embed', 'noscript']

const SRCSET_TAGS = new Set(['IMG', 'SOURCE'])
const URL_ATTRS: Record<string, string[]> = {
  IMG: ['src'],
  SOURCE: ['src'],
  VIDEO: ['src', 'poster'],
  AUDIO: ['src'],
  TRACK: ['src'],
  INPUT: ['src'],
  LINK: ['href'],
}

export function rewriteSectionHtml(html: string, sectionPath: string, bookId: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  for (const tag of DROP_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove())
  }

  const make = (value: string | null): string | null => {
    if (value == null) return null
    const abs = absolutize(value, sectionPath, bookId)
    return abs
  }

  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const attrs = URL_ATTRS[el.tagName]
    if (attrs) {
      for (const attr of attrs) {
        const value = el.getAttribute(attr)
        if (value == null) continue
        const abs = make(value)
        if (abs != null) el.setAttribute(attr, abs)
      }
    }

    if (SRCSET_TAGS.has(el.tagName)) {
      const srcset = el.getAttribute('srcset')
      if (srcset) el.setAttribute('srcset', rewriteSrcset(srcset, sectionPath, bookId))
    }

    // SVG <image href> / <use href>（含 xlink:href 旧写法）
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      for (const attr of ['href', 'xlink:href']) {
        const value = el.getAttribute(attr)
        if (!value) continue
        const abs = make(value)
        if (abs != null) el.setAttribute(attr, abs)
      }
    }

    // 内联 style 里的 url()
    const style = el.getAttribute('style')
    if (style && style.includes('url(')) {
      el.setAttribute('style', rewriteCssUrls(style, sectionPath, bookId))
    }

    // 少数书用 background 属性
    const bg = el.getAttribute('background')
    if (bg && el.tagName === 'BODY') {
      const abs = make(bg)
      if (abs != null) el.setAttribute('background', abs)
    }
  }

  // <style> 元素文本：内联 CSS 也会随 blob 文档解析，相对路径必须改
  doc.querySelectorAll('style').forEach((styleEl) => {
    const text = styleEl.textContent ?? ''
    if (text.includes('url(') || text.includes('@import')) {
      styleEl.textContent = rewriteCssUrls(text, sectionPath, bookId)
    }
  })

  // 保证中文不因缺 charset 解码错误（blob 已声明 charset，但书内 meta 优先）
  if (!doc.querySelector('meta[charset], meta[http-equiv="content-type" i]')) {
    const meta = doc.createElement('meta')
    meta.setAttribute('charset', 'utf-8')
    doc.head?.prepend(meta)
  }

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

function rewriteSrcset(srcset: string, sectionPath: string, bookId: string): string {
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return trimmed
      const space = trimmed.search(/\s/)
      const url = space < 0 ? trimmed : trimmed.slice(0, space)
      const descriptor = space < 0 ? '' : trimmed.slice(space)
      const abs = absolutize(url, sectionPath, bookId)
      return `${abs}${descriptor}`
    })
    .filter(Boolean)
    .join(', ')
}

/** 把 CSS 文本中的 url() 与 @import 相对地址改为协议绝对地址。 */
export function rewriteCssUrls(css: string, sectionPath: string, bookId: string): string {
  const withUrls = css.replace(
    /url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi,
    (_m, quote: string, value: string) => {
      const abs = absolutize(value.trim(), sectionPath, bookId)
      return `url(${quote}${abs}${quote})`
    },
  )
  return withUrls.replace(
    /@import\s+(['"])([^'"]+)\1/gi,
    (m, quote: string, value: string) => {
      const abs = absolutize(value.trim(), sectionPath, bookId)
      return abs === value ? m : `@import ${quote}${abs}${quote}`
    },
  )
}

/** 相对当前章节的地址 → epub 协议绝对地址；已是绝对/内联/外链的原样返回。 */
export function absolutize(value: string, sectionPath: string, bookId: string): string {
  const raw = value.trim()
  if (!raw) return raw
  if (
    raw.startsWith('data:') ||
    raw.startsWith('blob:') ||
    raw.startsWith('#') ||
    isExternalHref(raw) ||
    /^[a-z][a-z0-9+.-]*:/i.test(raw) // 其它协议（file:, javascript: 等）一律不动
  ) {
    return raw
  }
  if (raw.startsWith('//')) return `https:${raw}`
  const { path } = raw.startsWith('/')
    ? resolveFromRoot(raw)
    : resolveHref(sectionPath, raw)
  const safe = normalizePath(path || dirname(sectionPath))
  if (!safe) return raw
  return resourceUrl(bookId, safe)
}
