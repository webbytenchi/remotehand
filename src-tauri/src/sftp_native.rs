use crate::sftp::{
    SftpEntry, SftpListing, SftpRemoteItem, SftpTransferItem, SftpTransferProgress,
    SftpTransferResult,
};
use russh::{client, Disconnect};
use russh_sftp::client::SftpSession;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs::File as TokioFile,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
const TRANSFER_CHUNK_SIZE: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
#[derive(Default)]
pub struct PersistentSftpState {
    sessions: Mutex<HashMap<String, Arc<Mutex<NativeSession>>>>,
    transfers: StdMutex<HashMap<String, Arc<AtomicBool>>>,
}
struct NativeSession {
    host: String,
    port: u16,
    user: String,
    ssh: client::Handle<HostVerifier>,
    sftp: SftpSession,
}
#[derive(Clone)]
struct HostVerifier {
    host: String,
    port: u16,
}
#[derive(Debug)]
enum SshClientError {
    Russh(russh::Error),
    HostKey(String),
}
impl From<russh::Error> for SshClientError {
    fn from(value: russh::Error) -> Self {
        Self::Russh(value)
    }
}
impl std::fmt::Display for SshClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Russh(error) => write!(formatter, "{error}"),
            Self::HostKey(message) => formatter.write_str(message),
        }
    }
}
impl std::error::Error for SshClientError {}
#[async_trait::async_trait]
impl client::Handler for HostVerifier {
    type Error = SshClientError;
    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => Err(SshClientError::HostKey(format!(
                "SSH host key for {}:{} is not trusted in ~/.ssh/known_hosts",
                self.host, self.port
            ))),
            Err(error) => Err(SshClientError::HostKey(format!(
                "SSH host key verification failed for {}:{}: {error}",
                self.host, self.port
            ))),
        }
    }
}
fn map_sftp_error(activity: &str, error: impl std::fmt::Display) -> String {
    format!("SFTP {activity} failed: {error}")
}
async fn connect_native(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<NativeSession, String> {
    let host = host.trim();
    let user = user.trim();
    if host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if user.is_empty() {
        return Err("SFTP user is required".to_string());
    }
    let config = Arc::new(client::Config::default());
    let verifier = HostVerifier {
        host: host.to_string(),
        port: port.max(1),
    };
    let mut ssh = client::connect(config, (host, port.max(1)), verifier)
        .await
        .map_err(|error| format!("SFTP connection failed: {error}"))?;
    let auth = ssh
        .authenticate_password(user, password)
        .await
        .map_err(|error| format!("SFTP authentication failed: {error}"))?;
    if !auth {
        return Err("SFTP authentication failed: password was rejected".to_string());
    }
    let channel = ssh
        .channel_open_session()
        .await
        .map_err(|error| format!("SFTP channel failed: {error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("SFTP subsystem failed: {error}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| map_sftp_error("initialization", error))?;
    Ok(NativeSession {
        host: host.to_string(),
        port: port.max(1),
        user: user.to_string(),
        ssh,
        sftp,
    })
}
async fn session_for(
    state: &PersistentSftpState,
    session_id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<Arc<Mutex<NativeSession>>, String> {
    if session_id.trim().is_empty() {
        return Err("SFTP session id is required".to_string());
    }
    let existing = {
        let sessions = state.sessions.lock().await;
        sessions.get(session_id).cloned()
    };
    if let Some(existing) = existing {
        let reusable = {
            let session = existing.lock().await;
            session.host == host.trim()
                && session.port == port.max(1)
                && session.user == user.trim()
                && !session.ssh.is_closed()
        };
        if reusable {
            return Ok(existing);
        }
        let mut sessions = state.sessions.lock().await;
        sessions.remove(session_id);
    }
    let connected = Arc::new(Mutex::new(
        connect_native(host, port, user, password).await?,
    ));
    state
        .sessions
        .lock()
        .await
        .insert(session_id.to_string(), connected.clone());
    log::info!("Persistent SFTP session connected");
    Ok(connected)
}
fn permission_string(metadata: &russh_sftp::client::fs::Metadata) -> String {
    let kind = if metadata.is_dir() {
        'd'
    } else if metadata.is_symlink() {
        'l'
    } else {
        '-'
    };
    format!("{kind}{}", metadata.permissions())
}
fn join_remote_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}
pub async fn list(
    state: &PersistentSftpState,
    session_id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    path: &str,
) -> Result<SftpListing, String> {
    let session = session_for(state, session_id, host, port, user, password).await?;
    let session = session.lock().await;
    let requested = if path.trim().is_empty() {
        "."
    } else {
        path.trim()
    };
    let current_path = session
        .sftp
        .canonicalize(requested)
        .await
        .map_err(|error| map_sftp_error("listing", error))?;
    let read_dir = session
        .sftp
        .read_dir(current_path.clone())
        .await
        .map_err(|error| map_sftp_error("listing", error))?;
    let mut entries = read_dir
        .map(|entry| {
            let name = entry.file_name();
            let metadata = entry.metadata();
            SftpEntry {
                path: join_remote_path(&current_path, &name),
                name,
                is_dir: metadata.is_dir(),
                size: metadata.len(),
                permissions: permission_string(&metadata),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(SftpListing {
        path: current_path,
        entries,
    })
}
fn register_transfer(
    state: &PersistentSftpState,
    transfer_id: &str,
) -> Result<Arc<AtomicBool>, String> {
    let mut transfers = state
        .transfers
        .lock()
        .map_err(|_| "SFTP transfer state is unavailable".to_string())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    transfers.insert(transfer_id.to_string(), cancelled.clone());
    Ok(cancelled)
}
fn finish_transfer(state: &PersistentSftpState, transfer_id: &str) {
    if let Ok(mut transfers) = state.transfers.lock() {
        transfers.remove(transfer_id);
    }
}
pub fn cancel_transfer(state: &PersistentSftpState, transfer_id: &str) -> Result<bool, String> {
    let transfers = state
        .transfers
        .lock()
        .map_err(|_| "SFTP transfer state is unavailable".to_string())?;
    if let Some(cancelled) = transfers.get(transfer_id) {
        cancelled.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}
pub async fn disconnect(state: &PersistentSftpState, session_id: &str) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(session_id);
    if let Some(session) = session {
        let session = session.lock().await;
        let _ = session.sftp.close().await;
        let _ = session
            .ssh
            .disconnect(
                Disconnect::ByApplication,
                "RemoteHand SFTP panel closed",
                "",
            )
            .await;
        log::info!("Persistent SFTP session disconnected");
    }
    Ok(())
}
fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    direction: &str,
    path: &str,
    completed_files: usize,
    total_files: usize,
    total_folders: usize,
    transferred_bytes: u64,
    total_bytes: u64,
) {
    let _ = app.emit(
        "sftp-transfer-progress",
        SftpTransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: direction.to_string(),
            path: path.to_string(),
            completed_files,
            total_files,
            total_folders,
            transferred_bytes: transferred_bytes.min(total_bytes),
            total_bytes,
        },
    );
}
async fn rollback_remote_files(sftp: &SftpSession, files: &[String]) {
    for path in files.iter().rev() {
        let _ = sftp.remove_file(path.clone()).await;
    }
}
async fn cleanup_download(
    completed_files: &[PathBuf],
    created_directories: &[PathBuf],
    partial: Option<&Path>,
) {
    if let Some(partial) = partial {
        let _ = tokio::fs::remove_file(partial).await;
    }
    for path in completed_files.iter().rev() {
        let _ = tokio::fs::remove_file(path).await;
    }
    for path in created_directories.iter().rev() {
        let _ = tokio::fs::remove_dir(path).await;
    }
}
pub async fn upload_many(
    state: &PersistentSftpState,
    app: &AppHandle,
    session_id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    transfer_id: &str,
    items: &[SftpTransferItem],
) -> Result<SftpTransferResult, String> {
    if items.is_empty() {
        return Err("at least one upload file is required".to_string());
    }
    let mut plan = Vec::with_capacity(items.len());
    for item in items {
        if item.local_path.trim().is_empty() || item.remote_path.trim().is_empty() {
            return Err("upload paths cannot be empty".to_string());
        }
        let metadata = tokio::fs::metadata(item.local_path.trim())
            .await
            .map_err(|error| format!("failed to inspect upload file: {error}"))?;
        if !metadata.is_file() {
            return Err("one or more local source files do not exist".to_string());
        }
        plan.push((item.remote_path.trim().to_string(), metadata.len()));
    }
    let total_bytes = plan.iter().map(|(_, size)| *size).sum::<u64>();
    let session = session_for(state, session_id, host, port, user, password).await?;
    let cancelled = register_transfer(state, transfer_id)?;
    let mut transferred_bytes = 0u64;
    let mut completed_files = 0usize;
    let mut completed_remote = Vec::<String>::new();
    let mut current_temp: Option<String> = None;
    let result = async {
        let session = session.lock().await;
        for item in items {
            if cancelled.load(Ordering::SeqCst) {
                return Err("SFTP transfer cancelled".to_string());
            }
            let remote_path = item.remote_path.trim().to_string();
            if session
                .sftp
                .try_exists(remote_path.clone())
                .await
                .map_err(|error| map_sftp_error("upload preflight", error))?
            {
                return Err(format!("remote destination already exists: {remote_path}"));
            }
            let temp_path = format!("{remote_path}.remotehand-{transfer_id}.part");
            current_temp = Some(temp_path.clone());
            let mut local = TokioFile::open(item.local_path.trim())
                .await
                .map_err(|error| format!("failed to open upload file: {error}"))?;
            let mut remote = session
                .sftp
                .create(temp_path.clone())
                .await
                .map_err(|error| map_sftp_error("upload", error))?;
            let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];
            let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
            loop {
                if cancelled.load(Ordering::SeqCst) {
                    let _ = remote.shutdown().await;
                    let _ = session.sftp.remove_file(temp_path.clone()).await;
                    rollback_remote_files(&session.sftp, &completed_remote).await;
                    return Err("SFTP transfer cancelled".to_string());
                }
                let read = local
                    .read(&mut buffer)
                    .await
                    .map_err(|error| format!("failed to read upload file: {error}"))?;
                if read == 0 {
                    break;
                }
                remote
                    .write_all(&buffer[..read])
                    .await
                    .map_err(|error| map_sftp_error("upload", error))?;
                transferred_bytes = transferred_bytes.saturating_add(read as u64);
                if last_emit.elapsed() >= PROGRESS_INTERVAL {
                    emit_progress(
                        app,
                        transfer_id,
                        "upload",
                        &remote_path,
                        completed_files,
                        items.len(),
                        0,
                        transferred_bytes,
                        total_bytes,
                    );
                    last_emit = Instant::now();
                }
            }
            remote
                .shutdown()
                .await
                .map_err(|error| map_sftp_error("upload", error))?;
            session
                .sftp
                .rename(temp_path.clone(), remote_path.clone())
                .await
                .map_err(|error| map_sftp_error("upload finalize", error))?;
            current_temp = None;
            completed_remote.push(remote_path.clone());
            completed_files += 1;
            emit_progress(
                app,
                transfer_id,
                "upload",
                &remote_path,
                completed_files,
                items.len(),
                0,
                transferred_bytes,
                total_bytes,
            );
        }
        Ok(SftpTransferResult {
            items: items.len(),
            files: items.len(),
            folders: 0,
            bytes: total_bytes,
        })
    }
    .await;
    if result.is_err() {
        let session = session.lock().await;
        if let Some(temp) = current_temp.take() {
            let _ = session.sftp.remove_file(temp).await;
        }
        if !cancelled.load(Ordering::SeqCst) {
            rollback_remote_files(&session.sftp, &completed_remote).await;
        }
    }
    finish_transfer(state, transfer_id);
    result
}
async fn build_download_plan(
    sftp: &SftpSession,
    items: &[SftpRemoteItem],
    folder: &Path,
) -> Result<(Vec<(String, PathBuf, u64)>, Vec<PathBuf>), String> {
    let mut files = Vec::<(String, PathBuf, u64)>::new();
    let mut directories = Vec::<PathBuf>::new();
    let mut stack = Vec::<(String, PathBuf)>::new();
    for item in items {
        let destination = folder.join(item.name.trim());
        if destination.exists() {
            return Err(format!(
                "local destination already exists: {}",
                destination.to_string_lossy()
            ));
        }
        if item.is_dir {
            directories.push(destination.clone());
            stack.push((item.path.trim().to_string(), destination));
        } else {
            files.push((item.path.trim().to_string(), destination, item.size));
        }
    }
    while let Some((remote_dir, local_dir)) = stack.pop() {
        let entries = sftp
            .read_dir(remote_dir.clone())
            .await
            .map_err(|error| map_sftp_error("download scan", error))?;
        for entry in entries {
            let name = entry.file_name();
            let metadata = entry.metadata();
            let remote_path = join_remote_path(&remote_dir, &name);
            let local_path = local_dir.join(&name);
            if metadata.is_dir() {
                directories.push(local_path.clone());
                stack.push((remote_path, local_path));
            } else {
                files.push((remote_path, local_path, metadata.len()));
            }
        }
    }
    Ok((files, directories))
}
fn partial_download_path(destination: &Path, transfer_id: &str) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    destination.with_file_name(format!(".{file_name}.remotehand-{transfer_id}.part"))
}
pub async fn download_entries(
    state: &PersistentSftpState,
    app: &AppHandle,
    session_id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    transfer_id: &str,
    folder: &str,
    items: &[SftpRemoteItem],
) -> Result<SftpTransferResult, String> {
    if items.is_empty() {
        return Err("at least one remote item is required".to_string());
    }
    if folder.trim().is_empty() {
        return Err("local destination folder is required".to_string());
    }
    let session = session_for(state, session_id, host, port, user, password).await?;
    let cancelled = register_transfer(state, transfer_id)?;
    let folder_path = PathBuf::from(folder.trim());
    let result = async {
        let session = session.lock().await;
        let (files, directories) = build_download_plan(&session.sftp, items, &folder_path).await?;
        let total_folders = directories.len();
        let total_bytes = files.iter().map(|(_, _, size)| *size).sum::<u64>();
        let initial_path = files
            .first()
            .map(|(remote, _, _)| remote.as_str())
            .unwrap_or_default();
        emit_progress(
            app,
            transfer_id,
            "download",
            initial_path,
            0,
            files.len(),
            total_folders,
            0,
            total_bytes,
        );
        let mut created_directories = Vec::<PathBuf>::new();
        for directory in &directories {
            if cancelled.load(Ordering::SeqCst) {
                cleanup_download(&[], &created_directories, None).await;
                return Err("SFTP transfer cancelled".to_string());
            }
            tokio::fs::create_dir(directory).await.map_err(|error| {
                format!(
                    "failed to create download directory {}: {error}",
                    directory.to_string_lossy()
                )
            })?;
            created_directories.push(directory.clone());
        }
        let mut transferred_bytes = 0u64;
        let mut completed_files = 0usize;
        let mut completed_local = Vec::<PathBuf>::new();
        for (remote_path, local_path, _) in &files {
            if cancelled.load(Ordering::SeqCst) {
                cleanup_download(&completed_local, &created_directories, None).await;
                return Err("SFTP transfer cancelled".to_string());
            }
            if local_path.exists() {
                cleanup_download(&completed_local, &created_directories, None).await;
                return Err(format!(
                    "local destination already exists: {}",
                    local_path.to_string_lossy()
                ));
            }
            let partial = partial_download_path(local_path, transfer_id);
            let mut remote = session
                .sftp
                .open(remote_path.clone())
                .await
                .map_err(|error| map_sftp_error("download", error))?;
            let mut local = TokioFile::create(&partial)
                .await
                .map_err(|error| format!("failed to create download file: {error}"))?;
            let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];
            let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
            loop {
                if cancelled.load(Ordering::SeqCst) {
                    cleanup_download(&completed_local, &created_directories, Some(&partial)).await;
                    return Err("SFTP transfer cancelled".to_string());
                }
                let read = remote
                    .read(&mut buffer)
                    .await
                    .map_err(|error| map_sftp_error("download", error))?;
                if read == 0 {
                    break;
                }
                local
                    .write_all(&buffer[..read])
                    .await
                    .map_err(|error| format!("failed to write download file: {error}"))?;
                transferred_bytes = transferred_bytes.saturating_add(read as u64);
                if last_emit.elapsed() >= PROGRESS_INTERVAL {
                    emit_progress(
                        app,
                        transfer_id,
                        "download",
                        remote_path,
                        completed_files,
                        files.len(),
                        total_folders,
                        transferred_bytes,
                        total_bytes,
                    );
                    last_emit = Instant::now();
                }
            }
            local
                .flush()
                .await
                .map_err(|error| format!("failed to flush download file: {error}"))?;
            drop(local);
            tokio::fs::rename(&partial, local_path)
                .await
                .map_err(|error| format!("failed to finalize download file: {error}"))?;
            completed_local.push(local_path.clone());
            completed_files += 1;
            emit_progress(
                app,
                transfer_id,
                "download",
                remote_path,
                completed_files,
                files.len(),
                total_folders,
                transferred_bytes,
                total_bytes,
            );
        }
        Ok(SftpTransferResult {
            items: items.len(),
            files: files.len(),
            folders: total_folders,
            bytes: total_bytes,
        })
    }
    .await;
    finish_transfer(state, transfer_id);
    result
}
fn password_from_vault(
    vault_state: &crate::vault::VaultState,
    credential_ref: &str,
) -> Result<String, String> {
    crate::vault::get_secret(vault_state, credential_ref)?
        .ok_or_else(|| "saved SFTP credential was not found".to_string())
}

