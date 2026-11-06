import { getVersion } from '@tauri-apps/api/app'
import { open } from '@tauri-apps/plugin-dialog'
import { Check, Info, Loader2, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Segmented, SliderRow, SwitchRow } from '../../components/option-controls'
import {
  ALIGN_OPTIONS,
  FLOW_OPTIONS,
  FONT_PRESETS,
  indentEnabledToEm,
  indentEmToEnabled,
} from '../../renderer/reading-options'
import { importFont, listFonts, removeFont } from '../../lib/ipc'
import { cn } from '../../lib/cn'
import {
  THEME_OPTIONS,
  type ThemeId,
  themeSwatch,
} from '../../renderer/theme'
import { fontStackLabel, useReaderSettings } from '../../store/settings'
import type { InstalledFont } from '../../lib/types'

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
 * 设置页（P2：外观 + 排版全量 + 行为可用；转换占位 P4）。
 *
 * 这些设置持久化在 `modu:reader-settings`（localStorage），阅读页的排版
 * 快速面板与本页共享同一份状态：本页是「全量版」，快速面板是常用子集。
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
        <div className="mx-auto w-full max-w-2xl space-y-8 px-8 py-8">
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'typography' && <TypographySection />}
          {tab === 'conversion' && (
            <PlaceholderSection
              title="转换"
              items={['繁体自动转简体（默认关闭，进入渲染前统一转换，与全书搜索口径一致）']}
              note="该功能依赖 Rust 侧繁简词典，将在后续阶段开放。"
            />
          )}
          {tab === 'behavior' && <BehaviorSection />}
          {tab === 'about' && <AboutSection onCheckUpdate={onCheckUpdate} />}
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="text-[15px] font-semibold text-text">{children}</h2>
}

/** 设置分组通用骨架：标题 + 内容 + 底部说明。 */
function Group({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <SectionTitle>{title}</SectionTitle>
      <div className="space-y-4">{children}</div>
      {note && <p className="text-[11px] leading-relaxed text-overlay0">{note}</p>}
    </section>
  )
}

/** 外观：主题（5 选）+ 正文对齐。 */
function AppearanceSection() {
  const theme = useReaderSettings((state) => state.settings.theme)
  const textAlign = useReaderSettings((state) => state.settings.textAlign)
  const setTheme = useReaderSettings((state) => state.setTheme)
  const patch = useReaderSettings((state) => state.patch)

  return (
    <>
      <Group title="主题" note="主题同时作用于界面外壳与正文页面；「跟随系统」会随 Windows 深浅色设置实时切换。">
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
      </Group>
      <Group title="正文对齐" note="中文正文默认两端对齐；中英混排的书选「左对齐」可能更自然。">
        <Segmented options={ALIGN_OPTIONS} value={textAlign} onChange={(textAlign) => patch({ textAlign })} />
      </Group>
    </>
  )
}

