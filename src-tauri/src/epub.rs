//! EPUB 容器解析：zip → container.xml → OPF → 元数据 / 清单 / spine / 目录 / 封面。
//!
//! 这里只做“结构与文本”层面的解析，不处理 CSS/图片，也不做 HTML 改写；
//! 章节 XHTML 的原样文本交给前端用 DOMParser 改写（宽松 HTML 解析更抗畸形书），
//! 资源文件则通过 `epub://` 协议按 zip 内路径直接服务（见 protocol.rs）。
//!
//! 路径约定：本模块内部一律使用 zip 条目名（`/` 分隔、已 percent-decode、已规范化）。

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use zip::ZipArchive;

use crate::error::{AppError, AppResult};

const CONTAINER_XML: &str = "META-INF/container.xml";
const OPF_NS: &str = "http://www.idpf.org/2007/opf";
const XHTML_NS: &str = "http://www.w3.org/1999/xhtml";
const OPS_NS: &str = "http://www.idpf.org/2007/ops";
const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

/// 一本书在内存中的只读视图；zip 句柄单独加锁以便并发读取条目。
pub struct OpenedBook {
    pub id: String,
    pub path: String,
    pub package: Arc<Package>,
    archive: Mutex<ZipArchive<File>>,
}

impl OpenedBook {
    pub fn read_entry(&self, entry_path: &str) -> AppResult<Vec<u8>> {
        let mut archive = self.archive.lock();
        let name = resolve_entry_name(&mut archive, entry_path)
            .ok_or_else(|| AppError::EntryMissing(entry_path.to_string()))?;
        let mut file = archive.by_name(&name)?;
        let mut buf = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut buf)?;
        Ok(buf)
    }

    pub fn read_text(&self, entry_path: &str) -> AppResult<String> {
        Ok(decode_text(&self.read_entry(entry_path)?))
    }
}

