#!/usr/bin/env python3
"""生成测试用 EPUB（无第三方依赖）。

用法:
    python scripts/gen_test_epub.py               # 输出 .books/test-mandarin.epub
    python scripts/gen_test_epub.py --out path.epub

内容刻意覆盖渲染难点：中文排版、嵌套目录、脚注双向链接、图片、代码块、
超长段落、SVG 图、外部链接、nav + ncx 双目录。
"""

from __future__ import annotations

import argparse
import struct
import zipfile
import zlib
from pathlib import Path

MIMETYPE = b"application/epub+zip"

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:6f2f0d9e-6a2b-4d3b-9d0b-modu-test-0001</dc:identifier>
    <dc:title>墨读测试书：纸上的灯</dc:title>
    <dc:creator>墨读项目组</dc:creator>
    <dc:creator>Alan</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>本地自造样本</dc:publisher>
    <dc:description>用于验证排版、目录、脚注、图片与资源协议的一本小书。</dc:description>
    <meta property="dcterms:modified">2026-11-04T00:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="figure" href="Images/figure.png" media-type="image/png"/>
    <item id="vector" href="Images/vector.svg" media-type="image/svg+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="Text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx" page-progression-direction="ltr">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="Text/ch1.xhtml">第一章　纸上的灯</a>
        <ol>
          <li><a href="Text/ch1.xhtml#s1-1">一、灯芯</a></li>
          <li><a href="Text/ch1.xhtml#s1-2">二、影子</a></li>
        </ol>
      </li>
      <li><a href="Text/ch2.xhtml">第二章　长夜与短句</a></li>
      <li><a href="Text/ch3.xhtml">第三章　图的注脚</a></li>
      <li><a href="Text/notes.xhtml">注释</a></li>
    </ol>
  </nav>
</body>
</html>
"""

NCX = """<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">
  <head><meta name="dtb:uid" content="urn:uuid:modu-test-0001"/></head>
  <docTitle><text>墨读测试书：纸上的灯</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>第一章　纸上的灯</text></navLabel>
      <content src="Text/ch1.xhtml"/>
      <navPoint id="n1-1" playOrder="2"><navLabel><text>一、灯芯</text></navLabel><content src="Text/ch1.xhtml#s1-1"/></navPoint>
    </navPoint>
    <navPoint id="n2" playOrder="3"><navLabel><text>第二章　长夜与短句</text></navLabel><content src="Text/ch2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="4"><navLabel><text>第三章　图的注脚</text></navLabel><content src="Text/ch3.xhtml"/></navPoint>
  </navMap>
