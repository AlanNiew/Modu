import * as Popover from '@radix-ui/react-popover'
import { RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'

import { Segmented, SliderRow, SwitchRow } from '../../components/option-controls'
import { cn } from '../../lib/cn'
import {
  ALIGN_OPTIONS,
  FLOW_OPTIONS,
  indentEnabledToEm,
  indentEmToEnabled,
} from '../../renderer/reading-options'
import { FONT_STACKS, THEME_OPTIONS, themeSwatch } from '../../renderer/theme'
import { useReaderSettings } from '../../store/settings'

interface ReadingSettingsPanelProps {
  children: ReactNode
}

/** 快速面板的字体三分类入口（完整列表在 P3 的设置-排版开放）。 */
const FONT_OPTIONS: ReadonlyArray<{ kind: 'serif' | 'sans' | 'kai'; label: string }> = [
  { kind: 'serif', label: '宋体' },
  { kind: 'sans', label: '黑体' },
  { kind: 'kai', label: '楷体' },
]

/**
 * 阅读排版快速面板（阅读页标题栏保留的常用子集，P1 起由 App 渲染）。
 *
 * 这里是阅读中的高频调整入口；数据直接读 `useReaderSettings`，
 * 与设置页共享同一份持久化状态。完整设置页提供全量自定义（含字体
 * 预设列表与自定义导入，见 P3；页边距等回归项见 P2）。
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
              {/* 4 列 × 2 排：8 套主题正好排满，与设置页网格同口径 */}
              <div className="grid grid-cols-4 gap-1.5">
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

            <Segmented
              options={FONT_OPTIONS.map(({ kind, label }) => ({ id: kind, label }))}
              value={activeFont}
              onChange={(kind) => onFontKind(kind)}
            />

            <div className="space-y-2">
              <div className="text-[11px] text-subtext">阅读方式</div>
              <Segmented options={FLOW_OPTIONS} value={settings.flow} onChange={(flow) => onPatch({ flow })} />
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
              min={1.2}
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
              <Segmented options={ALIGN_OPTIONS} value={settings.textAlign} onChange={(textAlign) => onPatch({ textAlign })} />
            </div>

            <SwitchRow
              label="净版（忽略书内排版）"
              description="排版花乱的老书可以打开"
              checked={!settings.respectPublisherStyles}
              onChange={(checked) => onPatch({ respectPublisherStyles: !checked })}
            />

            <div className="border-t border-surface0/70 pt-3">
              <SwitchRow
                label="段落首行缩进"
                checked={indentEmToEnabled(settings.paragraphIndent)}
                onChange={(checked) => onPatch({ paragraphIndent: indentEnabledToEm(checked) })}
              />
            </div>

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
