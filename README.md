# 墨读（Modu）

<p align="center">
  <img src="src/assets/logo.svg" width="112" alt="墨读 logo" />
</p>

一个为中文长篇小说打磨的桌面 EPUB 阅读器：Tauri 2 + React 19 + TypeScript，Rust 负责解析，WebView 负责排版。

> 前身是 2023 年那版 PyQt5 阅读器（`QTextBrowser` 只能吃 CSS 2.1 子集，中文两端对齐、脚注、图片都很难看）。
> 这次把渲染换成 Chromium，分页内核使用 [foliate-js](https://github.com/johnfactotum/foliate-js)，阅读体验接近纸书。

**标识**：一滴墨落进摊开的书里——「墨」是内容，「读」是那本书；墨砖底 + 纸色书页 + 淡紫到蓝的墨滴，与深色/羊皮纸主题同源。矢量源在 `src/assets/logo.svg`，图标集由 `pnpm tauri icon src/assets/logo.svg` 生成到 `src-tauri/icons/`。

## 特性

- **书架**：拖拽批量导入、封面/字数/章数、搜索、排序（最近阅读/书名/作者/入库时间）、在读/未读/读完筛选；SQLite + 虚拟滚动，上千本也不卡。
- **排版**：分页阅读（单栏、按行宽分栏）、滚轮/触控板翻页、点击左右两侧翻页、目录树跳转、脚注锚点在章节内定位。
- **主题**：深色 / 浅色 / 羊皮纸 / 护眼绿 / 跟随系统，宿主界面与正文同色板，不再「一半浅一半深」；应用为无边框窗口，标题栏与界面一体。
- **阅读设置**：主题、字体（宋/黑/楷）、字号、行高、版心宽度、首行缩进、段后间距、字间距、对齐方式、「净版」（忽略书内排版），实时生效并持久化。
- **进度与书签**：Locator v2 —— 「章号 + 章内页分数 + 引文/前后文」，换字号、换窗口、重开书都会回到原来那一句；书签可写备注。
- **划线批注**：选中正文弹出工具条，四色划线（黄/绿/蓝/粉）+ 备注，可一键导出 Markdown。定位不依赖 CFI 或像素，而是记「引文 + 前后 32 字 + 同章第几次出现」，换字号、换主题、重开书都能重新画回原句。
- **全书搜索**：SQLite FTS5（trigram）建全文索引，命中列表带章名与上下文摘录；点结果会跳到目标页并把命中句高亮（CSS Custom Highlight API），中文两字词也能搜（回退 `instr` 扫描）。
- **滚动阅读**：排版面板可切换「翻页 / 滚动」，切换不重开书、位置保持；翻页模式下滚轮、触控板、点击左右两侧都能翻。
- **快捷键与帮助**：`F1` 打开帮助面板（翻页、书签、批注、视图三组清单），`F11` 全屏，`Ctrl+B/K/D` 侧栏/搜索/加书签。
- **沉浸模式**：`Esc` 退出，再 `Esc` 回书架。
- **格式容错**：GBK/GB18030 未声明编码的老书、`linear="no"` 的注释页、EPUB3 nav 与 NCX 双目录、大小写不一致的 zip 路径都能读；截断、缺 container、OPF 非法等畸形包会给出明确错误而不是崩溃。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Tauri 2（Rust 1.90+，Windows NSIS 打包） |
| 前端 | React 19、TypeScript、Vite 8、Tailwind 4、Radix UI、Zustand 5、lucide-react |
| 分页/渲染 | foliate-js（vendored，固定 commit） |
| EPUB 解析 | Rust：`zip` + `roxmltree` + `encoding_rs` |
| 存储 | `rusqlite`（bundled，WAL），书库 / 进度 / 书签 / 批注 / FTS5 全文索引 |
| 资源通道 | 自定义 `epub://` 协议（Windows 上即 `http://epub.localhost`） |

数据放在用户数据目录下（`modu.db` + `covers/`）；设置 `MODU_DATA_DIR` 可切到便携模式，把数据放到任意目录。

## 开发

```bash
pnpm install
pnpm tauri dev        # 起 Vite(1420) + Tauri 窗口
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm test             # vitest（前端单测）
cd src-tauri && cargo test   # Rust 单测（含 DRM/畸形样本/大书基准）
cd src-tauri && cargo clippy --lib --tests -- -D warnings   # 零告警门禁
pnpm tauri build --bundles nsis   # 打安装包
```

> Windows 需要 MSVC Build Tools（Desktop development with C++）与 WebView2 Runtime；`cargo` 编译 `zip`/`SQLite` 时如果撞上 MSVC 的 `D8050` 报错，见 `src-tauri/Cargo.toml` 里的 `[profile.dev.package.libsqlite3-sys]` 处理。

### 测试书与基准

```bash
python scripts/gen_test_epub.py   # 生成 .books/test-mandarin.epub（EPUB3 + NCX、脚注、图片、外链）
python scripts/gen_fixtures.py    # 生成 .books/bench-large.epub（200 章）与 8 个畸形样本
cd src-tauri && cargo test --lib benches -- --nocapture   # 打印性能数字
```

参考数字（debug 构建，本机）：200 章 / 26 万字符的书 open 16ms、全文读取 25ms、导入 + 建 FTS 索引 72ms、一次搜索 <1ms。

## 文档

- [用户手册](docs/用户手册.md)：安装、书架、阅读、排版、书签与批注、搜索、快捷键、数据备份、常见问题
- [开发任务书](docs/开发任务书.md)：需求、ADR、架构、里程碑与验收表
- [交付说明](docs/M0-M2-交付说明.md)：各里程碑交付内容与验证记录
- [审查与加固方案](docs/M0-M2-审查与加固方案.md)：M0–M2 两轴审查的 19 项问题、修复与 backlog

## 性能与已知限制

- 大书按章懒加载，书架用虚拟滚动；FTS5 索引在首次搜索时按需补建，老书无需重新导入。
- 批注以「引文 + 上下文 + 出现序号」定位，若某章文本被外部工具改动到前后文都对不上，该条批注会跳过不画（数据仍保留）。
- 搜索结果只覆盖当前打开的书；跨书搜索未做。
- 超短章节（封面、版权页）在分页模式下只有一页，按比例跳转会顺延到下一章，属 foliate 的边界行为。
- Windows 无边框窗口没有系统圆角与投影，缩放走自绘边缘热区。

## 仓库结构

```
epub-reader/
├─ src/                      # React 前端
│  ├─ features/shelf/        # 书架
│  ├─ features/reader/       # 阅读器（目录树、书签、批注、搜索、排版面板）
│  ├─ components/            # 自绘标题栏、窗口缩放热区、帮助面板
│  ├─ renderer/              # foliate 适配层：章节加载、主题 CSS、ReaderView
│  │  └─ vendor/foliate/     # vendored 分页内核（MIT）
│  ├─ lib/                   # IPC、路径、locator、协议 URL
│  └─ store/                 # Zustand（书库 / 阅读设置）
├─ src-tauri/src/            # Rust：epub 解析、SQLite（含 FTS5）、命令、自定义协议
├─ docs/                     # 开发任务书、交付说明
└─ scripts/                  # 测试书 / 基准书 / 畸形样本生成脚本
```

## 许可

MIT。vendored `src/renderer/vendor/foliate/` 来自 foliate-js，遵循其原始 MIT 许可（见该目录下 LICENSE）。
