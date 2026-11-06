import { invoke } from '@tauri-apps/api/core'
import type {
  Annotation,
  AnnotationColor,
  AnnotationDraft,
  BookSummary,
  Bookmark,
  ImportOutcome,
  InstalledFont,
  ListOptions,
  OpenedBookInfo,
  ProgressRecord,
  SearchHit,
  SectionHtml,
} from './types'

/** 打开 EPUB，返回书元数据 + spine + 目录；Rust 侧保留 zip 句柄。 */
export const openBook = (path: string, convertTraditional = false) =>
  invoke<OpenedBookInfo>('book_open', { path, convertTraditional })

/** 关闭书籍，释放句柄。 */
export const closeBook = (bookId: string) =>
  invoke<void>('book_close', { bookId })

/** 读取某个 spine 章节的原始 XHTML 文本；convertTraditional = 正文繁转简。 */
export const getSectionHtml = (bookId: string, index: number, convertTraditional = false) =>
  invoke<SectionHtml>('book_section_html', { bookId, index, convertTraditional })

/** 读取任意 zip 内文本（调试用）。 */
export const readBookText = (bookId: string, path: string) =>
  invoke<string>('book_read_text', { bookId, path })

/** 当前会话已打开的书（dev 热重载后可恢复）。 */
export const listOpenBooks = () => invoke<OpenedBookInfo[]>('book_list')

/** 弹系统文件选择器；用户取消时返回 null。 */
export const pickEpub = () => invoke<string | null>('pick_epub')

// ---------------------------------------------------------------------------
// 书库
// ---------------------------------------------------------------------------

/** 多选文件对话框；取消时返回空数组。 */
export const pickEpubs = () => invoke<string[]>('pick_epubs')

/** 导入一本书或多本书，逐本返回结果（失败不影响其它书）。 */
export const importBooks = (paths: string[]) =>
  invoke<ImportOutcome[]>('library_import', { paths })

/** 书架列表。 */
export const listLibrary = (options: ListOptions = {}) =>
  invoke<BookSummary[]>('library_list', { options })

/** 从书架打开：按库内路径解析，并记录最近阅读时间；convertTraditional 决定正文/目录是否繁转简。 */
export const openFromLibrary = (bookId: number, convertTraditional = false) =>
  invoke<OpenedBookInfo>('library_open', { bookId, convertTraditional })

/** 仅移出书架，不删除原文件。 */
export const removeFromLibrary = (bookId: number) =>
  invoke<void>('library_remove', { bookId })

/** 单本书架条目详情。 */
export const getLibraryBook = (bookId: number) =>
  invoke<BookSummary>('library_books', { bookId })

// ---------------------------------------------------------------------------
// 阅读进度与书签（M2）
// ---------------------------------------------------------------------------

export const getProgress = (bookId: number) =>
  invoke<ProgressRecord | null>('progress_get', { bookId })

export const saveProgress = (bookId: number, locator: string, percent: number) =>
  invoke<void>('progress_save', { bookId, locator, percent })

export const addBookmark = (
  bookId: number,
  locator: string,
  chapterTitle: string | null,
  excerpt: string | null,
) => invoke<Bookmark>('bookmark_add', { bookId, locator, chapterTitle, excerpt })

export const listBookmarks = (bookId: number) =>
  invoke<Bookmark[]>('bookmark_list', { bookId })

export const removeBookmark = (bookmarkId: number) =>
  invoke<void>('bookmark_remove', { bookmarkId })
// ---------------------------------------------------------------------------
// 全书搜索（M3）
// ---------------------------------------------------------------------------

export const searchBook = (
  bookId: string,
  libraryId: number,
  query: string,
  limit = 80,
  convertTraditional = false,
) => invoke<SearchHit[]>('book_search', { bookId, libraryId, query, limit, convertTraditional })

export const setBookmarkNote = (bookmarkId: number, note: string | null) =>
  invoke<void>('bookmark_note_set', { bookmarkId, note })

// ---------------------------------------------------------------------------
// 批注（M4）
// ---------------------------------------------------------------------------

export const addAnnotation = (libraryId: number, input: AnnotationDraft) =>
  invoke<Annotation>('annotation_add', { libraryId, input })

export const listAnnotations = (libraryId: number) =>
  invoke<Annotation[]>('annotation_list', { libraryId })

/** `note` 传 `null` 表示不动备注，传空字符串表示清空。 */
export const updateAnnotation = (
  annotationId: number,
  note: string | null,
  color: AnnotationColor | null = null,
) => invoke<Annotation>('annotation_update', { annotationId, note, color })

export const removeAnnotation = (annotationId: number) =>
  invoke<void>('annotation_remove', { annotationId })

/** 整本书的批注导出为 Markdown 文本（落盘由系统保存对话框决定）。 */
export const exportAnnotationsMarkdown = (libraryId: number) =>
  invoke<string>('annotation_export_markdown', { libraryId })

/** 写文本文件；路径来自用户显式选择的保存对话框。 */
export const writeTextFile = (path: string, contents: string) =>
  invoke<void>('write_text_file', { path, contents })

/** 在资源管理器中显示出数据目录（书库、封面、批注数据所在处），返回实际路径。 */
export const revealDataDir = () => invoke<string>('reveal_data_dir')

// ---------------------------------------------------------------------------
// 自定义字体（P3）
// ---------------------------------------------------------------------------

/** 解析并安装用户字体文件（路径来自系统文件对话框），返回 {file, family}。 */
export const importFont = (path: string) =>
  invoke<InstalledFont>('font_import', { path })

/** 重新扫描数据目录 fonts/（与磁盘对账）。 */
export const listFonts = () => invoke<InstalledFont[]>('font_list')

/** 删除一个自定义字体（纯文件名）。 */
export const removeFont = (file: string) => invoke<void>('font_remove', { file })