import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import {
  DEFAULT_READING_SETTINGS,
  FONT_STACKS,
  type ReadingSettings,
  type ThemeId,
} from '../renderer/theme'
import type { InstalledFont } from '../lib/types'

/**
 * 阅读排版设置：全局共享、写入 localStorage。
 *
 * 为什么不进 Rust/SQLite：这是「偏好」而不是「书的数据」，
 * 换机器跟着 localStorage 走更简单，也不会因为数据库迁移丢设置。
 *
 * `autoCheck`（启动时自动检查更新）原本独立放在 `modu:update:auto-check`
 * 这个 localStorage 键由更新面板读写；P2 起并入本 store（设置-行为分组），
 * 旧键在首次水合时读取一次并作为默认值，之后统一走本 store。
 */
interface SettingsState {
  settings: ReadingSettings
  autoCheck: boolean
  /** 用户导入的自定义字体（文件在数据目录 fonts/ 下；Rust font_list 为准）。 */
  customFonts: InstalledFont[]
  patch: (partial: Partial<ReadingSettings>) => void
  setTheme: (theme: ThemeId) => void
  setFontFamilyKind: (kind: 'serif' | 'sans' | 'kai') => void
  setFontFamily: (fontFamily: string) => void
  setAutoCheck: (enabled: boolean) => void
  setCustomFonts: (fonts: InstalledFont[]) => void
  reset: () => void
}

/**
 * 设置迁移（逐级向上兼容）：
 * - v1 → v2：去掉 `justify` 与 `pagePadding`（v2 起旧页边距由版心推导），
 *   主题升级为支持 `auto`
 * - v2 → v3：新增 `textAlign` / `paragraphSpacing` / `letterSpacing` / `respectPublisherStyles`，
 *   缺字段由默认值补齐，旧数据无需改写
 * - v0.4（持久化版本仍为 3）：`pagePadding` 独立回归（默认 24px）。
 *   只有 v1/v2 的旧数据（走 persist migrate 的 legacy 路径）需要丢弃
 *   旧语义的 pagePadding / justify；v3+ 数据按字段直接合入。
 */

// ReadingSettings 里用户可调的数值字段及其合法区间（超出会被钳回）。
// UI（滑杆）与持久化归一化共用以保证口径一致；键名即任务书 §4.3 的字段。
const NUMERIC_RANGES: Partial<Record<keyof ReadingSettings, [number, number]>> = {
  fontSize: [14, 32],
  lineHeight: [1.2, 2.4],
  paragraphIndent: [0, 4],
  pageWidth: [480, 1100],
  pagePadding: [0, 64],
  paragraphSpacing: [0, 2],
  letterSpacing: [-0.06, 0.3],
}

/** 白名单拷入一个字段；数值字段越界时钳回合法区间。 */
function adopt<K extends keyof ReadingSettings>(
  target: ReadingSettings,
  key: K,
  value: unknown,
): void {
  if (value === undefined) return
  const range = NUMERIC_RANGES[key]
  const candidate =
    range && typeof value === 'number' && Number.isFinite(value)
      ? Math.min(range[1], Math.max(range[0], value))
      : value
  // 白名单键的取值由键名决定，运行时来自可信持久化数据；
  // 这里按键名收窄到对应属性类型（单点收窄，不做整对象洗白）。
  target[key] = candidate as ReadingSettings[K]
}

/** 旧数据归一化：白名单字段 + 数值钳制；`dropLegacyKeys` 时丢弃 v1/v2 旧键。 */
export function normalizeSettings(
  saved: Partial<ReadingSettings> | Record<string, unknown> | undefined,
  { dropLegacyKeys = false }: { dropLegacyKeys?: boolean } = {},
): ReadingSettings {
  const source = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  if (dropLegacyKeys) {
    delete source.justify
    delete source.pagePadding
  }
  // 只接受默认值表里出现过的键（防外来/损坏数据注入多余字段）。
  const merged: ReadingSettings = { ...DEFAULT_READING_SETTINGS }
  for (const key of Object.keys(DEFAULT_READING_SETTINGS) as Array<keyof ReadingSettings>) {
    adopt(merged, key, source[key])
  }
  return merged
}

