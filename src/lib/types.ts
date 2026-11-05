// 与 Rust 侧 serde 结构一一对应的 DTO（Rust 用 rename_all = "camelCase"）。

export interface SpineItem {
  index: number
  idref: string
  /** zip 内绝对路径，例如 `OEBPS/Text/ch1.xhtml` */
  path: string
  mediaType: string
  linear: boolean
  size: number
}

export interface TocItem {
  label: string
  /** 目录项原始 href（已按 zip 路径解析，可能含 fragment） */
  href: string
  path: string | null
  fragment: string | null
  /** 嵌套深度，0 为顶层 */
  depth: number
}

export interface BookPackage {
  title: string
  authors: string[]
  language: string
  publisher: string | null
  description: string | null
  identifier: string | null
  coverPath: string | null
  direction: 'ltr' | 'rtl' | string
  opfPath: string
  spine: SpineItem[]
  toc: TocItem[]
  resourcePaths: string[]
}

export interface OpenedBookInfo {
  id: string
  path: string
  package: BookPackage
  /** 书库主键；从书架打开时才有，决定是否持久化进度/书签 */
  libraryId: number | null
}

/** 阅读进度的原始记录；locator 是 locator.ts 编码的 JSON 字符串 */
export interface ProgressRecord {
  locator: string
  percent: number
  updatedAt: number
}

/** 书签：locator 与进度同构，另存展示用的章节名与摘录 */
export interface Bookmark {
  id: number
  bookId: number
  locator: string
  chapterTitle: string | null
  excerpt: string | null
  note: string | null
  createdAt: number
}

export interface SectionHtml {
  html: string
  path: string
}

// ---------------------------------------------------------------------------
// 书库（M1）
// ---------------------------------------------------------------------------

export type ShelfSort = 'recent' | 'title' | 'author' | 'added'
export type ShelfFilter = 'all' | 'reading' | 'unread' | 'finished'

export interface ListOptions {
  sort?: ShelfSort
  filter?: ShelfFilter
  query?: string
}

/** 书架卡片数据，对应 Rust `library::BookSummary`。 */
export interface BookSummary {
  id: number
  path: string
  title: string
  author: string | null
  publisher: string | null
  language: string | null
  /** 相对数据目录，例如 `covers/<hash>.jpg`；无封面为 null */
  coverFile: string | null
  chapterCount: number
  charCount: number
  addedAt: number
  openedAt: number | null
  finishedAt: number | null
  /** 全书进度 0..1 */
  percent: number
}

export interface ImportOutcome {
  path: string
  book: BookSummary | null
  error: string | null
}

/** 一条全书搜索结果，对应 Rust `library::SearchHit`。 */
export interface SearchHit {
  /** spine 序号 */
  index: number
  href: string
  chapterTitle: string | null
  /** 命中片段，命中文本用 U+0001/U+0002 包裹 */
  snippet: string
  /** 命中位置（字符偏移，仅作排序/参考） */
  offset: number
}

// ---------------------------------------------------------------------------
// 批注（M4）
// ---------------------------------------------------------------------------

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink'

/** 一条划线/批注，字段与 Rust `library::Annotation` 对齐。 */
export interface Annotation {
  id: number
  bookId: number
  /** `{"v":1,"index":章序号,"fraction":0..1}` */
  locator: string
  /** 章内相对路径，用来判断画在哪一章 */
  chapterHref: string
  chapterTitle: string | null
  /** 选中原文（空白已压缩） */
  quote: string
  prefix: string | null
  suffix: string | null
  /** 同章内第几次出现，处理重复引文 */
  occurrence: number
  color: AnnotationColor
  note: string | null
  createdAt: number
  updatedAt: number
}

/** 新建批注时提交的选择器（id / 时间戳由后端生成）。 */
export interface AnnotationDraft {
  locator: string
  chapterHref: string
  chapterTitle?: string | null
  quote: string
  prefix: string | null
  suffix: string | null
  occurrence: number
  color?: AnnotationColor
  note?: string | null
}
