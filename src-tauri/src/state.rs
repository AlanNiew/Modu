use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::db::Db;
use crate::epub::OpenedBook;

/// 进程内全局状态。
///
/// `books` 只放“当前会话”的只读解析结果，关书或退出即释放；书架、进度、
/// 书签等持久化数据走 SQLite（`db`），封面文件落在 `covers_dir`。
/// `data_dir` 显式持有数据根目录（lib.rs 的 `data_dir` 决定），供
/// `reveal_data_dir` 等命令直接返回——不靠 `covers_dir.parent()` 反推，
/// 以后目录布局调整不会悄悄指错地方。
pub struct AppState {
    pub books: RwLock<HashMap<String, Arc<OpenedBook>>>,
    pub db: Db,
    pub data_dir: PathBuf,
    pub covers_dir: PathBuf,
}

impl AppState {
    pub fn new(db: Db, data_dir: PathBuf, covers_dir: PathBuf) -> Self {
        Self {
            books: RwLock::new(HashMap::new()),
            db,
            data_dir,
            covers_dir,
        }
    }

    pub fn get_book(&self, book_id: &str) -> Option<Arc<OpenedBook>> {
        self.books.read().get(book_id).cloned()
    }
}
