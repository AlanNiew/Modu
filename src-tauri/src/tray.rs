//! 系统托盘（P5）。
//!
//! 交互按 Windows 惯例：
//! - **左键单击**：显示/还原主窗口（不弹菜单）
//! - **右键**：弹出菜单（显示主窗口／检查更新／设置…／关闭窗口时 ▸／开机自启／退出）
//!
//! 托盘与设置页共享同一份 Rust 偏好（`prefs.rs`），关闭行为也在 Rust 侧
//! 拦截（见 `lib.rs` 的 `on_window_event`）。

use tauri::menu::{
    CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppResult;
use crate::prefs::{self, CloseAction};

/// 托盘菜单动作发给前端的事件名（前端据此打开设置页/更新面板）。
pub const EVENT_TRAY_ACTION: &str = "modu://tray-action";
/// 关闭请求发给前端的事件名（策略为「询问」时）。
pub const EVENT_CLOSE_REQUESTED: &str = "modu://close-requested";

/// 托盘菜单里需要事后回写的勾选项句柄（菜单事件不带 item 引用）。
pub struct TrayHandles {
    autostart: CheckMenuItem<tauri::Wry>,
    ask: CheckMenuItem<tauri::Wry>,
    tray: CheckMenuItem<tauri::Wry>,
    quit: CheckMenuItem<tauri::Wry>,
}

/// 托盘与设置页共享的 world：当前是否是便携模式（不写注册表）。
///
/// 便携版的 exe 可能在临时目录/U 盘，自启项会指向随时消失的路径，
/// 因此开机自启只对安装版开放（方案 §8 边界）。
pub fn is_portable() -> bool {
    std::env::var_os("MODU_DATA_DIR").is_some()
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

/// 设置页改了开机自启后，把托盘勾选状态同步过来（否则托盘显示会陈旧）。
pub fn sync_autostart_checked(app: &AppHandle, enabled: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.autostart.set_checked(enabled);
    }
}

/// 设置页改了关闭行为后，把托盘单选标记同步过来。
pub fn sync_close_action(app: &AppHandle, action: CloseAction) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.ask.set_checked(action == CloseAction::Ask);
        let _ = handles.tray.set_checked(action == CloseAction::Tray);
        let _ = handles.quit.set_checked(action == CloseAction::Quit);
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
    let check_update = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;

    // 「关闭窗口时」子菜单：托盘也能改策略（方案 §8 要求）。
    let current = prefs::load(&data_dir_of(app)).close_action;
    let ask = CheckMenuItem::with_id(
        app,
        "close-ask",
        "每次询问",
        true,
        current == CloseAction::Ask,
        None::<&str>,
    )?;
    let tray_close = CheckMenuItem::with_id(
        app,
        "close-tray",
        "最小化到托盘",
        true,
        current == CloseAction::Tray,
        None::<&str>,
    )?;
    let quit_close = CheckMenuItem::with_id(
        app,
        "close-quit",
        "直接退出",
        true,
        current == CloseAction::Quit,
        None::<&str>,
    )?;
    let close_menu = Submenu::with_items(
        app,
        "关闭窗口时",
        true,
        &[&ask, &tray_close, &quit_close],
    )?;

    // 便携版不支持开机自启：菜单项直接置灰，避免点了没反应。
    let portable = is_portable();
    let auto_enabled = !portable && app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        if portable {
            "开机自动启动（仅安装版支持）"
        } else {
            "开机自动启动"
        },
        !portable,
        auto_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出墨读", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &check_update,
            &settings,
            &separator,
            &close_menu,
            &autostart,
            &separator,
            &quit,
        ],
    )?;

    app.manage(TrayHandles {
        autostart: autostart.clone(),
        ask: ask.clone(),
        tray: tray_close.clone(),
        quit: quit_close.clone(),
    });

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
            "close-ask" | "close-tray" | "close-quit" => {
                let action = match event.id().as_ref() {
                    "close-tray" => CloseAction::Tray,
                    "close-quit" => CloseAction::Quit,
                    _ => CloseAction::Ask,
                };
                if let Ok(mut preferences) = take_prefs(app) {
                    preferences.close_action = action;
                    if let Err(err) = prefs::save(&data_dir_of(app), &preferences) {
                        log::warn!("保存关闭行为失败: {err}");
                        return;
                    }
                    sync_close_action(app, action);
                }
            }
            "autostart" => {
                if is_portable() {
                    return;
                }
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
                        sync_autostart_checked(app, now);
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
            // 左键 = 显示/还原主窗口（方案 §8 的口径；不做「再点收起」的增强，
            // 避免与「点托盘图标想回到阅读」的直觉冲突）。
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

/// 托盘事件里读偏好（失败按默认值，不阻塞菜单响应）。
fn take_prefs(app: &AppHandle) -> Result<prefs::Preferences, ()> {
    Ok(prefs::load(&data_dir_of(app)))
}

fn data_dir_of(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::state::AppState>().data_dir.clone()
}
