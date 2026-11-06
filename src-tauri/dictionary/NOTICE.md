# 内嵌繁简词典（繁→简）

本目录的两个数据文件来自 OpenCC（繁简中文转换开源项目）：

- 来源：<https://github.com/BYVoid/OpenCC>（data/dictionary）
- 许可：OpenCC 采用 Apache License 2.0，全文见同目录 `LICENSE-OpenCC.txt`
  （<https://www.apache.org/licenses/LICENSE-2.0>）；原始文件头亦标注来源与许可
- 用途：`src-tauri/src/convert.rs` 通过 `include_str!` 内嵌，构建
  「繁体 → 简体」静态词典（TSCharacters = 单字映射，TSPhrases = 短语优先映射）

处理方式（见 `convert.rs`）：

- 只取每个词条「制表符后第一组值」（OpenCC 语义中的默认/首选翻译），
  多候选值（如异体字/生僻字线索）不参与转换
- `#` 开头的注释行与空行忽略
- 数据文件保持原样入库，解析完全在运行时懒构建（`OnceLock`），启动不付出成本
