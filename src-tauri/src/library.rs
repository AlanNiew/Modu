//! 书库：导入流水线（指纹/元数据/封面/字数/目录）+ 查询。
//!
//! 导入是纯 Rust 操作：打开 zip → 解析 OPF → 抽封面落盘 → 统计章节字数 → 单事务写库。
//! 前端只传路径，不参与解析。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::{now_ms, Db};
use crate::epub::{self, OpenedBook};
use crate::error::{AppError, AppResult};

/// 书架卡片需要的全部字段；前端 `BookSummary` 与之对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookSummary {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    /// 相对数据目录的文件名，例如 `covers/<hash>.jpg`。
    pub cover_file: Option<String>,
    pub chapter_count: i64,
    pub char_count: i64,
    pub added_at: i64,
    pub opened_at: Option<i64>,
    pub finished_at: Option<i64>,
    /// 全书进度 0..1；未开始阅读为 0。
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub path: String,
    pub book: Option<BookSummary>,
    /// 单本失败不影响其它书，错误回传给前端逐个展示。
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Recent,
    Title,
    Author,
    Added,
}

impl SortKey {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "title" => Self::Title,
            "author" => Self::Author,
            "added" => Self::Added,
            _ => Self::Recent,
        }
    }

    fn order_by(self) -> &'static str {
        match self {
            // 最近阅读优先，没读过的按入库时间倒序排在后面。
            Self::Recent => "COALESCE(b.opened_at, b.added_at) DESC",
            Self::Title => "b.title COLLATE NOCASE ASC",
            Self::Author => "COALESCE(b.author, '') COLLATE NOCASE ASC",
            Self::Added => "b.added_at DESC",
        }
    }
}

/// 书架筛选：全部 / 在读 / 未读 / 读完。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterKey {
    All,
    Reading,
    Unread,
    Finished,
}

impl FilterKey {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "reading" => Self::Reading,
            "unread" => Self::Unread,
            "finished" => Self::Finished,
            _ => Self::All,
        }
    }

    fn predicate(self) -> &'static str {
        match self {
            Self::All => "1 = 1",
            Self::Reading => "p.percent > 0.001 AND p.percent < 0.999",
            Self::Unread => "COALESCE(p.percent, 0) <= 0.001",
            Self::Finished => "COALESCE(p.percent, 0) >= 0.999",
        }
    }
}

const SUMMARY_COLUMNS: &str = r#"
    b.id, b.path, b.title, b.author, b.publisher, b.language, b.cover_file,
    b.chapter_count, b.char_count, b.added_at, b.opened_at, b.finished_at,
    COALESCE(p.percent, 0.0)
"#;

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookSummary> {
    Ok(BookSummary {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        author: row.get(3)?,
        publisher: row.get(4)?,
        language: row.get(5)?,
        cover_file: row.get(6)?,
        chapter_count: row.get(7)?,
        char_count: row.get(8)?,
        added_at: row.get(9)?,
        opened_at: row.get(10)?,
        finished_at: row.get(11)?,
        percent: row.get(12)?,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOptions {
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

pub fn list(db: &Db, options: &ListOptions) -> AppResult<Vec<BookSummary>> {
    let sort = SortKey::parse(options.sort.as_deref().unwrap_or("recent"));
    let filter = FilterKey::parse(options.filter.as_deref().unwrap_or("all"));
    let keyword = options
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());

    let base = format!(
        "SELECT {SUMMARY_COLUMNS}
         FROM books b LEFT JOIN progress p ON p.book_id = b.id
         WHERE {}",
        filter.predicate()
    );
    let order = sort.order_by();

    // 关键词：标题/作者/出版商模糊匹配（LIKE 大小写不敏感仅对 ASCII 生效，
    // 中文按子串直接匹配，正好符合预期）。
    // 注意 SQLite 的 LIKE 默认没有转义字符，必须显式 ESCAPE '\'，
    // 否则 escape_like 输出的 `\%` 会变成「反斜杠 + 通配符」而不是字面量。
    let sql = if keyword.is_some() {
        format!(
            "{base} AND (b.title LIKE ?1 ESCAPE '\\' OR COALESCE(b.author, '') LIKE ?1 ESCAPE '\\'
                        OR COALESCE(b.publisher, '') LIKE ?1 ESCAPE '\\')
             ORDER BY {order}"
        )
    } else {
        format!("{base} ORDER BY {order}")
    };

    db.with(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = if let Some(keyword) = keyword {
            let pattern = format!("%{}%", escape_like(keyword));
            let iter = stmt.query_map([&pattern], row_to_summary)?;
            iter.collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            let iter = stmt.query_map([], row_to_summary)?;
            iter.collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    })
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn get(db: &Db, book_id: i64) -> AppResult<BookSummary> {
    let sql = format!(
        "SELECT {SUMMARY_COLUMNS} FROM books b
         LEFT JOIN progress p ON p.book_id = b.id WHERE b.id = ?1"
    );
    db.with(|conn| {
        conn.query_row(&sql, [book_id], row_to_summary)
            .map_err(|_| AppError::NotFound(format!("书籍不存在: {book_id}")))
    })
}

pub fn remove(db: &Db, book_id: i64) -> AppResult<()> {
    db.with(|conn| {
        let changed = conn.execute("DELETE FROM books WHERE id = ?1", [book_id])?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("书籍不存在: {book_id}")));
        }
        Ok(())
    })
}

