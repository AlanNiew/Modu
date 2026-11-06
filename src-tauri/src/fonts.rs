//! 本地字体管理：用户导入的字体存在 `<数据目录>/fonts/` 下。
//!
//! 设计要点：
//! - **家族名解析在导入时做一次**（sfnt `name` 表，优先 prefer 官方的
//!   Preferred Family nameID=16，回退 Family nameID=1），结果由前端持久化；
//!   列表命令重新解析是为了与磁盘对账（文件可能被手动删掉）。
//! - `woff` / `woff2` 可以导入（任务书 F-23 要求），但它们的 name 表在压缩
//!   数据里、不在裸 sfnt 里——家族名**退化为文件主名**（用户把霞鹜文楷清
//!   整成 `LXGWWenKai.woff2` 再导入，呈现名就是 `LXGWWenKai`）。
//! - 文件名一律视为**不含路径分隔符的纯文件名**写入/删除/按协议下发，
//!   杜绝任何 `..` / 盘符穿越。
//! - 单文件上限 64 MiB：字体文件再大也远超正常书用字体，直接拒绝。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 一个已安装的自定义字体。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFont {
    /// fonts 目录下的纯文件名（含扩展名），协议 URL 直接使用。
    pub file: String,
    /// 家族名：sfnt 解析；woff/woff2 为文件主名（注册 @font-face 用）。
    pub family: String,
}

/// 允许导入的扩展名。
pub const FONT_EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "woff", "woff2"];

/// 单个字体文件的大小上限（64 MiB）。
const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;

/// 数据目录下的 fonts 子目录。
pub fn fonts_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("fonts")
}

/// 校验「纯文件名 + 已知字体扩展名」；返回大写化前的扩展名本体。
fn validate_font_file_name(file: &str) -> AppResult<()> {
    let ok = !file.is_empty()
        && !file.contains(['/', '\\'])
        && !file.contains("..")
        && file
            .rsplit('.')
            .next()
            .is_some_and(|ext| FONT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()));
    if ok {
        Ok(())
    } else {
        Err(AppError::Validation(format!("非法的字体文件名：{file}")))
    }
}

/// 导入一个字体文件：解析家族名并复制进 fonts 目录（同名覆盖）。
pub fn install(data_dir: &Path, src_path: &str) -> AppResult<InstalledFont> {
    let src = Path::new(src_path);
    // 用户通过系统对话框选择的文件，路径可信度有限——这里进一步约束
    // 扩展名，防止把任意文件复制进数据目录。
    let extension = src
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    let Some(extension) = extension else {
        return Err(AppError::Validation(
            "请选择 .ttf / .otf / .ttc / .woff / .woff2 字体文件".into(),
        ));
    };
    if !FONT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::Validation(
            "请选择 .ttf / .otf / .ttc / .woff / .woff2 字体文件".into(),
        ));
    }
    if !src.is_file() {
        return Err(AppError::NotFound(format!("文件不存在: {src_path}")));
    }

    let bytes = fs::read(src)?;
    if bytes.len() > MAX_FONT_BYTES {
        return Err(AppError::Validation(format!(
            "字体文件过大（{} MiB > {} MiB）",
            bytes.len() / (1024 * 1024),
            MAX_FONT_BYTES / (1024 * 1024)
        )));
    }
    // ttf/otf/ttc 能解析出正式家族名；woff/woff2 是压缩容器，名字退化为
    // 文件主名（去扩展名，短横线/点保留原样）。
    let family = parse_font_family(&bytes).unwrap_or_else(|| {
        src.file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| stem.to_string())
            .unwrap_or_else(|| "imported-font".into())
    });
    if family.is_empty() {
        return Err(AppError::Validation("无法从字体文件中解析出字体名，文件可能已损坏".into()));
    }

    let dir = fonts_dir(data_dir);
    fs::create_dir_all(&dir)?;
    let file = format!(
        "{}.{extension}",
        src.file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| stem.chars().take(64).collect::<String>())
            .unwrap_or_else(|| "font".into())
    );
    fs::write(dir.join(&file), bytes)
        .map_err(|e| AppError::Io(format!("写入字体文件失败（{file}）: {e}")))?;

    Ok(InstalledFont { file, family })
}

