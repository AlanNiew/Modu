//! 桌面行为偏好（P5）：关闭动作等需要 Rust 侧判定的设置。
//!
//! 为什么放 Rust 而不是 localStorage：窗口 `CloseRequested` 的判定发生在
//! Rust 侧，托盘菜单与设置页要共享同一份状态；放前端的话 Rust 读不到。
//!
//! 存储：`<数据目录>/preferences.json`（独立于 SQLite——这类「界面行为」
//! 不属于书数据，损坏时按默认值继续工作，不阻塞启动）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 关闭主窗口时的行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CloseAction {
    /// 每次弹窗询问（首次启动的默认值）
    #[default]
    Ask,
    /// 最小化到系统托盘（应用继续在后台运行）
    Tray,
    /// 直接退出程序
    Quit,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub close_action: CloseAction,
}

fn prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("preferences.json")
}

/// 读取偏好；文件不存在/损坏都回退到默认值（不让界面行为配置阻塞启动）。
pub fn load(data_dir: &Path) -> Preferences {
    let path = prefs_path(data_dir);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|err| {
            log::warn!("preferences.json 解析失败，使用默认值: {err}");
            Preferences::default()
        }),
        Err(err) => {
            // 不存在是正常首次运行；其他错误（权限/占用）记下来便于排查。
            if err.kind() != std::io::ErrorKind::NotFound {
                log::warn!("读取 preferences.json 失败，使用默认值: {err}");
            }
            Preferences::default()
        }
    }
}

/// 原子写入偏好（写临时文件 → fsync → rename），避免断电留下半个 JSON。
pub fn save(data_dir: &Path, prefs: &Preferences) -> AppResult<()> {
    use std::io::Write as _;

    let path = prefs_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(prefs)
        .map_err(|e| AppError::Internal(format!("序列化偏好失败: {e}")))?;

    let write = || -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&json)?;
        // rename 本身是原子的，但数据可能还在页缓存里；落盘后再换名才真正防断电。
        file.sync_all()?;
        Ok(())
    };
    if let Err(err) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(format!("写入偏好失败: {err}")));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::Io(format!("保存偏好失败: {e}"))
    })
}

/// 改「关闭主窗口」行为并落盘（设置页与托盘共用这一处规则）。
pub fn set_close_action(data_dir: &Path, action: CloseAction) -> AppResult<CloseAction> {
    let mut preferences = load(data_dir);
    preferences.close_action = action;
    save(data_dir, &preferences)?;
    Ok(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_is_ask_when_missing() {
        let dir = scratch("prefs-missing");
        assert_eq!(load(&dir).close_action, CloseAction::Ask);
    }

    #[test]
    fn roundtrip_close_action() {
        let dir = scratch("prefs-roundtrip");
        let prefs = Preferences {
            close_action: CloseAction::Tray,
        };
        save(&dir, &prefs).unwrap();
        assert_eq!(load(&dir).close_action, CloseAction::Tray);

        let prefs = Preferences {
            close_action: CloseAction::Quit,
        };
        save(&dir, &prefs).unwrap();
        assert_eq!(load(&dir).close_action, CloseAction::Quit);
        // 不能留下临时文件
        assert!(!dir.join("preferences.json.tmp").exists());
    }

    #[test]
    fn corrupted_file_falls_back_to_default() {
        let dir = scratch("prefs-corrupt");
        fs::write(dir.join("preferences.json"), b"{ not json").unwrap();
        assert_eq!(load(&dir).close_action, CloseAction::Ask);
    }

    #[test]
    fn serde_shape_matches_frontend_contract() {
        // 前端按 camelCase 读写：字段名必须稳定（契约测试）。
        let json = serde_json::to_string(&Preferences {
            close_action: CloseAction::Quit,
        })
        .unwrap();
        assert!(json.contains("\"closeAction\":\"quit\""), "实际: {json}");
        let parsed: Preferences = serde_json::from_str(r#"{"closeAction":"tray"}"#).unwrap();
        assert_eq!(parsed.close_action, CloseAction::Tray);
    }
}
