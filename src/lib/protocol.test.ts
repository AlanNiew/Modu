import { describe, expect, it } from 'vitest'

import { customFontFaces, fontUrl } from './protocol'

describe('自定义字体 @font-face 生成', () => {
  it('空列表/非法列表返回空串', () => {
    expect(customFontFaces([])).toBe('')
    expect(customFontFaces(undefined)).toBe('')
  })

  it('生成带引号家族名与 format 提示的 @font-face', () => {
    const css = customFontFaces([{ file: 'my-font.otf', family: 'My Font' }])
    expect(css).toContain('font-family: "My Font";')
    expect(css).toContain('format("opentype")')
    // URL 必须带引号：文件名里的 ( ) 是 Windows 合法字符，不加引号会被截断
    expect(css).toContain('src: url("')
    // 文件名不含路径成分（URL 只保留 basename）
    expect(css).toContain('/__fonts/my-font.otf')
  })

  it('文件名含括号空格也能构造完整 URL', () => {
    const css = customFontFaces([{ file: 'My Font (2024).ttf', family: 'My Font 2024' }])
    expect(css).toContain('/__fonts/My%20Font%20(2024).ttf')
  })

  it('家族名里的引号/反斜杠被转义', () => {
    const css = customFontFaces([{ file: 'a.ttf', family: 'Bad"Name\\X' }])
    expect(css).toContain('font-family: "Bad\\"Name\\\\X";')
  })

  it('跳过没有家族名/文件名的条目', () => {
    const css = customFontFaces([
      { file: '', family: 'X' } as never,
      { file: 'a.ttf', family: '' } as never,
      { file: 'b.ttf', family: 'Name' },
    ])
    // 非法条目不产生 URL：空文件名会拼出 `__fonts/ + 空路径 + )` 的悬空地址
    expect(css).not.toContain('__fonts/)')
    expect(css).toContain('/__fonts/b.ttf')
  })

  it('fontUrl 从纯文件名构造（合法条目才有对应 URL）', () => {
    expect(fontUrl('a.ttf')).toContain('/__fonts/a.ttf')
  })
})
