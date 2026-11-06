//! 「繁 → 简」转换（P4）。
//!
//! 词表来自 OpenCC 的 TSCharacters / TSPhrases（见 `dictionary/NOTICE.md`）。
//! 短语优先、单字回退：正文里「皇后」「幹事」这类单字多义歧义靠长词匹配
//! 保住正确性（OpenCC 原生使用同一策略）。
//!
//! 性能：词典在首次使用时一次性构建（OnceLock），之后是纯查表。正文按章
//! 转换（几十 KB），滑杆级别的调用频率完全无感。匹配用字节偏移切片查表，
//! 不做每窗口的字符串分配（见 `t2s`）。

use std::collections::HashMap;
use std::sync::OnceLock;

const TS_CHARACTERS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/dictionary/TSCharacters.txt"
));
const TS_PHRASES: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/dictionary/TSPhrases.txt"
));

/// 短语最大匹配窗口（字符数）。实测词典最长 key 为 10，留一点余量。
const MAX_PHRASE_LEN: usize = 12;

struct Dictionary {
    /// 单字：繁体字 → 简体串（可能一个繁体对应多个简体，用默认值）。
    chars: HashMap<char, String>,
    /// 短语：繁体串 → 简体串。
    phrases: HashMap<String, String>,
}

static DICTIONARY: OnceLock<Dictionary> = OnceLock::new();

fn dictionary() -> &'static Dictionary {
    DICTIONARY.get_or_init(|| {
        let mut chars: HashMap<char, String> = HashMap::new();
        let mut phrases: HashMap<String, String> = HashMap::new();

        for line in TS_CHARACTERS.lines() {
            let Some((key, value)) = parse_line(line) else {
                continue;
            };
            // 单字表按「首字符」入表；多字 key（意外数据）忽略，避免误伤。
            let mut codepoints = key.chars();
            if let (Some(first), None) = (codepoints.next(), codepoints.next()) {
                chars.insert(first, value.to_string());
            }
        }

        for line in TS_PHRASES.lines() {
            let Some((key, value)) = parse_line(line) else {
                continue;
            };
            // 超长词条直接跳过：正文里几乎不可能出现，不值得拉高匹配窗口。
            if key.chars().count() > MAX_PHRASE_LEN {
                continue;
            }
            phrases.insert(key.to_string(), value.to_string());
        }

        // 词表规模进日志：数据文件损坏（被截断/改坏）时从日志一眼可见，
        // 而不是表现为「转换静默不生效」。
        log::debug!(
            "繁简词典已加载：{} 个单字、{} 个短语",
            chars.len(),
            phrases.len()
        );
        if chars.is_empty() && phrases.is_empty() {
            log::warn!("繁简词典为空：请检查 src-tauri/dictionary/ 数据文件是否完整");
        }

        Dictionary { chars, phrases }
    })
}

/// 解析一行词条：`key<TAB>value(s)`，取第一组非空值；注释/空行/坏行返回 None。
fn parse_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_end_matches('\r');
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, rest) = line.split_once('\t')?;
    let key = key.trim();
    let value = rest.split(' ').find(|v| !v.trim().is_empty())?.trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key, value))
}

/// 把一段文本里的繁体转成简体（短语优先、单字回退）。
///
/// 涉及的词条只覆盖 CJK 扩展区与 BMP 常用字；ASCII/拉丁字符原样穿过，
/// 所以对 XML/HTML 标签、URL、CSS 都是安全的——这正是把转换放在
/// Rust 侧「注入前」的原因（见开发任务书/优化方案 P4）。
///
/// 实现：预计算每个字符的字节边界，短语匹配直接在 `&str` 上切片查表；
/// 单字回退按 `char` 查表。全程零中间字符串分配（输出串除外）。
pub fn t2s(input: &str) -> String {
    let dict = dictionary();
    if input.is_empty() {
        return String::new();
    }
    // 字符边界表：bounds[i] = 第 i 个字符的起始字节偏移，末尾附加 len()。
    let mut bounds: Vec<usize> = input.char_indices().map(|(index, _)| index).collect();
    bounds.push(input.len());
    let char_count = bounds.len() - 1;

    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < char_count {
        // 短语匹配：从最长窗口往下试（窗口不越过文本末尾）。
        let mut matched_len = 0usize;
        let max_len = MAX_PHRASE_LEN.min(char_count - i);
        for len in (2..=max_len).rev() {
            let window = &input[bounds[i]..bounds[i + len]];
            if let Some(replacement) = dict.phrases.get(window) {
                out.push_str(replacement);
                matched_len = len;
                break;
            }
        }
        if matched_len > 0 {
            i += matched_len;
            continue;
        }
        let slice = &input[bounds[i]..bounds[i + 1]];
        match slice.chars().next().and_then(|ch| dict.chars.get(&ch)) {
            Some(replacement) => out.push_str(replacement),
            None => out.push_str(slice),
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{parse_line, t2s};

    #[test]
    fn ascii_passes_through_unchanged() {
        assert_eq!(t2s(""), "");
        assert_eq!(
            t2s("Hello, world! <p>epub://a/b.png</p>"),
            "Hello, world! <p>epub://a/b.png</p>"
        );
    }

    #[test]
    fn single_characters_convert() {
        // 逐字映射：繁 → 简
        assert_eq!(t2s("繁體中文"), "繁体中文");
        assert_eq!(t2s("電子書"), "电子书");
    }

    #[test]
    fn phrases_win_over_char_fallbacks() {
        // 词条级歧义：短语的转换结果与逐字不同，短语必须优先。
        assert_eq!(t2s("一目瞭然"), "一目了然");
    }

    #[test]
    fn mixed_markup_is_safe() {
        // HTML 里只有文字被转换；标签/属性名是 ASCII，原样穿过。
        assert_eq!(
            t2s("<p class=\"t\">資訊系統</p>"),
            "<p class=\"t\">资讯系统</p>"
        );
    }

    #[test]
    fn reused_dictionary_is_idempotent_for_simplified_input() {
        // 已是简体的正文再过一遍应该保持不变（幂等）——
        // 这是「开转换但书本身是简体」场景的兜底。
        let sample = "这是一段已经是简体字的正文， Citizens 字符不应被动。";
        assert_eq!(t2s(sample), sample);
    }

    #[test]
    fn convert_preserves_multi_byte_boundaries() {
        // 混合 ASCII/CJK/emoji 时不得切坏 UTF-8（按字符边界切片）。
        let input = "a繁b體c😀中d";
        let output = t2s(input);
        assert_eq!(output, "a繁b体c😀中d");
    }

    #[test]
    fn parse_line_tolerates_dirty_rows() {
        // 正常行
        assert_eq!(parse_line("一坏\t一坯"), Some(("一坏", "一坯")));
        // 注释 / 空行
        assert_eq!(parse_line("# comment"), None);
        assert_eq!(parse_line(""), None);
        // 无 tab 的坏行
        assert_eq!(parse_line("bad row without tab"), None);
        // key 前后空白被裁掉；取第一组非空值
        assert_eq!(parse_line("  說明\t说明 注释 "), Some(("說明", "说明")));
        // CRLF 行尾
        assert_eq!(parse_line("髮\t发\r"), Some(("髮", "发")));
    }
}
