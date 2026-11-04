import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_READING_SETTINGS, FONT_STACKS } from '../renderer/theme'
import { fontFamilyKind, useReaderSettings } from './settings'

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

  it('persists under a versioned localStorage key', async () => {
    useReaderSettings.getState().patch({ fontSize: 28 })
    await Promise.resolve()
    const raw = localStorage.getItem('modu:reader-settings')
    expect(raw).toBeTruthy()
    const saved = JSON.parse(raw as string)
    // v2 起 settings 里新增了 flow/theme=auto；版本号与 store 里的 version 保持一致
    expect(saved.version).toBe(2)
    expect(saved.state.settings.fontSize).toBe(28)
    expect(saved.state.settings.flow).toBe('paginated')
  })
})
