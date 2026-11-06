//! 前端可调用的 Tauri 命令。命令一律返回 `Result<T, AppError>`，
//! 错误在 IPC 上表现为字符串，避免把 Rust 类型泄漏给 TS。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::fonts;
use crate::library::{
    self, Annotation, AnnotationColor, AnnotationInput, Bookmark, BookSummary, ImportOutcome,
    ListOptions, ProgressRecord,
};
use crate::epub::{self, Package};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedBookInfo {
    pub id: String,
    pub path: String,
    pub package: Package,
    /// 书库主键；从书架打开时才有，决定要不要写进度/书签。
    pub library_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionHtml {
    /// 章节 XHTML 原文；前端用 DOMParser 解析后改写资源地址。
    pub html: String,
    /// zip 内绝对路径，前端据此解析章节内相对 URL。
    pub path: String,
}

/// 打开一本 EPUB：解包、读 OPF、spine、目录、封面，并把句柄留在进程内。
#[tauri::command]
pub fn book_open(state: State<'_, AppState>, path: String) -> AppResult<OpenedBookInfo> {
    open_into_state(&state, &path, None)
}

fn open_into_state(state: &AppState, path: &str, library_id: Option<i64>) -> AppResult<OpenedBookInfo> {
    let book = epub::open(path)?;
    let info = OpenedBookInfo {
        id: book.id.clone(),
        path: book.path.clone(),
        package: (*book.package).clone(),
        library_id,
    };
    state.books.write().insert(book.id.clone(), Arc::new(book));
    Ok(info)
}

/// 关闭一本书，释放 zip 句柄。
#[tauri::command]
pub fn book_close(state: State<'_, AppState>, book_id: String) {
    state.books.write().remove(&book_id);
}

/// 读取某个 spine 章节的原始 XHTML 文本。
#[tauri::command]
pub fn book_section_html(
    state: State<'_, AppState>,
    book_id: String,
    index: usize,
) -> AppResult<SectionHtml> {
    let book = state
        .get_book(&book_id)
        .ok_or_else(|| AppError::NotFound(format!("书籍未打开: {book_id}")))?;
    let item = book
        .package
        .spine
        .get(index)
        .ok_or_else(|| AppError::NotFound(format!("章节不存在: {index}")))?;
    let html = book.read_text(&item.path)?;
    Ok(SectionHtml { html, path: item.path.clone() })
}

/// 打开系统文件选择器（Rust 侧弹窗，路径不经过 fs 插件 scope）。
#[tauri::command]
pub fn pick_epub(app: tauri::AppHandle) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("EPUB 电子书", &["epub"])
        .blocking_pick_file();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------------------
// 书库（M1）
// ---------------------------------------------------------------------------

/// 打开多选文件对话框，返回绝对路径（取消时为空数组）。
#[tauri::command]
pub fn pick_epubs(app: tauri::AppHandle) -> AppResult<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("EPUB 电子书", &["epub"])
        .blocking_pick_files();
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

/// 导入一本或多本 epub；单本失败会带回错误，不影响其它书。
#[tauri::command]
pub fn library_import(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> AppResult<Vec<ImportOutcome>> {
    Ok(library::import(&state.db, &state.covers_dir, &paths))
}

/// 书架列表：排序 / 筛选 / 关键词。
#[tauri::command]
pub fn library_list(state: State<'_, AppState>, options: ListOptions) -> AppResult<Vec<BookSummary>> {
    library::list(&state.db, &options)
}

/// 仅移出书架，不动原文件。
#[tauri::command]
pub fn library_remove(state: State<'_, AppState>, book_id: i64) -> AppResult<()> {
    library::remove(&state.db, book_id)
}

/// 从书架打开一本书：按库内路径解析，并记录最近阅读时间。
#[tauri::command]
pub fn library_open(state: State<'_, AppState>, book_id: i64) -> AppResult<OpenedBookInfo> {
    let summary = library::get(&state.db, book_id)?;
    let info = open_into_state(&state, &summary.path, Some(book_id))?;
    if let Some(book) = state.get_book(&info.id) {
        // 老数据的章节标题是空的，打开时顺手按目录补一次
        let _ = library::backfill_chapter_titles(&state.db, book_id, &book);
    }
    library::mark_opened(&state.db, book_id)?;
    Ok(info)
}

// ---------------------------------------------------------------------------
// 阅读进度与书签（M2）
// ---------------------------------------------------------------------------

/// 读取上次阅读位置；没读过返回 null。
#[tauri::command]
pub fn progress_get(state: State<'_, AppState>, book_id: i64) -> AppResult<Option<ProgressRecord>> {
    library::progress_get(&state.db, book_id)
}

/// 写入阅读位置（前端防抖后调用）。
#[tauri::command]
pub fn progress_save(
    state: State<'_, AppState>,
    book_id: i64,
    locator: String,
    percent: f64,
) -> AppResult<()> {
    library::progress_save(&state.db, book_id, &locator, percent)
}

#[tauri::command]
pub fn bookmark_add(
    state: State<'_, AppState>,
    book_id: i64,
    locator: String,
    chapter_title: Option<String>,
    excerpt: Option<String>,
) -> AppResult<Bookmark> {
    library::bookmark_add(
        &state.db,
        book_id,
        &locator,
        chapter_title.as_deref(),
        excerpt.as_deref(),
    )
}

#[tauri::command]
pub fn bookmark_list(state: State<'_, AppState>, book_id: i64) -> AppResult<Vec<Bookmark>> {
    library::bookmark_list(&state.db, book_id)
}

#[tauri::command]
pub fn bookmark_remove(state: State<'_, AppState>, bookmark_id: i64) -> AppResult<()> {
    library::bookmark_remove(&state.db, bookmark_id)
}
// ---------------------------------------------------------------------------
// 全书搜索（M3）
// ---------------------------------------------------------------------------

/// 在整本书里搜索关键词。
///
/// 索引在导入时已写入 FTS5；老库里的书第一次搜索时按需补建，
/// 所以这里要拿到已打开的 zip 句柄。
#[tauri::command]
pub fn book_search(
    state: State<'_, AppState>,
    book_id: String,
    library_id: i64,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<library::SearchHit>> {
    let book = state
        .get_book(&book_id)
        .ok_or_else(|| AppError::NotFound(format!("书籍未打开: {book_id}")))?;
    if library::index_status(&state.db, library_id)? == 0 {
        library::index_book(&state.db, library_id, &book)?;
    }
    let limit = limit.unwrap_or(80).clamp(1, 300);
    library::search(&state.db, library_id, &query, limit)
}

/// 更新书签备注（传空字符串即清空）。
#[tauri::command]
pub fn bookmark_note_set(
    state: State<'_, AppState>,
    bookmark_id: i64,
    note: Option<String>,
) -> AppResult<()> {
    library::bookmark_note_set(&state.db, bookmark_id, note.as_deref())
}

// ---------------------------------------------------------------------------
// 批注（M4）
// ---------------------------------------------------------------------------

/// 新建一条划线/批注。`library_id` 是书库主键，批注挂在书上而不是打开的句柄上。
#[tauri::command]
pub fn annotation_add(
    state: State<'_, AppState>,
    library_id: i64,
    input: AnnotationInput,
) -> AppResult<Annotation> {
    library::annotation_add(&state.db, library_id, &input)
}

#[tauri::command]
pub fn annotation_list(state: State<'_, AppState>, library_id: i64) -> AppResult<Vec<Annotation>> {
    library::annotation_list(&state.db, library_id)
}

/// 更新备注/颜色。`note: Some("")` 表示清空备注。
#[tauri::command]
pub fn annotation_update(
    state: State<'_, AppState>,
    annotation_id: i64,
    note: Option<String>,
    color: Option<AnnotationColor>,
) -> AppResult<Annotation> {
    library::annotation_update(&state.db, annotation_id, note.as_deref(), color)
}

/// 导出整本书的批注为 Markdown 文本（由前端弹保存对话框后写入）。
#[tauri::command]
pub fn annotation_export_markdown(
    state: State<'_, AppState>,
    library_id: i64,
) -> AppResult<String> {
    library::annotations_markdown(&state.db, library_id)
}

/// 把用户明确要导出的文本写到指定路径。
///
/// 路径来自系统保存对话框（用户的显式选择），所以这里不开 fs 插件权限，
/// 也不允许前端传任意路径之外的参数——调用方只传一个由对话框返回的字符串。
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Validation("保存路径不能为空".into()));
    }
    std::fs::write(&path, contents)
        .map_err(|e| AppError::Io(format!("写入文件失败（{path}）: {e}")))
}

