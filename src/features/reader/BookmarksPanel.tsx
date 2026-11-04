import { Bookmark as BookmarkIcon, Trash2 } from 'lucide-react'

import { cn } from '../../lib/cn'
import type { Bookmark } from '../../lib/types'

interface BookmarksPanelProps {
  bookmarks: Bookmark[]
  loading: boolean
  onJump: (bookmark: Bookmark) => void
  onRemove: (bookmark: Bookmark) => void
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function BookmarksPanel({ bookmarks, loading, onJump, onRemove }: BookmarksPanelProps) {
  if (loading) {
    return <div className="px-3 py-4 text-xs text-overlay0">加载书签…</div>
  }
  if (bookmarks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-overlay0">
        <BookmarkIcon size={22} className="text-overlay0/60" />
        <div>还没有书签</div>
        <div className="text-overlay0/70">阅读时点右上角书签按钮，记录当前位置</div>
      </div>
    )
  }

  return (
    <div className="space-y-1 p-2">
      {bookmarks.map((bookmark) => (
        <div
          key={bookmark.id}
          className={cn(
            'group rounded-md border border-transparent px-2 py-2 transition',
            'hover:border-surface0 hover:bg-surface0/40',
          )}
        >
          <button
            type="button"
            onClick={() => onJump(bookmark)}
            className="block w-full text-left"
            title={bookmark.locator}
          >
            <div className="truncate text-[12px] text-text">
              {bookmark.chapterTitle || '未命名章节'}
            </div>
            {bookmark.excerpt && (
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-overlay0">
                {bookmark.excerpt}
              </div>
            )}
            <div className="mt-1 text-[10px] tabular-nums text-overlay0/60">
              {formatTime(bookmark.createdAt)}
            </div>
          </button>
          <div className="mt-1 flex justify-end opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onRemove(bookmark)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-overlay0 hover:bg-red/15 hover:text-red"
              title="删除书签"
            >
              <Trash2 size={11} />
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
