import { describe, expect, it } from 'vitest'

import { rewriteSectionHtml } from './sectionLoader'

const BOOK = 'book1'
const SECTION = 'OEBPS/Text/ch1.xhtml'

const html = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example" />
<link rel="stylesheet" href="../Styles/main.css" />
<style>.x { background: url(../Images/bg.png) }</style>
</head><body>
<script>alert(1)</script>
<iframe src="https://evil.example"></iframe>
<form action="https://evil.example"><input name="q" /></form>
<p onclick="alert(2)">正文<a href="javascript:alert(3)">坏链接</a></p>
<img src="../Images/a.png" srcset="../Images/a.png 1x, ../Images/b.png 2x" />
<a href="ch2.xhtml#note1">下一章</a>
<a href="https://example.com/out">站外</a>
<div style="background-image: url('../Images/inline.png')">块</div>
</body></html>`

describe('rewriteSectionHtml', () => {
  const out = rewriteSectionHtml(html, SECTION, BOOK)

  it('removes scripts, frames, forms and refresh metadata', () => {
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('http-equiv="refresh"')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
  })

  it('rewrites chapter-relative resources to the epub protocol', () => {
    expect(out).toContain('epub://localhost/book1/OEBPS/Images/a.png')
    expect(out).toContain('epub://localhost/book1/OEBPS/Images/b.png 2x')
    expect(out).toContain('epub://localhost/book1/OEBPS/Styles/main.css')
    expect(out).toContain('epub://localhost/book1/OEBPS/Images/bg.png')
    expect(out).toContain('epub://localhost/book1/OEBPS/Images/inline.png')
  })

  it('keeps same-book links as fragments so footnote navigation still works', () => {
    expect(out).toContain('href="ch2.xhtml#note1"')
  })

  it('leaves external http(s) links for the system browser', () => {
    expect(out).toContain('href="https://example.com/out"')
  })
})