/// 列出 fonts 目录里的全部字体（解析家族名；解析失败的文件跳过并保持安静）。
pub fn list(data_dir: &Path) -> AppResult<Vec<InstalledFont>> {
    let dir = fonts_dir(data_dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut fonts = Vec::new();
    let mut entries = fs::read_dir(&dir)?;
    // 目录顺序在 Windows 上不稳定，列表按文件名排序保证 UI 稳定。
    let mut paths = Vec::new();
    for entry in &mut entries {
        let path = entry?.path();
        if path.is_file() {
            paths.push(path);
        }
    }
    paths.sort_by_key(|p| p.file_name().map(|n| n.to_os_string()).unwrap_or_default());
    for path in paths {
        let Some(file) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if validate_font_file_name(file).is_err() {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        // 与 install 的规则一致：sfnt 解析失败（如 woff/woff2）退回文件主名。
        let family = parse_font_family(&bytes).unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(|stem| stem.to_string())
                .unwrap_or_else(|| file.to_string())
        });
        fonts.push(InstalledFont {
            file: file.to_string(),
            family,
        });
    }
    Ok(fonts)
}

/// 删除一个字体文件（只接受纯文件名）。
pub fn remove(data_dir: &Path, file: &str) -> AppResult<()> {
    validate_font_file_name(file)?;
    let path = fonts_dir(data_dir).join(file);
    if !path.is_file() {
        return Err(AppError::NotFound(format!("字体不存在: {file}")));
    }
    fs::remove_file(path).map_err(|e| AppError::Io(format!("删除字体失败（{file}）: {e}")))
}

// ---------------------------------------------------------------------------
// sfnt/TTF `name` 表解析
// ---------------------------------------------------------------------------

fn be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let hi = *bytes.get(offset)?;
    let lo = *bytes.get(offset.checked_add(1)?)?;
    Some(u16::from_be_bytes([hi, lo]))
}

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from(be_u16(bytes, offset)?) << 16
        | u32::from(be_u16(bytes, offset.checked_add(2)?)?))
}

/// 在 sfnt 数据里找到 `tag` 表；`base` 是 sfnt 目录的起始偏移（ttc 时非 0）。
fn find_sfnt_table(bytes: &[u8], base: usize, tag: &[u8; 4]) -> Option<(usize, usize)> {
    let count = be_u16(bytes, base.checked_add(4)?)? as usize;
    for index in 0..count {
        let entry = base + 12 + index * 16;
        if entry + 16 > bytes.len() {
            return None;
        }
        if &bytes[entry..entry + 4] == tag {
            let offset = be_u32(bytes, entry + 8)? as usize;
            let length = be_u32(bytes, entry + 12)? as usize;
            if offset.saturating_add(length) <= bytes.len() {
                return Some((offset, length));
            }
            return None;
        }
    }
    None
}