/// 记录一次“打开”，供书架按最近阅读排序。
pub fn mark_opened(db: &Db, book_id: i64) -> AppResult<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE books SET opened_at = ?2 WHERE id = ?1",
            rusqlite::params![book_id, now_ms()],
        )?;
        Ok(())
    })
}

/// 导入一批文件。单本失败只记录错误，继续导入其余的。
pub fn import(db: &Db, covers_dir: &Path, paths: &[String]) -> Vec<ImportOutcome> {
    paths
        .iter()
        .map(|path| match import_one(db, covers_dir, path) {
            Ok(book) => ImportOutcome {
                path: path.clone(),
                book: Some(book),
                error: None,
            },
            Err(err) => ImportOutcome {
                path: path.clone(),
                book: None,
                error: Some(err.to_string()),
            },
        })
        .collect()
}

fn import_one(db: &Db, covers_dir: &Path, path: &str) -> AppResult<BookSummary> {
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Err(AppError::NotFound(path.to_string()));
    }
    let file_path =
        file_path
            .canonicalize()
            .map_err(|e| AppError::Internal(format!("路径规范化失败 {path}: {e}")))?;
    let path = file_path.to_string_lossy().to_string();

    let bytes = std::fs::read(&file_path)?;
    let file_hash = blake3::hash(&bytes).to_hex().to_string();
    let file_size = bytes.len() as i64;
    // 指纹算完即释放：后续解析自己会再打开 zip，避免同时持有两倍内存。
    drop(bytes);

    let book = epub::open(&path)?;
    let package = book.package.clone();
    let cover_file = write_cover(covers_dir, &file_hash, &book).ok();

    // 章节标题：从目录（nav/NCX）按 path 反查，搜索结果显示「第X章」而不是 chap3.xhtml。
    let toc_titles: std::collections::HashMap<&str, &str> = package
        .toc
        .iter()
        .filter(|item| !item.label.trim().is_empty())
        .filter_map(|item| item.path.as_deref().map(|path| (path, item.label.trim())))
        .collect();

    // 章节字数与正文：一次性算完，搜索/统计/进度估算都要用。
    let mut chapters: Vec<(usize, String, Option<String>, i64, String)> = Vec::new();
    let mut total_chars: i64 = 0;
    for item in &package.spine {
        let html = book.read_text(&item.path).unwrap_or_default();
        let text = html_to_text(&html);
        let count = text.chars().filter(|c| !c.is_whitespace()).count() as i64;
        total_chars += count;
        let chapter_title = toc_titles.get(item.path.as_str()).map(|s| (*s).to_string());
        chapters.push((item.index, item.path.clone(), chapter_title, count, text));
    }

    let title = if package.title.trim().is_empty() {
        file_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名".into())
    } else {
        package.title.clone()
    };
    let author = if package.authors.is_empty() {
        None
    } else {
        Some(package.authors.join("、"))
    };
    let cover_file = cover_file.map(|name| format!("covers/{name}"));

    let id = db.with_mut(|conn| {
        let tx = conn.transaction()?;
        let now = now_ms();

        // 同一文件（hash 相同）重复导入 → 复用旧条目，只刷新元数据与路径。
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM books WHERE file_hash = ?1 OR path = ?2 LIMIT 1",
                rusqlite::params![file_hash, path],
                |row| row.get(0),
            )
            .ok();

        let id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE books SET path = ?2, file_size = ?3, title = ?4, author = ?5,
                        publisher = ?6, language = ?7, identifier = ?8, description = ?9,
                        cover_file = COALESCE(?10, cover_file),
                        chapter_count = ?11, char_count = ?12
                     WHERE id = ?1",
                    rusqlite::params![
                        id,
                        path,
                        file_size,
                        title,
                        author,
                        package.publisher,
                        package.language,
                        package.identifier,
                        package.description,
                        cover_file,
                        package.spine.len() as i64,
                        total_chars,
                    ],
                )?;
                id
            }
            None => {
                tx.execute(
                    "INSERT INTO books
                        (path, file_hash, file_size, title, author, publisher, language,
                         identifier, description, cover_file, chapter_count, char_count, added_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    rusqlite::params![
                        path,
                        file_hash,
                        file_size,
                        title,
                        author,
                        package.publisher,
                        package.language,
                        package.identifier,
                        package.description,
                        cover_file,
                        package.spine.len() as i64,
                        total_chars,
                        now,
                    ],
                )?;
                tx.last_insert_rowid()
            }
        };

        tx.execute("DELETE FROM chapters WHERE book_id = ?1", [id])?;
        tx.execute("DELETE FROM chapters_fts WHERE book_id = ?1", [id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chapters (book_id, ord, href, title, char_count)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (ord, href, title, count, _) in &chapters {
                stmt.execute(rusqlite::params![id, *ord as i64, href, title, count])?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chapters_fts (text, href, ord, book_id) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (ord, href, _, _, text) in &chapters {
                stmt.execute(rusqlite::params![text, href, *ord as i64, id])?;
            }
        }

        tx.commit()?;
        Ok(id)
    })?;

    get(db, id)
}

/// 把封面写进数据目录；返回文件名（不含 `covers/` 前缀）。
fn write_cover(covers_dir: &Path, file_hash: &str, book: &OpenedBook) -> AppResult<String> {
    let cover_path = book
        .package
        .cover_path
        .as_deref()
        .ok_or_else(|| AppError::EntryMissing("该书没有封面".into()))?;
    let bytes = book.read_entry(cover_path)?;
    let ext = cover_extension(cover_path);
    std::fs::create_dir_all(covers_dir)?;
    let name = format!("{file_hash}.{ext}");
    // 同一本书重复导入会覆盖同名文件，内容一致，无副作用。
    std::fs::write(covers_dir.join(&name), &bytes)?;
    Ok(name)
}

