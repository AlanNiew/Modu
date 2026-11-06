// 主题系统：一套「主题」同时驱动两块颜色
//
// 1) 应用外壳（chrome）：标题栏、侧栏、按钮、边框——通过 CSS 变量注入到
//    documentElement，Tailwind 的 bg-crust / text-subtext 等工具类引用的
//    就是这些变量，所以换主题不需要改任何类名。
// 2) 阅读页（page）：注入到章节 iframe 的 <head> 末尾，可覆盖书内样式；
//    对必须压过书内 CSS 的属性加 !important。
//
// 两套颜色属于同一个主题，因此宿主界面与正文永远不会「一半浅一半深」。
// 这就是 v1.3 修的主题割裂问题。

/** 具体主题（有确定的色板） */
export type ConcreteThemeId = 'dark' | 'light' | 'sepia' | 'green'

/** 用户可选主题：auto 跟随系统深浅色 */
export type ThemeId = 'auto' | ConcreteThemeId

/** 主题色块：具体主题用「纸色 + 强调色」斜切，auto 用深浅对半。 */
export function themeSwatch(theme: ThemeId): string {
  if (theme === 'auto') {
    return 'conic-gradient(from 210deg, #1e1e2e 0 50%, #eff1f5 50% 100%)'
  }
  const palette = getReadingTheme(theme)
  return `linear-gradient(135deg, ${palette.background} 0 58%, ${palette.accent} 58% 100%)`
}

/** 排版流向：分页（左右翻）或滚动（上下滑） */
export type ReadingFlow = 'paginated' | 'scrolled'

export interface ReadingSettings {
  theme: ThemeId
  /** CSS font-family 栈 */
  fontFamily: string
  /** px */
  fontSize: number
  /** 无单位行高 */
  lineHeight: number
  /** 段落首行缩进，单位 em（0 = 不缩进） */
  paragraphIndent: number
  /** 版心宽度上限，单位 px（传给 paginator 的 max-inline-size） */
  pageWidth: number
  /** 页边距（正文四周留白），单位 px（0–64；v0.4 重新独立，与版心解耦） */
  pagePadding: number
  /** 分页还是滚动阅读 */
  flow: ReadingFlow
  /** 正文对齐：中文默认两端对齐，也可左对齐（混合排版时更自然） */
  textAlign: 'justify' | 'left'
  /** 段后间距，单位 em */
  paragraphSpacing: number
  /** 字间距，单位 em（0 = 不加） */
  letterSpacing: number
  /** 是否保留出版方（书内）样式；false = 净版，只按本应用的排版渲染 */
  respectPublisherStyles: boolean
  /** 繁体正文转简体（P4）：转换在 Rust 侧注入前统一做，与全文搜索同口径 */
  simplifyTraditional: boolean
}

export interface ReadingTheme {
  id: ConcreteThemeId
  label: string
  background: string
  foreground: string
  muted: string
  link: string
  accent: string
  border: string
  surface: string
  selection: string
  dark: boolean
}

/** 应用外壳色板：变量名沿用 Catppuccin 的语义命名，Tailwind 直接消费。 */
export interface ChromePalette {
  crust: string
  mantle: string
  base: string
  surface0: string
  surface1: string
  surface2: string
  overlay0: string
  subtext: string
  text: string
  blue: string
  lavender: string
  mauve: string
  green: string
  red: string
  yellow: string
  teal: string
}

