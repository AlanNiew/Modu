import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_READING_SETTINGS, FONT_STACKS } from '../renderer/theme'
import { fontFamilyKind, normalizeSettings, useReaderSettings } from './settings'

describe('reader settings store', () => {
  beforeEach(() => {
    localStorage.clear()
    useReaderSettings.setState({ settings: DEFAULT_READING_SETTINGS })
  })

  it('patches only the provided fields', () => {
    useReaderSettings.getState().patch({ fontSize: 24, lineHeight: 2 })
    const { settings } = useReaderSettings.getState()
    expect(settings.fontSize).toBe(24)
    expect(settings.lineHeight).toBe(2)
    expect(settings.theme).toBe(DEFAULT_READING_SETTINGS.theme)
  })

  it('switches font family by kind and can be detected back', () => {
    useReaderSettings.getState().setFontFamilyKind('sans')
    const { fontFamily } = useReaderSettings.getState().settings
    expect(fontFamily).toBe(FONT_STACKS.sans)
    expect(fontFamilyKind(fontFamily)).toBe('sans')
  })

  it('resets to defaults', () => {
    useReaderSettings.getState().patch({ fontSize: 30, theme: 'sepia' })
    useReaderSettings.getState().reset()
    expect(useReaderSettings.getState().settings).toEqual(DEFAULT_READING_SETTINGS)
  })

  it('pagePadding 默认 24，patch 后持久化结果包含它', async () => {
    expect(DEFAULT_READING_SETTINGS.pagePadding).toBe(24)
    useReaderSettings.getState().patch({ pagePadding: 40 })
    expect(useReaderSettings.getState().settings.pagePadding).toBe(40)
    await Promise.resolve()
    const saved = JSON.parse(localStorage.getItem('modu:reader-settings') as string)
    expect(saved.state.settings.pagePadding).toBe(40)
  })

  it('normalizeSettings：v3 缺页边距补默认，v1/v2 旧键被丢弃', () => {
    // v3 数据（0.3.x 之前/之后都可能出现）：缺 pagePadding → 默认补齐
    const v3 = normalizeSettings({ fontSize: 21 })
    expect(v3.pagePadding).toBe(24)
    expect(v3.fontSize).toBe(21)
    // v0.4 的 v3 数据：pagePadding 正常保留
    const current = normalizeSettings({ pagePadding: 44, fontSize: 21 })
    expect(current.pagePadding).toBe(44)
    // v1/v2 legacy：旧语义键被丢弃，不污染新默认值
    const legacy = normalizeSettings(
      { fontSize: 21, justify: true, pagePadding: 88 },
      { dropLegacyKeys: true },
    )
    expect(legacy.pagePadding).toBe(24)
    expect('justify' in legacy).toBe(false)
  })

  it('persists under a versioned localStorage key', async () => {
    useReaderSettings.getState().patch({ fontSize: 28 })
    await Promise.resolve()
    const raw = localStorage.getItem('modu:reader-settings')
    expect(raw).toBeTruthy()
    const saved = JSON.parse(raw as string)
    // v2 起 settings 里新增了 flow/theme=auto；版本号与 store 里的 version 保持一致
    expect(saved.version).toBe(3)
    expect(saved.state.settings.fontSize).toBe(28)
    expect(saved.state.settings.flow).toBe('paginated')
  })
})
