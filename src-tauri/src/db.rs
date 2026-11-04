//! SQLite 持久化：连接管理 + 迁移。
//!
//! 所有 SQL 都留在 Rust 侧（ADR-005）：前端拿不到连接，也就没有注入面。
//! 迁移用 `PRAGMA user_version` 手动递增，不引入额外框架。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

/// 当前 schema 版本。新增迁移时 +1，并在 [`migrate`] 里追加分支。
pub const SCHEMA_VERSION: i64 = 1;

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                AppError::Internal(format!("创建数据目录失败 {}: {e}", dir.display()))
            })?;
        }
        let mut conn = Connection::open(path).map_err(|e| {
            AppError::Internal(format!("打开数据库失败 {}: {e}", path.display()))
        })?;

        // WAL：读写不互相阻塞；外键必须显式打开（SQLite 默认关闭）。
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        migrate(&mut conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self
            .0
            .lock()
            .map_err(|_| AppError::Internal("数据库连接已损坏（锁中毒）".into()))?;
        f(&conn)
    }

    pub fn with_mut<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self
            .0
            .lock()
            .map_err(|_| AppError::Internal("数据库连接已损坏（锁中毒）".into()))?;
        f(&mut conn)
    }
}

fn user_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

fn migrate(conn: &mut Connection) -> AppResult<()> {
    let from = user_version(conn)?;
    if from >= SCHEMA_VERSION {
        return Ok(());
    }

    let tx = conn.transaction()?;

    if from < 1 {
        tx.execute_batch(
            r#"
            CREATE TABLE books (
              id            INTEGER PRIMARY KEY,
              path          TEXT    NOT NULL UNIQUE,
              file_hash     TEXT    NOT NULL,
              file_size     INTEGER NOT NULL,
              title         TEXT    NOT NULL,
              author        TEXT,
              publisher     TEXT,
              language      TEXT,
              identifier    TEXT,
              description   TEXT,
              cover_file    TEXT,
              chapter_count INTEGER NOT NULL DEFAULT 0,
              char_count    INTEGER NOT NULL DEFAULT 0,
              added_at      INTEGER NOT NULL,
              opened_at     INTEGER,
              finished_at   INTEGER
            );

            CREATE TABLE chapters (
              book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
              ord        INTEGER NOT NULL,
              href       TEXT    NOT NULL,
              title      TEXT,
              char_count INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (book_id, ord)
            );

            CREATE TABLE progress (
              book_id    INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
              locator    TEXT    NOT NULL,
              percent    REAL    NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE TABLE bookmarks (
              id            INTEGER PRIMARY KEY,
              book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
              locator       TEXT    NOT NULL,
              chapter_title TEXT,
              excerpt       TEXT,
              note          TEXT,
              created_at    INTEGER NOT NULL
            );

            CREATE INDEX idx_bookmarks_book ON bookmarks(book_id, created_at DESC);

            CREATE VIRTUAL TABLE chapters_fts USING fts5(
              text,
              href UNINDEXED,
              ord  UNINDEXED,
              book_id UNINDEXED,
              tokenize = 'trigram'
            );
            "#,
        )?;
    }

    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(())
}

/// 现在（Unix 毫秒），SQLite 与前端都吃这个单位。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试临时目录放在 `target/` 下：系统 TEMP 可能被 DSH 沙箱拦截。
    fn temp_dir() -> std::path::PathBuf {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
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
    fn migrates_fresh_database() {
        let dir = temp_dir();
        let db = Db::open(&dir.join("modu.db")).unwrap();
        let version = db.with(|c| Ok(user_version(c)?)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let tables: i64 = db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'books'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(tables, 1);
    }

    #[test]
    fn migrating_twice_is_idempotent() {
        let dir = temp_dir();
        let path = dir.join("modu.db");
        drop(Db::open(&path).unwrap());
        let db = Db::open(&path).unwrap();
        let version = db.with(|c| Ok(user_version(c)?)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
}