/// 家族名的展示净化：家族名会被写进 CSS（`font-family: "..."`），
/// 换行/控制字符一并清掉，避免把脏字符带进样式表。
fn sanitize_family(raw: String) -> Option<String> {
    let cleaned = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// 解码 UTF-16BE（Windows 字体 name 表的文字编码）。
fn decode_utf16be(bytes: &[u8]) -> Option<String> {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    let text = String::from_utf16(&units).ok()?;
    sanitize_family(text)
}

/// 从 ttf/otf/ttc 字体数据解析家族名。
///
/// 顺序：UTF-16BE（platform 3, Windows）的 nameID 16 → nameID 1；
/// 找不到整数族名时回退 Macintosh ASCII（platform 1）的 nameID 1。
pub fn parse_font_family(bytes: &[u8]) -> Option<String> {
    // TTC 容器：第 12 字节起是第一个字体的 sfnt 目录偏移。
    let dir_base = if bytes.starts_with(b"ttcf") {
        be_u32(bytes, 12)? as usize
    } else {
        0
    };
    let (name_offset, name_length) = find_sfnt_table(bytes, dir_base, b"name")?;
    let name_table = bytes.get(name_offset..name_offset + name_length)?;
    let count = be_u16(name_table, 2)? as usize;
    let string_offset = be_u16(name_table, 4)? as usize;

    let mut preferred: Option<String> = None;
    let mut family: Option<String> = None;
    let mut mac_family: Option<String> = None;
    for index in 0..count {
        let record = 6 + index * 12;
        if record + 12 > name_table.len() {
            break;
        }
        let platform = be_u16(name_table, record)?;
        let encoding = be_u16(name_table, record.checked_add(2)?)?;
        let name_id = be_u16(name_table, record.checked_add(6)?)?;
        let length = be_u16(name_table, record.checked_add(8)?)? as usize;
        let offset = be_u16(name_table, record.checked_add(10)?)? as usize + string_offset;
        let Some(text_bytes) = name_table
            .get(offset..)
            .and_then(|rest| rest.get(..length))
        else {
            continue;
        };
        if name_id == 16 || name_id == 1 {
            // Windows 平台（3）任意编码基本都是 UTF-16 文字；其次试 Mac ASCII。
            let decoded = if platform == 3 {
                decode_utf16be(text_bytes)
            } else {
                decode_ascii(text_bytes)
            };
            if let Some(text) = decoded {
                if name_id == 16 && preferred.is_none() {
                    preferred = Some(text);
                } else if name_id == 1 {
                    match platform {
                        1 => mac_family = Some(text),
                        _ => family = Some(text),
                    }
                }
            }
        }
    }
    // nameID 16 别名表（微软改名工具常见）比普通 family 更想表达“正式的家族名”。
    preferred.or(family).or(mac_family)
}

/// Macintosh（platform 1）的 ASCII 编码。
fn decode_ascii(bytes: &[u8]) -> Option<String> {
    let text: String = bytes
        .iter()
        .map(|&b| b as char)
        .collect::<String>()
        .trim_matches('\u{0}')
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ---------------------------------------------------------------------------
// 测试：手工拼一个最小 name 表来解析家族名（不依赖真实字体文件）。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造一个只有一个 name 记录的最小 sfnt：
    /// table 目录 + name 表（format/count/stringOffset + 1 条记录 + 文本）。
    fn sfnt_with_name(platform: u16, encoding: u16, name_id: u16, text: &[u8]) -> Vec<u8> {
        let mut table: Vec<u8> = Vec::new();
        table.extend_from_slice(&0u16.to_be_bytes()); // format
        table.extend_from_slice(&1u16.to_be_bytes()); // count
        // stringOffset 以「表起始」为原点：1 条记录占 12 字节，字符串区从 6+12 起。
        table.extend_from_slice(&18u16.to_be_bytes());
        table.extend_from_slice(&platform.to_be_bytes());
        table.extend_from_slice(&encoding.to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes()); // language
        table.extend_from_slice(&name_id.to_be_bytes());
        table.extend_from_slice(&(text.len() as u16).to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes()); // offset 相对 stringOffset
        table.extend_from_slice(text);

        let mut sfnt: Vec<u8> = Vec::new();
        // sfnt 头：version(4) numTables(2) searchRange(2) entrySelector(2)
        // rangeShift(2)；表目录入口从第 12 字节起（find_sfnt_table 读 base+12）。
        sfnt.extend_from_slice(b"\x00\x01\x00\x00"); // version 1.0
        sfnt.extend_from_slice(&1u16.to_be_bytes()); // table count
        sfnt.extend_from_slice(&[0x00; 6]);
        sfnt.extend_from_slice(b"name"); // tag
        sfnt.extend_from_slice(&[0x00; 4]); // checksum
        sfnt.extend_from_slice(&(28u32.to_be_bytes())); // name 表数据的绝对文件偏移（12 头 + 16 目录项）
        sfnt.extend_from_slice(&(table.len() as u32).to_be_bytes()); // length
        sfnt.extend_from_slice(&table);
        sfnt
    }

    #[test]
    fn parses_utf16be_family_name() {
        let mut text: Vec<u8> = Vec::new();
        for unit in "思源宋体".encode_utf16() {
            text.extend_from_slice(&unit.to_be_bytes());
        }
        let sfnt = sfnt_with_name(3, 1, 1, &text);
        assert_eq!(parse_font_family(&sfnt).as_deref(), Some("思源宋体"));
    }

    #[test]
    fn preferred_family_wins_over_family() {
        let mut preferred: Vec<u8> = Vec::new();
        for unit in "Terminess Nerd".encode_utf16() {
            preferred.extend_from_slice(&unit.to_be_bytes());
        }
        let mut fallback: Vec<u8> = Vec::new();
        for unit in "Terminus".encode_utf16() {
            fallback.extend_from_slice(&unit.to_be_bytes());
        }
        // 两张记录：name 用「记录数组两条」布局重造。
        let mut table: Vec<u8> = Vec::new();
        table.extend_from_slice(&0u16.to_be_bytes());
        table.extend_from_slice(&2u16.to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes()); // stringOffset 稍后回填
        // 记录 1：nameID 16（相对 stringOffset 的偏移为 0）
        table.extend_from_slice(&3u16.to_be_bytes());
        table.extend_from_slice(&1u16.to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes());
        table.extend_from_slice(&16u16.to_be_bytes());
        table.extend_from_slice(&(preferred.len() as u16).to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes());
        // 记录 2：nameID 1（紧跟 preferred 之后）
        table.extend_from_slice(&3u16.to_be_bytes());
        table.extend_from_slice(&1u16.to_be_bytes());
        table.extend_from_slice(&0u16.to_be_bytes());
        table.extend_from_slice(&1u16.to_be_bytes());
        table.extend_from_slice(&(fallback.len() as u16).to_be_bytes());
        table.extend_from_slice(&(preferred.len() as u16).to_be_bytes());
        // 字符串区（紧跟记录数组：6 + 2*12 = 30，与 stringOffset 对齐）
        table.extend_from_slice(&preferred);
        table.extend_from_slice(&fallback);
        table[4..6].copy_from_slice(&30u16.to_be_bytes());

        let mut sfnt: Vec<u8> = Vec::new();
        sfnt.extend_from_slice(b"\x00\x01\x00\x00");
        sfnt.extend_from_slice(&1u16.to_be_bytes());
        sfnt.extend_from_slice(&[0x00; 6]);
        sfnt.extend_from_slice(b"name");
        sfnt.extend_from_slice(&[0x00; 4]);
        sfnt.extend_from_slice(&(28u32.to_be_bytes()));
        sfnt.extend_from_slice(&(table.len() as u32).to_be_bytes());
        sfnt.extend_from_slice(&table);
        assert_eq!(parse_font_family(&sfnt).as_deref(), Some("Terminess Nerd"));
    }

    #[test]
    fn rejects_non_font_files() {
        assert!(parse_font_family(b"not a font at all").is_none());
    }

    #[test]
    fn installs_and_lists_fonts_in_dir() {
        let dir = scratch("fonts-install");
        // platform 3 的文字按 UTF-16BE 编码。
        let mut text: Vec<u8> = Vec::new();
        for unit in "TestFont".encode_utf16() {
            text.extend_from_slice(&unit.to_be_bytes());
        }
        let font = sfnt_with_name(3, 1, 1, &text);
        let src = dir.join("sample.ttf");
        fs::write(&src, &font).unwrap();

        let installed = install(&dir, src.to_str().unwrap()).unwrap();
        assert_eq!(installed.family, "TestFont");
        assert_eq!(installed.file, "sample.ttf");

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].family, "TestFont");

        remove(&dir, "sample.ttf").unwrap();
        assert!(list(&dir).unwrap().is_empty());
    }

    #[test]
    fn woff_import_falls_back_to_file_stem_family() {
        let dir = scratch("fonts-woff");
        // 文件名带空格和括号（Windows 合法字符），顺带验证 file 名保留原样。
        let src = dir.join("My Font (2024).woff2");
        fs::write(&src, b"wOF2").unwrap();
        let installed = install(&dir, src.to_str().unwrap()).unwrap();
        assert_eq!(installed.file, "My Font (2024).woff2");
        assert_eq!(installed.family, "My Font (2024)");
        // 列表（磁盘对账）同样给出行主名。
        let listed = list(&dir).unwrap();
        assert_eq!(listed[0].family, "My Font (2024)");
    }

    #[test]
    fn deletes_rejects_traversal_and_unknown() {
        let dir = scratch("fonts-remove");
        assert!(remove(&dir, "../evil.ttf").is_err());
        assert!(remove(&dir, "missing.ttf").is_err());
        assert!(remove(&dir, "note.txt").is_err());
    }
}
