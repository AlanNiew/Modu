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
    expect(JSON.parse(raw as string).version).toBe(1)
    expect(JSON.parse(raw as string).state.settings.fontSize).toBe(28)
  })
})
