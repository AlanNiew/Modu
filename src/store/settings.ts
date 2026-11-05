import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import {
  DEFAULT_READING_SETTINGS,
  FONT_STACKS,
  type ReadingSettings,
  type ThemeId,
} from '../renderer/theme'

/**
 * 阅读排版设置：全局共享、写入 localStorage。
 *
 * 为什么不进 Rust/SQLite：这是「偏好」而不是「书的数据」，
 * 换机器跟着 localStorage 走更简单，也不会因为数据库迁移丢设置。
 */
interface SettingsState {
  settings: ReadingSettings
  patch: (partial: Partial<ReadingSettings>) => void
  setTheme: (theme: ThemeId) => void
  setFontFamilyKind: (kind: 'serif' | 'sans' | 'kai') => void
  reset: () => void
}

/**
 * 设置迁移（逐级向上兼容）：
 * - v1 → v2：去掉 `justify` 与 `pagePadding`（对齐改由 textAlign 控制，页边距由版心推导），
 *   主题升级为支持 `auto`
 * - v2 → v3：新增 `textAlign` / `paragraphSpacing` / `letterSpacing` / `respectPublisherStyles`，
 *   缺字段由 DEFAULT_READING_SETTINGS 补齐，旧数据无需改写
 */
interface PersistedV1 {
  settings?: Partial<ReadingSettings> & { justify?: boolean; pagePadding?: number }
}

function migrate(persisted: unknown): { settings: ReadingSettings } {
  const saved = (persisted as PersistedV1 | undefined)?.settings ?? {}
  const { justify: _justify, pagePadding: _pagePadding, ...rest } = saved
  return { settings: { ...DEFAULT_READING_SETTINGS, ...rest } }
}

export const useReaderSettings = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_READING_SETTINGS,
      patch: (partial) => set((prev) => ({ settings: { ...prev.settings, ...partial } })),
      setTheme: (theme) => set((prev) => ({ settings: { ...prev.settings, theme } })),
      setFontFamilyKind: (kind) =>
        set((prev) => ({ settings: { ...prev.settings, fontFamily: FONT_STACKS[kind] } })),
      reset: () => set({ settings: DEFAULT_READING_SETTINGS }),
    }),
    {
      name: 'modu:reader-settings',
      version: 3,
      // 只持久化 settings，避免把函数写进 localStorage
      partialize: (state) => ({ settings: state.settings }),
      migrate: (persisted) => migrate(persisted),
      merge: (persisted, current) => {
        const saved = (persisted as { settings?: Partial<ReadingSettings> } | undefined)?.settings
        return { ...current, settings: { ...DEFAULT_READING_SETTINGS, ...saved } }
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