fn cover_extension(cover_path: &str) -> String {
    let ext = match epub::mime_for(cover_path) {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => cover_path
            .rsplit('.')
            .next()
            .filter(|ext| matches!(*ext, "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg"))
            .unwrap_or("img"),
    };
    ext.to_string()
}

/// 在 ASCII 大小写不敏感的前提下查找子串，返回起始字节位置。
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let hay = haystack.as_bytes();
    let ndl = needle.as_bytes();
    if ndl.is_empty() || hay.len() < ndl.len() {
        return None;
    }
    (0..=hay.len() - ndl.len()).find(|&start| {
        hay[start..start + ndl.len()]
            .iter()
            .zip(ndl)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
    })
}

/// `rest` 以 `<` 开头；判断这个标签是否属于「块级/换行」语义。
fn is_block_tag(rest: &str) -> bool {
    let after = rest[1..].strip_prefix('/').unwrap_or(&rest[1..]);
    let bytes = after.as_bytes();
    let mut end = 0;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric()) {
        end += 1;
    }
    if end == 0 {
        return false;
    }
    let name = after.as_bytes()[..end].to_ascii_lowercase();
    matches!(
        name.as_slice(),
        b"p" | b"div"
            | b"br"
            | b"hr"
            | b"li"
            | b"ul"
            | b"ol"
            | b"dl"
            | b"dt"
            | b"dd"
            | b"tr"
            | b"td"
            | b"th"
            | b"section"
            | b"article"
            | b"aside"
            | b"header"
            | b"footer"
            | b"nav"
            | b"main"
            | b"figure"
            | b"figcaption"
            | b"blockquote"
            | b"pre"
            | b"table"
            | b"h1"
            | b"h2"
            | b"h3"
            | b"h4"
            | b"h5"
            | b"h6"
    )
}

/// 粗略统计可见正文字符数：去掉标签、注释、script/style 内容，解码常见实体。
///
/// 不做完整 HTML 解析——只为字数/进度展示服务，几百万字也只需毫秒级。
#[cfg_attr(not(test), allow(dead_code))] // 仅测试用于校验 html_to_text 的字数口径
pub fn plain_text_len(html: &str) -> usize {
    html_to_text(html).chars().filter(|c| !c.is_whitespace()).count()
}

/// 抽出可见正文：与 [`plain_text_len`] 同一套扫描规则，但保留文本本身。
///
/// 结果用于全文索引与搜索摘录，所以把连续空白压成单个空格、去掉首尾空白。
pub fn html_to_text(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 2);
    let mut pending_space = false;
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'<' {
            let rest = &html[i..];

            // 注释整段跳过：注释里的 '>' 不能当作标签结束。
            if rest.starts_with("<!--") {
                i = match rest.find("-->") {
                    Some(pos) => i + pos + 3,
                    None => break,
                };
                continue;
            }

            // script/style 连内容一起跳过。
            // 注意用字节切片：按 str 切片会在中文边界上 panic。
            let tag_head = &rest.as_bytes()[..rest.len().min(7)];
            if tag_head.len() >= 7 && tag_head[..7].eq_ignore_ascii_case(b"<script") {
                i = match find_ci(rest, "</script") {
                    Some(pos) => {
                        // 跳过结束标签本身
                        match rest[pos..].find('>') {
                            Some(gt) => i + pos + gt + 1,
                            None => break,
                        }
                    }
                    None => break,
                };
                continue;
            }
            if tag_head.len() >= 6 && tag_head[..6].eq_ignore_ascii_case(b"<style") {
                i = match find_ci(rest, "</style") {
                    Some(pos) => match rest[pos..].find('>') {
                        Some(gt) => i + pos + gt + 1,
                        None => break,
                    },
                    None => break,
                };
                continue;
            }

            // 块级标签在正文里也要产生分隔：否则 `<p>第一章</p><p>纸上的灯</p>`
            // 会拼成「第一章纸上的灯」，让搜索短语命中跨段、摘录读起来也怪。
            if is_block_tag(rest) && !out.is_empty() {
                pending_space = true;
            }

            match rest.find('>') {
                Some(pos) => {
                    i += pos + 1;
                    continue;
                }
                None => break,
            }
        }

        if bytes[i] == b'&'
            && let Some(semi) = html[i..].find(';').filter(|n| *n <= 10) {
                let entity = &html[i + 1..i + semi];
                let ch = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => entity
                        .strip_prefix('#')
                        .and_then(|num| {
                            if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                                u32::from_str_radix(hex, 16).ok()
                            } else {
                                num.parse::<u32>().ok()
                            }
                        })
                        .and_then(char::from_u32),
                };
                if let Some(ch) = ch {
                    push_text(ch, &mut out, &mut pending_space);
                    i += semi + 1;
                    continue;
                }
            }

        // 多字节 UTF-8：按字符推进。
        let ch = html[i..].chars().next().unwrap_or('\u{fffd}');
        push_text(ch, &mut out, &mut pending_space);
        i += ch.len_utf8();
    }

    out.trim().to_string()
}