#[tauri::command]
pub async fn sftp_native_list(
    session_id: String,
    host: String,
    port: u16,
    user: String,
    path: String,
    credential_ref: String,
    state: tauri::State<'_, PersistentSftpState>,
    vault_state: tauri::State<'_, crate::vault::VaultState>,
) -> Result<SftpListing, String> {
    let password = password_from_vault(&vault_state, &credential_ref)?;
    let result = list(&state, &session_id, &host, port, &user, &password, &path).await;
    if result.is_err() {
        state.sessions.lock().await.remove(&session_id);
    }
    result
}

#[tauri::command]
pub async fn sftp_native_upload_many(
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    user: String,
    items: Vec<SftpTransferItem>,
    credential_ref: String,
    transfer_id: String,
    state: tauri::State<'_, PersistentSftpState>,
    vault_state: tauri::State<'_, crate::vault::VaultState>,
) -> Result<SftpTransferResult, String> {
    let password = password_from_vault(&vault_state, &credential_ref)?;
    let result = upload_many(
        &state,
        &app,
        &session_id,
        &host,
        port,
        &user,
        &password,
        &transfer_id,
        &items,
    )
    .await;
    if result.is_err()
        && !matches!(result.as_ref(), Err(message) if message == "SFTP transfer cancelled")
    {
        state.sessions.lock().await.remove(&session_id);
    }
    result
}

#[tauri::command]
pub async fn sftp_native_download_entries(
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    user: String,
    folder: String,
    items: Vec<SftpRemoteItem>,
    credential_ref: String,
    transfer_id: String,
    state: tauri::State<'_, PersistentSftpState>,
    vault_state: tauri::State<'_, crate::vault::VaultState>,
) -> Result<SftpTransferResult, String> {
    let password = password_from_vault(&vault_state, &credential_ref)?;
    let result = download_entries(
        &state,
        &app,
        &session_id,
        &host,
        port,
        &user,
        &password,
        &transfer_id,
        &folder,
        &items,
    )
    .await;
    if result.is_err()
        && !matches!(result.as_ref(), Err(message) if message == "SFTP transfer cancelled")
    {
        state.sessions.lock().await.remove(&session_id);
    }
    result
}

#[tauri::command]
pub fn sftp_native_cancel_transfer(
    transfer_id: String,
    state: tauri::State<'_, PersistentSftpState>,
) -> Result<bool, String> {
    cancel_transfer(&state, &transfer_id)
}

#[tauri::command]
pub async fn sftp_native_disconnect(
    session_id: String,
    state: tauri::State<'_, PersistentSftpState>,
) -> Result<(), String> {
    disconnect(&state, &session_id).await
}
