mod autostart;
mod commands;
mod convert;
mod db;
mod epub;
mod error;
mod fonts;
mod library;
mod prefs;
mod protocol;
mod state;
mod tray;

use tauri::Manager;

/// 应用数据根目录。
///
/// 默认 `%APPDATA%\Modu`（Windows）。支持 `MODU_DATA_DIR` 覆盖，用于便携模式、
/// 测试环境和受控沙箱（GUI 子进程可能没有 %APPDATA% 写权限）。
///
/// 这里**特意不用** Tauri 的 `app_data_dir()`（= `%APPDATA%\<bundle identifier>`）：
/// NSIS 卸载器在用户勾选「删除应用数据」时会执行 `RmDir /r "$APPDATA\${BUNDLEID}"`，
/// 数据若放在 bundle id 下，卸载程序会把书架、进度、书签、批注一起删掉且不可恢复。
/// 用独立目录名把「程序」与「数据」解耦——卸载安装器只删程序，不再碰书库。
///
/// 老版本（≤ 0.3.1）的数据在 `%APPDATA%\com.alanview.epubreader`，这里做一次性迁移：
/// 同卷 `rename` 成功即完成；失败（被占用、跨卷等）则继续使用旧目录，绝不丢数据。
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    if let Some(custom) = std::env::var_os("MODU_DATA_DIR") {
        let path = std::path::PathBuf::from(custom);
        if path.as_os_str().is_empty() {
            return Err("MODU_DATA_DIR 不能为空".into());
        }
        return Ok(path);
    }

    let legacy = app.path().app_data_dir()?;
    let Some(roaming) = legacy.parent() else {
        return Ok(legacy);
    };
    let target = roaming.join("Modu");

    match migrate_legacy_data(&legacy, &target) {
        Ok(true) => {
            log::info!(
                "数据目录已迁移: {} -> {}",
                legacy.display(),
                target.display()
            );
            Ok(target)
        }
        Ok(false) => Ok(if target.exists() { target } else { legacy }),
        Err(err) => {
            log::warn!("数据目录迁移失败，继续使用旧目录: {err}");
            Ok(legacy)
        }
    }
}

/// 把旧版本（≤ 0.3.1）的数据目录整体搬到新目录。
///
/// 返回 `Ok(true)` 表示这次真的搬了，`Ok(false)` 表示不需要搬（新目录已有数据，
/// 或旧目录不存在）。搬运用同卷 `rename`：要么整目录换名成功，要么原样不动，
/// 不会出现「搬了一半」的状态。
fn migrate_legacy_data(
    legacy: &std::path::Path,
    target: &std::path::Path,
) -> Result<bool, std::io::Error> {
    if target.exists() || !legacy.exists() {
        return Ok(false);
    }
    std::fs::rename(legacy, target)?;
    Ok(true)
}

/// 首次启动时创建数据目录并打开数据库；失败则直接报错——没有书架就无法工作。
fn init_state(app: &tauri::AppHandle) -> Result<state::AppState, Box<dyn std::error::Error>> {
    let base = data_dir(app)?;
    std::fs::create_dir_all(&base)?;
    let (db_path, covers_dir) = library::data_layout(&base);
    std::fs::create_dir_all(&covers_dir)?;
    let db = db::Db::open(&db_path)?;
    log::info!("数据目录: {}", base.display());
    Ok(state::AppState::new(db, base, covers_dir))
}

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // 开发构建只写 stdout：dev 下不去碰用户目录（有些安全软件会拦住未签名 exe
    // 写 %LOCALAPPDATA%，tauri-plugin-log 的 LogDir 初始化失败会直接让 App 起不来）。
    let builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Info)
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ));
    #[cfg(not(debug_assertions))]
    let builder = builder.target(tauri_plugin_log::Target::new(match log_folder() {
        // 日志跟着「数据目录」走，而不是 Tauri 默认的 LogDir（%LOCALAPPDATA%\<id>\logs）：
        // 便携版不会写用户目录；被安全软件盯上的机器也不会因为日志写不进去而启动失败。
        Some(folder) => tauri_plugin_log::TargetKind::Folder {
            path: folder,
            file_name: Some("modu".into()),
        },
        None => tauri_plugin_log::TargetKind::LogDir {
            file_name: Some("modu".into()),
        },
    }));
    builder.build()
}

/// release 版日志目录：`<MODU_DATA_DIR>/logs` 或 `%APPDATA%\Modu\logs`。
/// （debug 只写 stdout，所以这个函数只给 release 用）
#[cfg(not(debug_assertions))]
fn log_folder() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("MODU_DATA_DIR") {
        return Some(std::path::PathBuf::from(dir).join("logs"));
    }
    std::env::var_os("APPDATA")
        .map(|appdata| std::path::PathBuf::from(appdata).join("Modu").join("logs"))
}

