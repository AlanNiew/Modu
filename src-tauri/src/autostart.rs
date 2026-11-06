//! 开机自启（P5）：包一层 `tauri-plugin-autostart`，并区分「便携版不支持」。
//!
//! 为什么单独成模块：命令层只做参数 → 调用 → DTO（任务书 §3.2），
//! 便携版判定、回读校正、托盘勾选同步这些规则都属于业务逻辑。
//!
//! 便携版判定：`MODU_DATA_DIR` 有值即视为便携模式（lib.rs 的 data_dir 约定），
//! 此时 exe 可能在 U 盘/临时目录，写进 Run 键会指向随时消失的路径，
//! 因此 supported=false，前端与托盘同时置灰。

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// 自启状态：`supported=false` 表示当前环境（便携版）不支持。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub supported: bool,
    pub enabled: bool,
}

/// 是否便携模式（数据目录由环境变量指定）。
pub fn is_portable() -> bool {
    std::env::var_os("MODU_DATA_DIR").is_some()
}

/// 读取当前状态。
pub fn status(app: &AppHandle) -> AppResult<AutostartStatus> {
    use tauri_plugin_autostart::ManagerExt;

    if is_portable() {
        return Ok(AutostartStatus {
            supported: false,
            enabled: false,
        });
    }
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| AppError::Internal(format!("读取开机自启状态失败: {e}")))?;
    Ok(AutostartStatus {
        supported: true,
        enabled,
    })
}

/// 开关自启，返回**实际生效**的状态（系统可能拒绝，不能按点击取反）。
pub fn set(app: &AppHandle, enabled: bool) -> AppResult<AutostartStatus> {
    use tauri_plugin_autostart::ManagerExt;

    if is_portable() {
        return Err(AppError::Validation(
            "便携版不支持开机自启，请使用安装版".into(),
        ));
    }
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|e| AppError::Internal(format!("开启开机自启失败: {e}")))?;
    } else {
        manager
            .disable()
            .map_err(|e| AppError::Internal(format!("关闭开机自启失败: {e}")))?;
    }
    let actual = manager
        .is_enabled()
        .map_err(|e| AppError::Internal(format!("读取开机自启状态失败: {e}")))?;
    Ok(AutostartStatus {
        supported: true,
        enabled: actual,
    })
}
