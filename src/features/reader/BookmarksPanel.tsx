import { Bookmark as BookmarkIcon, NotebookPen, PencilLine, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../../lib/cn'
import type { Bookmark } from '../../lib/types'

interface BookmarksPanelProps {
  bookmarks: Bookmark[]
  loading: boolean
  onJump: (bookmark: Bookmark) => void
  onRemove: (bookmark: Bookmark) => void
  /** 保存书签备注（空字符串 = 清空） */
  onNote: (bookmark: Bookmark, note: string) => void
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function BookmarksPanel({ bookmarks, loading, onJump, onRemove, onNote }: BookmarksPanelProps) {
  // 正在编辑备注的书签 id；同一时间只编辑一条，避免面板里到处是输入框
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

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

  const beginEdit = (bookmark: Bookmark) => {
    setEditingId(bookmark.id)
    setDraft(bookmark.note ?? '')
  }

  const commit = (bookmark: Bookmark) => {
    onNote(bookmark, draft)
    setEditingId(null)
    setDraft('')
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
            {bookmark.note && editingId !== bookmark.id && (
              <div className="mt-1 flex items-start gap-1 rounded bg-yellow/10 px-1.5 py-1 text-[11px] leading-relaxed text-subtext">
                <NotebookPen size={11} className="mt-0.5 shrink-0 text-yellow" />
                <span className="whitespace-pre-wrap">{bookmark.note}</span>
              </div>
            )}
            <div className="mt-1 text-[10px] tabular-nums text-overlay0/60">
              {formatTime(bookmark.createdAt)}
            </div>
          </button>

          {editingId === bookmark.id ? (
            <div className="mt-1">
              <textarea
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setEditingId(null)
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    commit(bookmark)
                  }
                }}
                rows={3}
                placeholder="写点备注…（Ctrl+Enter 保存，Esc 取消）"
                className="w-full resize-none rounded-md border border-surface0 bg-crust/60 px-2 py-1.5 text-[11px] leading-relaxed text-text outline-none placeholder:text-overlay0/60 focus:border-blue/60"
              />
              <div className="mt-1 flex justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="rounded px-2 py-0.5 text-[10px] text-overlay0 hover:text-text"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => commit(bookmark)}
                  className="rounded bg-blue/20 px-2 py-0.5 text-[10px] text-blue hover:bg-blue/30"
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-1 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={() => beginEdit(bookmark)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-overlay0 hover:bg-surface0 hover:text-text"
                title={bookmark.note ? '编辑备注' : '添加备注'}
              >
                <PencilLine size={11} />
                {bookmark.note ? '改备注' : '备注'}
              </button>
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
          )}
        </div>
      ))}
    </div>
  )
}
