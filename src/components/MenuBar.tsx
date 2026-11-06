import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight } from 'lucide-react'
import { useRef, useState } from 'react'

import { runCommand } from '../lib/commands'
import { cn } from '../lib/cn'

/** 组合出「全局固定菜单栏」所需的三种条目形态。 */
export interface MenuItemSpec {
  kind: 'item'
  /** 稳定 id 用于 React key；无强约束。 */
  id: string
  label: string
  /** 右侧快捷键提示（纯展示，快捷键的实际监听在各自组件里）。 */
  kb?: string
  disabled?: boolean
  /** 当前条目带对勾标记（主题单选等）。 */
  checked?: boolean
  /** 填了就直接在菜单内执行该命令（命令总线）；需要更细控制时用 onSelect。 */
  command?: string
  onSelect?: () => void
}

export interface MenuSepSpec {
  kind: 'separator'
}

export interface MenuSubSpec {
  kind: 'submenu'
  id: string
  label: string
  items: MenuEntry[]
}

export type MenuEntry = MenuItemSpec | MenuSepSpec | MenuSubSpec

export interface MenuSectionSpec {
  id: string
  label: string
  entries: MenuEntry[]
}

/** 菜单内容样式常量：主菜单与子菜单共用一套。 */
const CONTENT_CLASS =
  'min-w-[212px] rounded-lg border border-surface0/70 bg-mantle p-1 shadow-xl shadow-black/30 outline-none'

const ITEM_CLASS =
  'grid h-7 cursor-default select-none grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 text-[12px] text-subtext outline-none ' +
  'data-[highlighted]:bg-surface0/80 data-[highlighted]:text-text data-[disabled]:text-overlay0/40'

/**
 * 全局固定菜单栏（文件/阅读/视图/帮助）。
 *
 * 交互约定（常规桌面应用习惯）：
 * - 点击打开；鼠标扫过兄弟菜单时切换到那一个（省一次点击）；
 * - 已被滑过的菜单再点击不关闭（Windows/VS Code 均如此），用 Esc 或
 *   点击外部关闭——否则「移入再点击」会被 Radix 当 toggle 立即关上；
 *
 * 注意：trigger 不能被拖拽区吞掉。Tauri 的 drag region 脚本只拦截
 * 自己带 `data-tauri-drag-region` 属性的目标，这里的按钮不具备该属性，
 * 所以点击/悬停事件都能正常到达。
 */
export function MenuBar({ sections }: { sections: MenuSectionSpec[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const openIdRef = useRef(openId)
  openIdRef.current = openId

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {sections.map((section) => (
        <DropdownMenu.Root
          key={section.id}
          open={openId === section.id}
          onOpenChange={(open) => setOpenId(open ? section.id : null)}
        >
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              onPointerEnter={() => {
                // 已有菜单打开时，滑过其它菜单直接切换（桌面应用习惯）。
                if (openIdRef.current !== null && openIdRef.current !== section.id) {
                  setOpenId(section.id)
                }
              }}
              // 已打开的菜单再点一次不收起（详见组件注释）；
              // detail>0 过滤掉键盘 Enter/Space 触发的 click，键盘仍可正常开合。
              onClick={(event) => {
                if (event.detail > 0 && openIdRef.current === section.id) event.preventDefault()
              }}
              className={cn(
                'flex h-7 items-center rounded-md px-2 text-[12px] leading-none transition',
                openId === section.id
                  ? 'bg-surface0 text-text'
                  : 'text-subtext hover:bg-surface0/80 hover:text-text',
              )}
            >
              {section.label}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={6}
              className={CONTENT_CLASS}
            >
              <Entries entries={section.entries} />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ))}
    </div>
  )
}

const SUB_TRIGGER_CLASS = ITEM_CLASS + ' pr-1.5'

function Entries({ entries }: { entries: MenuEntry[] }) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') {
          return <DropdownMenu.Separator key={`sep-${index}`} className="my-1 h-px bg-surface0/60" />
        }
        if (entry.kind === 'submenu') {
          return (
            <DropdownMenu.Sub key={entry.id}>
              <DropdownMenu.SubTrigger className={SUB_TRIGGER_CLASS}>
                <span />
                <span className="truncate">{entry.label}</span>
                <ChevronRight size={12} className="col-start-3 text-overlay0" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent sideOffset={4} className={CONTENT_CLASS}>
                  <Entries entries={entry.items} />
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          )
        }
        return (
          <DropdownMenu.Item
            key={entry.id}
            disabled={entry.disabled}
            onSelect={() => {
              if (entry.command) runCommand(entry.command)
              entry.onSelect?.()
            }}
            className={ITEM_CLASS}
          >
            <span className="col-start-1 text-blue">
              {entry.checked ? <Check size={12} /> : null}
            </span>
            <span className="col-start-2 truncate">{entry.label}</span>
            {entry.kb && (
              <span className="col-start-3 text-[10px] tabular-nums text-overlay0">{entry.kb}</span>
            )}
          </DropdownMenu.Item>
        )
      })}
    </>
  )
}
