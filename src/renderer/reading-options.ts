import type { ReadingFlow } from './theme'
import { THEME_OPTIONS } from './theme'

/**
 * 排版相关的共享选项元数据：阅读快速面板与设置页用同一份，
 * 避免出现「面板一套标签、设置页一套标签」的双源。
 */

export const FLOW_OPTIONS: ReadonlyArray<{ id: ReadingFlow; label: string }> = [
  { id: 'paginated', label: '翻页' },
  { id: 'scrolled', label: '滚动' },
]

export const ALIGN_OPTIONS: ReadonlyArray<{ id: 'justify' | 'left'; label: string }> = [
  { id: 'justify', label: '两端对齐' },
  { id: 'left', label: '左对齐' },
]

/** 段落首行缩进（em）：快速面板用开关表达，设置页也用开关，值域固定 0/2。 */
export const INDENT_EM = 2

export function indentEnabledToEm(enabled: boolean): number {
  return enabled ? INDENT_EM : 0
}

export function indentEmToEnabled(em: number): boolean {
  return em > 0
}

/** 主题选项透传：面板/设置页都从这里取，保持同一份。 */
export { THEME_OPTIONS as ALL_THEME_OPTIONS }
