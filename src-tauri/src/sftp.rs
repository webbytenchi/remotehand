use crate::sftp_path::safe_local_child;
use crate::vault::{self, VaultState};
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{Read, Write},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) size: u64,
    pub(crate) permissions: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpTransferItem {
    pub(crate) local_path: String,
    pub(crate) remote_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpRemoteItem {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) is_dir: bool,
    #[serde(default)]
    pub(crate) size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpListing {
    pub(crate) path: String,
    pub(crate) entries: Vec<SftpEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpTransferProgress {
    pub(crate) transfer_id: String,
    pub(crate) direction: String,
    pub(crate) path: String,
    pub(crate) completed_files: usize,
    pub(crate) total_files: usize,
    pub(crate) total_folders: usize,
    pub(crate) transferred_bytes: u64,
    pub(crate) total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SftpTransferResult {
    pub(crate) items: usize,
    pub(crate) files: usize,
    pub(crate) folders: usize,
    pub(crate) bytes: u64,
}

#[derive(Clone, Debug)]
struct SftpTransferPlanItem {
    path: String,
    size: u64,
}

fn quote_batch_path(path: &str) -> Result<String, String> {
    if path.contains('\n') || path.contains('\r') {
        return Err("remote path contains unsupported characters".to_string());
    }
    Ok(format!(
        "\"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn join_remote_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn parse_listing_line(line: &str, base: &str) -> Option<SftpEntry> {
    let mut parts = line.split_whitespace();
    let permissions = parts.next()?.to_string();
    let first = permissions.chars().next()?;
    if first != 'd' && first != '-' && first != 'l' {
        return None;
    }

    parts.next()?;
    parts.next()?;
    parts.next()?;
    let size = parts.next()?.parse::<u64>().unwrap_or(0);
    parts.next()?;
    parts.next()?;
    parts.next()?;

    let raw_name = parts.collect::<Vec<_>>().join(" ");
    if raw_name.is_empty() || raw_name == "." || raw_name == ".." {
        return None;
    }

    let name = if first == 'l' {
        raw_name
            .split_once(" -> ")
            .map(|(name, _)| name.to_string())
            .unwrap_or(raw_name)
    } else {
        raw_name
    };

    Some(SftpEntry {
        path: join_remote_path(base, &name),
        name,
        is_dir: first == 'd',
        size,
        permissions,
    })
}

fn password_for_credential(
    vault_state: &State<'_, VaultState>,
    credential_ref: Option<&str>,
) -> Result<Option<String>, String> {
    credential_ref
        .filter(|value| !value.trim().is_empty())
        .map(|credential_ref| vault::get_secret(vault_state, credential_ref))
        .transpose()
        .map(|value| value.flatten())
}

fn transfer_percent_from_record(record: &str) -> Option<u64> {
    record.split_whitespace().find_map(|token| {
        token
            .strip_suffix('%')
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value <= 100)
    })
}

fn forward_sftp_records<R: Read>(
    mut reader: R,
    is_stderr: bool,
    sender: std::sync::mpsc::Sender<(bool, String)>,
) {
    let mut buffer = [0u8; 4096];
    let mut pending = Vec::new();
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        for byte in &buffer[..read] {
            if *byte == b'\r' || *byte == b'\n' {
                if !pending.is_empty() {
                    let record = String::from_utf8_lossy(&pending).into_owned();
                    if sender.send((is_stderr, record)).is_err() {
                        return;
                    }
                    pending.clear();
                }
            } else {
                pending.push(*byte);
            }
        }
    }
    if !pending.is_empty() {
        let _ = sender.send((is_stderr, String::from_utf8_lossy(&pending).into_owned()));
    }
}

fn emit_transfer_progress(
    app: &AppHandle,
    transfer_id: &str,
    direction: &str,
    plan: &[SftpTransferPlanItem],
    total_folders: usize,
    completed_files: usize,
    transferred_bytes: u64,
) {
    let total_bytes: u64 = plan.iter().map(|item| item.size).sum();
    let path = if completed_files < plan.len() {
        plan[completed_files].path.clone()
    } else {
        plan.last()
            .map(|item| item.path.clone())
            .unwrap_or_default()
    };
    let _ = app.emit(
        "sftp-transfer-progress",
        SftpTransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: direction.to_string(),
            path,
            completed_files,
            total_files: plan.len(),
            total_folders,
            transferred_bytes: transferred_bytes.min(total_bytes),
            total_bytes,
        },
    );
}

fn run_sftp_transfer_stream(
    app: AppHandle,
    transfer_id: String,
    direction: &str,
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    batch: String,
    plan: Vec<SftpTransferPlanItem>,
    total_folders: usize,
) -> Result<(), String> {
    let host = host.trim();
    let user = user.trim();
    if host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if user.is_empty() {
        return Err("SFTP user is required".to_string());
    }

    emit_transfer_progress(&app, &transfer_id, direction, &plan, total_folders, 0, 0);

    let mut command = Command::new("sftp");
    command
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-P")
        .arg(port.max(1).to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(password) = password {
        let askpass = env::current_exe().map_err(|error| error.to_string())?;
        command
            .arg("-o")
            .arg("BatchMode=no")
            .arg("-o")
            .arg("PreferredAuthentications=password")
            .arg("-o")
            .arg("NumberOfPasswordPrompts=1")
            .env("SSH_ASKPASS", askpass)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "remotehand")
            .env("REMOTEHAND_ASKPASS", "1")
            .env("REMOTEHAND_ASKPASS_SECRET", password);
    } else {
        command.arg("-b").arg("-").arg("-o").arg("BatchMode=yes");
    }

    command.arg(format!("{user}@{host}"));

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start sftp: {error}"))?;

    child
        .stdin
        .take()
        .ok_or_else(|| "failed to open sftp input".to_string())?
        .write_all(batch.as_bytes())
        .map_err(|error| format!("failed to send sftp command: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to read sftp output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to read sftp errors".to_string())?;

    let (record_tx, record_rx) = std::sync::mpsc::channel::<(bool, String)>();
    let stdout_tx = record_tx.clone();
    let stdout_thread = std::thread::spawn(move || {
        forward_sftp_records(stdout, false, stdout_tx);
    });
    let stderr_thread = std::thread::spawn(move || {
        forward_sftp_records(stderr, true, record_tx);
    });

    let mut completed_files = 0usize;
    let mut completed_bytes = 0u64;
    let mut last_percent = None;
    let mut stderr_text = String::new();

    for (is_stderr, record) in record_rx {
        let percent = transfer_percent_from_record(&record);
        if is_stderr && percent.is_none() {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&record);
        }

        if let Some(percent) = percent {
            if last_percent != Some(percent) {
                if let Some(current) = plan.get(completed_files) {
                    let current_bytes = current.size.saturating_mul(percent).saturating_div(100);
                    emit_transfer_progress(
                        &app,
                        &transfer_id,
                        direction,
                        &plan,
                        total_folders,
                        completed_files,
                        completed_bytes.saturating_add(current_bytes),
                    );
                }
                last_percent = Some(percent);
            }
        }
        if !is_stderr
            && record.contains("Remote working directory:")
            && completed_files < plan.len()
        {
            completed_bytes = completed_bytes.saturating_add(plan[completed_files].size);
            completed_files += 1;
            last_percent = None;
            emit_transfer_progress(
                &app,
                &transfer_id,
                direction,
                &plan,
                total_folders,
                completed_files,
                completed_bytes,
            );
        }
    }

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for sftp: {error}"))?;

    if !status.success() {
        let message = stderr_text.trim();
        return Err(if message.is_empty() {
            format!("SFTP {direction} failed")
        } else {
            format!("SFTP {direction} failed: {message}")
        });
    }

    if completed_files != plan.len() {
        return Err(format!(
            "SFTP {direction} finished without confirming every file ({completed_files}/{})",
            plan.len()
        ));
    }

    Ok(())
}

fn run_sftp_batch(
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    batch: String,
    activity: &str,
) -> Result<String, String> {
    let host = host.trim();
    let user = user.trim();

    if host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if user.is_empty() {
        return Err("SFTP user is required".to_string());
    }

    let mut command = Command::new("sftp");
    command
        .arg("-q")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-P")
        .arg(port.max(1).to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(password) = password {
        let askpass = env::current_exe().map_err(|error| error.to_string())?;
        command
            .arg("-o")
            .arg("BatchMode=no")
            .arg("-o")
            .arg("PreferredAuthentications=password")
            .arg("-o")
            .arg("NumberOfPasswordPrompts=1")
            .env("SSH_ASKPASS", askpass)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "remotehand")
            .env("REMOTEHAND_ASKPASS", "1")
            .env("REMOTEHAND_ASKPASS_SECRET", password);
    } else {
        command.arg("-b").arg("-").arg("-o").arg("BatchMode=yes");
    }

    command.arg(format!("{user}@{host}"));

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start sftp: {error}"))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| "failed to open sftp input".to_string())?
        .write_all(batch.as_bytes())
        .map_err(|error| format!("failed to send sftp command: {error}"))?;

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to wait for sftp: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            format!("SFTP {activity} failed")
        } else {
            format!("SFTP {activity} failed: {message}")
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn sftp_list(
    host: String,
    port: u16,
    user: String,
    path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<SftpListing, String> {
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;

    tauri::async_runtime::spawn_blocking(move || run_sftp_list(host, port, user, path, password))
        .await
        .map_err(|error| format!("SFTP task failed: {error}"))?
}

fn run_sftp_list(
    host: String,
    port: u16,
    user: String,
    path: String,
    password: Option<String>,
) -> Result<SftpListing, String> {
    let host = host.trim();
    let user = user.trim();
    let requested_path = if path.trim().is_empty() {
        "."
    } else {
        path.trim()
    };

    if host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if user.is_empty() {
        return Err("SFTP user is required".to_string());
    }

    let quoted_path = quote_batch_path(requested_path)?;

    let mut command = Command::new("sftp");
    command
        .arg("-q")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-P")
        .arg(port.max(1).to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(password) = password {
        let askpass = env::current_exe().map_err(|error| error.to_string())?;
        command
            .arg("-o")
            .arg("BatchMode=no")
            .arg("-o")
            .arg("PreferredAuthentications=password")
            .arg("-o")
            .arg("NumberOfPasswordPrompts=1")
            .env("SSH_ASKPASS", askpass)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "remotehand")
            .env("REMOTEHAND_ASKPASS", "1")
            .env("REMOTEHAND_ASKPASS_SECRET", password);
    } else {
        command.arg("-b").arg("-");
        command.arg("-o").arg("BatchMode=yes");
    }

    command.arg(format!("{user}@{host}"));

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start sftp: {error}"))?;

    let batch = format!("cd {quoted_path}\npwd\nls -la\n");
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "failed to open sftp input".to_string())?
        .write_all(batch.as_bytes())
        .map_err(|error| format!("failed to send sftp command: {error}"))?;

    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to wait for sftp: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            "SFTP connection failed".to_string()
        } else {
            format!("SFTP connection failed: {message}")
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let current_path = stdout
        .lines()
        .find_map(|line| line.strip_prefix("Remote working directory: "))
        .unwrap_or(requested_path)
        .trim()
        .to_string();

    let mut entries = stdout
        .lines()
        .filter_map(|line| parse_listing_line(line, &current_path))
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    log::info!("SFTP directory listed");
    Ok(SftpListing {
        path: current_path,
        entries,
    })
}

#[tauri::command]
pub async fn sftp_pick_upload_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .set_title("Select files to upload")
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|error| format!("File picker failed: {error}"))?
}
#[tauri::command]
pub async fn sftp_pick_download_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .set_title("Choose download folder")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("Folder picker failed: {error}"))?
}
#[tauri::command]
pub async fn sftp_upload_many(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    items: Vec<SftpTransferItem>,
    credential_ref: Option<String>,
    transfer_id: String,
    vault_state: State<'_, VaultState>,
) -> Result<SftpTransferResult, String> {
    if items.is_empty() {
        return Err("at least one upload file is required".to_string());
    }

    let mut plan = Vec::with_capacity(items.len());
    for item in &items {
        if item.local_path.trim().is_empty() || item.remote_path.trim().is_empty() {
            return Err("upload paths cannot be empty".to_string());
        }
        let metadata = std::fs::metadata(item.local_path.trim())
            .map_err(|error| format!("failed to inspect upload file: {error}"))?;
        if !metadata.is_file() {
            return Err("one or more local source files do not exist".to_string());
        }
        plan.push(SftpTransferPlanItem {
            path: item.remote_path.trim().to_string(),
            size: metadata.len(),
        });
    }

    let count = items.len();
    let total_bytes: u64 = plan.iter().map(|item| item.size).sum();
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut batch = String::new();
        for item in items {
            let local = quote_batch_path(item.local_path.trim())?;
            let remote = quote_batch_path(item.remote_path.trim())?;
            batch.push_str(&format!("put {local} {remote}\npwd\n"));
        }
        run_sftp_transfer_stream(
            app,
            transfer_id,
            "upload",
            host,
            port,
            user,
            password,
            batch,
            plan,
            0,
        )?;
        log::info!("SFTP upload batch completed");
        Ok(SftpTransferResult {
            items: count,
            files: count,
            folders: 0,
            bytes: total_bytes,
        })
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}
#[tauri::command]
pub async fn sftp_download_many(
    host: String,
    port: u16,
    user: String,
    items: Vec<SftpTransferItem>,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<usize, String> {
    if items.is_empty() {
        return Err("at least one download file is required".to_string());
    }
    for item in &items {
        if item.local_path.trim().is_empty() || item.remote_path.trim().is_empty() {
            return Err("download paths cannot be empty".to_string());
        }
        if std::path::Path::new(item.local_path.trim()).exists() {
            return Err("one or more local destinations already exist".to_string());
        }
    }

    let count = items.len();
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut batch = String::new();
        for item in items {
            let remote = quote_batch_path(item.remote_path.trim())?;
            let local = quote_batch_path(item.local_path.trim())?;
            batch.push_str(&format!("get {remote} {local}\n"));
        }
        run_sftp_batch(host, port, user, password, batch, "download")?;
        log::info!("SFTP download batch completed");
        Ok(count)
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

fn remote_directory_is_empty(
    host: String,
    port: u16,
    user: String,
    password: Option<String>,
    path: &str,
) -> Result<bool, String> {
    let quoted = quote_batch_path(path)?;
    let output = run_sftp_batch(
        host,
        port,
        user,
        password,
        format!("cd {quoted}\nls -la\n"),
        "directory check",
    )?;
    Ok(output
        .lines()
        .filter_map(|line| parse_listing_line(line, path))
        .next()
        .is_none())
}
fn collect_remote_download_plan(
    host: &str,
    port: u16,
    user: &str,
    password: &Option<String>,
    remote_path: &str,
    local_path: &std::path::Path,
    files: &mut Vec<(String, std::path::PathBuf, u64)>,
    directories: &mut Vec<std::path::PathBuf>,
) -> Result<(), String> {
    directories.push(local_path.to_path_buf());
    let listing = run_sftp_list(
        host.to_string(),
        port,
        user.to_string(),
        remote_path.to_string(),
        password.clone(),
    )?;
    for entry in listing.entries {
        let local_child = safe_local_child(local_path, &entry.name)?;
        if entry.is_dir {
            collect_remote_download_plan(
                host,
                port,
                user,
                password,
                &entry.path,
                &local_child,
                files,
                directories,
            )?;
        } else {
            files.push((entry.path, local_child, entry.size));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_download_entries(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    folder: String,
    items: Vec<SftpRemoteItem>,
    credential_ref: Option<String>,
    transfer_id: String,
    vault_state: State<'_, VaultState>,
) -> Result<SftpTransferResult, String> {
    if items.is_empty() {
        return Err("at least one remote item is required".to_string());
    }
    if folder.trim().is_empty() {
        return Err("local destination folder is required".to_string());
    }

    let folder_path = std::path::PathBuf::from(folder.trim());
    let mut destinations = Vec::with_capacity(items.len());
    for item in &items {
        let destination = safe_local_child(&folder_path, &item.name)?;
        if destination.exists() {
            return Err(format!(
                "local destination already exists: {}",
                destination.to_string_lossy()
            ));
        }
        destinations.push(destination);
    }

    let selected_items = items.len();
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::<(String, std::path::PathBuf, u64)>::new();
        let mut directories = Vec::<std::path::PathBuf>::new();

        for (item, destination) in items.iter().zip(destinations.iter()) {
            if item.is_dir {
                collect_remote_download_plan(
                    &host,
                    port,
                    &user,
                    &password,
                    item.path.trim(),
                    destination,
                    &mut files,
                    &mut directories,
                )?;
            } else {
                files.push((item.path.trim().to_string(), destination.clone(), item.size));
            }
        }

        for directory in &directories {
            std::fs::create_dir_all(directory).map_err(|error| {
                format!(
                    "failed to create download directory {}: {error}",
                    directory.to_string_lossy()
                )
            })?;
        }

        let total_folders = directories.len();
        let total_bytes: u64 = files.iter().map(|(_, _, size)| *size).sum();
        let plan = files
            .iter()
            .map(|(remote, _, size)| SftpTransferPlanItem {
                path: remote.clone(),
                size: *size,
            })
            .collect::<Vec<_>>();

        let mut batch = String::new();
        for (remote_path, local_path, _) in &files {
            let remote = quote_batch_path(remote_path)?;
            let local = quote_batch_path(&local_path.to_string_lossy())?;
            batch.push_str(&format!("get {remote} {local}\npwd\n"));
        }

        run_sftp_transfer_stream(
            app,
            transfer_id,
            "download",
            host,
            port,
            user,
            password,
            batch,
            plan,
            total_folders,
        )?;
        log::info!("SFTP recursive download batch completed");
        Ok(SftpTransferResult {
            items: selected_items,
            files: files.len(),
            folders: total_folders,
            bytes: total_bytes,
        })
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}
#[tauri::command]
pub async fn sftp_mkdir(
    host: String,
    port: u16,
    user: String,
    path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("remote folder path is required".to_string());
    }
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let remote = quote_batch_path(&path)?;
        run_sftp_batch(
            host,
            port,
            user,
            password,
            format!(
                "mkdir {remote}
"
            ),
            "mkdir",
        )?;
        log::info!("SFTP mkdir completed");
        Ok(())
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

#[tauri::command]
pub async fn sftp_rename_entry(
    host: String,
    port: u16,
    user: String,
    source: String,
    destination: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let source = source.trim().to_string();
    let destination = destination.trim().to_string();
    if source.is_empty() || destination.is_empty() {
        return Err("remote source and destination are required".to_string());
    }
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = quote_batch_path(&source)?;
        let destination = quote_batch_path(&destination)?;
        run_sftp_batch(
            host,
            port,
            user,
            password,
            format!(
                "rename {source} {destination}
"
            ),
            "rename",
        )?;
        log::info!("SFTP rename completed");
        Ok(())
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

#[tauri::command]
pub async fn sftp_move_entries(
    host: String,
    port: u16,
    user: String,
    destination: String,
    items: Vec<SftpRemoteItem>,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<usize, String> {
    if items.is_empty() {
        return Err("at least one remote item is required".to_string());
    }
    let destination = destination.trim().to_string();
    if destination.is_empty() {
        return Err("remote destination directory is required".to_string());
    }
    let count = items.len();
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut batch = String::new();
        for item in items {
            let source = quote_batch_path(item.path.trim())?;
            let target_path = join_remote_path(&destination, item.name.trim());
            let target = quote_batch_path(&target_path)?;
            batch.push_str(&format!("rename {source} {target}\n"));
        }
        run_sftp_batch(host, port, user, password, batch, "move")?;
        log::info!("SFTP move batch completed");
        Ok(count)
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}
#[tauri::command]
pub async fn sftp_chmod_entries(
    host: String,
    port: u16,
    user: String,
    mode: String,
    items: Vec<SftpRemoteItem>,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<usize, String> {
    if items.is_empty() {
        return Err("at least one remote item is required".to_string());
    }
    let mode = mode.trim().to_string();
    if mode.len() < 3
        || mode.len() > 4
        || !mode.chars().all(|character| matches!(character, '0'..='7'))
    {
        return Err("CHMOD mode must be a 3 or 4 digit octal value".to_string());
    }
    let count = items.len();
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut batch = String::new();
        for item in items {
            let remote = quote_batch_path(item.path.trim())?;
            batch.push_str(&format!("chmod {mode} {remote}\n"));
        }
        run_sftp_batch(host, port, user, password, batch, "chmod")?;
        log::info!("SFTP chmod batch completed");
        Ok(count)
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}
#[tauri::command]
pub async fn sftp_delete_entries(
    host: String,
    port: u16,
    user: String,
    items: Vec<SftpRemoteItem>,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<usize, String> {
    if items.is_empty() {
        return Err("at least one remote item is required".to_string());
    }
    let count = items.len();
    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        for item in items.iter().filter(|item| item.is_dir) {
            if !remote_directory_is_empty(
                host.clone(),
                port,
                user.clone(),
                password.clone(),
                item.path.trim(),
            )? {
                return Err(format!("Directory is not empty: {}", item.name));
            }
        }

        let mut batch = String::new();
        for item in items {
            let remote = quote_batch_path(item.path.trim())?;
            if item.is_dir {
                batch.push_str(&format!("rmdir {remote}\n"));
            } else {
                batch.push_str(&format!("rm {remote}\n"));
            }
        }
        run_sftp_batch(host, port, user, password, batch, "delete")?;
        log::info!("SFTP delete batch completed");
        Ok(count)
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

#[tauri::command]
pub async fn sftp_download(
    host: String,
    port: u16,
    user: String,
    remote_path: String,
    local_path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let remote_path = remote_path.trim().to_string();
    let local_path = local_path.trim().to_string();

    if remote_path.is_empty() {
        return Err("remote file path is required".to_string());
    }
    if local_path.is_empty() {
        return Err("local destination path is required".to_string());
    }
    if std::path::Path::new(&local_path).exists() {
        return Err("local destination already exists".to_string());
    }

    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let remote = quote_batch_path(&remote_path)?;
        let local = quote_batch_path(&local_path)?;
        run_sftp_batch(
            host,
            port,
            user,
            password,
            format!("get {remote} {local}\n"),
            "download",
        )?;
        log::info!("SFTP download completed");
        Ok(())
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

#[tauri::command]
pub async fn sftp_upload(
    host: String,
    port: u16,
    user: String,
    local_path: String,
    remote_path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<(), String> {
    let local_path = local_path.trim().to_string();
    let remote_path = remote_path.trim().to_string();

    if local_path.is_empty() {
        return Err("local source path is required".to_string());
    }
    if remote_path.is_empty() {
        return Err("remote destination path is required".to_string());
    }
    if !std::path::Path::new(&local_path).is_file() {
        return Err("local source file does not exist".to_string());
    }

    let password = password_for_credential(&vault_state, credential_ref.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let local = quote_batch_path(&local_path)?;
        let remote = quote_batch_path(&remote_path)?;
        run_sftp_batch(
            host,
            port,
            user,
            password,
            format!("put {local} {remote}\n"),
            "upload",
        )?;
        log::info!("SFTP upload completed");
        Ok(())
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

#[tauri::command]
pub fn sftp_default_download_path(file_name: String) -> String {
    let home = if cfg!(windows) {
        env::var("USERPROFILE").ok()
    } else {
        env::var("HOME").ok()
    };

    home.map(|home| {
        std::path::PathBuf::from(home)
            .join("Downloads")
            .join(&file_name)
            .to_string_lossy()
            .into_owned()
    })
    .unwrap_or(file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_directory_entry_with_spaces() {
        let entry = parse_listing_line(
            "drwxr-xr-x 2 owner group 4096 Sep 14 12:30 Project Files",
            "/home/test",
        )
        .unwrap();

        assert!(entry.is_dir);
        assert_eq!(entry.name, "Project Files");
        assert_eq!(entry.path, "/home/test/Project Files");
    }

    #[test]
    fn ignores_dot_entries() {
        assert!(
            parse_listing_line("drwxr-xr-x 2 owner group 4096 Sep 14 12:30 .", "/home/test")
                .is_none()
        );
    }
}