export const READING_THEMES: Record<ConcreteThemeId, ReadingTheme> = {
  dark: {
    id: 'dark',
    label: '深色',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    muted: '#a6adc8',
    link: '#89b4fa',
    accent: '#b4befe',
    border: '#45475a',
    surface: '#313244',
    selection: '#585b70',
    dark: true,
  },
  light: {
    id: 'light',
    label: '浅色',
    background: '#eff1f5',
    foreground: '#4c4f69',
    muted: '#6c6f85',
    link: '#1e66f5',
    accent: '#7287fd',
    border: '#bcc0cc',
    surface: '#e6e9ef',
    selection: '#bcc0cc',
    dark: false,
  },
  sepia: {
    id: 'sepia',
    label: '羊皮纸',
    background: '#f4ecd8',
    foreground: '#5b4636',
    muted: '#7d6651',
    link: '#a15c1f',
    accent: '#b07d3a',
    border: '#dbc9a6',
    surface: '#ece0c8',
    selection: '#e0cfa8',
    dark: false,
  },
  green: {
    id: 'green',
    label: '护眼绿',
    background: '#e4f0e2',
    foreground: '#2f4630',
    muted: '#5d755c',
    link: '#2f6f45',
    accent: '#3f7a3f',
    border: '#c3d8c0',
    surface: '#d9e8d5',
    selection: '#bcd6b8',
    dark: false,
  },
}

/**
 * 外壳色板：深色 = Catppuccin Mocha；浅色 = Latte；
 * 羊皮纸/护眼绿沿用同一套语义色相，只把明度、饱和度调成对应纸感。
 */
export const CHROME_PALETTES: Record<ConcreteThemeId, ChromePalette> = {
  dark: {
    crust: '#11111b',
    mantle: '#181825',
    base: '#1e1e2e',
    surface0: '#313244',
    surface1: '#45475a',
    surface2: '#585b70',
    overlay0: '#6c7086',
    subtext: '#a6adc8',
    text: '#cdd6f4',
    blue: '#89b4fa',
    lavender: '#b4befe',
    mauve: '#cba6f7',
    green: '#a6e3a1',
    red: '#f38ba8',
    yellow: '#f9e2af',
    teal: '#94e2d5',
  },
  light: {
    crust: '#dce0e8',
    mantle: '#e6e9ef',
    base: '#eff1f5',
    surface0: '#ccd0da',
    surface1: '#bcc0cc',
    surface2: '#acb0be',
    overlay0: '#9ca0b0',
    subtext: '#6c6f85',
    text: '#4c4f69',
    blue: '#1e66f5',
    lavender: '#7287fd',
    mauve: '#8839ef',
    green: '#40a02b',
    red: '#d20f39',
    yellow: '#df8e1d',
    teal: '#179299',
  },
  sepia: {
    crust: '#e7dcc4',
    mantle: '#efe6d2',
    base: '#f4ecd8',
    surface0: '#e4d7ba',
    surface1: '#d8c8a5',
    surface2: '#c9b78f',
    overlay0: '#a48f6d',
    subtext: '#7a6650',
    text: '#4f3f31',
    blue: '#4a6f8f',
    lavender: '#7d6b93',
    mauve: '#7a5a74',
    green: '#5d7a4a',
    red: '#a8443c',
    yellow: '#a97c2f',
    teal: '#3f7a72',
  },
  green: {
    crust: '#dbe8d9',
    mantle: '#e6f1e3',
    base: '#eef6eb',
    surface0: '#d9e8d5',
    surface1: '#c9dcc6',
    surface2: '#b8cfb5',
    overlay0: '#8fa78d',
    subtext: '#5d755c',
    text: '#2f4630',
    blue: '#2f6f8f',
    lavender: '#5f7f95',
    mauve: '#6f5a7d',
    green: '#3f7a3f',
    red: '#a8443c',
    yellow: '#9a7a2f',
    teal: '#2f7a72',
  },
}

export const THEME_OPTIONS: Array<{ id: ThemeId; label: string }> = [
  { id: 'auto', label: '跟随系统' },
  { id: 'dark', label: '深色' },
  { id: 'light', label: '浅色' },
  { id: 'sepia', label: '羊皮纸' },
  { id: 'green', label: '护眼绿' },
]

