use serde::{Serialize, Serializer};

/// Unified error type for all Tauri commands.
///
/// Every variant renders to a human readable message; the frontend receives it
/// as a plain string (see `AppError::serialize`), so commands can stay
/// `Result<T, AppError>` without leaking Rust types over IPC.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("文件不存在: {0}")]
    NotFound(String),
    #[error("打开失败: {0}")]
    Io(String),
    #[error("EPUB 结构损坏: {0}")]
    InvalidEpub(String),
    #[error("不支持的内容: {0}")]
    Unsupported(String),
    #[error("条目不存在: {0}")]
    EntryMissing(String),
    /// 用户可修复的输入问题（空引文、非法颜色…）。与 Internal 区分开，
    /// 前端不会把它当成程序 bug 报「内部错误」。
    #[error("{0}")]
    Validation(String),
    #[error("内部错误: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(e: zip::result::ZipError) -> Self {
        match e {
            zip::result::ZipError::FileNotFound => AppError::EntryMissing(e.to_string()),
            _ => AppError::InvalidEpub(e.to_string()),
        }
    }
}

impl From<roxmltree::Error> for AppError {
    fn from(e: roxmltree::Error) -> Self {
        AppError::InvalidEpub(format!("XML 解析失败: {e}"))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Internal(format!("数据库错误: {e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
