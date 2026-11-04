import * as Popover from '@radix-ui/react-popover'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import { RotateCcw } from 'lucide-react'

import { cn } from '../../lib/cn'
import {
  FONT_STACKS,
  THEME_OPTIONS,
  getReadingTheme,
  type ReadingSettings,
  type ThemeId,
} from '../../renderer/theme'

const FONT_OPTIONS: Array<{ kind: 'serif' | 'sans' | 'kai'; label: string }> = [
  { kind: 'serif', label: '宋体' },
  { kind: 'sans', label: '黑体' },
  { kind: 'kai', label: '楷体' },
]

/** 主题色块：具体主题用「纸色 + 强调色」斜切，auto 用深浅对半。 */
function themeSwatch(theme: ThemeId): string {
  if (theme === 'auto') {
    return 'conic-gradient(from 210deg, #1e1e2e 0 50%, #eff1f5 50% 100%)'
  }
  const palette = getReadingTheme(theme)
  return `linear-gradient(135deg, ${palette.background} 0 58%, ${palette.accent} 58% 100%)`
}

interface ReadingSettingsPanelProps {
  settings: ReadingSettings
  onPatch: (partial: Partial<ReadingSettings>) => void
  onFontKind: (kind: 'serif' | 'sans' | 'kai') => void
  onReset: () => void
  children: React.ReactNode
}

function SliderRow({
  label,
  value,
  suffix,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  suffix?: string
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-subtext">
        <span>{label}</span>
        <span className="tabular-nums text-overlay0">
          {value}
          {suffix}
        </span>
      </div>
      <Slider.Root
        className="relative flex h-4 w-full touch-none select-none items-center"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      >
        <Slider.Track className="relative h-1 grow rounded-full bg-surface0">
          <Slider.Range className="absolute h-full rounded-full bg-blue/80" />
        </Slider.Track>
        <Slider.Thumb className="block h-3.5 w-3.5 rounded-full bg-text shadow outline-none transition hover:bg-blue focus-visible:ring-2 focus-visible:ring-blue/60" />
      </Slider.Root>
    </div>
  )
}

/**
 * 阅读排版面板。
 *
 * 选项刻意克制：主题、字体、字号、行高、版心、首行缩进——这六项覆盖了
 * 中文阅读的绝大多数诉求；两端对齐和页边距这种「调了只会更难看」的参数
 * 直接固定，不再暴露给用户。
 */
export function ReadingSettingsPanel({
  settings,
  onPatch,
  onFontKind,
  onReset,
  children,
}: ReadingSettingsPanelProps) {
  const activeFont =
    settings.fontFamily === FONT_STACKS.sans
      ? 'sans'
      : settings.fontFamily === FONT_STACKS.kai
        ? 'kai'
        : 'serif'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-50 w-76 rounded-xl border border-surface0 bg-mantle p-4 text-text shadow-2xl shadow-black/40 outline-none"
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-[11px] text-subtext">阅读主题</div>
              <div className="grid grid-cols-5 gap-1.5">
                {THEME_OPTIONS.map((option) => {
                  const active = settings.theme === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onPatch({ theme: option.id })}
                      title={option.label}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-lg border p-1.5 transition',
                        active
                          ? 'border-blue ring-1 ring-blue/40'
                          : 'border-surface0 hover:border-overlay0',
                      )}
                    >
                      <span
                        className="h-5 w-full rounded"
                        style={{ background: themeSwatch(option.id) }}
                      />
                      <span className="text-[10px] text-subtext">{option.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] text-subtext">字体</div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface0/50 p-1">
                {FONT_OPTIONS.map((option) => (
                  <button
                    key={option.kind}
                    type="button"
                    onClick={() => onFontKind(option.kind)}
                    className={cn(
                      'rounded-md py-1.5 text-[11px] transition',
                      activeFont === option.kind
                        ? 'bg-surface1 text-text'
                        : 'text-overlay0 hover:text-text',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <SliderRow
              label="字号"
              value={settings.fontSize}
              suffix=" px"
              min={13}
              max={34}
              step={1}
              onChange={(fontSize) => onPatch({ fontSize })}
            />
            <SliderRow
              label="行高"
              value={Number(settings.lineHeight.toFixed(2))}
              min={1.3}
              max={2.4}
              step={0.05}
              onChange={(lineHeight) => onPatch({ lineHeight })}
            />
            <SliderRow
              label="版心宽度"
              value={settings.pageWidth}
              suffix=" px"
              min={520}
              max={1000}
              step={20}
              onChange={(pageWidth) => onPatch({ pageWidth })}
            />

            <label className="flex items-center justify-between border-t border-surface0/70 pt-3 text-[11px] text-subtext">
              <span>段落首行缩进</span>
              <Switch.Root
                checked={settings.paragraphIndent > 0}
                onCheckedChange={(checked) => onPatch({ paragraphIndent: checked ? 2 : 0 })}
                className="relative h-4 w-8 rounded-full bg-surface1 transition data-[state=checked]:bg-blue"
              >
                <Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-text transition-transform data-[state=checked]:translate-x-4" />
              </Switch.Root>
            </label>

            <button
              type="button"
              onClick={onReset}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface0 py-1.5 text-[11px] text-overlay0 transition hover:border-overlay0 hover:text-text"
            >
              <RotateCcw size={12} />
              恢复默认排版
            </button>
          </div>
          <Popover.Arrow className="fill-mantle" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