/// 把字符追加到正文缓冲：空白折叠成单个空格，且不写在开头。
fn push_text(ch: char, out: &mut String, pending_space: &mut bool) {
    if ch.is_whitespace() {
        if !out.is_empty() {
            *pending_space = true;
        }
        return;
    }
    if *pending_space {
        out.push(' ');
        *pending_space = false;
    }
    out.push(ch);
}

/// 数据目录布局：`modu.db` + `covers/`。所有可写文件都在这里。
pub fn data_layout(app_data_dir: &Path) -> (PathBuf, PathBuf) {
    (app_data_dir.join("modu.db"), app_data_dir.join("covers"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试临时目录放在 `target/` 下：系统 TEMP 可能被 DSH 沙箱拦截。
    fn temp_dir() -> PathBuf {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = base.join(format!("{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建测试目录");
        dir
    }

    #[test]
    fn counts_visible_characters_only() {
        let html = "<html><head><style>p{color:red}</style></head>\
                    <body><!-- 注释 --><p>第一章&nbsp;纸上的灯</p>\
                    <script>var x = '不该计入';</script></body></html>";
        // 「第一章纸上的灯」= 7 个非空白字符
        assert_eq!(plain_text_len(html), 7);
    }

    #[test]
    fn decodes_numeric_entities() {
        assert_eq!(plain_text_len("<p>&#20320;&#x597D;</p>"), 2);
        assert_eq!(plain_text_len("<p>&amp;&lt;</p>"), 2);
    }

    #[test]
    fn handles_unterminated_markup() {
        assert_eq!(plain_text_len("<p>abc"), 3);
        assert_eq!(plain_text_len("abc"), 3);
    }

    #[test]
    fn imports_and_lists_books() {
        let dir = temp_dir();
        let db = Db::open(&dir.join("modu.db")).unwrap();
        let covers = dir.join("covers");

        // 测试书由 scripts/gen_test_epub.py 生成，仓库内固定路径。
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".books")
            .join("test-mandarin.epub");
        if !sample.is_file() {
            return; // 没有样书时跳过（CI 环境不生成）
        }

        let outcomes = import(&db, &covers, &[sample.to_string_lossy().to_string()]);
        assert_eq!(outcomes.len(), 1);
        let first = outcomes[0].book.as_ref().expect("导入应成功");
        assert_eq!(first.chapter_count, 4);
        assert!(first.char_count > 0, "字数应大于 0");
        assert!(first.cover_file.is_some(), "测试书带封面");

        // 重复导入不产生重复条目。
        let again = import(&db, &covers, &[sample.to_string_lossy().to_string()]);
        assert_eq!(again[0].book.as_ref().unwrap().id, first.id);

        let books = list(&db, &ListOptions::default()).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(list(&db, &ListOptions {
            query: Some("纸上的灯".into()),
            ..Default::default()
        })
        .unwrap()
        .len(), 1);

        // 全文索引在导入时写好，长词走 FTS5、短词走逐章扫描，两者都要能命中。
        assert_eq!(index_status(&db, first.id).unwrap(), 4);
        let long_hits = search(&db, first.id, "纸上的灯", 10).unwrap();
        assert!(!long_hits.is_empty(), ">=3 字应命中章节");
        assert!(long_hits[0].snippet.contains(SNIPPET_MARK_START));
        assert!(long_hits.iter().all(|hit| hit.index < 4));
        // 章名从目录反查，搜索结果不该只显示文件名
        assert!(
            long_hits.iter().any(|hit| hit.chapter_title.is_some()),
            "章节标题应从目录回填"
        );
        let short_hits = search(&db, first.id, "灯", 10).unwrap();
        assert!(!short_hits.is_empty(), "单字应回退到扫描");
    }

    #[test]
    fn annotations_roundtrip() {
        let dir = temp_dir();
        let db = Db::open(&dir.join("modu.db")).unwrap();
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".books")
            .join("test-mandarin.epub");
        if !sample.is_file() {
            return;
        }
        let outcome = import(&db, &dir.join("covers"), &[sample.to_string_lossy().to_string()]);
        let book_id = outcome[0].book.as_ref().expect("导入应成功").id;

        let input = AnnotationInput {
            locator: r#"{"v":1,"index":1,"fraction":0.42}"#.into(),
            chapter_href: "OEBPS/Text/ch1.xhtml".into(),
            chapter_title: Some("第一章".into()),
            quote: "纸上的灯".into(),
            prefix: Some("第一章".into()),
            suffix: None,
            occurrence: 0,
            color: Some(AnnotationColor::Green),
            note: Some("  记一笔  ".into()),
        };
        let added = annotation_add(&db, book_id, &input).unwrap();
        assert_eq!(added.color, AnnotationColor::Green);
        assert_eq!(added.note.as_deref(), Some("记一笔"), "备注应去首尾空白");

        // 省略颜色时默认黄；空引文拒绝
        let default_color = AnnotationInput {
            color: None,
            note: None,
            ..input.clone()
        };
        assert_eq!(
            annotation_add(&db, book_id, &default_color).unwrap().color,
            AnnotationColor::Yellow
        );
        let empty_quote = AnnotationInput {
            quote: "   ".into(),
            ..input.clone()
        };
        assert!(annotation_add(&db, book_id, &empty_quote).is_err());

        assert_eq!(annotation_list(&db, book_id).unwrap().len(), 2);

        let updated =
            annotation_update(&db, added.id, Some("改过的备注"), Some(AnnotationColor::Blue)).unwrap();
        assert_eq!(updated.note.as_deref(), Some("改过的备注"));
        assert_eq!(updated.color, AnnotationColor::Blue);

        // 传空字符串 = 清空备注
        assert!(annotation_update(&db, added.id, Some(""), None)
            .unwrap()
            .note
            .is_none());

        annotation_remove(&db, added.id).unwrap();
        assert_eq!(annotation_list(&db, book_id).unwrap().len(), 1);
        assert!(annotation_remove(&db, added.id).is_err(), "重复删除应报不存在");
    }

    /// 导入 + 建 FTS 索引的耗时（打印用，不做硬断言）。
    #[test]
    fn benches_import_large_book() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(".books")
            .join("bench-large.epub");
        if !sample.is_file() {
            eprintln!("跳过导入基准：先跑 scripts/gen_fixtures.py");
            return;
        }
        let dir = temp_dir();
        let db = Db::open(&dir.join("modu.db")).unwrap();
        let covers = dir.join("covers");

        let started = std::time::Instant::now();
        let outcomes = import(&db, &covers, &[sample.to_string_lossy().to_string()]);
        let import_ms = started.elapsed().as_millis();

        let book = outcomes[0].book.as_ref().expect("导入应成功");
        assert_eq!(book.chapter_count, 200, "基准书 200 章");

        let started = std::time::Instant::now();
        let hits = search(&db, book.id, "夜色", 20).expect("搜索应当成功");
        let search_ms = started.elapsed().as_millis();
        assert!(!hits.is_empty(), "「夜色」应当能搜到");

        eprintln!(
            "bench-import: 200 章 · {} 字，导入+索引 {} ms，搜索 {} ms（{} 条）",
            book.char_count,
            import_ms,
            search_ms,
            hits.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 现场生成一本最小 EPUB（不依赖 gitignored 的 `.books/`，测试永远可跑）。
    ///
    /// title 可定制，用来验证像书的标题里带 `%`/`_` 时 LIKE 转义是否正确。
    fn mini_epub(path: &Path, title: &str, encrypted: bool) {
        use std::io::Write as _;
        let file = std::fs::File::create(path).expect("建测试 epub");
        let mut zip = zip::ZipWriter::new(file);
        let stored: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        let deflated: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("META-INF/container.xml", deflated).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
        )
        .unwrap();

        let title = title.replace('&', "&amp;").replace('<', "&lt;");
        let opf = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">test-mini</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest><item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"#
        );
        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(opf.as_bytes()).unwrap();
        zip.start_file("OEBPS/Text/ch1.xhtml", deflated).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p><p>         </p></body></html>"#,
        )
        .unwrap();
        if encrypted {
            zip.start_file("META-INF/encryption.xml", deflated).unwrap();
            zip.write_all(
                br#"<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:CipherData><enc:CipherReference URI="OEBPS/Text/ch1.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>"#,
            )
            .unwrap();
        }
        zip.finish().unwrap();
    }

    /// 段落之间要有分隔，否则 `第一章`+`纸上的灯` 会拼成一个词。
    #[test]
    fn html_to_text_separates_blocks() {
        let text = html_to_text("<p>第一章</p><p>纸上的灯</p><div>尾巴</div>");
        assert_eq!(text, "第一章 纸上的灯 尾巴");
        assert!(html_to_text("<p>a</p><p>b</p>").contains(' '));
    }

    /// 标题里的 `%`/`_` 必须按字面量匹配（回归：LIKE 缺 ESCAPE 时它们是通配符）。
    #[test]
    fn list_escapes_like_wildcards() {
        let dir = temp_dir();
        let db = Db::open(&dir.join("modu.db")).unwrap();
        let epub = dir.join("wildcards.epub");
        mini_epub(&epub, "100%_真实", false);
        import(&db, &dir.join("covers"), &[epub.to_string_lossy().to_string()]);

        let hit = |query: &str| {
            list(
                &db,
                &ListOptions { sort: None, filter: None, query: Some(query.into()) },
            )
            .unwrap()
            .len()
        };
        assert_eq!(hit("100%"), 1, "`%` 应按字面量匹配");
        assert_eq!(hit("_"), 1, "`_` 应按字面量匹配");
        assert_eq!(hit("zzz%"), 0, "没有匹配时不能因为通配符而命中");
        assert_eq!(hit("真实"), 1);
    }

    /// 批注导出 Markdown：书名标题、章节二级标题、引文 blockquote、备注前缀。
    #[test]
    fn annotations_markdown_exports() {
        let dir = temp_dir();
        let db = Db::open(&dir.join("modu.db")).unwrap();
        let epub = dir.join("markdown.epub");
        mini_epub(&epub, "导出测试书", false);
        let book_id = import(&db, &dir.join("covers"), &[epub.to_string_lossy().to_string()])[0]
            .book
            .as_ref()
            .expect("导入应成功")
            .id;

        annotation_add(
            &db,
            book_id,
            &AnnotationInput {
                locator: r#"{"v":1,"index":0,"fraction":0.1}"#.into(),
                chapter_href: "OEBPS/Text/ch1.xhtml".into(),
                chapter_title: Some("第一章".into()),
                quote: "纸上的灯".into(),
                prefix: None,
                suffix: None,
                occurrence: 0,
                color: Some(AnnotationColor::Pink),
                note: Some("这句好".into()),
            },
        )
        .unwrap();

        let md = annotations_markdown(&db, book_id).unwrap();
        assert!(md.starts_with("# 导出测试书 · 批注"), "md = {md}");
        assert!(md.contains("## 第一章"));
        assert!(md.contains("> 纸上的灯"));
        assert!(md.contains("备注：这句好"));
        assert!(md.contains("pink划线"));
    }

}

