import { create } from 'zustand'

import {
  importBooks,
  listLibrary,
  pickEpubs,
  removeFromLibrary,
} from '../lib/ipc'
import type { BookSummary, ShelfFilter, ShelfSort } from '../lib/types'

interface LibraryState {
  books: BookSummary[]
  loading: boolean
  /** 正在导入的书籍数量；> 0 时书架显示导入条。 */
  importing: number
  error: string | null
  sort: ShelfSort
  filter: ShelfFilter
  query: string

  load: () => Promise<void>
  setSort: (sort: ShelfSort) => void
  setFilter: (filter: ShelfFilter) => void
  setQuery: (query: string) => void
  /** 弹文件选择器并导入选中的书。 */
  importFromDialog: () => Promise<BookSummary[]>
  /** 导入给定路径（拖拽/命令行用）。 */
  importPaths: (paths: string[]) => Promise<BookSummary[]>
  remove: (bookId: number) => Promise<void>
  clearError: () => void
}

export const useLibrary = create<LibraryState>((set, get) => ({
  books: [],
  loading: false,
  importing: 0,
  error: null,
  sort: 'recent',
  filter: 'all',
  query: '',

  load: async () => {
    const { sort, filter, query } = get()
    set({ loading: true })
    try {
      const books = await listLibrary({ sort, filter, query })
      set({ books, loading: false })
    } catch (err) {
      set({ loading: false, error: `读取书架失败：${String(err)}` })
    }
  },

  setSort: (sort) => {
    set({ sort })
    void get().load()
  },

  setFilter: (filter) => {
    set({ filter })
    void get().load()
  },

  setQuery: (query) => {
    set({ query })
    void get().load()
  },

  importFromDialog: async () => {
    const paths = await pickEpubs()
    if (paths.length === 0) return []
    return get().importPaths(paths)
  },

  importPaths: async (paths) => {
    const epubs = paths.filter((path) => path.toLowerCase().endsWith('.epub'))
    if (epubs.length === 0) return []

    set((state) => ({ importing: state.importing + epubs.length }))
    try {
      const outcomes = await importBooks(epubs)
      const imported = outcomes
        .map((outcome) => outcome.book)
        .filter((book): book is BookSummary => book !== null)
      const failures = outcomes.filter((outcome) => outcome.error)

      await get().load()

      if (failures.length > 0) {
        const detail = failures
          .map((failure) => `${failure.path.split(/[\\/]/).pop()}：${failure.error}`)
          .join('\n')
        set({ error: `有 ${failures.length} 本导入失败\n${detail}` })
      }
      return imported
    } catch (err) {
      set({ error: `导入失败：${String(err)}` })
      return []
    } finally {
      set((state) => ({ importing: Math.max(0, state.importing - epubs.length) }))
    }
  },

  remove: async (bookId) => {
    try {
      await removeFromLibrary(bookId)
      set((state) => ({ books: state.books.filter((book) => book.id !== bookId) }))
    } catch (err) {
      set({ error: `移出书架失败：${String(err)}` })
    }
  },

  clearError: () => set({ error: null }),
}))

/** 排序下拉用的中文标签。 */
export const SORT_LABELS: Record<ShelfSort, string> = {
  recent: '最近阅读',
  title: '书名',
  author: '作者',
  added: '入库时间',
}

export const FILTER_LABELS: Record<ShelfFilter, string> = {
  all: '全部',
  reading: '在读',
  unread: '未读',
  finished: '读完',
}