</ncx>
"""

CSS = """@charset "utf-8";
body { margin: 0; padding: 0 1.2em; font-family: "Noto Serif SC", "Source Han Serif SC", serif; }
h1 { font-size: 1.6em; line-height: 1.4; margin: 1.2em 0 0.8em; border-bottom: 1px solid #89b4fa; padding-bottom: 0.35em; }
h2 { font-size: 1.2em; margin: 1.4em 0 0.6em; }
p { line-height: 1.9; text-indent: 2em; margin: 0 0 0.9em; text-align: justify; }
p.noindent { text-indent: 0; }
blockquote { margin: 1em 1.6em; padding-left: 0.9em; border-left: 2px solid #7287fd; color: #555; }
figure { margin: 1.2em 0; text-align: center; }
figure img { max-width: 100%; }
figcaption { font-size: 0.85em; color: #666; text-indent: 0; margin-top: 0.5em; }
code, pre { font-family: "JetBrains Mono", Consolas, monospace; }
pre { padding: 0.8em 1em; background: #f2f4f8; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
.fnref { vertical-align: super; font-size: 0.75em; }
.footnotes { margin-top: 2em; border-top: 1px solid #ccc; font-size: 0.9em; }
"""


def chapter(title: str, body: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>{title}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
{body}
</body>
</html>
"""


CH1 = """<h1 id="s1-1">第一章　纸上的灯</h1>
<p>台灯是旧式的，黄铜灯罩上有一圈被手摸出的亮点。夜里十一点，整条巷子只剩这盏灯还亮着，像一枚被留在桌上的句号。</p>
<h2 id="s1-2">二、影子</h2>
<p>他翻开那本从旧书摊上买来的书，书页发脆，边角卷起。第一页只有一句话：“愿每个读到这里的人，都能找到自己的灯。”<a class="fnref" id="fnref-1" href="notes.xhtml#fn-1">[1]</a></p>
<p>窗外的雨敲在铁皮雨棚上，节奏忽快忽慢。他把书页压平，读得很慢，仿佛每个字都需要先在舌头上过一遍。</p>
<blockquote><p>注意：这一行在引用块里，缩进与正文应当不同；如果你看到它和正文挤在一起，说明安装样式丢失了。</p></blockquote>
<p>这一章还带了两个锚点，目录里“一、灯芯”与“二、影子”应当都能跳到这里对应的位置。</p>
"""

CH2 = """<h1>第二章　长夜与短句</h1>
<p>长夜适合短句。短句不解释，只留下一点余地。他把这个念头写在书页的空白处，字很小，像怕吵醒谁。</p>
<p>下面是一段用于测试长行的文字：在中文排版里，两端对齐会让字距忽松忽紧；好的阅读器会把这一点处理得不那么刺眼。如果你发现某一行的字被拉开了很大的缝，那大概不是书的问题，而是排版引擎的问题。</p>
<pre><code>fn main() {
    println!("这是一段代码，用来测试等宽字体与横向溢出");
}</code></pre>
<p class="noindent">—— 以上为代码块测试。</p>
<p>段落之间还应该有足够的呼吸感。把这一行读三遍，如果你没有想改字号，说明默认的字号与行高还算合适。</p>
"""

CH3 = """<h1>第三章　图的注脚</h1>
<p>图是关键。<img src="../Images/figure.png" alt="占位插图"/></p>
<figure>
  <img src="../Images/figure.png" alt="编号插图"/>
  <figcaption>图 1　一张程序生成的画像，用来验证相对路径与跨目录解析。</figcaption>
</figure>
<figure>
  <img src="../Images/vector.svg" alt="矢量图"/>
  <figcaption>图 2　SVG 资源，验证 MIME 与渲染。</figcaption>
</figure>
<p>外链测试：<a href="https://www.gutenberg.org/">Project Gutenberg</a>（应当交给系统浏览器打开）。</p>
<p>返回第一章：<a href="ch1.xhtml#s1-2">回到“二、影子”</a>。</p>
"""

NOTES = """<h1>注释</h1>
<section class="footnotes">
  <p id="fn-1">[1] 这句话是本书唯一一句作者原话，其余均为测试文本。<a href="ch1.xhtml#fnref-1">返回正文</a></p>
</section>
"""


def png(width: int, height: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> bytes:
    rows = bytearray()
    for y in range(height):
        t = y / max(height - 1, 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        rows.append(0)  # filter: none
        rows.extend(bytes((r, g, b)) * width)
    raw = zlib.compress(bytes(rows), 9)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


SVG = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320" height="160">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e1e2e"/>
      <stop offset="1" stop-color="#89b4fa"/>
    </linearGradient>
  </defs>
  <rect width="320" height="160" fill="url(#g)"/>
  <circle cx="160" cy="80" r="46" fill="#f4ecd8" opacity="0.9"/>
  <text x="160" y="88" text-anchor="middle" font-size="20" fill="#1e1e2e">墨读</text>
</svg>
"""


def build(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w") as zf:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, MIMETYPE)

        def add(name: str, text: str | bytes) -> None:
            data = text.encode("utf-8") if isinstance(text, str) else text
            zf.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)

        add("META-INF/container.xml", CONTAINER)
        add("OEBPS/content.opf", OPF)
        add("OEBPS/nav.xhtml", NAV)
        add("OEBPS/toc.ncx", NCX)
        add("OEBPS/style.css", CSS)
        add("OEBPS/Text/ch1.xhtml", chapter("第一章", CH1))
        add("OEBPS/Text/ch2.xhtml", chapter("第二章", CH2))
        add("OEBPS/Text/ch3.xhtml", chapter("第三章", CH3))
        add("OEBPS/Text/notes.xhtml", chapter("注释", NOTES))
        add("OEBPS/Images/cover.png", png(600, 900, (30, 30, 46), (137, 180, 250)))
        add("OEBPS/Images/figure.png", png(640, 360, (244, 236, 216), (114, 135, 253)))
        add("OEBPS/Images/vector.svg", SVG)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser()
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("--out", type=Path, default=root / ".books" / "test-mandarin.epub")
    build(parser.parse_args().out.resolve())


if __name__ == "__main__":
    main()