// ---------------------------------------------------------------------------
// 阅读进度与书签（M2）
// ---------------------------------------------------------------------------

/// 阅读进度。`locator` 是前端定义的定位 JSON（章节 index + 章内分数），
/// Rust 只做透传，不解释语义——换了算法也不用迁移数据库。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRecord {
    pub locator: String,
    pub percent: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub book_id: i64,
    pub locator: String,
    pub chapter_title: Option<String>,
    pub excerpt: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
}

pub fn progress_get(db: &Db, book_id: i64) -> AppResult<Option<ProgressRecord>> {
    db.with(|conn| {
        let row = conn.query_row(
            "SELECT locator, percent, updated_at FROM progress WHERE book_id = ?1",
            [book_id],
            |row| {
                Ok(ProgressRecord {
                    locator: row.get(0)?,
                    percent: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        );
        match row {
            Ok(record) => Ok(Some(record)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err.into()),
        }
    })
}

/// 写入进度。读到 99.9% 以上视为读完，回退则清掉完成时间。
pub fn progress_save(db: &Db, book_id: i64, locator: &str, percent: f64) -> AppResult<()> {
    let percent = percent.clamp(0.0, 1.0);
    let now = now_ms();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO progress (book_id, locator, percent, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(book_id) DO UPDATE SET
                 locator = excluded.locator,
                 percent = excluded.percent,
                 updated_at = excluded.updated_at",
            rusqlite::params![book_id, locator, percent, now],
        )?;
        if percent >= 0.999 {
            conn.execute(
                "UPDATE books SET finished_at = COALESCE(finished_at, ?2) WHERE id = ?1",
                rusqlite::params![book_id, now],
            )?;
        } else {
            conn.execute("UPDATE books SET finished_at = NULL WHERE id = ?1", [book_id])?;
        }
        Ok(())
    })
}

pub fn bookmark_add(
    db: &Db,
    book_id: i64,
    locator: &str,
    chapter_title: Option<&str>,
    excerpt: Option<&str>,
) -> AppResult<Bookmark> {
    let now = now_ms();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO bookmarks (book_id, locator, chapter_title, excerpt, note, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            rusqlite::params![book_id, locator, chapter_title, excerpt, now],
        )?;
        let id = conn.last_insert_rowid();
        Ok(Bookmark {
            id,
            book_id,
            locator: locator.to_owned(),
            chapter_title: chapter_title.map(str::to_owned),
            excerpt: excerpt.map(str::to_owned),
            note: None,
            created_at: now,
        })
    })
}

