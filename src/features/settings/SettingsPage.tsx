import { getVersion } from '@tauri-apps/api/app'
import { Check, Info } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cn } from '../../lib/cn'
import { THEME_OPTIONS, type ThemeId, themeSwatch } from '../../renderer/theme'
import { useReaderSettings } from '../../store/settings'

export type SettingsTabId = 'appearance' | 'typography' | 'conversion' | 'behavior' | 'about'

const TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: 'appearance', label: '外观' },
  { id: 'typography', label: '排版' },
  { id: 'conversion', label: '转换' },
  { id: 'behavior', label: '行为' },
  { id: 'about', label: '关于' },
]

interface SettingsPageProps {
  /** 从菜单「关于墨读」进入时直接落在「关于」分组；null = 默认分组。 */
  initialTab?: SettingsTabId | null
  /** 「关于」页的检查更新按钮：由 App 打开统一的更新面板。 */
  onCheckUpdate: () => void
}

/**
 * 设置页（P1：骨架 + 外观分组可用）。
 *
 * 后续阶段逐步解锁：
 * - 排版：字体（扩充预设 + 用户自定义导入）/字号/行高/缩进/段距/字距/页边距/版心/流向/净版
 * - 转换：繁体→简体
 * - 行为：更新检查/关闭窗口行为/开机自启/托盘
 *
 * 这些设置本来就持久化在 `modu:reader-settings` 里，本页只是换一个
 * 「固定入口、可完整自定义」的家；阅读页的排版快速面板继续保留常用子集。
 */
export function SettingsPage({ initialTab = null, onCheckUpdate }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTabId>(initialTab ?? 'appearance')

  return (
    <div className="flex h-full min-h-0 bg-base text-text">
      <nav className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-surface0/60 bg-mantle/40 p-2">
        <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-widest text-overlay0/70">
          设置
        </p>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              'flex h-8 items-center rounded-md px-3 text-left text-[13px] transition',
              tab === item.id
                ? 'bg-surface0 text-text'
                : 'text-subtext hover:bg-surface0/50 hover:text-text',
            )}
          >
            {item.label}
          </button>
        ))}
        <div className="mt-auto px-3 pb-1 text-[10px] text-overlay0/60">
          墨读 {__APP_VERSION__ ? `v${__APP_VERSION__}` : ''}
        </div>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-8 py-8">
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'typography' && (
            <PlaceholderSection
              title="排版"
              items={[
                '字体（扩充预设 + 用户自定义导入）',
                '字号 / 行高 / 字间距',
                '段落缩进 / 段间距 / 页边距 / 版心宽',
                '阅读流向（翻页 / 滚动）与净版模式',
              ]}
              note="该分组将在下一阶段开放；当前可继续使用阅读页标题栏的「排版」快速面板调整这些设置。"
            />
          )}
          {tab === 'conversion' && (
            <PlaceholderSection
              title="转换"
              items={['繁体自动转简体（默认关闭，进入渲染前统一转换，与全书搜索口径一致）']}
              note="该功能依赖 Rust 侧繁简词典，将在后续阶段开放。"
            />
          )}
          {tab === 'behavior' && (
            <PlaceholderSection
              title="行为"
              items={[
                '启动时自动检查更新（从更新面板迁入）',
                '关闭窗口行为（询问一次并记忆 / 直接退出 / 最小化到托盘）',
                '开机自启 · 系统托盘',
              ]}
              note="托盘与关闭询问将在后续阶段开放。"
            />
          )}
          {tab === 'about' && <AboutSection onCheckUpdate={onCheckUpdate} />}
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="text-[15px] font-semibold text-text">{children}</h2>
}