export const FONT_STACKS = {
  /** 中文正文首选：宋体/思源宋体 */
  serif: '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif',
  sans: '"Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
} as const

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  theme: 'auto',
  fontFamily: FONT_STACKS.serif,
  fontSize: 19,
  lineHeight: 1.85,
  paragraphIndent: 2,
  pageWidth: 720,
  pagePadding: 24,
  textAlign: 'justify',
  paragraphSpacing: 0.72,
  letterSpacing: 0,
  respectPublisherStyles: true,
  simplifyTraditional: false,
  flow: 'paginated',
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 把用户选择解析成具体色板 id（auto → 跟随系统）。 */
export function resolveThemeId(choice: ThemeId | undefined): ConcreteThemeId {
  if (choice === 'auto' || choice == null) return systemPrefersDark() ? 'dark' : 'light'
  return choice in READING_THEMES ? (choice as ConcreteThemeId) : 'dark'
}

export function getReadingTheme(choice: ThemeId | undefined): ReadingTheme {
  return READING_THEMES[resolveThemeId(choice)]
}

const CHROME_VAR_KEYS: Array<keyof ChromePalette> = [
  'crust',
  'mantle',
  'base',
  'surface0',
  'surface1',
  'surface2',
  'overlay0',
  'subtext',
  'text',
  'blue',
  'lavender',
  'mauve',
  'green',
  'red',
  'yellow',
  'teal',
]

/**
 * 把主题写进 documentElement 的 CSS 变量。
 *
 * Tailwind 的 @theme 令牌编译成 var(--color-*)，运行时覆盖同名变量即可
 * 让整个外壳（标题栏/侧栏/按钮/边框/滚动条）跟着换色，无需改任何类名。
 */
export function applyChromeTheme(choice: ThemeId | undefined): ConcreteThemeId {
  const id = resolveThemeId(choice)
  const palette = CHROME_PALETTES[id]
  const reading = READING_THEMES[id]
  if (typeof document === 'undefined') return id

  const root = document.documentElement
  for (const key of CHROME_VAR_KEYS) {
    root.style.setProperty(`--color-${key}`, palette[key])
  }
  // 阅读区背景与 chrome 属于同一主题，避免宿主/正文颜色割裂
  root.style.setProperty('--reader-page-bg', reading.background)
  root.style.setProperty('--reader-page-fg', reading.foreground)
  root.style.colorScheme = reading.dark ? 'dark' : 'light'
  root.dataset.theme = id
  return id
}

const MONO_STACK =
  '"JetBrains Mono", "Cascadia Code", Consolas, "Noto Sans Mono CJK SC", monospace'

