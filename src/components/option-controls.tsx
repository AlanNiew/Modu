import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

/**
 * 设置控件三件套：滑杆、分段按钮、开关行。
 *
 * 阅读快速面板（Popover 窄幅）与设置页（宽幅）共用同一套视觉与语义，
 * 只允许出现在这里定义：两处联调出问题只改一份。
 */

export function SliderRow({
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

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  columns,
}: {
  options: ReadonlyArray<{ id: T; label: string; title?: string }>
  value: T
  onChange: (id: T) => void
  /** 默认按选项数平分；需要换行时可显式指定列数。 */
  columns?: number
}) {
  return (
    <div
      className="grid gap-1 rounded-lg bg-surface0/50 p-1"
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            'truncate rounded-md py-1.5 text-[11px] transition',
            value === option.id
              ? 'bg-surface1 text-text'
              : 'text-overlay0 hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  /** 置灰（如便携版不支持开机自启）。 */
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-center justify-between text-[11px] text-subtext',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="flex flex-col">
        <span>{label}</span>
        {description && <span className="text-[10px] text-overlay0/70">{description}</span>}
      </span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative h-4 w-8 shrink-0 rounded-full bg-surface1 transition data-[state=checked]:bg-blue"
      >
        <Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-text transition-transform data-[state=checked]:translate-x-4" />
      </Switch.Root>
    </label>
  )
}
