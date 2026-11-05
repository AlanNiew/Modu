import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

interface HelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface Row {
  keys: string[]
  label: string
}

interface Group {
  title: string
  rows: Row[]
}

const GROUPS: Group[] = [
  {
    title: '翻页与导航',
    rows: [
      { keys: ['→', 'PageDown', '空格'], label: '下一页 / 下一屏' },
      { keys: ['←', 'PageUp'], label: '上一页 / 上一屏' },
      { keys: ['滚轮下滑'], label: '翻到下一页（滚动模式下为连续滚动）' },
      { keys: ['点击左侧 30%'], label: '上一页' },
      { keys: ['点击右侧 30%'], label: '下一页' },
      { keys: ['Esc'], label: '退出沉浸模式 / 返回书架' },
    ],
  },
  {
    title: '书与批注',
    rows: [
      { keys: ['Ctrl', 'D'], label: '当前位置加书签' },
      { keys: ['选中文本'], label: '弹出工具条：四色划线或写批注' },
      { keys: ['Ctrl', 'K'], label: '打开侧栏搜索并聚焦输入框' },
      { keys: ['Ctrl', 'B'], label: '显示 / 隐藏侧栏' },
    ],
  },
  {
    title: '视图',
    rows: [
      { keys: ['F11'], label: '全屏 / 退出全屏' },
      { keys: ['F1'], label: '打开这个帮助面板' },
      { keys: ['Ctrl', '滚轮'], label: '交给系统缩放（不翻页）' },
    ],
  },
]

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-crust/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-surface0 bg-mantle p-5 shadow-2xl shadow-black/50 outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-text">快捷键与帮助</Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] text-overlay0">
                墨读的大部分操作都有键盘入口，下面是完整清单。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭帮助"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-subtext transition hover:bg-surface0 hover:text-text"
              >
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-4 space-y-4">
            {GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-overlay0">
                  {group.title}
                </h3>
                <ul className="space-y-1">
                  {group.rows.map((row) => (
                    <li
                      key={row.label}
                      className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 odd:bg-surface0/25"
                    >
                      <span className="text-[12px] text-subtext">{row.label}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {row.keys.map((key) => (
                          <kbd
                            key={key}
                            className="rounded border border-surface1 bg-crust/70 px-1.5 py-0.5 font-mono text-[10px] text-subtext"
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-overlay0/80">
            提示：框选正文后点颜色圆点即可划线；点已有划线会跳到批注面板。滚轮翻页有 320ms
            冷却，避免触控板一滑翻过好几页。
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