#[tauri::command]
pub fn annotation_remove(
    state: State<'_, AppState>,
    annotation_id: i64,
) -> AppResult<()> {
    library::annotation_remove(&state.db, annotation_id)
}

/// 在资源管理器中显示出数据目录（书库、封面、批注数据所在处）。
///
/// 「打开」语义放在 Rust：路径由 `AppState::data_dir`（lib.rs 的 data_dir）
/// 决定，前端不持有也不传路径，避免任意路径被展示出窗口。
#[tauri::command]
pub fn reveal_data_dir(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = state.data_dir.clone();
    app.opener()
        .reveal_item_in_dir(&dir)
        .map_err(|e| AppError::Internal(format!("打开数据目录失败: {e}")))?;
    Ok(dir.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// 字体（P3）：用户自定义 ttf/otf/ttc 的导入/列表/删除
// ---------------------------------------------------------------------------

/// 解析并安装用户选择的字体文件；返回 {file, family}。
///
/// 路径来自系统文件对话框（用户的显式选择）；删除与下发只认 fonts 目录
/// 内的纯文件名。列表以 fonts 目录的解析结果为准，`font_list` 用于对账。
#[tauri::command]
pub fn font_import(state: State<'_, AppState>, path: String) -> AppResult<fonts::InstalledFont> {
    fonts::install(&state.data_dir, &path)
}

/// 重新解析 fonts 目录（用户手动删文件后对账用）。
#[tauri::command]
pub fn font_list(state: State<'_, AppState>) -> AppResult<Vec<fonts::InstalledFont>> {
    fonts::list(&state.data_dir)
}

#[tauri::command]
pub fn font_remove(state: State<'_, AppState>, file: String) -> AppResult<()> {
    fonts::remove(&state.data_dir, &file)
}
