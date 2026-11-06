import type { ReadingFlow } from './theme'
import { FONT_STACKS, THEME_OPTIONS } from './theme'

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

/**
 * 预设字体（P3）：设置-排版 可以从这组挑选；栈尾都留有兜底（serif/sans）。
 * 命中不了系统里没装的字体时浏览器回退到下一级——所以栈里同时放
 * 英文内部名与常见中文别名，Windows 安装的字体两个都认。
 *
 * `hint` 是类型标注（§1.3 验收口径），悬停可看；「已安装才列出」的探测
 * 不做（无系统字体枚举通道，未安装时浏览器自动回退，行为等价）。
 */
export interface FontPreset {
  id: string
  label: string
  stack: string
  /** 类型标注（衬线/黑体/圆体/系统…），tooltip 用。 */
  hint: string
}

export const FONT_PRESETS: ReadonlyArray<FontPreset> = [
  { id: 'serif', label: '宋体', stack: FONT_STACKS.serif, hint: '衬线 · 思源宋体/中易宋体' },
  { id: 'sans', label: '黑体', stack: FONT_STACKS.sans, hint: '无衬线 · 思源黑体/微软雅黑' },
  { id: 'kai', label: '楷体', stack: FONT_STACKS.kai, hint: '书法体 · 楷体/华文楷体' },
  { id: 'fangsong', label: '仿宋', stack: '"FangSong", "STFangsong", "仿宋", serif', hint: '印刷仿宋体' },
  { id: 'dengxian', label: '等线', stack: '"DengXian", "等线", sans-serif', hint: '现代无衬线' },
  { id: 'youyuan', label: '幼圆', stack: '"YouYuan", "幼圆", sans-serif', hint: '圆体' },
  { id: 'wenkai', label: '霞鹜文楷', stack: '"LXGW WenKai", "LXGW WenKai GB", "霞鹜文楷", serif', hint: '开源楷体（需本机安装或自行导入）' },
  {
    id: 'mono',
    label: '等宽',
    stack:
      '"Cascadia Code", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace',
    hint: '等宽 · 代码/技术书排版',
  },
  {
    id: 'system',
    label: '系统默认',
    stack: 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif',
    hint: '跟随系统 UI 字体',
  },
]
