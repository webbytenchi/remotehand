mod logging;
mod sftp;
mod storage;
mod terminal;
mod vault;

use terminal::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TerminalState::default())
        .manage(vault::VaultState::default())
        .invoke_handler(tauri::generate_handler![
            storage::load_settings,
            storage::save_settings,
            storage::load_connections,
            storage::save_connections,
            storage::load_workspace,
            storage::save_workspace,
            storage::clear_workspace,
            sftp::sftp_list,
            sftp::sftp_pick_upload_files,
            sftp::sftp_pick_download_folder,
            sftp::sftp_upload_many,
            sftp::sftp_download_many,
            sftp::sftp_download_entries,
            sftp::sftp_move_entries,
            sftp::sftp_chmod_entries,
            sftp::sftp_delete_entries,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_default_download_path,
            vault::vault_status,
            vault::vault_initialize,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_store_secret,
            vault::vault_get_secret,
            vault::vault_delete_secret,
            terminal::terminal_start,
            terminal::ssh_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
        ])
        .setup(|app| {
            app.handle()
                .plugin(logging::builder().map_err(std::io::Error::other)?.build())?;
            log::info!("RemoteHand started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
