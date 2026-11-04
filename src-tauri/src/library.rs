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
    let sql = if keyword.is_some() {
        format!(
            "{base} AND (b.title LIKE ?1 OR COALESCE(b.author, '') LIKE ?1
                        OR COALESCE(b.publisher, '') LIKE ?1)
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

    // 章节字数：一次性算完，搜索/统计/进度估算都要用。
    let mut chapters: Vec<(usize, String, Option<String>, i64)> = Vec::new();
    let mut total_chars: i64 = 0;
    for item in &package.spine {
        let text = book.read_text(&item.path).unwrap_or_default();
        let count = plain_text_len(&text) as i64;
        total_chars += count;
        chapters.push((item.index, item.path.clone(), None, count));
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
        {
            let mut stmt = tx.prepare(
                "INSERT INTO chapters (book_id, ord, href, title, char_count)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (ord, href, title, count) in &chapters {
                stmt.execute(rusqlite::params![id, *ord as i64, href, title, count])?;
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
    let ext = cover_extension(cover_path, &book.package.opf_path);
    std::fs::create_dir_all(covers_dir)?;
    let name = format!("{file_hash}.{ext}");
    // 同一本书重复导入会覆盖同名文件，内容一致，无副作用。
    std::fs::write(covers_dir.join(&name), &bytes)?;
    Ok(name)
}

fn cover_extension(cover_path: &str, _opf_path: &str) -> String {
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

/// 粗略统计可见正文字符数：去掉标签、注释、script/style 内容，解码常见实体。
///
/// 不做完整 HTML 解析——只为字数/进度展示服务，几百万字也只需毫秒级。
pub fn plain_text_len(html: &str) -> usize {
    let bytes = html.as_bytes();
    let mut count = 0usize;
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

            match rest.find('>') {
                Some(pos) => {
                    i += pos + 1;
                    continue;
                }
                None => break,
            }
        }

        if bytes[i] == b'&' {
            if let Some(semi) = html[i..].find(';').filter(|n| *n <= 10) {
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
                    if !ch.is_whitespace() {
                        count += 1;
                    }
                    i += semi + 1;
                    continue;
                }
            }
        }

        // 多字节 UTF-8：按字符推进，空白不计。
        let ch = html[i..].chars().next().unwrap_or('\u{fffd}');
        if !ch.is_whitespace() {
            count += 1;
        }
        i += ch.len_utf8();
    }

    count
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