/// 书级元数据 + 阅读顺序，全部为前端可直接消费的 DTO。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub title: String,
    pub authors: Vec<String>,
    pub language: String,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub identifier: Option<String>,
    /// zip 内封面图片路径（相对 zip 根），可能为空。
    pub cover_path: Option<String>,
    /// 页面 progression 方向："ltr" | "rtl"。
    pub direction: String,
    /// OPF 文件路径，前端拼协议 URL 时用它定位资源根。
    pub opf_path: String,
    pub spine: Vec<SpineItem>,
    pub toc: Vec<TocItem>,
    /// spine 之外的 manifest 资源（CSS/图片/字体），供协议层做存在性判断与统计。
    pub resource_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpineItem {
    pub index: usize,
    pub idref: String,
    /// zip 内绝对路径，例如 `OEBPS/Text/ch01.xhtml`。
    pub path: String,
    pub media_type: String,
    pub linear: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocItem {
    pub label: String,
    /// 目录链接原始 href（可能带 `#fragment`），已相对 toc 文件解析成 zip 路径。
    pub href: String,
    pub path: Option<String>,
    pub fragment: Option<String>,
    /// 嵌套深度，0 为顶层；前端按深度渲染缩进。
    pub depth: u32,
}

#[derive(Debug, Clone)]
struct ManifestItem {
    id: String,
    path: String,
    media_type: String,
    properties: String,
}

pub fn open(path: &str) -> AppResult<OpenedBook> {
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Err(AppError::NotFound(path.to_string()));
    }
    let file = File::open(file_path)?;
    let mut archive = ZipArchive::new(file)?;

    let container = read_zip_text(&mut archive, CONTAINER_XML)?;
    let container_doc = roxmltree::Document::parse(&container)?;
    let opf_path = container_doc
        .descendants()
        .find(|n| n.has_tag_name(("urn:oasis:names:tc:opendocument:xmlns:container", "rootfile")))
        .and_then(|n| n.attribute("full-path"))
        .ok_or_else(|| AppError::InvalidEpub("container.xml 缺少 rootfile/@full-path".into()))?
        .to_string();
    let opf_path = normalize_path(&opf_path);

    let opf = read_zip_text(&mut archive, &opf_path)?;
    let doc = roxmltree::Document::parse(&opf)?;

    let opf_dir = parent_dir(&opf_path);
    let metadata = doc
        .descendants()
        .find(|n| n.has_tag_name((OPF_NS, "metadata")));

    let mut title = String::new();
    let mut authors: Vec<String> = Vec::new();
    let mut language = String::new();
    let mut publisher = None;
    let mut description = None;
    let mut identifier = None;
    let mut meta_cover_id: Option<String> = None;

    if let Some(meta) = metadata {
        for child in meta.descendants().filter(|n| n.is_element()) {
            let tag = child.tag_name();
            match (tag.namespace(), tag.name()) {
                (Some(DC_NS), "title") if title.is_empty() => {
                    title = child.text().unwrap_or_default().trim().to_string();
                }
                (Some(DC_NS), "creator") => {
                    let name = child.text().unwrap_or_default().trim();
                    if !name.is_empty() {
                        authors.push(name.to_string());
                    }
                }
                (Some(DC_NS), "language") if language.is_empty() => {
                    language = child.text().unwrap_or_default().trim().to_string();
                }
                (Some(DC_NS), "publisher") => {
                    publisher = child.text().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                }
                (Some(DC_NS), "description") => {
                    description = child.text().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                }
                (Some(DC_NS), "identifier") if identifier.is_none() => {
                    identifier = child.text().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                }
                (_, "meta") => {
                    if child.attribute("name") == Some("cover") {
                        meta_cover_id = child.attribute("content").map(|s| s.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    // ---- manifest ----
    let mut manifest: HashMap<String, ManifestItem> = HashMap::new();
    let mut resource_paths: Vec<String> = Vec::new();
    if let Some(items) = doc.descendants().find(|n| n.has_tag_name((OPF_NS, "manifest"))) {
        for item in items.children().filter(|n| n.has_tag_name((OPF_NS, "item"))) {
            let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) else {
                continue;
            };
            let media_type = item.attribute("media-type").unwrap_or("").to_string();
            let properties = item.attribute("properties").unwrap_or("").to_string();
            let path = resolve_href(&opf_dir, href);
            if !path.is_empty() {
                resource_paths.push(path.clone());
            }
            manifest.insert(
                id.to_string(),
                ManifestItem { id: id.to_string(), path, media_type, properties },
            );
        }
    }

    // ---- spine ----
    let mut spine: Vec<SpineItem> = Vec::new();
    let mut direction = "ltr".to_string();
    let mut spine_toc_id: Option<String> = None;
    if let Some(spine_el) = doc.descendants().find(|n| n.has_tag_name((OPF_NS, "spine"))) {
        if let Some(dir) = spine_el.attribute("page-progression-direction") {
            direction = dir.to_string();
        }
        spine_toc_id = spine_el.attribute("toc").map(|s| s.to_string());
        for itemref in spine_el.children().filter(|n| n.has_tag_name((OPF_NS, "itemref"))) {
            let Some(idref) = itemref.attribute("idref") else { continue };
            let Some(item) = manifest.get(idref) else { continue };
            let linear = itemref.attribute("linear").map(|v| v != "no").unwrap_or(true);
            spine.push(SpineItem {
                index: spine.len(),
                idref: idref.to_string(),
                path: item.path.clone(),
                media_type: item.media_type.clone(),
                linear,
                size: 0,
            });
        }
    }
    if spine.is_empty() {
        return Err(AppError::InvalidEpub("spine 为空".into()));
    }

    // 补 ascii 大小供前端显示/进度回退；读不到的条目保持 0。
    for item in &mut spine {
        if let Some(size) = resolve_entry_name(&mut archive, &item.path)
            .and_then(|name| archive.by_name(&name).ok().map(|f| f.size()))
        {
            item.size = size;
        }
    }

    // ---- 封面 ----
    let cover_path = manifest
        .values()
        .find(|i| i.properties.split_whitespace().any(|p| p == "cover-image"))
        .map(|i| i.path.clone())
        .or_else(|| {
            meta_cover_id
                .as_ref()
                .and_then(|id| manifest.get(id))
                .map(|i| i.path.clone())
        })
        .filter(|p| !p.is_empty());

    // ---- 目录：优先 EPUB3 nav，回退 NCX ----
    let mut toc = Vec::new();
    if let Some(nav_item) = manifest
        .values()
        .find(|i| i.properties.split_whitespace().any(|p| p == "nav"))
    {
        if let Ok(text) = read_zip_text(&mut archive, &nav_item.path) {
            if let Ok(nav_doc) = roxmltree::Document::parse(&text) {
                toc = parse_nav(&nav_doc, &parent_dir(&nav_item.path));
            }
        }
    }
    if toc.is_empty() {
        let ncx_path = spine_toc_id
            .as_ref()
            .and_then(|id| manifest.get(id))
            .map(|i| i.path.clone())
            .or_else(|| {
                manifest
                    .values()
                    .find(|i| i.media_type == "application/x-dtbncx+xml")
                    .map(|i| i.path.clone())
            });
        if let Some(ncx_path) = ncx_path {
            if let Ok(text) = read_zip_text(&mut archive, &ncx_path) {
                if let Ok(ncx_doc) = roxmltree::Document::parse(&text) {
                    toc = parse_ncx(&ncx_doc, &parent_dir(&ncx_path));
                }
            }
        }
    }

    let package = Package {
        title: if title.is_empty() { "未命名".to_string() } else { title },
        authors,
        language,
        publisher,
        description,
        identifier,
        cover_path,
        direction,
        opf_path,
        spine,
        toc,
        resource_paths,
    };

    let id = book_id(path, &package);
    Ok(OpenedBook { id, path: path.to_string(), package: Arc::new(package), archive: Mutex::new(archive) })
}

fn book_id(path: &str, package: &Package) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.as_bytes());
    if let Ok(meta) = std::fs::metadata(path) {
        hasher.update(&meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(&dur.as_millis().to_le_bytes());
            }
        }
    }
    hasher.update(package.opf_path.as_bytes());
    hasher.finalize().to_hex()[..16].to_string()
}

fn read_zip_text(archive: &mut ZipArchive<File>, path: &str) -> AppResult<String> {
    let name = resolve_entry_name(archive, path)
        .ok_or_else(|| AppError::EntryMissing(path.to_string()))?;
    let mut file = archive.by_name(&name)?;
    let mut buf = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut buf)?;
    Ok(decode_text(&buf))
}

/// zip 条目名区分大小写，但现实里不少书的 OPF/manifest 与 zip 内大小写不一致。
/// 先精确匹配，再对整本做一次不区分大小写的回退查找。
fn resolve_entry_name(archive: &mut ZipArchive<File>, path: &str) -> Option<String> {
    let path = path.trim_start_matches('/').to_string();
    if archive.by_name(&path).is_ok() {
        return Some(path);
    }
    let lower = path.to_lowercase();
    (0..archive.len())
        .filter_map(|i| archive.by_index_raw(i).ok().map(|f| f.name().to_string()))
        .find(|name| name.to_lowercase() == lower)
}

/// 从 EPUB 文本字节里解出字符串。优先 BOM，其次 XML 声明 / `<meta charset>`。
pub fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(&bytes[2..]);
        return text.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _) = encoding_rs::UTF_16BE.decode_without_bom_handling(&bytes[2..]);
        return text.into_owned();
    }

    if let Some(label) = sniff_encoding(bytes) {
        if let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) {
            if enc != encoding_rs::UTF_8 {
                let (text, _, _) = enc.decode(bytes);
                return text.into_owned();
            }
        }
    }
    // 没声明编码时：合法 UTF-8 直接用；否则按 GB18030 兜底（GBK 超集，
    // 覆盖大量不做声明的中文老书）。Big5 等其它中文编码通常会带 charset 声明，
    // 由上面的 sniff_encoding 分支处理。
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => {
            let (text, _, had_errors) = encoding_rs::GB18030.decode(bytes);
            if had_errors {
                String::from_utf8_lossy(bytes).into_owned()
            } else {
                text.into_owned()
            }
        }
    }
}

