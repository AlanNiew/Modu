import { BookOpen, MoreHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../../lib/cn'
import { shelfCoverUrl } from '../../lib/protocol'
import type { BookSummary } from '../../lib/types'

interface BookCardProps {
  book: BookSummary
  onOpen: (book: BookSummary) => void
  onRemove: (book: BookSummary) => void
}

function formatChars(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`
  return `${count} 字`
}

/** 无封面时的占位：用书名首字做渐变方块，避免书架出现空洞。 */
function CoverFallback({ title }: { title: string }) {
  const initial = title.trim().charAt(0) || '书'
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface0 via-mantle to-crust">
      <span className="font-serif text-4xl text-overlay0">{initial}</span>
    </div>
  )
}

export function BookCard({ book, onOpen, onRemove }: BookCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)
  const cover = shelfCoverUrl(book.coverFile)
  const percent = Math.round(book.percent * 100)

  return (
    <div
      className="group relative flex flex-col gap-2"
      onMouseLeave={() => setMenuOpen(false)}
    >
      <button
        type="button"
        onClick={() => onOpen(book)}
        className={cn(
          'relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-surface0/60',
          'bg-mantle shadow-lg shadow-crust/40 transition',
          'hover:border-blue/60 hover:shadow-xl hover:shadow-crust/60',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue',
        )}
        title={book.title}
      >
        {cover && !coverFailed ? (
          <img
            src={cover}
            alt={book.title}
            loading="lazy"
            draggable={false}
            onError={() => setCoverFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <CoverFallback title={book.title} />
        )}

        {/* 读过的书显示进度条贴底 */}
        {percent > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-crust/70">
            <div className="h-full bg-blue" style={{ width: `${Math.min(percent, 100)}%` }} />
          </div>
        )}

        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-crust/70 opacity-0 transition group-hover:opacity-100">
          <span className="flex items-center gap-1.5 rounded-full bg-blue px-3 py-1.5 text-xs font-medium text-crust">
            <BookOpen size={14} />
            {percent > 0 ? '继续阅读' : '开始阅读'}
          </span>
        </span>
      </button>

      {/* 卡片菜单：只用 M1 需要的移出书架；M2 起再加详情 */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen((open) => !open)
        }}
        className="absolute right-1 top-1 rounded-md bg-crust/70 p-1 text-subtext opacity-0 backdrop-blur transition hover:text-text group-hover:opacity-100"
        title="更多"
      >
        <MoreHorizontal size={16} />
      </button>
      {menuOpen && (
        <div className="absolute right-1 top-9 z-10 w-36 overflow-hidden rounded-lg border border-surface1 bg-base shadow-xl">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false)
              onRemove(book)
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-subtext transition hover:bg-surface0 hover:text-red"
          >
            <Trash2 size={14} />
            移出书架
          </button>
        </div>
      )}

      <div className="min-w-0 px-0.5">
        <p className="truncate text-sm font-medium text-text" title={book.title}>
          {book.title}
        </p>
        <p className="truncate text-xs text-overlay1">
          {book.author ?? '未知作者'}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-surface2">
          {book.chapterCount} 章 · {formatChars(book.charCount)}
          {percent > 0 && ` · ${percent}%`}
        </p>
      </div>
    </div>
  )
}
