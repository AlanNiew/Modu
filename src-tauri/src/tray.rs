//! 系统托盘（P5）。
//!
//! 交互按 Windows 惯例：
//! - **左键单击**：显示/还原主窗口（不弹菜单）
//! - **右键**：弹出菜单（显示主窗口／检查更新／设置…／关闭窗口时 ▸／开机自启／退出）
//!
//! 托盘与设置页共享同一份 Rust 偏好（`prefs.rs`），关闭行为也在 Rust 侧
//! 拦截（见 `lib.rs` 的 `on_window_event`）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::autostart;
use crate::error::AppResult;
use crate::prefs::{self, CloseAction};

/// 菜单项 id（三处 switch 共用同一份常量，避免裸字符串拼错）。
const ID_SHOW: &str = "show";
const ID_CHECK_UPDATE: &str = "check-update";
const ID_SETTINGS: &str = "settings";
const ID_CLOSE_ASK: &str = "close-ask";
const ID_CLOSE_TRAY: &str = "close-tray";
const ID_CLOSE_QUIT: &str = "close-quit";
const ID_AUTOSTART: &str = "autostart";
const ID_QUIT: &str = "quit";

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

/// 最小化到托盘：先存窗口状态再隐藏（hide 路径不会触发常规保存）。
pub fn hide_main_window(app: &AppHandle) -> AppResult<()> {
    save_window_state(app);
    if let Some(window) = app.get_webview_window("main") {
        window
            .hide()
            .map_err(|e| crate::error::AppError::Internal(format!("隐藏窗口失败: {e}")))?;
    }
    Ok(())
}

/// 退出程序：先存窗口状态再退出（避免下次启动窗口错位）。
pub fn quit_app(app: &AppHandle) {
    save_window_state(app);
    app.exit(0);
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
    let show = MenuItem::with_id(app, ID_SHOW, "显示主窗口", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, ID_CHECK_UPDATE, "检查更新…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, ID_SETTINGS, "设置…", true, None::<&str>)?;

    // 「关闭窗口时」子菜单：托盘也能改策略（方案 §8 要求）。
    let current = prefs::load(&data_dir_of(app)).close_action;
    let ask = CheckMenuItem::with_id(
        app,
        ID_CLOSE_ASK,
        "每次询问",
        true,
        current == CloseAction::Ask,
        None::<&str>,
    )?;
    let tray_close = CheckMenuItem::with_id(
        app,
        ID_CLOSE_TRAY,
        "最小化到托盘",
        true,
        current == CloseAction::Tray,
        None::<&str>,
    )?;
    let quit_close = CheckMenuItem::with_id(
        app,
        ID_CLOSE_QUIT,
        "直接退出",
        true,
        current == CloseAction::Quit,
        None::<&str>,
    )?;
    let close_menu =
        Submenu::with_items(app, "关闭窗口时", true, &[&ask, &tray_close, &quit_close])?;

    // 便携版不支持开机自启：菜单项直接置灰，避免点了没反应。
    let portable = autostart::is_portable();
    let auto_enabled = autostart::status(app)
        .map(|status| status.enabled)
        .unwrap_or(false);
    let autostart_item = CheckMenuItem::with_id(
        app,
        ID_AUTOSTART,
        if portable {
            "开机自动启动（仅安装版支持）"
        } else {
            "开机自动启动"
        },
        !portable,
        auto_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出墨读", true, None::<&str>)?;
    // 分隔线是菜单资源，不能复用同一个实例两次（NSIS/GTK 都会出问题）。
    let separator_top = PredefinedMenuItem::separator(app)?;
    let separator_bottom = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &check_update,
            &settings,
            &separator_top,
            &close_menu,
            &autostart_item,
            &separator_bottom,
            &quit,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| crate::error::AppError::Internal("缺少应用图标".into()))?;

    // 图标确认可用后再 manage：否则托盘创建失败却已注册句柄，
    // 后续 init 重试会因「重复 manage」直接 panic。
    app.manage(TrayHandles {
        autostart: autostart_item.clone(),
        ask: ask.clone(),
        tray: tray_close.clone(),
        quit: quit_close.clone(),
    });

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("墨读")
        .menu(&menu)
        // 左键由 on_tray_icon_event 处理，右键才弹菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                ID_SHOW => show_main_window(app),
                ID_SETTINGS | ID_CHECK_UPDATE => {
                    show_main_window(app);
                    let _ = app.emit(EVENT_TRAY_ACTION, id);
                }
                ID_CLOSE_ASK | ID_CLOSE_TRAY | ID_CLOSE_QUIT => {
                    let action = match id {
                        ID_CLOSE_TRAY => CloseAction::Tray,
                        ID_CLOSE_QUIT => CloseAction::Quit,
                        _ => CloseAction::Ask,
                    };
                    match prefs::set_close_action(&data_dir_of(app), action) {
                        Ok(saved) => sync_close_action(app, saved),
                        Err(err) => log::warn!("保存关闭行为失败: {err}"),
                    }
                }
                ID_AUTOSTART => {
                    // 便携版菜单项已置灰；这里再拦一层防止程序化触发。
                    if autostart::is_portable() {
                        return;
                    }
                    let enabled = autostart::status(app).map(|s| s.enabled).unwrap_or(false);
                    match autostart::set(app, !enabled) {
                        Ok(status) => {
                            sync_autostart_checked(app, status.enabled);
                            let _ = app.emit(EVENT_TRAY_ACTION, "autostart-changed");
                        }
                        Err(err) => log::warn!("切换开机自启失败: {err}"),
                    }
                }
                ID_QUIT => quit_app(app),
                _ => {}
            }
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

fn data_dir_of(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::state::AppState>().data_dir.clone()
}