pub fn bookmark_list(db: &Db, book_id: i64) -> AppResult<Vec<Bookmark>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, book_id, locator, chapter_title, excerpt, note, created_at
             FROM bookmarks WHERE book_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([book_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                book_id: row.get(1)?,
                locator: row.get(2)?,
                chapter_title: row.get(3)?,
                excerpt: row.get(4)?,
                note: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

pub fn bookmark_remove(db: &Db, bookmark_id: i64) -> AppResult<()> {
    db.with(|conn| {
        let changed = conn.execute("DELETE FROM bookmarks WHERE id = ?1", [bookmark_id])?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("书签不存在: {bookmark_id}")));
        }
        Ok(())
    })
}
/// 更新书签备注。`None` 或空白字符串等同清空。
pub fn bookmark_note_set(db: &Db, bookmark_id: i64, note: Option<&str>) -> AppResult<()> {
    let note = note.map(str::trim).filter(|s| !s.is_empty());
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE bookmarks SET note = ?2 WHERE id = ?1",
            rusqlite::params![bookmark_id, note],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("书签不存在: {bookmark_id}")));
        }
        Ok(())
    })
}

/// 一条批注：选中原文 + 定位信息 + 可选的备注。
///
/// 定位不用 CFI、也不用像素，存的是「引文 + 前后文 + 本页第几次出现」——
/// 打开书时按当前排版重新解析成 Range，换字号/换主题都不会漂。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    pub locator: String,
    pub chapter_href: String,
    pub chapter_title: Option<String>,
    pub quote: String,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub occurrence: i64,
    pub color: AnnotationColor,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 前端提交的新批注（id / 时间戳由数据库生成）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationInput {
    pub locator: String,
    pub chapter_href: String,
    pub chapter_title: Option<String>,
    pub quote: String,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub occurrence: i64,
    pub color: Option<AnnotationColor>,
    pub note: Option<String>,
}

/// 划线颜色。用枚举而不是裸字符串：非法值在 IPC 边界就被 serde 拒掉，
/// 不会出现「静默改成黄色」这种看不出来的数据漂移。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationColor {
    Yellow,
    Green,
    Blue,
    Pink,
}

impl AnnotationColor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Yellow => "yellow",
            Self::Green => "green",
            Self::Blue => "blue",
            Self::Pink => "pink",
        }
    }

    /// 读库兜底：历史数据或手工改库出现未知值时按黄色处理，不阻断列表加载。
    fn from_db(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "green" => Self::Green,
            "blue" => Self::Blue,
            "pink" => Self::Pink,
            _ => Self::Yellow,
        }
    }
}

const ANNOTATION_COLUMNS: &str = "id, book_id, locator, chapter_href, chapter_title, quote, \
     prefix, suffix, occurrence, color, note, created_at, updated_at";