/// 给 WebView2 指定用户数据目录，避开默认的 `%LOCALAPPDATA%\<bundle id>\EBWebView`。
///
/// 为什么需要：实测部分安全软件（如本机的 Lenovo/火绒组合）会拦截未签名 exe
/// 往 `%LOCALAPPDATA%` 写文件，WebView2 创建环境时直接返回 `0x8000FFFF` /
/// `0x800700AA`，表现为「打开就崩、没有任何窗口」。把缓存放到应用自己的位置
/// 可以绕开这类误拦，也让 dev 与已安装版不再抢同一个缓存目录。
///
/// 优先级：显式环境变量 > `MODU_DATA_DIR`（便携版）> 开发构建放 `target/`。
fn prepare_webview_profile() {
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return;
    }
    let mut profile: Option<std::path::PathBuf> = None;
    if let Some(dir) = std::env::var_os("MODU_DATA_DIR") {
        profile = Some(std::path::PathBuf::from(dir).join("EBWebView"));
    }
    #[cfg(debug_assertions)]
    if profile.is_none() {
        // target\debug\modu.exe → target\webview-profile（在项目目录内，不受用户目录拦截影响）
        if let Ok(exe) = std::env::current_exe() {
            if let Some(target_dir) = exe.parent().and_then(|dir| dir.parent()) {
                profile = Some(target_dir.join("webview-profile"));
            }
        }
    }
    let Some(path) = profile else { return };
    if let Err(err) = std::fs::create_dir_all(&path) {
        log::warn!("创建 WebView2 缓存目录失败（将退回默认目录）: {err}");
        return;
    }
    // 在创建任何线程之前设置环境变量：Tauri 尚未初始化，这里仍是单线程。
    // SAFETY: 同上——此刻没有并发读取环境的线程。
    unsafe {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &path);
    }
}

/// 启动失败时的可执行提示（比一句 panic 有用得多）。
fn report_startup_failure(err: &tauri::Error) -> ! {
    eprintln!("墨读启动失败: {err}");
    let text = err.to_string();
    if text.contains("WebView2") || text.contains("0x8000") || text.contains("0x8007") {
        eprintln!();
        eprintln!("这通常是 WebView2 环境创建失败，常见原因：");
        eprintln!("  1) 安全软件（火绒/Defender/360 等）拦截了 modu.exe 写用户目录；");
        eprintln!("     把 modu.exe 及其安装目录加入信任区/白名单即可。");
        eprintln!("  2) 已有另一个墨读实例占用了 WebView2 缓存：先退出托盘里的墨读再启动。");
        eprintln!("  3) 仍不行时可手动指定缓存目录后重试：");
        eprintln!("     set WEBVIEW2_USER_DATA_FOLDER=%LOCALAPPDATA%\\Modu\\EBWebView");
    }
    std::process::exit(1)
}

/// 窗口几何修正。
///
/// `tauri-plugin-window-state` 会恢复上次的尺寸/位置：如果上次在更大的显示器
/// （或外接屏已拔掉）上关窗口，恢复出来的窗口可能比当前屏幕还大、整个落在屏外，
/// 用户看到的现象就是「进程在跑但没有窗口」。这里把它拉回可视区。
fn fix_window_geometry(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };

    // 至少要有 120x120 落在某个显示器里，否则视为「跑到屏外」
    let x = position.x as i64;
    let y = position.y as i64;
    let width = size.width as i64;
    let height = size.height as i64;
    let visible = monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let area = monitor.size();
        let overlap_x =
            (x + width).min(origin.x as i64 + area.width as i64) - x.max(origin.x as i64);
        let overlap_y =
            (y + height).min(origin.y as i64 + area.height as i64) - y.max(origin.y as i64);
        overlap_x >= 120 && overlap_y >= 120
    });

    let mut resized = false;
    if let Ok(Some(primary)) = window.primary_monitor() {
        let area = primary.size();
        // 留出任务栏/标题栏余量：宽度 95%、高度 90%
        let max_width = (area.width as f64 * 0.95) as u32;
        let max_height = (area.height as f64 * 0.9) as u32;
        if size.width > max_width || size.height > max_height {
            let _ = window.set_size(tauri::PhysicalSize::new(
                size.width.min(max_width),
                size.height.min(max_height),
            ));
            resized = true;
        }
    }

    if !visible || resized {
        let _ = window.center();
    }
}

