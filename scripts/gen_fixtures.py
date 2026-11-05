#!/usr/bin/env python3
"""生成 M4 用的样本：一本大书（性能基准）+ 一组畸形 EPUB（容错验证）。

用法：python scripts/gen_fixtures.py
输出到 .books/ 下：
  bench-large.epub          约 200 章 / 7 MB，测导入、打开、搜索
  broken-*.epub             各种损坏形态，验证报错而不是崩溃
"""

from __future__ import annotations

import os
import struct
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".books"
OUT.mkdir(exist_ok=True)

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:{book_uuid}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>基准生成器</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
{manifest}
  </manifest>
  <spine>
{spine}
  </spine>
</package>
"""

CHAPTER = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><title>第{index}章</title><link rel="stylesheet" href="../Styles/style.css"/></head>
<body>
<section>
<h1>第{index}章 {title}</h1>
{paragraphs}
</section>
</body>
</html>
"""

STYLE = """body { padding: 0 1.2em; line-height: 1.9; }
h1 { font-size: 1.5em; border-bottom: 1px solid #999; }
p { text-indent: 2em; margin: 0.6em 0; text-align: justify; }
"""

SENTENCES = [
    "夜色从窗缝里渗进来，灯芯轻轻抖了一下，把影子推到了墙角。",
    "他把书翻到折角的那一页，读了很久，才想起自己还没吃晚饭。",
    "院子里那棵老槐树又落了一层花，风一吹，像是有人在低声说话。",
    "她说，别急着回去，路上有雾，等天亮再走也不迟。",
    "钟声敲过十二下，城市忽然安静下来，只剩远处车轮压过积水的声音。",
    "他在纸上写下第一个字，然后停住，仿佛在等那个字自己长出下一句。",
    "书架最高一格积了灰，他踩上凳子，指尖碰到一本没有书名的旧册子。",
    "雨停之后，空气里有一股泥土和铁锈混在一起的味道，说不清是旧还是新。",
    "孩子们在巷口追逐，笑声撞到墙上，又弹回来，落在每个人的肩头。",
    "那一刻他忽然明白，所谓远方，不过是把眼前的日子再走一遍。",
]


def paragraph(seed: int, count: int = 5) -> str:
    parts = [SENTENCES[(seed + i) % len(SENTENCES)] for i in range(count)]
    return "<p>" + "".join(parts) + "</p>"


def write_epub(path: Path, title: str, chapters: int, paras_per_chapter: int) -> None:
    book_uuid = f"{abs(hash(title)):032x}"[:32]
    manifest = [
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '    <item id="css" href="Styles/style.css" media-type="text/css"/>',
    ]
    spine = []
    for i in range(1, chapters + 1):
        manifest.append(
            f'    <item id="ch{i}" href="Text/ch{i}.xhtml" media-type="application/xhtml+xml"/>'
        )
        spine.append(f'    <itemref idref="ch{i}"/>')
    opf = OPF.format(
        book_uuid=book_uuid,
        title=title,
        manifest="\n".join(manifest),
        spine="\n".join(spine),
    )
    nav_items = "\n".join(
        f'      <li><a href="Text/ch{i}.xhtml">第{i}章</a></li>' for i in range(1, chapters + 1)
    )
    nav = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
        "<head><title>目录</title></head><body>"
        '<nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n'
        f"{nav_items}\n    </ol></nav></body></html>"
    )

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # mimetype 必须是第一个条目且不压缩
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", opf)
        zf.writestr("OEBPS/nav.xhtml", nav)
        zf.writestr("OEBPS/Styles/style.css", STYLE)
        for i in range(1, chapters + 1):
            body = "\n".join(
                paragraph(i * 7 + p * 13, count=6) for p in range(paras_per_chapter)
            )
            zf.writestr(
                f"OEBPS/Text/ch{i}.xhtml",
                CHAPTER.format(index=i, title=f"夜读 {i}", paragraphs=body),
            )


def write_bytes(path: Path, payload: bytes) -> None:
    path.write_bytes(payload)


def build_malformed() -> list[tuple[str, str]]:
    """返回 [(文件名, 说明)]，每个文件对应一种损坏形态。"""
    results: list[tuple[str, str]] = []

    # 1. 空文件
    write_bytes(OUT / "broken-empty.epub", b"")
    results.append(("broken-empty.epub", "0 字节"))

    # 2. 不是 zip 的随机字节
    write_bytes(OUT / "broken-not-zip.epub", struct.pack("<16s", b"not a zip file!!") * 64)
    results.append(("broken-not-zip.epub", "非 zip 数据"))

    # 3. 截断的合法 zip：只写前 60%
    full = OUT / "_tmp-full.epub"
    write_epub(full, "截断样本", chapters=6, paras_per_chapter=2)
    data = full.read_bytes()
    write_bytes(OUT / "broken-truncated.epub", data[: int(len(data) * 0.6)])
    full.unlink()
    results.append(("broken-truncated.epub", "zip 被截断"))

    # 4. 缺 mimetype
    with zipfile.ZipFile(OUT / "broken-no-mimetype.epub", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF.format(book_uuid="a" * 32, title="缺 mimetype",
                                                   manifest="", spine=""))
    results.append(("broken-no-mimetype.epub", "缺少 mimetype 条目"))

    # 5. 缺 container.xml
    with zipfile.ZipFile(OUT / "broken-no-container.epub", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("OEBPS/content.opf", OPF.format(book_uuid="b" * 32, title="无 container",
                                                   manifest="", spine=""))
    results.append(("broken-no-container.epub", "缺少 META-INF/container.xml"))

    # 6. OPF 不是合法 XML
    with zipfile.ZipFile(OUT / "broken-bad-opf.epub", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", "<package><metadata><dc:title>没闭合")
    results.append(("broken-bad-opf.epub", "OPF 非法 XML"))

    # 7. spine 指向不存在的条目
    with zipfile.ZipFile(OUT / "broken-missing-spine.epub", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr(
            "OEBPS/content.opf",
            OPF.format(
                book_uuid="c" * 32,
                title="丢章节",
                manifest='    <item id="ch1" href="Text/missing.xhtml" '
                'media-type="application/xhtml+xml"/>',
                spine='    <itemref idref="ch1"/>',
            ),
        )
    results.append(("broken-missing-spine.epub", "spine 指向不存在的文件"))

    # 8. 合法 zip 但容器指向不存在的 OPF
    with zipfile.ZipFile(OUT / "broken-missing-opf.epub", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
    results.append(("broken-missing-opf.epub", "container 指向的 OPF 不存在"))

    return results


def main() -> None:
    write_epub(OUT / "bench-large.epub", "夜读大书（性能基准）", chapters=200, paras_per_chapter=6)
    size_mb = (OUT / "bench-large.epub").stat().st_size / (1024 * 1024)
    print(f"bench-large.epub  {size_mb:.2f} MiB  200 章")

    for name, note in build_malformed():
        path = OUT / name
        print(f"{name:28s} {path.stat().st_size:>8d} B  {note}")


if __name__ == "__main__":
    main()