fn row_to_annotation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: row.get(0)?,
        book_id: row.get(1)?,
        locator: row.get(2)?,
        chapter_href: row.get(3)?,
        chapter_title: row.get(4)?,
        quote: row.get(5)?,
        prefix: row.get(6)?,
        suffix: row.get(7)?,
        occurrence: row.get(8)?,
        color: AnnotationColor::from_db(&row.get::<_, String>(9)?),
        note: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub fn annotation_add(db: &Db, book_id: i64, input: &AnnotationInput) -> AppResult<Annotation> {
    let quote = input.quote.trim();
    if quote.is_empty() {
        return Err(AppError::Validation("批注内容不能为空".into()));
    }
    let color = input.color.unwrap_or(AnnotationColor::Yellow);
    let note = input
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let now = now_ms();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO annotations
                 (book_id, locator, chapter_href, chapter_title, quote, prefix, suffix,
                  occurrence, color, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            rusqlite::params![
                book_id,
                input.locator,
                input.chapter_href,
                input.chapter_title,
                quote,
                input.prefix,
                input.suffix,
                input.occurrence,
                color.as_str(),
                note,
                now
            ],
        )?;
        let id = conn.last_insert_rowid();
        let sql = format!("SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE id = ?1");
        Ok(conn.query_row(&sql, [id], row_to_annotation)?)
    })
}

pub fn annotation_list(db: &Db, book_id: i64) -> AppResult<Vec<Annotation>> {
    db.with(|conn| {
        let sql = format!(
            "SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE book_id = ?1 \
             ORDER BY created_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([book_id], row_to_annotation)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 更新备注与颜色。`note` 传 `Some("")` 表示清空备注；传 `None` 表示不动备注。
pub fn annotation_update(
    db: &Db,
    annotation_id: i64,
    note: Option<&str>,
    color: Option<AnnotationColor>,
) -> AppResult<Annotation> {
    let set_note = note.is_some();
    let note = note.map(str::trim).filter(|s| !s.is_empty());
    let color = color.map(AnnotationColor::as_str);
    let now = now_ms();
    db.with(|conn| {
        let changed = conn.execute(
            "UPDATE annotations SET
                 note = CASE WHEN ?2 THEN ?3 ELSE note END,
                 color = COALESCE(?4, color),
                 updated_at = ?5
             WHERE id = ?1",
            rusqlite::params![annotation_id, set_note, note, color, now],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("批注不存在: {annotation_id}")));
        }
        let sql = format!("SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE id = ?1");
        Ok(conn.query_row(&sql, [annotation_id], row_to_annotation)?)
    })
}

/// 导出整本书的批注为 Markdown（书名/章节/原文/备注/时间）。
///
/// 返回字符串而不是直接写文件：写到哪里由前端用系统保存对话框决定，
/// Rust 侧不猜用户目录，也就不用开 fs 插件权限。
pub fn annotations_markdown(db: &Db, book_id: i64) -> AppResult<String> {
    let (title, author) = db.with(|conn| {
        conn.query_row(
            "SELECT title, COALESCE(author, '') FROM books WHERE id = ?1",
            [book_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|_| AppError::NotFound(format!("书籍不存在: {book_id}")))
    })?;
    let annotations = annotation_list(db, book_id)?;

    let mut md = String::new();
    md.push_str(&format!("# {title} · 批注\n\n"));
    if !author.is_empty() {
        md.push_str(&format!("- 作者：{author}\n"));
    }
    md.push_str(&format!("- 批注数：{}\n", annotations.len()));
    md.push_str("- 导出工具：墨读（Modu）\n\n");

    let mut current_chapter: Option<String> = None;
    for item in &annotations {
        let chapter = item
            .chapter_title
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                item.chapter_href
                    .rsplit('/')
                    .next()
                    .unwrap_or(&item.chapter_href)
                    .to_string()
            });
        if current_chapter.as_deref() != Some(chapter.as_str()) {
            md.push_str(&format!("## {chapter}\n\n"));
            current_chapter = Some(chapter);
        }
        // 原文按 blockquote；引文里本身可能有换行，逐行加 `> `。
        for line in item.quote.lines() {
            md.push_str(&format!("> {line}\n"));
        }
        if let Some(note) = item.note.as_deref().filter(|s| !s.trim().is_empty()) {
            md.push('\n');
            for line in note.lines() {
                md.push_str(&format!("备注：{line}\n"));
            }
        }
        md.push_str(&format!(
            "\n*{}划线 · {}*\n\n",
            item.color.as_str(),
            format_time_ms(item.created_at)
        ));
    }
    Ok(md)
}

/// 毫秒时间戳 → `YYYY-MM-DD HH:mm`（按 UTC 展示；导出仅供人读，不做时区换算）。
fn format_time_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let time = secs.rem_euclid(86_400);
    // 1970-01-01 起的天数 → 年月日（civil_from_days 算法，避免拉 chrono 依赖）。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        time / 3600,
        (time % 3600) / 60
    )
}

pub fn annotation_remove(db: &Db, annotation_id: i64) -> AppResult<()> {
    db.with(|conn| {
        let changed = conn.execute("DELETE FROM annotations WHERE id = ?1", [annotation_id])?;
        if changed == 0 {
            return Err(AppError::NotFound(format!("批注不存在: {annotation_id}")));
        }
        Ok(())
    })
}