export function buildReadingCss(settings: ReadingSettings): string {
  const theme = getReadingTheme(settings.theme)
  const indent = `${settings.paragraphIndent}em`

  return `
:root { color-scheme: ${theme.dark ? 'dark' : 'light'}; }

html {
  background: ${theme.background} !important;
  -webkit-text-size-adjust: 100%;
}

body {
  box-sizing: border-box !important;
  margin: 0 !important;
  padding: 0 !important;
  background: ${theme.background} !important;
  color: ${theme.foreground} !important;
  font-family: ${settings.fontFamily} !important;
  font-size: ${settings.fontSize}px !important;
  line-height: ${settings.lineHeight} !important;
  text-align: ${settings.textAlign} !important;
  /* 西文断词交给浏览器；中文不受 hyphens 影响 */
  hyphens: auto !important;
  -webkit-hyphens: auto !important;
  /* 中文换行按严格规则，避免标点跑到行首 */
  line-break: strict;
  letter-spacing: ${settings.letterSpacing === 0 ? 'normal' : `${settings.letterSpacing}em`};
  overflow-wrap: break-word !important;
  word-break: normal !important;
  text-rendering: optimizeLegibility;
}

body > *:first-child { margin-top: 0 !important; }
body > *:last-child { margin-bottom: 0 !important; }

p, li, dd, dt, blockquote, td, th, figcaption {
  line-height: ${settings.lineHeight} !important;
  color: ${theme.foreground} !important;
}

p {
  margin: 0 0 ${settings.paragraphSpacing}em !important;
  text-indent: ${indent} !important;
}

/* 标题后第一段、列表内段落、图注、引用内段落：不缩进 */
h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p,
li p, figcaption, blockquote p, td p, th p,
p.noindent, p.first, .noindent {
  text-indent: 0 !important;
}

h1, h2, h3, h4, h5, h6 {
  color: ${theme.foreground} !important;
  font-family: inherit !important;
  font-weight: 600 !important;
  line-height: 1.35 !important;
  text-indent: 0 !important;
  margin: 1.5em 0 0.7em !important;
  break-after: avoid !important;
  page-break-after: avoid !important;
}
h1 { font-size: 1.55em !important; }
h2 { font-size: 1.3em !important; }
h3 { font-size: 1.15em !important; }
h4, h5, h6 { font-size: 1.02em !important; }

a {
  color: ${theme.link} !important;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.16em;
}

strong, b { color: ${theme.foreground} !important; font-weight: 700 !important; }
em, i { font-style: italic !important; }

img, svg, image, video, canvas {
  max-width: 100% !important;
  height: auto !important;
}
img {
  max-height: 88vh !important;
  object-fit: contain !important;
  break-inside: avoid !important;
}

figure { margin: 1.1em 0 !important; text-align: center !important; }
figure img { margin: 0 auto !important; }
figcaption { margin-top: 0.5em !important; font-size: 0.86em !important; color: ${theme.muted} !important; }

blockquote {
  margin: 1em 0 !important;
  padding: 0.1em 0 0.1em 0.95em !important;
  border-left: 3px solid ${theme.accent} !important;
  color: ${theme.muted} !important;
}
blockquote p { color: inherit !important; }

hr {
  border: none !important;
  border-top: 1px solid ${theme.border} !important;
  margin: 1.8em auto !important;
  width: 60% !important;
}

pre, code, kbd, samp {
  font-family: ${MONO_STACK} !important;
  text-indent: 0 !important;
}
pre {
  font-size: 0.86em !important;
  line-height: 1.6 !important;
  padding: 0.85em 1em !important;
  margin: 1em 0 !important;
  background: ${theme.surface} !important;
  border-radius: 8px !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  overflow: visible !important;
  max-width: 100% !important;
}
code {
  font-size: 0.9em !important;
  padding: 0.1em 0.32em !important;
  border-radius: 4px !important;
  background: ${theme.surface} !important;
}
pre code { background: transparent !important; padding: 0 !important; font-size: 1em !important; }

table {
  border-collapse: collapse !important;
  max-width: 100% !important;
  font-size: 0.94em !important;
  margin: 1em 0 !important;
}
th, td {
  border: 1px solid ${theme.border} !important;
  padding: 0.32em 0.55em !important;
  text-indent: 0 !important;
}

::selection { background: ${theme.selection} !important; color: inherit !important; }

/* 书籍自带的脚注区隐藏（脚注通过锚点跳转查看） */
aside[epub\\:type~="footnote"], aside[epub\\:type~="endnote"],
section[epub\\:type~="footnotes"], nav[epub\\:type~="footnotes"],
aside[role~="doc-footnote"] {
  display: none !important;
}

/* 中和书内与分页相关的属性，避免和 column 布局打架 */
html, body, section, article, div {
  break-inside: auto;
}
@page { margin: 0; }
${settings.respectPublisherStyles
  ? ''
  : `
/* 净版（respectPublisherStyles = false）：屏蔽出版方样式对版式的影响。
   普通模式仍然尊重书内 CSS；净版只保留本应用的排版，适合排版很花的老书。 */
body, body * {
  font-family: ${settings.fontFamily} !important;
  color: ${theme.foreground} !important;
  background: transparent !important;
  text-align: ${settings.textAlign} !important;
  float: none !important;
  position: static !important;
  width: auto !important;
  max-width: 100% !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  border: none !important;
}
p { text-indent: ${indent} !important; }
h1 { font-size: 1.5em !important; }
h2 { font-size: 1.25em !important; }
h3 { font-size: 1.1em !important; }
h1, h2, h3, h4, h5, h6 { font-weight: 600 !important; }
img, svg, video { max-width: 100% !important; height: auto !important; }
`}
`
}