/** 排版：全量排版选项（字体分组随 P3 扩充导入）。 */
function TypographySection() {
  // 字段级订阅：任一滑杆拖动只让本分组内的读取点重渲，
  // 避免整库订阅把 App/标题栏/其它分组全带起来。
  const flow = useReaderSettings((state) => state.settings.flow)
  const fontSize = useReaderSettings((state) => state.settings.fontSize)
  const lineHeight = useReaderSettings((state) => state.settings.lineHeight)
  const pagePadding = useReaderSettings((state) => state.settings.pagePadding)
  const pageWidth = useReaderSettings((state) => state.settings.pageWidth)
  const paragraphSpacing = useReaderSettings((state) => state.settings.paragraphSpacing)
  const letterSpacing = useReaderSettings((state) => state.settings.letterSpacing)
  const paragraphIndent = useReaderSettings((state) => state.settings.paragraphIndent)
  const respectPublisherStyles = useReaderSettings((state) => state.settings.respectPublisherStyles)
  const fontFamily = useReaderSettings((state) => state.settings.fontFamily)
  const patch = useReaderSettings((state) => state.patch)
  const reset = useReaderSettings((state) => state.reset)
  const setFontFamily = useReaderSettings((state) => state.setFontFamily)

  return (
    <>
      <Group
        title="版式"
        note="修改立即生效并重新分栏，阅读位置自动跟随。"
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="text-[11px] text-subtext">阅读流向</div>
            <Segmented options={FLOW_OPTIONS} value={flow} onChange={(flow) => patch({ flow })} />
          </div>
          <SliderRow
            label="字号"
            value={fontSize}
            suffix=" px"
            min={14}
            max={32}
            step={1}
            onChange={(fontSize) => patch({ fontSize })}
          />
          <SliderRow
            label="行高"
            value={Number(lineHeight.toFixed(2))}
            min={1.2}
            max={2.4}
            step={0.05}
            onChange={(lineHeight) => patch({ lineHeight })}
          />
          <SliderRow
            label="页边距"
            value={pagePadding}
            suffix=" px"
            min={0}
            max={64}
            step={4}
            onChange={(pagePadding) => patch({ pagePadding })}
          />
          <SliderRow
            label="版心宽度"
            value={pageWidth}
            suffix=" px"
            min={520}
            max={1000}
            step={20}
            onChange={(pageWidth) => patch({ pageWidth })}
          />
          <SliderRow
            label="段落间距"
            value={Number(paragraphSpacing.toFixed(2))}
            suffix=" em"
            min={0}
            max={1.6}
            step={0.04}
            onChange={(paragraphSpacing) => patch({ paragraphSpacing })}
          />
          <SliderRow
            label="字间距"
            value={Number(letterSpacing.toFixed(2))}
            suffix=" em"
            min={-0.02}
            max={0.2}
            step={0.01}
            onChange={(letterSpacing) => patch({ letterSpacing })}
          />
        </div>
      </Group>

      <Group title="段落与净版">
        <SwitchRow
          label="段落首行缩进（2 字）"
          description="关闭后所有段落不缩进（西文书常用）"
          checked={indentEmToEnabled(paragraphIndent)}
          onChange={(checked) => patch({ paragraphIndent: indentEnabledToEm(checked) })}
        />
        <SwitchRow
          label="净版模式（忽略书内排版）"
          description="只按本应用的排版渲染，只适合排版花乱的老书"
          checked={!respectPublisherStyles}
          onChange={(checked) => patch({ respectPublisherStyles: !checked })}
        />
      </Group>

      <Group
        title="字体"
        note="预设命中不了（本机未安装）时会回退到系统默认；「霞鹜文楷」等免费字体需本机已安装或从下方导入字体文件。"
      >
        <div className="space-y-2">
          <Segmented
            options={FONT_PRESETS.map(({ id, label, hint }) => ({ id, label, title: hint }))}
            value={
              // 当前字体栈命中某个预设就用其 id；自定义字体/未知栈显示空。
              FONT_PRESETS.find((preset) => preset.stack === fontFamily)?.id ?? ''
            }
            onChange={(id) => {
              const preset = FONT_PRESETS.find((item) => item.id === id)
              if (preset) setFontFamily(preset.stack)
            }}
            columns={5}
          />
          <p className="text-[11px] text-overlay0">
            悬停预览各字体类型；当前字体：
            <span className="font-medium text-text">{fontStackLabel(fontFamily)}</span>
          </p>
        </div>
      </Group>
      <CustomFontsGroup />

      <section className="space-y-3 border-t border-surface0/60 pt-5">
        <SectionTitle>恢复默认</SectionTitle>
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1.5 rounded-lg border border-surface0 px-3 py-2 text-[12px] text-overlay0 transition hover:border-overlay0 hover:text-text"
        >
          <RotateCcw size={13} />
          恢复全部排版与外观默认值
        </button>
        <p className="text-[11px] text-overlay0">不影响书架、进度、书签与批注数据。</p>
      </section>
    </>
  )
}

/** 行为：更新检查（迁移自更新面板）+ P5 占位。 */
function BehaviorSection() {
  // autoCheck 自 P2 起并入 settings store：这里是唯一的读写入口，
  // 与 App 的启动静默检查共享一份状态，不存在镜像漂移。
  const autoCheck = useReaderSettings((state) => state.autoCheck)
  const setAutoCheck = useReaderSettings((state) => state.setAutoCheck)

  return (
    <>
      <Group
        title="软件更新"
        note="更新包会先校验签名再静默安装，完成后自动重启；书架、进度、书签与批注数据不受影响。"
      >
        <SwitchRow
          label="启动时自动检查更新"
          checked={autoCheck}
          onChange={setAutoCheck}
        />
      </Group>
      <PlaceholderSection
        title="窗口与系统"
        items={[
          '关闭窗口行为（询问一次并记忆 / 直接退出 / 最小化到托盘）',
          '开机自启 · 系统托盘',
        ]}
        note="托盘与关闭询问依赖 Rust 侧生命周期，将在后续阶段开放。"
      />
    </>
  )
}

/**
 * 自定义字体管理（P3）：文件复制进 `<数据目录>/fonts/`，家族名由 Rust
 * 解析后在这里与磁盘对账。删除只影响阅读排版（内置预设不受影响）。
 */

