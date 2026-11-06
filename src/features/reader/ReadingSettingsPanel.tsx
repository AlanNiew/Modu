import * as Popover from '@radix-ui/react-popover'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import { RotateCcw } from 'lucide-react'

import { cn } from '../../lib/cn'
import {
  FONT_STACKS,
  THEME_OPTIONS,
  type ReadingFlow,
  themeSwatch,
} from '../../renderer/theme'
import { useReaderSettings } from '../../store/settings'

const ALIGN_OPTIONS: Array<{ id: 'justify' | 'left'; label: string }> = [
  { id: 'justify', label: '两端对齐' },
  { id: 'left', label: '左对齐' },
]

const FLOW_OPTIONS: Array<{ id: ReadingFlow; label: string }> = [
  { id: 'paginated', label: '翻页' },
  { id: 'scrolled', label: '滚动' },
]

const FONT_OPTIONS: Array<{ kind: 'serif' | 'sans' | 'kai'; label: string }> = [
  { kind: 'serif', label: '宋体' },
  { kind: 'sans', label: '黑体' },
  { kind: 'kai', label: '楷体' },
]

interface ReadingSettingsPanelProps {
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
 * 阅读排版快速面板（阅读页标题栏保留的常用子集，P1 起由 App 渲染）。
 *
 * 这里是阅读中的高频调整入口；数据直接读 `useReaderSettings`，
 * 与设置页共享同一份持久化状态。完整设置页（后续阶段的排版/转换/
 * 行为分组）提供全量自定义。
 */
export function ReadingSettingsPanel({ children }: ReadingSettingsPanelProps) {
  const settings = useReaderSettings((state) => state.settings)
  const onPatch = useReaderSettings((state) => state.patch)
  const onFontKind = useReaderSettings((state) => state.setFontFamilyKind)
  const onReset = useReaderSettings((state) => state.reset)
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

            <div className="space-y-2">
              <div className="text-[11px] text-subtext">阅读方式</div>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface0/50 p-1">
                {FLOW_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onPatch({ flow: option.id })}
                    className={cn(
                      'rounded-md py-1.5 text-[11px] transition',
                      settings.flow === option.id
                        ? 'bg-surface1 text-text'
                        : 'text-overlay0 hover:text-text',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="px-1 text-[10px] leading-relaxed text-overlay0/70">
                翻页：左右翻，滚轮一滑翻一页；滚动：上下连续滑动
              </div>
            </div>

            <SliderRow
              label="字号"
              value={settings.fontSize}
              suffix=" px"
              min={14}
              max={32}
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
            <SliderRow
              label="段后间距"
              value={Number(settings.paragraphSpacing.toFixed(2))}
              suffix=" em"
              min={0}
              max={1.6}
              step={0.04}
              onChange={(paragraphSpacing) => onPatch({ paragraphSpacing })}
            />
            <SliderRow
              label="字间距"
              value={Number(settings.letterSpacing.toFixed(2))}
              suffix=" em"
              min={-0.02}
              max={0.2}
              step={0.01}
              onChange={(letterSpacing) => onPatch({ letterSpacing })}
            />

            <div className="space-y-2">
              <div className="text-[11px] text-subtext">正文对齐</div>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface0/50 p-1">
                {ALIGN_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onPatch({ textAlign: option.id })}
                    className={cn(
                      'rounded-md py-1.5 text-[11px] transition',
                      settings.textAlign === option.id
                        ? 'bg-surface1 text-text'
                        : 'text-overlay0 hover:text-text',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between text-[11px] text-subtext">
              <span className="flex flex-col">
                <span>净版（忽略书内排版）</span>
                <span className="text-[10px] text-overlay0/70">排版花乱的老书可以打开</span>
              </span>
              <Switch.Root
                checked={!settings.respectPublisherStyles}
                onCheckedChange={(checked) =>
                  onPatch({ respectPublisherStyles: !checked })
                }
                className="relative h-4 w-8 shrink-0 rounded-full bg-surface1 transition data-[state=checked]:bg-blue"
              >
                <Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-text transition-transform data-[state=checked]:translate-x-4" />
              </Switch.Root>
            </label>

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
