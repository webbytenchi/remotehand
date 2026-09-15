mod logging;
mod plugins;
mod sftp;
mod sftp_native;
mod sftp_path;
mod storage;
mod terminal;
mod vault;
mod window_state;
use std::sync::{
    atomic::{AtomicBool, Ordering},
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

    tauri::Builder::default()
        .manage(TerminalState::default())
        .manage(sftp_native::PersistentSftpState::default())
        .manage(vault::VaultState::default())
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
            plugins::plugin_set_enabled,
            plugins::plugin_remove,
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
            app.handle()
                .plugin(logging::builder().map_err(std::io::Error::other)?.build())?;
            let tracker = window_state::WindowStateTracker::default();
            app.manage(tracker.clone());
            window_state::restore(app, &tracker).map_err(std::io::Error::other)?;
            setup_window_restored.store(true, Ordering::Release);
            if setup_page_loaded.load(Ordering::Acquire) {
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
            let tracker = window.state::<window_state::WindowStateTracker>();
            window_state::handle_event(&tracker, window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