/// 补写老数据缺失的章节标题（早期导入时只写了字数，没有从目录反查标题）。
///
/// 每本书只做一次：全部章节都有标题时直接返回，不打开事务。
pub fn backfill_chapter_titles(db: &Db, book_id: i64, book: &OpenedBook) -> AppResult<()> {
    let missing: i64 = db.with(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?1 AND title IS NULL",
            [book_id],
            |row| row.get(0),
        )?)
    })?;
    if missing == 0 {
        return Ok(());
    }

    let titles: Vec<(i64, String)> = book
        .package
        .toc
        .iter()
        .filter(|item| !item.label.trim().is_empty())
        .filter_map(|item| {
            let path = item.path.as_deref()?;
            book.package
                .spine
                .iter()
                .find(|s| s.path == path)
                .map(|s| (s.index as i64, item.label.trim().to_string()))
        })
        .collect();
    if titles.is_empty() {
        return Ok(());
    }

    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare("UPDATE chapters SET title = ?3 WHERE book_id = ?1 AND ord = ?2")?;
            for (ord, title) in &titles {
                stmt.execute(rusqlite::params![book_id, ord, title])?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

/// 一本书已有多少章进了全文索引。
pub fn index_status(db: &Db, book_id: i64) -> AppResult<usize> {
    db.with(|conn| {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM chapters_fts WHERE book_id = ?1",
            [book_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    })
}

/// 把章节正文写进 FTS 表。导入时已写；旧数据在首次搜索时按需补建。
pub fn index_book(db: &Db, book_id: i64, book: &OpenedBook) -> AppResult<usize> {
    let mut rows: Vec<(String, String, i64)> = Vec::new();
    for item in &book.package.spine {
        let html = book.read_text(&item.path).unwrap_or_default();
        rows.push((html_to_text(&html), item.path.clone(), item.index as i64));
    }
    let written = rows.len();
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM chapters_fts WHERE book_id = ?1", [book_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chapters_fts (text, href, ord, book_id) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (text, href, ord) in &rows {
                stmt.execute(rusqlite::params![text, href, ord, book_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(written)
}

/// 一条全文搜索结果。`snippet` 里命中片段用 U+0001 / U+0002 包裹，
/// 前端据此做高亮，不需要重复解析 HTML。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub index: usize,
    pub href: String,
    pub chapter_title: Option<String>,
    pub snippet: String,
    pub offset: usize,
}

const SNIPPET_MARK_START: char = '\u{1}';
const SNIPPET_MARK_END: char = '\u{2}';

/// 全书搜索。>=3 字走 FTS5 trigram（短语匹配，中文无需分词），
/// 更短的查询 trigram 索引帮不上忙，退回逐章扫描。
pub fn search(db: &Db, book_id: i64, query: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    if needle.chars().count() >= 3 {
        match fts_search(db, book_id, needle, limit) {
            Ok(hits) if !hits.is_empty() => return Ok(hits),
            _ => {}
        }
    }
    scan_search(db, book_id, needle, limit)
}

fn fts_search(db: &Db, book_id: i64, needle: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    // FTS5 的短语查询：整体加引号，内部引号双写转义。
    let phrase = format!("\"{}\"", needle.replace('"', "\"\""));
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT f.ord, f.href, c.title,
                    snippet(chapters_fts, 0, char(1), char(2), '…', 20) AS snip,
                    instr(f.text, ?4) AS pos
             FROM chapters_fts f
             LEFT JOIN chapters c ON c.book_id = f.book_id AND c.ord = f.ord
             WHERE chapters_fts MATCH ?1 AND f.book_id = ?2
             ORDER BY rank
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![phrase, book_id, limit as i64, needle],
            |row| {
                Ok(SearchHit {
                    index: row.get::<_, i64>(0)? as usize,
                    href: row.get(1)?,
                    chapter_title: row.get(2)?,
                    snippet: row.get(3)?,
                    offset: row.get::<_, Option<i64>>(4)?.unwrap_or(-1).max(0) as usize,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

fn scan_search(db: &Db, book_id: i64, needle: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT f.ord, f.href, c.title, f.text
             FROM chapters_fts f
             LEFT JOIN chapters c ON c.book_id = f.book_id AND c.ord = f.ord
             WHERE f.book_id = ?1
             ORDER BY f.ord",
        )?;
        let mut rows = stmt.query([book_id])?;
        let mut hits = Vec::new();
        while let Some(row) = rows.next()? {
            let index = row.get::<_, i64>(0)? as usize;
            let href: String = row.get(1)?;
            let title: Option<String> = row.get(2)?;
            let text: String = row.get(3)?;
            if let Some(offset) = text.find(needle) {
                hits.push(SearchHit {
                    index,
                    href,
                    chapter_title: title,
                    snippet: make_snippet(&text, offset, needle.chars().count()),
                    offset,
                });
                if hits.len() >= limit {
                    break;
                }
            }
        }
        Ok(hits)
    })
}

/// 以命中位置为中心截一段上下文，并用 U+0001/U+0002 标出命中。
fn make_snippet(text: &str, offset: usize, match_chars: usize) -> String {
    let before: String = text[..offset].chars().rev().take(24).collect::<Vec<_>>().into_iter().rev().collect();
    let match_len = text[offset..]
        .char_indices()
        .nth(match_chars)
        .map(|(i, _)| i)
        .unwrap_or_else(|| text[offset..].len());
    let after: String = text[offset + match_len..].chars().take(24).collect();
    format!(
        "{}{}{SNIPPET_MARK_START}{}{SNIPPET_MARK_END}{}",
        if offset > 0 { "…" } else { "" },
        before,
        &text[offset..offset + match_len],
        after
    )
}
