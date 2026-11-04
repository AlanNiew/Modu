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
- **阅读设置**：主题、字体（宋/黑/楷）、字号、行高、版心宽度、首行缩进，实时生效并持久化。
- **进度与书签**：按「章号 + 章内位置」记录（Locator v1），换字号不丢位置；跨章/跨页自动记录，启动时恢复到上次位置。
- **沉浸模式**：`Esc` 退出，再 `Esc` 回书架。
- **格式容错**：GBK/GB18030 未声明编码的老书、`linear="no"` 的注释页、EPUB3 nav 与 NCX 双目录、大小写不一致的 zip 路径都能读。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Tauri 2（Rust 1.90+，Windows NSIS 打包） |
| 前端 | React 19、TypeScript、Vite 8、Tailwind 4、Radix UI、Zustand 5、lucide-react |
| 分页/渲染 | foliate-js（vendored，固定 commit） |
| EPUB 解析 | Rust：`zip` + `roxmltree` + `encoding_rs` |
| 存储 | `rusqlite`（bundled，WAL），进度/书签/书库 |
| 资源通道 | 自定义 `epub://` 协议（Windows 上即 `http://epub.localhost`） |

数据放在用户数据目录下（`modu.db` + `covers/`）；设置 `MODU_DATA_DIR` 可切到便携模式，把数据放到任意目录。

## 开发

```bash
pnpm install
pnpm tauri dev        # 起 Vite(1420) + Tauri 窗口
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest（前端单测）
cd src-tauri && cargo test   # Rust 单测
pnpm tauri build --bundles nsis   # 打安装包
```

> Windows 需要 MSVC Build Tools（Desktop development with C++）与 WebView2 Runtime；`cargo` 编译 `zip`/`SQLite` 时如果撞上 MSVC 的 `D8050` 报错，见 `src-tauri/Cargo.toml` 里的 `[profile.dev.package.libsqlite3-sys]` 处理。

## 仓库结构

```
epub-reader/
├─ src/                      # React 前端
│  ├─ features/shelf/        # 书架
│  ├─ features/reader/       # 阅读器（目录树、书签、排版面板）
│  ├─ renderer/              # foliate 适配层：章节加载、主题 CSS、ReaderView
│  │  └─ vendor/foliate/     # vendored 分页内核（MIT）
│  ├─ lib/                   # IPC、路径、locator、协议 URL
│  └─ store/                 # Zustand（书库 / 阅读设置）
├─ src-tauri/src/            # Rust：epub 解析、SQLite、命令、自定义协议
├─ docs/                     # 开发任务书、交付说明
└─ scripts/                  # 测试书生成脚本
```

## 许可

MIT。vendored `src/renderer/vendor/foliate/` 来自 foliate-js，遵循其原始 MIT 许可（见该目录下 LICENSE）。