/** 磁盘对账：保留仍在盘上的条目，并补上盘上新增的解析结果。 */
function mergeWithDisk(
  fonts: InstalledFont[],
  onDisk: InstalledFont[],
): InstalledFont[] {
  const diskFiles = new Set(onDisk.map((font) => font.file))
  return [
    ...fonts.filter((font) => diskFiles.has(font.file)),
    ...onDisk.filter((font) => !fonts.some((item) => item.file === font.file)),
  ]
}

function CustomFontsGroup() {
  const customFonts = useReaderSettings((state) => state.customFonts)
  const currentFamily = useReaderSettings((state) => state.settings.fontFamily)
  const setCustomFonts = useReaderSettings((state) => state.setCustomFonts)
  const setFontFamily = useReaderSettings((state) => state.setFontFamily)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleImport = useCallback(async () => {
    setError(null)
    setImporting(true)
    try {
      const ctx = useReaderSettings.getState()
      // 导入前先与磁盘对账：丢掉已被手动删掉的条目，避免幽灵项。
      const onDisk = await listFonts()
      let fonts = mergeWithDisk(ctx.customFonts, onDisk)
      const picked = await open({
        multiple: true,
        filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
      })
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
      const fresh: InstalledFont[] = []
      for (const path of paths) {
        // 同名文件重复导入视为替换（Rust 侧覆盖写文件，家族名随之更新）。
        // 若中途某本失败，前面已写入磁盘的字体会在下一次导入的对账中
        // 自动收编（installed 期间未写 store 不会丢），不需要回滚事务。
        const installed = await importFont(path)
        fonts = fonts.filter((font) => font.file !== installed.file)
        fresh.push(installed)
      }
      if (fresh.length > 0) {
        fonts = [...fonts, ...fresh]
        setCustomFonts(fonts)
        // 应用最后导入的字体（多个一起导时用户期望直接看到效果）。
        setFontFamily(fresh[fresh.length - 1].family)
      } else if (paths.length === 0) {
        // 用户在对话框里取消：仍然把对账结果写回，静默清理幽灵项。
        if (fonts.length !== ctx.customFonts.length) setCustomFonts(fonts)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setImporting(false)
    }
  }, [setCustomFonts, setFontFamily])

  const handleRemove = useCallback(
    async (font: InstalledFont) => {
      try {
        await removeFont(font.file)
        const state = useReaderSettings.getState()
        const next = state.customFonts.filter((item) => item.file !== font.file)
        setCustomFonts(next)
        // 删除的恰是正在用的字体：回退到默认宋体栈，而不是残留一个
        // 已不存在的 @font-face 家族名（否则正文会悄悄落到系统字体，
        // 与 UI 的「当前高亮」口径不一致）。
        if (state.settings.fontFamily === font.family) {
          setFontFamily(FONT_PRESETS[0].stack)
        }
      } catch (err) {
        setError(String(err))
      }
    },
    [setCustomFonts, setFontFamily],
  )

  return (
    <Group
      title="自定义字体"
      note="支持 ttf / otf / ttc / woff / woff2；woff 系无裸 name 表，呈现名取文件主名。导入后可在上方「字体」里选择（也可以直接点条目应用）。"
    >
      {error && <p className="text-[11px] text-red">{error}</p>}
      {customFonts.length === 0 ? (
        <p className="text-[11px] text-overlay0">还没有导入自定义字体。</p>
      ) : (
        <ul className="space-y-1.5">
          {customFonts.map((font) => (
            <li
              key={font.file}
              className={cn(
                'flex items-center gap-2 rounded-lg border bg-mantle/40 px-3 py-2',
                currentFamily === font.family
                  ? 'border-blue bg-blue/10'
                  : 'border-surface0',
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setFontFamily(font.family)}
                title="应用该字体"
              >
                <span className="block truncate text-[12.5px] text-text">{font.family}</span>
                <span className="block truncate text-[10px] text-overlay0">{font.file}</span>
              </button>
              {currentFamily === font.family && <Check size={14} className="shrink-0 text-blue" />}
              <button
                type="button"
                title="删除该字体（内置预设不受影响）"
                onClick={() => void handleRemove(font)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-overlay0 transition hover:bg-surface0 hover:text-red"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => void handleImport()}
        disabled={importing}
        className="flex items-center gap-1.5 rounded-lg border border-surface0 px-3 py-2 text-[12px] text-subtext transition hover:border-surface1 hover:text-text disabled:opacity-50"
      >
        {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        {importing ? '正在导入…' : '导入字体文件…'}
      </button>
    </Group>
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

/** 尚未开放分组的占位说明（后续阶段逐个替换）。 */
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
