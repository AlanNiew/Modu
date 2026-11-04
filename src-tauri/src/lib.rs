mod commands;
mod db;
mod epub;
mod error;
mod library;
mod protocol;
mod state;

use tauri::Manager;

/// 应用数据目录。
///
/// 默认 `%APPDATA%\com.alanview.epubreader`（Windows）。支持 `MODU_DATA_DIR`
/// 覆盖，用于便携模式、测试环境和受控沙箱（GUI 子进程可能没有 %APPDATA% 写权限）。
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    if let Some(custom) = std::env::var_os("MODU_DATA_DIR") {
        let path = std::path::PathBuf::from(custom);
        if path.as_os_str().is_empty() {
            return Err("MODU_DATA_DIR 不能为空".into());
        }
        return Ok(path);
    }
    Ok(app.path().app_data_dir()?)
}

/// 首次启动时创建数据目录并打开数据库；失败则直接报错——没有书架就无法工作。
fn init_state(app: &tauri::AppHandle) -> Result<state::AppState, Box<dyn std::error::Error>> {
    let base = data_dir(app)?;
    std::fs::create_dir_all(&base)?;
    let (db_path, covers_dir) = library::data_layout(&base);
    std::fs::create_dir_all(&covers_dir)?;
    let db = db::Db::open(&db_path)?;
    log::info!("数据目录: {}", base.display());
    Ok(state::AppState::new(db, covers_dir))
}

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // 开发构建只写 stdout：DSH 沙箱不允许子进程写 %LOCALAPPDATA%，
    // 而 tauri-plugin-log 的 LogDir target 初始化失败会直接让 App 启动失败。
    let builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Info)
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ));
    #[cfg(not(debug_assertions))]
    let builder = builder.target(tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::LogDir {
            file_name: Some("modu".into()),
        },
    ));
    builder.build()
}

pub fn run() {
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
        .setup(|app| {
            let state = init_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .register_uri_scheme_protocol("epub", |app, request| {
            let state = app.app_handle().state::<state::AppState>();
            protocol::handle(&state, &request)
        })
        .invoke_handler(tauri::generate_handler![
            commands::book_open,
            commands::book_close,
            commands::book_section_html,
            commands::book_read_text,
            commands::book_list,
            commands::pick_epub,
            commands::pick_epubs,
            commands::library_import,
            commands::library_list,
            commands::library_remove,
            commands::library_open,
            commands::library_books,
            commands::progress_get,
            commands::progress_save,
            commands::bookmark_add,
            commands::bookmark_list,
            commands::bookmark_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
