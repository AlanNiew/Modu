import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '../../lib/cn'
import type { TocItem } from '../../lib/types'

interface TocNode {
  item: TocItem
  children: TocNode[]
}

/** 扁平（带 depth）的目录项 → 树。旧版把层级拍平了，这里按 depth 还原。 */
function buildTree(items: TocItem[]): TocNode[] {
  const roots: TocNode[] = []
  const stack: TocNode[] = []
  for (const item of items) {
    const node: TocNode = { item, children: [] }
    const depth = Math.max(0, item.depth)
    while (stack.length > depth) stack.pop()
    if (depth === 0 || stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

interface TocTreeProps {
  items: TocItem[]
  /** 当前章节的 zip 内路径，用于高亮 */
  activePath?: string | null
  /** 当前页起点锚点：同一章挂了多个 fragment 时用它精确高亮 */
  activeFragment?: string | null
  onSelect: (item: TocItem) => void
}

export function TocTree({ items, activePath, activeFragment, onSelect }: TocTreeProps) {
  const tree = useMemo(() => buildTree(items), [items])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  // 同一章可能有多条目录项（小节/脚注锚点）：只高亮最贴近当前页的那一条，
  // 否则一次会把整章的目录项全点亮。fragment 匹配不上时退回本章第一条。
  const activeKey = useMemo(() => {
    if (!activePath) return null
    const sameChapter = items.filter((item) => item.path === activePath)
    if (sameChapter.length === 0) return null
    const exact = activeFragment
      ? sameChapter.find((item) => item.fragment === activeFragment)
      : undefined
    const target = exact ?? sameChapter[0]
    return `${target.href}#${target.fragment ?? ''}`
  }, [items, activePath, activeFragment])

  if (items.length === 0) {
    return <div className="px-3 py-4 text-xs text-overlay0">这本书没有可用的目录</div>
  }

  const renderNodes = (nodes: TocNode[], level: number) =>
    nodes.map((node) => {
      const { item } = node
      const key = `${item.href}#${item.fragment ?? ''}`
      const hasChildren = node.children.length > 0
      const isCollapsed = collapsed.has(key)
      const active = activeKey != null && key === activeKey

      return (
        <div key={`${key}-${level}`}>
          <div
            className={cn(
              'group flex items-center gap-1 rounded-md pr-2 text-[13px] transition',
              active ? 'bg-blue/15 text-blue' : 'text-subtext hover:bg-surface0/60 hover:text-text',
            )}
            style={{ paddingLeft: 6 + level * 12 }}
          >
            {hasChildren ? (
              <button
                type="button"
                aria-label={isCollapsed ? '展开' : '收起'}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }
                className="flex h-5 w-4 shrink-0 items-center justify-center text-overlay0 hover:text-text"
              >
                <ChevronRight
                  size={12}
                  className={cn('transition-transform', !isCollapsed && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => onSelect(item)}
              title={item.label}
              className="min-w-0 flex-1 truncate py-[6px] text-left"
            >
              {item.label || '未命名'}
            </button>
          </div>

          {hasChildren && !isCollapsed && renderNodes(node.children, level + 1)}
        </div>
      )
    })

  return <div className="pb-2">{renderNodes(tree, 0)}</div>
}