fn sniff_encoding(bytes: &[u8]) -> Option<String> {
    let probe = &bytes[..bytes.len().min(4096)];
    let lower: Vec<u8> = probe.iter().map(|b| b.to_ascii_lowercase()).collect();
    let text = String::from_utf8_lossy(&lower);
    let start = text
        .find("encoding=")
        .map(|i| (i + 9, b'"'))
        .or_else(|| text.find("charset=").map(|i| (i + 8, b'"')))?;
    let (mut i, _) = start;
    let bytes = text.as_bytes();
    while i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'' || bytes[i] == b' ') {
        i += 1;
    }
    let begin = i;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' {
            i += 1;
        } else {
            break;
        }
    }
    if begin == i {
        None
    } else {
        Some(text[begin..i].to_string())
    }
}

/// 把某个文件里的 href（相对该文件所在目录）解析成 zip 内规范路径。
pub fn resolve_href(base_dir: &str, href: &str) -> String {
    let no_query = match href.find('#') {
        Some(i) => &href[..i],
        None => href,
    };
    let decoded = percent_decode(no_query);
    if decoded.starts_with('/') {
        normalize_path(&decoded)
    } else if base_dir.is_empty() {
        normalize_path(&decoded)
    } else {
        normalize_path(&format!("{base_dir}/{decoded}"))
    }
}

pub fn href_fragment(href: &str) -> Option<String> {
    href.find('#').map(|i| href[i + 1..].to_string()).filter(|s| !s.is_empty())
}

pub fn percent_decode(input: &str) -> String {
    percent_encoding::percent_decode_str(input).decode_utf8_lossy().into_owned()
}

pub fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

// ---------------- nav / ncx ----------------

