import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderOpen, Library, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '../../lib/cn'
import type { BookSummary, ShelfFilter, ShelfSort } from '../../lib/types'
import { FILTER_LABELS, SORT_LABELS, useLibrary } from '../../store/library'
import { BookCard } from './BookCard'

interface ShelfPageProps {
  onOpenBook: (book: BookSummary) => void
}

/** 卡片最小宽度与间距：列数由容器宽度反算，不写死每行几本。 */
const MIN_CARD_WIDTH = 168
const GAP = 22
const COVER_ASPECT = 1.5 // 封面 2:3
const LABEL_HEIGHT = 60 // 书名 + 作者 + 字数三行
const ROW_GAP = 26

interface GridMetrics {
  columns: number
  cardWidth: number
  rowHeight: number
}

function fallbackRowHeight(cardWidth: number): number {
  return Math.round(cardWidth * COVER_ASPECT) + LABEL_HEIGHT + ROW_GAP
}

/**
 * 量出书架可用的宽度，再由它推导列数、卡片宽度和行高。
 *
 * 行高必须跟卡片宽度绑定：封面是 2:3 的按宽度等比缩放，卡片越宽封面越高；
 * 之前行高写死 316，窗口一宽封面就顶出格子、把下一行盖住（文字像被吃掉）。
 */
function useGridMetrics(ref: React.RefObject<HTMLDivElement | null>): GridMetrics {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return useMemo<GridMetrics>(() => {
    if (width <= 0) {
      return { columns: 4, cardWidth: MIN_CARD_WIDTH, rowHeight: fallbackRowHeight(MIN_CARD_WIDTH) }
    }
    const columns = Math.max(1, Math.floor((width + GAP) / (MIN_CARD_WIDTH + GAP)))
    const cardWidth = Math.floor((width - GAP * (columns - 1)) / columns)
    return { columns, cardWidth, rowHeight: fallbackRowHeight(cardWidth) }
  }, [width])
}

export function ShelfPage({ onOpenBook }: ShelfPageProps) {
  const books = useLibrary((state) => state.books)
  const loading = useLibrary((state) => state.loading)
  const importing = useLibrary((state) => state.importing)
  const error = useLibrary((state) => state.error)
  const sort = useLibrary((state) => state.sort)
  const filter = useLibrary((state) => state.filter)
  const query = useLibrary((state) => state.query)
  const load = useLibrary((state) => state.load)
  const setSort = useLibrary((state) => state.setSort)
  const setFilter = useLibrary((state) => state.setFilter)
  const setQuery = useLibrary((state) => state.setQuery)
  const importFromDialog = useLibrary((state) => state.importFromDialog)
  const remove = useLibrary((state) => state.remove)
  const clearError = useLibrary((state) => state.clearError)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [localQuery, setLocalQuery] = useState(query)
  const { columns, rowHeight } = useGridMetrics(gridRef)

  useEffect(() => {
    void load()
  }, [load])

  // 搜索防抖：中文输入法组合阶段不发请求。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (localQuery !== useLibrary.getState().query) setQuery(localQuery)
    }, 220)
    return () => window.clearTimeout(timer)
  }, [localQuery, setQuery])

  const rows = useMemo(() => {
    const chunked: BookSummary[][] = []
    for (let i = 0; i < books.length; i += columns) {
      chunked.push(books.slice(i, i + columns))
    }
    return chunked
  }, [books, columns])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  })

  // 行高随窗口宽度变化：清掉已测量的高度，否则虚拟列表还用旧值定位。
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, columns, virtualizer])

  const isEmpty = !loading && books.length === 0 && query.trim() === '' && filter === 'all'

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      {/* 标题栏由 App 统一渲染；页面只需要工具栏（搜索 + 筛选 + 排序）。 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-surface0/50 px-6 py-2.5">
        <div className="relative w-64">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-overlay0"
          />
          <input
            ref={searchRef}
            value={localQuery}
            onChange={(event) => setLocalQuery(event.target.value)}
            placeholder="搜索书名、作者"
            className={cn(
              'w-full rounded-lg border border-surface0 bg-mantle py-1.5 pl-8.5 pr-8 text-[13px] text-text',
              'placeholder:text-surface2 focus:border-blue/60 focus:outline-none',
            )}
          />
          {localQuery && (
            <button
              type="button"
              onClick={() => setLocalQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-overlay0 hover:text-text"
              title="清空"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <FilterTabs value={filter} onChange={setFilter} />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as ShelfSort)}
            className="rounded-lg border border-surface0 bg-mantle px-2.5 py-1.5 text-[11px] text-subtext focus:border-blue/60 focus:outline-none"
            title="排序方式"
          >
            {(Object.keys(SORT_LABELS) as ShelfSort[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
      </header>

      {importing > 0 && (
        <div className="flex items-center gap-2 border-b border-surface0/40 bg-mantle px-8 py-2 text-xs text-subtext">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue" />
          正在导入 {importing} 本书…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 border-b border-red/20 bg-red/10 px-8 py-2 text-xs text-red">
          <pre className="flex-1 whitespace-pre-wrap font-sans">{error}</pre>
          <button type="button" onClick={clearError} className="shrink-0 underline">
            关闭
          </button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div ref={gridRef} className="w-full">
          {isEmpty ? (
            <EmptyShelf onImport={() => void importFromDialog()} loading={loading} />
          ) : (
            <>
              {books.length === 0 && !loading && (
                <p className="py-16 text-center text-sm text-overlay0">
                  没有匹配的书
                </p>
              )}
              <div
                className="relative w-full"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((row) => (
                  <div
                    key={row.key}
                    className="absolute left-0 right-0"
                    style={{
                      top: row.start,
                      height: rowHeight,
                      display: 'grid',
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      columnGap: GAP,
                    }}
                  >
                    {rows[row.index].map((book) => (
                      <div key={book.id} className="min-w-0">
                        <BookCard
                          book={book}
                          onOpen={onOpenBook}
                          onRemove={(target) => {
                            if (window.confirm(`把《${target.title}》移出书架？（不会删除文件）`)) {
                              void remove(target.id)
                            }
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FilterTabs({
  value,
  onChange,
}: {
  value: ShelfFilter
  onChange: (filter: ShelfFilter) => void
}) {
  return (
    <div className="flex items-center rounded-lg border border-surface0 bg-mantle p-0.5">
      {(Object.keys(FILTER_LABELS) as ShelfFilter[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            'rounded-md px-2.5 py-1.5 text-xs transition',
            value === key
              ? 'bg-surface0 text-text'
              : 'text-overlay1 hover:text-subtext',
          )}
        >
          {FILTER_LABELS[key]}
        </button>
      ))}
    </div>
  )
}

function EmptyShelf({ onImport, loading }: { onImport: () => void; loading: boolean }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-surface0 bg-mantle">
        <Library size={34} className="text-surface2" />
      </div>
      <div>
        <p className="text-base font-medium text-subtext">
          {loading ? '正在打开书架…' : '书架还是空的'}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-overlay0">
          把 epub 文件拖进窗口，或点下面的按钮选择文件
          <br />
          支持 EPUB 2 / 3，导入后封面与目录会自动整理
        </p>
      </div>
      <button
        type="button"
        onClick={onImport}
        className="flex items-center gap-1.5 rounded-lg bg-blue px-4 py-2 text-sm font-medium text-crust transition hover:bg-lavender"
      >
        <FolderOpen size={16} />
        导入 EPUB
      </button>
    </div>
  )
}

