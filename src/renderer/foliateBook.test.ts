import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFoliateBook, buildTocTree } from './foliateBook'
import type { BookPackage, OpenedBookInfo, TocItem } from '../lib/types'

vi.mock('../lib/ipc', () => ({
  getSectionHtml: vi.fn(async (_bookId: string, index: number) => ({
    html: `<!doctype html><html><head><title>c${index}</title></head><body><p>第 ${index} 章</p></body></html>`,
    path: `OEBPS/Text/ch${index}.xhtml`,
  })),
}))

function makePackage(toc: TocItem[]): BookPackage {
  return {
    title: '测试书',
    authors: ['作者'],
    language: 'zh-CN',
    publisher: null,
    description: null,
    identifier: null,
    coverPath: null,
    direction: 'ltr',
    opfPath: 'OEBPS/content.opf',
    spine: [
      {
        index: 0,
        idref: 'ch0',
        path: 'OEBPS/Text/ch0.xhtml',
        mediaType: 'application/xhtml+xml',
        linear: true,
        size: 10,
      },
      {
        index: 1,
        idref: 'ch1',
        path: 'OEBPS/Text/ch1.xhtml',
        mediaType: 'application/xhtml+xml',
        linear: true,
        size: 10,
      },
      {
        index: 2,
        idref: 'notes',
        path: 'OEBPS/Text/notes.xhtml',
        mediaType: 'application/xhtml+xml',
        linear: false,
        size: 10,
      },
    ],
    toc,
    resourcePaths: [],
  }
}

function makeInfo(toc: TocItem[]): OpenedBookInfo {
  return { id: 'book-1', path: 'D:/books/test.epub', libraryId: 7, package: makePackage(toc) }
}

describe('buildTocTree', () => {
  it('nests flat toc items by depth', () => {
    const tree = buildTocTree([
      { label: '第一章', href: 'Text/ch1.xhtml', path: 'OEBPS/Text/ch1.xhtml', fragment: null, depth: 0 },
      { label: '第一节', href: 'Text/ch1.xhtml#s1', path: 'OEBPS/Text/ch1.xhtml', fragment: 's1', depth: 1 },
      { label: '第二章', href: 'Text/ch2.xhtml', path: 'OEBPS/Text/ch2.xhtml', fragment: null, depth: 0 },
    ])
    expect(tree).toHaveLength(2)
    expect(tree[0].label).toBe('第一章')
    expect(tree[0].subitems.map((item) => item.label)).toEqual(['第一节'])
    expect(tree[1].label).toBe('第二章')
  })

  it('keeps siblings after returning to depth 0', () => {
    const tree = buildTocTree([
      { label: 'A', href: 'a.xhtml', path: 'OEBPS/a.xhtml', fragment: null, depth: 0 },
      { label: 'A1', href: 'a.xhtml#1', path: 'OEBPS/a.xhtml', fragment: '1', depth: 1 },
      { label: 'A2', href: 'a.xhtml#2', path: 'OEBPS/a.xhtml', fragment: '2', depth: 1 },
      { label: 'B', href: 'b.xhtml', path: 'OEBPS/b.xhtml', fragment: null, depth: 0 },
    ])
    expect(tree.map((item) => item.label)).toEqual(['A', 'B'])
    expect(tree[0].subitems.map((item) => item.label)).toEqual(['A1', 'A2'])
  })
})

describe('createFoliateBook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
  })

  it('exposes one section per spine item and honours linear=no', () => {
    const book = createFoliateBook(makeInfo([]))
    expect(book.sections).toHaveLength(3)
    expect(book.sections.map((section) => section.linear)).toEqual(['yes', 'yes', 'no'])
    expect(book.dir).toBe('ltr')
    book.dispose()
  })

  it('loads a section as a same-origin blob URL and revokes it on unload', async () => {
    const book = createFoliateBook(makeInfo([]))
    const url = await book.sections[0].load()
    expect(url).toBe('blob:test')
    book.sections[0].unload()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    book.dispose()
  })

  it('resolves zip-internal hrefs to a spine index plus fragment anchor', () => {
    const book = createFoliateBook(makeInfo([]))
    // 目录/内链给的都是 zip 内完整路径（OPF 目录相对），不是章节相对路径。
    const resolved = book.resolveHref('OEBPS/Text/ch1.xhtml#s2')
    expect(resolved?.index).toBe(1)
    expect(typeof resolved?.anchor).toBe('function')
    // 没有路径的纯锚点不参与章节定位。
    expect(book.resolveHref('#s2')).toBeUndefined()
    book.dispose()
  })

  it('flags external links instead of treating them as chapters', () => {
    const book = createFoliateBook(makeInfo([]))
    expect(book.isExternal('https://example.com/')).toBe(true)
    expect(book.isExternal('mailto:a@b.c')).toBe(true)
    expect(book.isExternal('Text/ch1.xhtml')).toBe(false)
    book.dispose()
  })
})
