mod logging;
mod plugin_runtime;
mod plugins;
mod sftp;
mod sftp_native;
mod sftp_path;
mod storage;
mod startup_tray;
mod terminal;
mod vault;
mod window_state;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::{webview::PageLoadEvent, Manager};
use terminal::TerminalState;

#[tauri::command]
fn local_os() -> &'static str {
    std::env::consts::OS
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let window_restored = Arc::new(AtomicBool::new(false));
    let page_loaded = Arc::new(AtomicBool::new(false));
    let load_window_restored = window_restored.clone();
    let load_page_loaded = page_loaded.clone();
    let setup_window_restored = window_restored.clone();
    let setup_page_loaded = page_loaded.clone();
    let startup_tray_state = startup_tray::StartupTrayState::default();
    let start_hidden = startup_tray::should_minimize_at_startup();
    let popout_counter = Arc::new(AtomicU64::new(0));

    tauri::Builder::default()
        .manage(TerminalState::default())
        .manage(plugin_runtime::PluginRuntimeState::default())
        .manage(sftp_native::PersistentSftpState::default())
        .manage(vault::VaultState::default())
        .manage(startup_tray_state.clone())
        .plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())
        .invoke_handler(tauri::generate_handler![
            storage::load_settings,
            storage::save_settings,
            storage::load_connections,
            storage::save_connections,
            storage::load_recent_activities,
            storage::save_recent_activities,
            storage::load_workspace,
            storage::save_workspace,
            storage::clear_workspace,
            plugins::plugin_install_from_folder,
            plugins::plugin_list,
            plugins::plugin_read_panel_html,
            plugins::plugin_set_enabled,
            plugins::plugin_remove,
            plugin_runtime::plugin_runtime_call,
            sftp::sftp_list,
            sftp::sftp_pick_upload_files,
            sftp::sftp_pick_download_folder,
            sftp::sftp_upload_many,
            sftp::sftp_download_many,
            sftp::sftp_download_entries,
            sftp::sftp_mkdir,
            sftp::sftp_rename_entry,
            sftp::sftp_move_entries,
            sftp::sftp_chmod_entries,
            sftp::sftp_delete_entries,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_default_download_path,
            sftp_native::sftp_native_list,
            sftp_native::sftp_native_mkdir,
            sftp_native::sftp_native_rename_entry,
            sftp_native::sftp_native_move_entries,
            sftp_native::sftp_native_chmod_entries,
            sftp_native::sftp_native_delete_entries,
            sftp_native::sftp_native_upload_many,
            sftp_native::sftp_native_download_entries,
            sftp_native::sftp_native_cancel_transfer,
            sftp_native::sftp_native_disconnect,
            vault::vault_status,
            vault::vault_initialize,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_store_secret,
            vault::vault_delete_secret,
            terminal::terminal_start,
            terminal::ssh_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            local_os,
            startup_tray::set_startup_enabled,
            startup_tray::startup_enabled,
            startup_tray::set_tray_visible,
            startup_tray::set_close_to_tray,
        ])
        .on_page_load(move |webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                load_page_loaded.store(true, Ordering::Release);
                if load_window_restored.load(Ordering::Acquire) {
                    if let Err(error) = webview.window().show() {
                        log::error!("Failed to show main window: {error}");
                    }
                }
            }
        })
        .setup(move |app| {
            let main_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or_else(|| std::io::Error::other("missing main window config"))?;
            let popout_app = app.handle().clone();
            let popout_counter = popout_counter.clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main_config)
                .map_err(std::io::Error::other)?
                .on_new_window(move |url, features| {
                    let sequence = popout_counter.fetch_add(1, Ordering::Relaxed) + 1;
                    let label = format!("panel-popout-{sequence}");
                    let builder = tauri::WebviewWindowBuilder::new(
                        &popout_app,
                        label,
                        tauri::WebviewUrl::External(
                            "about:blank".parse().expect("valid about:blank URL"),
                        ),
                    )
                    .window_features(features)
                    .title("RemoteHand Panel")
                    .on_document_title_changed(|window, title| {
                        let _ = window.set_title(&title);
                    });
                    match builder.build() {
                        Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                        Err(error) => {
                            log::error!("Failed to create panel popout for {url}: {error}");
                            tauri::webview::NewWindowResponse::Deny
                        }
                    }
                })
                .build()
                .map_err(std::io::Error::other)?;
            startup_tray::install(app, &startup_tray_state).map_err(std::io::Error::other)?;
            let saved = storage::load_settings().map_err(std::io::Error::other)?;
            startup_tray_state.set_close_to_tray(saved.minimize_to_tray_on_close);
            startup_tray_state.set_show_in_tray(app.handle(), saved.show_in_system_tray).map_err(std::io::Error::other)?;
            app.handle()
                .plugin(logging::builder().map_err(std::io::Error::other)?.build())?;
            if let Some(runtime) = app.try_state::<plugin_runtime::PluginRuntimeState>() {
                runtime
                    .set_app_handle(app.handle().clone())
                    .map_err(std::io::Error::other)?;
                if let Err(error) = plugins::start_enabled_plugins(&runtime) {
                    log::error!("Failed to restore enabled plugins: {error}");
                }
            }
            let tracker = window_state::WindowStateTracker::default();
            app.manage(tracker.clone());
            window_state::restore(app, &tracker).map_err(std::io::Error::other)?;
            setup_window_restored.store(true, Ordering::Release);
            if setup_page_loaded.load(Ordering::Acquire) && !start_hidden {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.show() {
                        log::error!("Failed to show main window: {error}");
                    }
                }
            }
            log::info!("RemoteHand started");
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let tray_state = window.state::<startup_tray::StartupTrayState>();
                if startup_tray::handle_close(window, &tray_state) {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
            }
            let tracker = window.state::<window_state::WindowStateTracker>();
            window_state::handle_event(&tracker, window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