/** 外观：主题（跟随系统 / 深色 / 浅色 / 羊皮纸 / 护眼绿）+ 正文对齐。 */
function AppearanceSection() {
  const theme = useReaderSettings((state) => state.settings.theme)
  const textAlign = useReaderSettings((state) => state.settings.textAlign)
  const setTheme = useReaderSettings((state) => state.setTheme)
  const patch = useReaderSettings((state) => state.patch)

  return (
    <section className="space-y-4">
      <SectionTitle>主题</SectionTitle>
      <div className="flex flex-wrap gap-3 pt-1">
        {THEME_OPTIONS.map((option) => {
          const active: boolean = theme === option.id
          return (
            <ThemeButton
              key={option.id}
              id={option.id}
              label={option.label}
              active={active}
              onSelect={() => setTheme(option.id)}
            />
          )
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-overlay0">
        主题同时作用于界面外壳与正文页面；「跟随系统」会随 Windows 深浅色设置实时切换。
      </p>

      <SectionTitle>正文对齐</SectionTitle>
      <div className="flex gap-1 self-start rounded-lg border border-surface0 bg-mantle p-0.5 w-fit">
        {(
          [
            { id: 'justify', label: '两端对齐' },
            { id: 'left', label: '左对齐' },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => patch({ textAlign: option.id })}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] transition',
              textAlign === option.id
                ? 'bg-surface0 text-text'
                : 'text-overlay1 hover:text-subtext',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-overlay0">
        中文正文默认两端对齐；中英混排的书选「左对齐」可能更自然。
      </p>
    </section>
  )
}

function ThemeButton({
  id,
  label,
  active,
  onSelect,
}: {
  id: ThemeId
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-[118px] flex-col items-center gap-2 rounded-lg border px-3 py-4 text-[12px] transition',
        active
          ? 'border-blue bg-blue/10 text-text'
          : 'border-surface0 text-subtext hover:border-surface1 hover:text-text',
      )}
    >
      <span
        className="h-10 w-16 rounded-md border border-surface0 shadow-inner shadow-black/10"
        style={{ background: themeSwatch(id) }}
      />
      <span className="flex items-center gap-1">
        {active && <Check size={12} className="text-blue" />}
        {label}
      </span>
    </button>
  )
}

/** 尚未开放分组的占位说明（P2 起逐个替换）。 */
function PlaceholderSection({
  title,
  items,
  note,
}: {
  title: string
  items: string[]
  note: string
}) {
  return (
    <section className="space-y-3">
      <SectionTitle>{title}</SectionTitle>
      <div className="rounded-lg border border-dashed border-surface1 bg-mantle/50 p-4">
        <ul className="space-y-1.5 text-[12px] text-subtext">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-surface2" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] leading-relaxed text-overlay0">{note}</p>
      </div>
    </section>
  )
}

function AboutSection({ onCheckUpdate }: { onCheckUpdate: () => void }) {
  const [version, setVersion] = useState<string | null>(null)

  // 版本从打包元数据读取（与 tauri.conf.json / latest.json 同源）；
  // 读取失败时回退到构建时注入的 package.json 版本。
  useEffect(() => {
    let disposed = false
    void getVersion()
      .then((value) => {
        if (!disposed) setVersion(value)
      })
      .catch(() => {
        if (!disposed) setVersion(__APP_VERSION__)
      })
    return () => {
      disposed = true
    }
  }, [])

  return (
    <section className="space-y-4">
      <SectionTitle>关于墨读</SectionTitle>
      <div className="flex items-start gap-3 rounded-lg border border-surface0/70 bg-mantle/50 p-4">
        <Info size={18} className="mt-0.5 shrink-0 text-blue" />
        <div className="space-y-1 text-[12px] text-subtext">
          <p>
            当前版本：
            <span className="font-medium text-text">v{version ?? __APP_VERSION__}</span>
          </p>
          <p className="text-[11px] text-overlay0">
            更新包会校验签名后静默安装；书架、进度、书签与批注数据不受影响。
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onCheckUpdate}
        className="rounded-md bg-blue px-3 py-1.5 text-[12px] font-medium text-crust transition hover:brightness-110"
      >
        检查软件更新…
      </button>
    </section>
  )
}