/** 旧版独立键（P2 之前由更新面板写的），首次水合时迁移进 store。 */
const LEGACY_AUTO_CHECK_KEY = 'modu:update:auto-check'

function readLegacyAutoCheck(): boolean {
  try {
    const raw = window.localStorage.getItem(LEGACY_AUTO_CHECK_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

function sanitizeCustomFonts(saved: unknown): InstalledFont[] {
  if (!Array.isArray(saved)) return []
  return saved.filter(
    (font): font is InstalledFont =>
      typeof font === 'object' &&
      font !== null &&
      typeof (font as InstalledFont).family === 'string' &&
      (font as InstalledFont).family.length > 0 &&
      typeof (font as InstalledFont).file === 'string' &&
      (font as InstalledFont).file.length > 0 &&
      // 协议只认纯文件名：持久化数据同样过一遍这道闸，避免 URL 注入。
      !/[\\/]/.test((font as InstalledFont).file) &&
      !(font as InstalledFont).file.includes('..'),
  )
}

function migrate(persisted: unknown): {
  settings: ReadingSettings
  autoCheck: boolean
  customFonts: InstalledFont[]
} {
  const saved = (persisted as { settings?: Partial<ReadingSettings> } | undefined)?.settings
  const autoCheck = (persisted as { autoCheck?: boolean } | undefined)?.autoCheck
  return {
    settings: normalizeSettings(saved, { dropLegacyKeys: true }),
    autoCheck: typeof autoCheck === 'boolean' ? autoCheck : readLegacyAutoCheck(),
    customFonts: sanitizeCustomFonts(
      (persisted as { customFonts?: unknown } | undefined)?.customFonts,
    ),
  }
}

export const useReaderSettings = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_READING_SETTINGS,
      autoCheck: true,
      customFonts: [],
      patch: (partial) => set((prev) => ({ settings: { ...prev.settings, ...partial } })),
      setTheme: (theme) => set((prev) => ({ settings: { ...prev.settings, theme } })),
      setFontFamilyKind: (kind) =>
        set((prev) => ({ settings: { ...prev.settings, fontFamily: FONT_STACKS[kind] } })),
      setFontFamily: (fontFamily) => set((prev) => ({ settings: { ...prev.settings, fontFamily } })),
      setAutoCheck: (autoCheck) => set({ autoCheck }),
      setCustomFonts: (customFonts) => set({ customFonts: sanitizeCustomFonts(customFonts) }),
      reset: () => set({ settings: DEFAULT_READING_SETTINGS }),
    }),
    {
      name: 'modu:reader-settings',
      version: 3,
      // 只持久化 settings 与 autoCheck/customFonts，避免把函数写进 localStorage
      partialize: (state) => ({
        settings: state.settings,
        autoCheck: state.autoCheck,
        customFonts: state.customFonts,
      }),
      migrate: (persisted) => migrate(persisted),
      merge: (persisted, current) => {
        const saved = persisted as
          | {
              settings?: Partial<ReadingSettings>
              autoCheck?: boolean
              customFonts?: unknown
            }
          | undefined
        return {
          ...current,
          settings: normalizeSettings(saved?.settings),
          autoCheck:
            typeof saved?.autoCheck === 'boolean' ? saved.autoCheck : readLegacyAutoCheck(),
          customFonts: sanitizeCustomFonts(saved?.customFonts),
        }
      },
    },
  ),
)

/** 判断当前字体栈属于哪一类，用于工具栏高亮。 */
export function fontFamilyKind(fontFamily: string): 'serif' | 'sans' | 'kai' {
  if (fontFamily === FONT_STACKS.sans) return 'sans'
  if (fontFamily === FONT_STACKS.kai) return 'kai'
  return 'serif'
}

/** 供「关于/关于更新」等处展示的可读字体名（取栈首并去引号）。 */
export function fontStackLabel(fontFamily: string): string {
  const first = fontFamily.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  return first || fontFamily
}
