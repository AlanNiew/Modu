//! `epub://` 自定义协议：把 zip 内部资源喂给 WebView。
//!
//! Tauri 会把 `epub://<host>/<path>` 映射成平台 URL：Windows/Android 上是
//! `http://epub.localhost/<path>`，Linux/macOS 上是 `epub://localhost/<path>`。
//! 因此 CSP 里要写 `http://epub.localhost`（见 tauri.conf.json），而不是裸 `epub:`。
//!
//! URL 形状：`<scheme>://epub.localhost/<bookId>/<zip 内路径>`
//! 章节 HTML 不走这个协议（跨源会拿不到 contentDocument），只服务子资源：
//! img / link[rel=stylesheet] / @font-face / SVG image 等。
//!
//! 另有保留前缀：
//! - `__covers/`：书架封面不是 zip 内资源（书可能没打开），从数据目录直接读文件；
//! - `__fonts/`（P3）：用户自定义字体文件（`<数据目录>/fonts/`），供
//!   `@font-face` 注册。

use std::sync::Arc;

use tauri::http::{header, Request, Response, StatusCode};

use crate::epub::{self, mime_for, OpenedBook};
use crate::state::AppState;

/// 书架封面在协议里的保留前缀，不可能是合法的 bookId。
const COVERS_PREFIX: &str = "__covers";

/// 用户自定义字体在协议里的保留前缀（P3）。
const FONTS_PREFIX: &str = "__fonts";

pub fn handle(state: &AppState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    if let Some(file) = path.strip_prefix(COVERS_PREFIX).and_then(|rest| rest.strip_prefix('/')) {
        return serve_cover(state, file);
    }
    if let Some(file) = path.strip_prefix(FONTS_PREFIX).and_then(|rest| rest.strip_prefix('/')) {
        return serve_font(state, file, request);
    }
    let Some((book_id, resource)) = path.split_once('/') else {
        return not_found("资源路径缺少书籍标识");
    };
    let Some(book) = state.get_book(book_id) else {
        return not_found("未知书籍");
    };
    let entry = epub::percent_decode(resource);
    if entry.is_empty() {
        return not_found("空资源路径");
    }
    serve(book, entry, request)
}

/// 只允许纯文件名 + 已知图片后缀，杜绝 `..` 穿越。
fn serve_cover(state: &AppState, file: &str) -> Response<Vec<u8>> {
    let decoded = epub::percent_decode(file);
    let allowed = !decoded.is_empty()
        && !decoded.contains(['/', '\\'])
        && !decoded.contains("..")
        && matches!(
            decoded.rsplit('.').next(),
            Some("jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "img")
        );
    if !allowed {
        return not_found("封面文件名不合法");
    }
    match std::fs::read(state.covers_dir.join(&decoded)) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_for(&decoded))
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "构造响应失败")),
        Err(err) => not_found(&format!("封面读取失败: {err}")),
    }
}

/// 只允许纯文件名 + 已知字体后缀；字体数据缓存一小时（可能被重装替换）。
fn serve_font(
    state: &AppState,
    file: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let decoded = epub::percent_decode(file);
    let mime = match decoded.rsplit('.').next() {
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("ttc") => "font/collection",
        // woff/woff2 仅作下发兼容（不允许导入，Rust 侧不解析）。
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => return not_found("字体文件名不合法"),
    };
    // 与封面同规则：杜绝任何路径成分。
    if decoded.is_empty() || decoded.contains(['/', '\\']) || decoded.contains("..") {
        return not_found("字体文件名不合法");
    }
    let font_dir = crate::fonts::fonts_dir(&state.data_dir);
    match std::fs::read(font_dir.join(&decoded)) {
        Ok(bytes) => {
            // @font-face 是 CORS 请求；规则与 zip 内字体一致。
            let allow_origin = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|origin| origin.to_str().ok())
                .unwrap_or("*");
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin)
                // 字体可能被用户重装/替换（同名文件改名覆盖），缓存直接不落；
                // 每次章节 iframe 加载都会走一遍磁盘读，成本可忽略。
                .header(header::CACHE_CONTROL, "no-store")
                .body(bytes)
                .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "构造响应失败"))
        }
        Err(err) => not_found(&format!("字体读取失败: {err}")),
    }
}

fn serve(book: Arc<OpenedBook>, entry: String, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match book.read_entry(&entry) {
        Ok(bytes) => {
            let mime = mime_for(&entry);
            // 字体（@font-face）是 CORS 请求，没有这个头浏览器会拒绝加载。
            // 只发一个 ACAO：有 Origin 就回显（覆盖 `null` 之类的特殊值），否则用 `*`。
            let allow_origin = request
                .headers()
                .get(header::ORIGIN)
                .and_then(|origin| origin.to_str().ok())
                .unwrap_or("*");
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin)
                // bookId 由文件内容算出，同一 URL 的内容在本次安装里不会变化。
                .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
                .body(bytes)
                .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "构造响应失败"))
        }
        Err(err) => error_response(StatusCode::NOT_FOUND, &err.to_string()),
    }
}

fn not_found(message: &str) -> Response<Vec<u8>> {
    error_response(StatusCode::NOT_FOUND, message)
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("static response")
}