pub fn run() {
    // 必须在建窗口之前：决定 WebView2 缓存落在哪（见函数注释）。
    prepare_webview_profile();

    tauri::Builder::default()
        // 单实例必须最先注册：第二次启动时把已有窗口拉到前台。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 自动更新：updater 负责「检查 / 下载 / 验签 / 静默安装」，
        // process 负责安装完成后 relaunch() 重启到新版本。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 开机自启（写 HKCU\...\Run）：插件与托盘菜单、设置页共用同一状态。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            // 托盘必须在 setup 里建：此时窗口已存在，左键切换可见性才有意义。
            tray::init(app.handle());
            // 恢复的窗口位置/尺寸可能来自别的显示器配置，这里兜底拉回可视区。
            fix_window_geometry(app.handle());
            Ok(())
        })
        // 关闭主窗口时的行为（托盘 / 退出 / 询问），见 prefs::CloseAction。
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let app = window.app_handle();
            let data_dir = app.state::<state::AppState>().data_dir.clone();
            match prefs::load(&data_dir).close_action {
                prefs::CloseAction::Tray => {
                    // 隐藏而不是关闭：保存窗口位置后收进托盘继续跑。
                    tray::save_window_state(app);
                    api.prevent_close();
                    let _ = window.hide();
                }
                prefs::CloseAction::Quit => {
                    tray::save_window_state(app);
                    api.prevent_close();
                    app.exit(0);
                }
                prefs::CloseAction::Ask => {
                    // 交给前端弹一次性询问框；用户选择后由命令落盘并执行。
                    // 前端监听尚未就绪（极早期启动/前端崩溃）时事件会失败：
                    // 此时退回「最小化到托盘」，保证窗口不会被一个弹不出来的
                    // 对话框永久卡住（比直接退出更安全）。
                    api.prevent_close();
                    if tauri::Emitter::emit(app, tray::EVENT_CLOSE_REQUESTED, ()).is_err() {
                        log::warn!("关闭询问事件发送失败，退回最小化到托盘");
                        if let Err(err) = tray::hide_main_window(app) {
                            log::warn!("隐藏窗口失败: {err}");
                        }
                    }
                }
            }
        })
        .register_uri_scheme_protocol("epub", |app, request| {
            let state = app.app_handle().state::<state::AppState>();
            protocol::handle(&state, &request)
        })
        .invoke_handler(tauri::generate_handler![
            commands::book_open,
            commands::book_close,
            commands::book_section_html,
            commands::pick_epub,
            commands::pick_epubs,
            commands::library_import,
            commands::library_list,
            commands::library_remove,
            commands::library_open,
            commands::progress_get,
            commands::progress_save,
            commands::bookmark_add,
            commands::bookmark_list,
            commands::bookmark_remove,
            commands::bookmark_note_set,
            commands::book_search,
            commands::annotation_add,
            commands::annotation_list,
            commands::annotation_update,
            commands::annotation_remove,
            commands::annotation_export_markdown,
            commands::write_text_file,
            commands::reveal_data_dir,
            commands::font_import,
            commands::font_list,
            commands::font_remove,
            commands::close_policy_get,
            commands::close_policy_set,
            commands::hide_to_tray,
            commands::quit_app,
            commands::autostart_get,
            commands::autostart_set,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| report_startup_failure(&err));
}

#[cfg(test)]
mod tests {
    use super::migrate_legacy_data;
    use std::fs;
    use std::path::PathBuf;

    /// 与 library.rs 的测试保持一致：不用系统 TEMP（DSH 沙箱下不可写），
    /// 在 target/test-tmp 下建临时目录。
    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrates_legacy_dir_into_new_one() {
        let root = scratch("data-migrate");
        let legacy = root.join("com.alanview.epubreader");
        let target = root.join("Modu");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("modu.db"), b"library").unwrap();

        assert!(migrate_legacy_data(&legacy, &target).unwrap());
        assert!(!legacy.exists(), "旧目录应已被整体改名");
        assert_eq!(fs::read(target.join("modu.db")).unwrap(), b"library");
    }

    #[test]
    fn keeps_existing_target_and_leaves_legacy_alone() {
        let root = scratch("data-migrate-existing");
        let legacy = root.join("com.alanview.epubreader");
        let target = root.join("Modu");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("old.db"), b"old").unwrap();
        fs::write(target.join("new.db"), b"new").unwrap();

        // 新目录已有数据：不迁移，也不碰旧目录（旧目录可能仍有用户想找回的东西）。
        assert!(!migrate_legacy_data(&legacy, &target).unwrap());
        assert!(legacy.exists());
        assert_eq!(fs::read(target.join("new.db")).unwrap(), b"new");
    }

    #[test]
    fn no_legacy_means_nothing_to_do() {
        let root = scratch("data-migrate-none");
        let legacy = root.join("com.alanview.epubreader");
        let target = root.join("Modu");

        assert!(!migrate_legacy_data(&legacy, &target).unwrap());
        assert!(!target.exists());
    }
}
