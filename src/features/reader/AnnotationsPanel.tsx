import { Highlighter, NotebookPen, PencilLine, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '../../lib/cn'
import type { Annotation, AnnotationColor } from '../../lib/types'

interface AnnotationsPanelProps {
  annotations: Annotation[]
  loading: boolean
  /** 正文里点中的那条（或刚新建的），自动展开编辑 */
  activeId: number | null
  onJump: (annotation: Annotation) => void
  onRemove: (annotation: Annotation) => void
  /** 保存批注（空字符串 = 清空） */
  onNote: (annotation: Annotation, note: string) => void
}

const SWATCHES: Record<AnnotationColor, string> = {
  yellow: 'rgba(249, 226, 175, .95)',
  green: 'rgba(166, 227, 161, .95)',
  blue: 'rgba(137, 180, 250, .95)',
  pink: 'rgba(245, 194, 231, .95)',
}

const COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function AnnotationsPanel({
  annotations,
  loading,
  activeId,
  onJump,
  onRemove,
  onNote,
}: AnnotationsPanelProps) {
  // 正在编辑备注的批注 id；同一时间只编辑一条
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  // 记录已经自动展开过的 activeId：只在「选中了另一条」时展开，
  // 不能在 annotations 变化（比如刚保存完备注）时又把它重新撑开。
  const handledActiveRef = useRef<number | null>(null)

  // 从正文点划线过来时，自动进入编辑态，省一次点击
  useEffect(() => {
    if (activeId == null) {
      handledActiveRef.current = null
      return
    }
    if (handledActiveRef.current === activeId) return
    handledActiveRef.current = activeId
    const target = annotations.find((item) => item.id === activeId)
    if (!target) return
    setEditingId(activeId)
    setDraft(target.note ?? '')
  }, [activeId, annotations])

  if (loading) {
    return <div className="px-3 py-4 text-xs text-overlay0">加载批注…</div>
  }
  if (annotations.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-overlay0">
        <Highlighter size={22} className="text-overlay0/60" />
        <div>还没有批注</div>
        <div className="text-overlay0/70">在正文里选中一句话，点「写批注」即可</div>
      </div>
    )
  }

  const commit = (annotation: Annotation) => {
    onNote(annotation, draft)
    setEditingId(null)
    setDraft('')
  }

  return (
    <div className="space-y-1 p-2">
      {annotations.map((annotation) => {
        const color = (annotation.color ?? 'yellow') as AnnotationColor
        return (
          <div
            key={annotation.id}
            className={cn(
              'group rounded-md border border-transparent px-2 py-2 transition',
              'hover:border-surface0 hover:bg-surface0/40',
              activeId === annotation.id && 'border-blue/40 bg-surface0/40',
            )}
          >
            <button
              type="button"
              onClick={() => onJump(annotation)}
              className="block w-full text-left"
              title={annotation.locator}
            >
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/25"
                  style={{ background: SWATCHES[color] }}
                />
                <span className="truncate text-[12px] text-text">
                  {annotation.chapterTitle || '未命名章节'}
                </span>
              </div>
              <div className="mt-1 line-clamp-2 border-l-2 pl-1.5 text-[11px] leading-relaxed text-subtext"
                style={{ borderColor: SWATCHES[color] }}>
                {annotation.quote}
              </div>
              {annotation.note && editingId !== annotation.id && (
                <div className="mt-1 flex items-start gap-1 rounded bg-yellow/10 px-1.5 py-1 text-[11px] leading-relaxed text-subtext">
                  <NotebookPen size={11} className="mt-0.5 shrink-0 text-yellow" />
                  <span className="whitespace-pre-wrap">{annotation.note}</span>
                </div>
              )}
              <div className="mt-1 text-[10px] tabular-nums text-overlay0/60">
                {COLOR_LABELS[color]}划线 · {formatTime(annotation.createdAt)}
              </div>
            </button>

            {editingId === annotation.id ? (
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
                      commit(annotation)
                    }
                  }}
                  rows={3}
                  placeholder="写下你的想法…（Ctrl+Enter 保存，Esc 取消）"
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
                    onClick={() => commit(annotation)}
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
                  onClick={() => {
                    setEditingId(annotation.id)
                    setDraft(annotation.note ?? '')
                  }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-overlay0 hover:bg-surface0 hover:text-text"
                  title={annotation.note ? '编辑批注' : '写批注'}
                >
                  <PencilLine size={11} />
                  {annotation.note ? '改批注' : '写批注'}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(annotation)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-overlay0 hover:bg-red/15 hover:text-red"
                  title="删除划线"
                >
                  <Trash2 size={11} />
                  删除
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
