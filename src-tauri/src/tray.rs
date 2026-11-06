//! 系统托盘（P5）。
//!
//! 交互按 Windows 惯例：
//! - **左键单击**：显示/还原主窗口（不弹菜单）
//! - **右键**：弹出菜单（显示主窗口／设置／检查更新／开机自启／退出）
//!
//! 托盘与设置页共享同一份 Rust 偏好（`prefs.rs`），关闭行为也在 Rust 侧
//! 拦截（见 `lib.rs` 的 `on_window_event`）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppResult;

/// 托盘菜单动作发给前端的事件名（前端据此打开设置页/更新面板）。
pub const EVENT_TRAY_ACTION: &str = "modu://tray-action";
/// 关闭请求发给前端的事件名（策略为「询问」时）。
pub const EVENT_CLOSE_REQUESTED: &str = "modu://close-requested";

/// 托盘菜单里「开机自启」勾选项的句柄（切换后要回写勾选状态）。
pub struct TrayHandles {
    autostart: CheckMenuItem<tauri::Wry>,
}

/// 把桌面状态保存一次（隐藏/退出路径不会触发 window-state 的常规保存）。
pub fn save_window_state(app: &AppHandle) {
    use tauri_plugin_window_state::AppHandleExt;
    if let Err(err) = app.save_window_state(tauri_plugin_window_state::StateFlags::all()) {
        log::warn!("保存窗口状态失败: {err}");
    }
}

/// 显示并聚焦主窗口（托盘左键、单实例第二次启动都走这里）。
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 创建托盘图标与菜单。失败只记日志：没有托盘也要能正常读书。
pub fn init(app: &AppHandle) {
    if let Err(err) = build(app) {
        log::warn!("系统托盘初始化失败（应用仍可正常使用）: {err}");
    }
}

fn build(app: &AppHandle) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let auto_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        auto_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出墨读", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&show, &settings, &separator, &check_update, &autostart, &separator, &quit],
    )?;

    // 勾选项句柄留给菜单事件回写（Tauri 的菜单事件不带 item 引用）。
    app.manage(TrayHandles { autostart: autostart.clone() });

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| crate::error::AppError::Internal("缺少应用图标".into()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("墨读")
        .menu(&menu)
        // 左键由 on_tray_icon_event 处理，右键才弹菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "settings" | "check-update" => {
                show_main_window(app);
                let _ = app.emit(EVENT_TRAY_ACTION, event.id().as_ref());
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                match result {
                    Ok(()) => {
                        // 回读实际状态再回写勾选（系统可能拒绝，不能只按点击取反）。
                        let now = manager.is_enabled().unwrap_or(!enabled);
                        if let Some(handles) = app.try_state::<TrayHandles>() {
                            let _ = handles.autostart.set_checked(now);
                        }
                        let _ = app.emit(EVENT_TRAY_ACTION, "autostart-changed");
                    }
                    Err(err) => log::warn!("切换开机自启失败: {err}"),
                }
            }
            "quit" => {
                save_window_state(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键 = 显示/还原主窗口（方案 §8 的口径；不在这里做「再点收起」，
            // 避免与「点托盘图标想回到阅读」的直觉冲突——收起用关闭按钮即可）。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