fn parse_nav(doc: &roxmltree::Document, base_dir: &str) -> Vec<TocItem> {
    let Some(nav) = doc
        .descendants()
        .filter(|n| n.has_tag_name((XHTML_NS, "nav")))
        .find(|n| {
            n.attribute((OPS_NS, "type"))
                .map(|t| t.split_whitespace().any(|x| x == "toc"))
                .unwrap_or(false)
        })
        .or_else(|| doc.descendants().find(|n| n.has_tag_name((XHTML_NS, "nav"))))
    else {
        return Vec::new();
    };
    let Some(list) = nav.descendants().find(|n| n.has_tag_name((XHTML_NS, "ol"))) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    collect_nav_list(list, base_dir, 0, &mut out);
    out
}

fn collect_nav_list(list: roxmltree::Node, base_dir: &str, depth: u32, out: &mut Vec<TocItem>) {
    for li in list.children().filter(|n| n.has_tag_name((XHTML_NS, "li"))) {
        let link = li.children().find(|n| n.has_tag_name((XHTML_NS, "a")));
        let span = li.children().find(|n| n.has_tag_name((XHTML_NS, "span")));
        let label = link
            .or(span)
            .map(|n| n.text().unwrap_or_default().trim().to_string())
            .unwrap_or_default();
        if let Some(a) = link {
            if let Some(href) = a.attribute("href") {
                let path = resolve_href(base_dir, href);
                out.push(TocItem {
                    label,
                    href: href.to_string(),
                    path: Some(path).filter(|p| !p.is_empty()),
                    fragment: href_fragment(href),
                    depth,
                });
            }
        }
        if let Some(sub) = li.children().find(|n| n.has_tag_name((XHTML_NS, "ol"))) {
            collect_nav_list(sub, base_dir, depth + 1, out);
        }
        // 个别书把嵌套 ol 放进了 a 里面
        if let Some(a) = link {
            if let Some(sub) = a.children().find(|n| n.has_tag_name((XHTML_NS, "ol"))) {
                collect_nav_list(sub, base_dir, depth + 1, out);
            }
        }
    }
}

fn parse_ncx(doc: &roxmltree::Document, base_dir: &str) -> Vec<TocItem> {
    let Some(map) = doc.descendants().find(|n| n.has_tag_name("navMap")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for point in map.children().filter(|n| n.has_tag_name("navPoint")) {
        collect_nav_point(point, base_dir, 0, &mut out);
    }
    out
}

fn collect_nav_point(point: roxmltree::Node, base_dir: &str, depth: u32, out: &mut Vec<TocItem>) {
    let label = point
        .children()
        .find(|n| n.has_tag_name("navLabel"))
        .and_then(|n| n.children().find(|c| c.has_tag_name("text")))
        .and_then(|n| n.text())
        .unwrap_or_default()
        .trim()
        .to_string();
    if let Some(src) = point
        .children()
        .find(|n| n.has_tag_name("content"))
        .and_then(|n| n.attribute("src"))
    {
        let path = resolve_href(base_dir, src);
        out.push(TocItem {
            label,
            href: src.to_string(),
            path: Some(path).filter(|p| !p.is_empty()),
            fragment: href_fragment(src),
            depth,
        });
    }
    for child in point.children().filter(|n| n.has_tag_name("navPoint")) {
        collect_nav_point(child, base_dir, depth + 1, out);
    }
}

/// zip 条目 → MIME。`mime_guess` 依赖扩展名，但 EPUB 里少数资源没有扩展名，
/// 这里补几条常见兜底，其余走 `application/octet-stream`。
pub fn mime_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    let guessed = mime_guess::from_path(&lower).first_raw();
    match guessed {
        Some(m) => m,
        None => match lower.rsplit('.').next().unwrap_or("") {
            "xhtml" | "xht" => "application/xhtml+xml",
            "ncx" => "application/x-dtbncx+xml",
            "otf" => "font/otf",
            "ttf" => "font/ttf",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_href_paths() {
        assert_eq!(resolve_href("OEBPS", "Text/ch1.xhtml"), "OEBPS/Text/ch1.xhtml");
        assert_eq!(resolve_href("OEBPS/Text", "../Images/a.png"), "OEBPS/Images/a.png");
        assert_eq!(resolve_href("OEBPS", "./ch1.xhtml#fn1"), "OEBPS/ch1.xhtml");
        assert_eq!(href_fragment("./ch1.xhtml#fn1").as_deref(), Some("fn1"));
    }

    #[test]
    fn decodes_utf8_and_gbk() {
        assert_eq!(decode_text("你好".as_bytes()), "你好");
        let (gbk, _, _) = encoding_rs::GBK.encode("第一章");
        assert_eq!(decode_text(&gbk), "第一章");
    }

    #[test]
    fn sniffs_declared_charset() {
        let html = br#"<?xml version="1.0" encoding="GBK"?><html></html>"#;
        let probe = sniff_encoding(html).unwrap();
        assert_eq!(probe, "gbk");
    }
}
