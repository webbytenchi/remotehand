use crate::vault::{self, VaultState};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    permissions: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
    path: String,
    entries: Vec<SftpEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferProgress {
    transfer_id: String,
    status: String,
    transferred_bytes: u64,
    total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResult {
    transfer_id: String,
    local_path: Option<String>,
    remote_path: String,
    bytes: u64,
}

#[derive(Default)]
pub struct SftpState {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SftpSessionConfig {
    host: String,
    port: u16,
    user: String,
    credential_ref: Option<String>,
}

struct SftpSession {
    config: SftpSessionConfig,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: Arc<Mutex<VecDeque<String>>>,
}

fn make_config(
    host: String,
    port: u16,
    user: String,
    credential_ref: Option<String>,
) -> Result<SftpSessionConfig, String> {
    let config = SftpSessionConfig {
        host: host.trim().to_string(),
        port: port.max(1),
        user: user.trim().to_string(),
        credential_ref: credential_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    };
    if config.host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if config.user.is_empty() {
        return Err("SFTP user is required".to_string());
    }
    Ok(config)
}

fn resolve_password(
    vault_state: &State<'_, VaultState>,
    credential_ref: Option<&str>,
) -> Result<Option<String>, String> {
    credential_ref
        .map(|credential_ref| vault::get_secret(vault_state, credential_ref))
        .transpose()
        .map(|secret| secret.flatten())
}

fn quote_batch_path(path: &str) -> Result<String, String> {
    if path.contains('\n') || path.contains('\r') {
        return Err("path contains unsupported characters".to_string());
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

fn build_sftp_command(
    config: &SftpSessionConfig,
    password: Option<&str>,
    quiet: bool,
    batch: bool,
) -> Result<Command, String> {
    let mut command = Command::new("sftp");
    if quiet {
        command.arg("-q");
    }
    if batch {
        command.arg("-b").arg("-");
    }
    command
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-P")
        .arg(config.port.max(1).to_string())
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
        command.arg("-o").arg("BatchMode=yes");
    }

    command.arg(format!("{}@{}", config.user, config.host));
    Ok(command)
}

fn start_session(
    config: SftpSessionConfig,
    password: Option<String>,
) -> Result<SftpSession, String> {
    let mut command = build_sftp_command(&config, password.as_deref(), true, false)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start sftp: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open sftp input".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to open sftp output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open sftp error output".to_string())?;

    let stderr_buffer = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_sink = stderr_buffer.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = line.trim();
                    if text.is_empty() {
                        continue;
                    }
                    if let Ok(mut lines) = stderr_sink.lock() {
                        lines.push_back(text.to_string());
                        while lines.len() > 8 {
                            lines.pop_front();
                        }
                    }
                }
            }
        }
    });

    Ok(SftpSession {
        config,
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr: stderr_buffer,
    })
}

fn session_stderr(session: &SftpSession) -> String {
    session
        .stderr
        .lock()
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join(" | "))
        .unwrap_or_default()
}

fn run_session_list(session: &mut SftpSession, path: String) -> Result<SftpListing, String> {
    if let Some(status) = session
        .child
        .try_wait()
        .map_err(|error| format!("failed to inspect sftp session: {error}"))?
    {
        let detail = session_stderr(session);
        return Err(if detail.is_empty() {
            format!("SFTP session exited with status {status}")
        } else {
            format!("SFTP session exited with status {status}: {detail}")
        });
    }
    let requested_path = if path.trim().is_empty() { "." } else { path.trim() };
    let quoted_path = quote_batch_path(requested_path)?;
    let batch = format!("cd {quoted_path}\npwd\nls -la\npwd\n");

    session
        .stdin
        .write_all(batch.as_bytes())
        .and_then(|_| session.stdin.flush())
        .map_err(|error| format!("failed to send sftp command: {error}"))?;

    let mut current_path = None;
    let mut listing_lines = Vec::new();
    loop {
        let mut line = String::new();
        let count = session
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("failed to read sftp output: {error}"))?;
        if count == 0 {
            let detail = session_stderr(session);
            return Err(if detail.is_empty() {
                "SFTP session closed unexpectedly".to_string()
            } else {
                format!("SFTP session closed unexpectedly: {detail}")
            });
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some(path) = trimmed.strip_prefix("Remote working directory: ") {
            if current_path.is_some() {
                break;
            }
            current_path = Some(path.trim().to_string());
            continue;
        }
        if current_path.is_some() {
            listing_lines.push(trimmed.to_string());
        }
    }

    let current_path = current_path.unwrap_or_else(|| requested_path.to_string());
    let mut entries = listing_lines
        .iter()
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

fn run_session_chmod(session: &mut SftpSession, path: &str, mode: &str) -> Result<(), String> {
    if !valid_mode(mode) {
        return Err("permissions must be 3 or 4 octal digits".to_string());
    }
    let quoted = quote_batch_path(path)?;
    let batch = format!("chmod {mode} {quoted}\npwd\n");
    session
        .stdin
        .write_all(batch.as_bytes())
        .and_then(|_| session.stdin.flush())
        .map_err(|error| format!("failed to send chmod command: {error}"))?;

    loop {
        let mut line = String::new();
        let count = session
            .stdout
            .read_line(&mut line)
            .map_err(|error| format!("failed to read chmod result: {error}"))?;
        if count == 0 {
            return Err("SFTP session closed while applying permissions".to_string());
        }
        if line.trim().starts_with("Remote working directory: ") {
            break;
        }
    }
    Ok(())
}

fn valid_mode(mode: &str) -> bool {
    (mode.len() == 3 || mode.len() == 4) && mode.chars().all(|value| ('0'..='7').contains(&value))
}

fn parse_progress_percent(text: &str) -> Option<u64> {
    text.split_whitespace().find_map(|token| {
        token
            .strip_suffix('%')
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value <= 100)
    })
}

fn portable_download_dir() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir.join("data").join("downloads"))
}

fn unique_download_path(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 2..10_000 {
        let next_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let next = directory.join(next_name);
        if !next.exists() {
            return next;
        }
    }
    candidate
}

fn download_name(remote_path: &str) -> Result<String, String> {
    let name = remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('\\') {
        return Err("remote filename is invalid".to_string());
    }
    Ok(name.to_string())
}

fn run_transfer(
    app: AppHandle,
    config: SftpSessionConfig,
    password: Option<String>,
    transfer_id: String,
    batch: String,
    total_bytes: u64,
) -> Result<(), String> {
    let mut command = build_sftp_command(&config, password.as_deref(), false, true)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start sftp transfer: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open sftp transfer input".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to open sftp transfer diagnostics".to_string())?;

    app.emit(
        "sftp-transfer-progress",
        SftpTransferProgress {
            transfer_id: transfer_id.clone(),
            status: "running".to_string(),
            transferred_bytes: 0,
            total_bytes,
        },
    )
    .map_err(|error| error.to_string())?;

    let progress_app = app.clone();
    let progress_id = transfer_id.clone();
    let diagnostics = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let diagnostics_sink = diagnostics.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut current = Vec::new();
        let mut byte = [0_u8; 1];
        loop {
            match reader.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) if byte[0] == b'\r' || byte[0] == b'\n' => {
                    if current.is_empty() {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&current).trim().to_string();
                    current.clear();
                    if text.is_empty() {
                        continue;
                    }
                    if let Some(percent) = parse_progress_percent(&text) {
                        let transferred = total_bytes.saturating_mul(percent) / 100;
                        let _ = progress_app.emit(
                            "sftp-transfer-progress",
                            SftpTransferProgress {
                                transfer_id: progress_id.clone(),
                                status: "running".to_string(),
                                transferred_bytes: transferred,
                                total_bytes,
                            },
                        );
                    } else if let Ok(mut lines) = diagnostics_sink.lock() {
                        lines.push_back(text);
                        while lines.len() > 8 {
                            lines.pop_front();
                        }
                    }
                }
                Ok(_) => current.push(byte[0]),
            }
        }
    });

    stdin
        .write_all(batch.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to send transfer command: {error}"))?;
    drop(stdin);

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for sftp transfer: {error}"))?;
    let _ = reader_thread.join();

    if status.success() {
        let _ = app.emit(
            "sftp-transfer-progress",
            SftpTransferProgress {
                transfer_id,
                status: "completed".to_string(),
                transferred_bytes: total_bytes,
                total_bytes,
            },
        );
        Ok(())
    } else {
        let detail = diagnostics
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        Err(if detail.is_empty() {
            format!("SFTP transfer exited with status {status}")
        } else {
            format!("SFTP transfer failed: {detail}")
        })
    }
}

#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    host: String,
    port: u16,
    user: String,
    path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
    sftp_state: State<'_, SftpState>,
) -> Result<SftpListing, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("SFTP session id is required".to_string());
    }
    let config = make_config(host, port, user, credential_ref)?;

    let existing_matches = {
        let sessions = sftp_state
            .sessions
            .lock()
            .map_err(|_| "SFTP session store is unavailable".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| {
                session
                    .lock()
                    .map(|session| session.config == config)
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    };
    let password = if existing_matches {
        None
    } else {
        resolve_password(&vault_state, config.credential_ref.as_deref())?
    };

    let sessions = sftp_state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "SFTP session store is unavailable".to_string())?;
            if let Some(existing) = sessions.get(&session_id) {
                let matches = existing
                    .lock()
                    .map_err(|_| "SFTP session is unavailable".to_string())?
                    .config
                    == config;
                if !matches {
                    if let Some(old) = sessions.remove(&session_id) {
                        if let Ok(mut old) = old.lock() {
                            let _ = old.child.kill();
                        }
                    }
                }
            }

            if let Some(existing) = sessions.get(&session_id) {
                existing.clone()
            } else {
                let session = Arc::new(Mutex::new(start_session(config.clone(), password)?));
                sessions.insert(session_id.clone(), session.clone());
                log::info!("SFTP session started");
                session
            }
        };

        let mut session = session
            .lock()
            .map_err(|_| "SFTP session is unavailable".to_string())?;
        match run_session_list(&mut session, path.clone()) {
            Ok(listing) => Ok(listing),
            Err(error) => {
                let should_retry = session.child.try_wait().ok().flatten().is_some();
                drop(session);
                if should_retry {
                    if let Ok(mut sessions) = sessions.lock() {
                        sessions.remove(&session_id);
                    }
                }
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("SFTP task failed: {error}"))?
}

#[tauri::command]
pub async fn sftp_chmod(
    session_id: String,
    path: String,
    mode: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let sessions = sftp_state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let sessions = sessions
                .lock()
                .map_err(|_| "SFTP session store is unavailable".to_string())?;
            sessions
                .get(session_id.trim())
                .cloned()
                .ok_or_else(|| "SFTP session is not connected".to_string())?
        };
        let mut session = session
            .lock()
            .map_err(|_| "SFTP session is unavailable".to_string())?;
        run_session_chmod(&mut session, path.trim(), mode.trim())
    })
    .await
    .map_err(|error| format!("SFTP chmod task failed: {error}"))?
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    transfer_id: String,
    host: String,
    port: u16,
    user: String,
    local_path: String,
    remote_path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<SftpTransferResult, String> {
    let config = make_config(host, port, user, credential_ref)?;
    let password = resolve_password(&vault_state, config.credential_ref.as_deref())?;
    let local = PathBuf::from(local_path.trim());
    let metadata =
        fs::metadata(&local).map_err(|error| format!("failed to read upload file: {error}"))?;
    if !metadata.is_file() {
        return Err("upload source must be a file".to_string());
    }
    let remote = remote_path.trim().to_string();
    let batch = format!(
        "put {} {}\n",
        quote_batch_path(local.to_string_lossy().as_ref())?,
        quote_batch_path(&remote)?
    );
    let bytes = metadata.len();
    let result_id = transfer_id.trim().to_string();
    let task_id = result_id.clone();
    let task_remote = remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_transfer(app, config, password, task_id, batch, bytes)
    })
    .await
    .map_err(|error| format!("SFTP upload task failed: {error}"))??;

    Ok(SftpTransferResult {
        transfer_id: result_id,
        local_path: Some(local.to_string_lossy().into_owned()),
        remote_path: task_remote,
        bytes,
    })
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    transfer_id: String,
    host: String,
    port: u16,
    user: String,
    remote_path: String,
    remote_size: u64,
    conflict_policy: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<SftpTransferResult, String> {
    let config = make_config(host, port, user, credential_ref)?;
    let password = resolve_password(&vault_state, config.credential_ref.as_deref())?;
    let downloads = portable_download_dir()?;
    fs::create_dir_all(&downloads)
        .map_err(|error| format!("failed to create downloads directory: {error}"))?;
    let file_name = download_name(&remote_path)?;
    let requested = downloads.join(&file_name);
    let local = match conflict_policy.trim() {
        "overwrite" => requested,
        "rename" | "" => unique_download_path(&downloads, &file_name),
        "error" if requested.exists() => return Err("download target already exists".to_string()),
        "error" => requested,
        other => return Err(format!("unsupported conflict policy: {other}")),
    };

    let remote = remote_path.trim().to_string();
    let batch = format!(
        "get {} {}\n",
        quote_batch_path(&remote)?,
        quote_batch_path(local.to_string_lossy().as_ref())?
    );
    let result_id = transfer_id.trim().to_string();
    let task_id = result_id.clone();
    let task_remote = remote.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_transfer(app, config, password, task_id, batch, remote_size)
    })
    .await
    .map_err(|error| format!("SFTP download task failed: {error}"))??;

    Ok(SftpTransferResult {
        transfer_id: result_id,
        local_path: Some(local.to_string_lossy().into_owned()),
        remote_path: task_remote,
        bytes: remote_size,
    })
}

#[tauri::command]
pub fn sftp_close(session_id: String, sftp_state: State<'_, SftpState>) -> Result<(), String> {
    let mut sessions = sftp_state
        .sessions
        .lock()
        .map_err(|_| "SFTP session store is unavailable".to_string())?;
    if let Some(session) = sessions.remove(session_id.trim()) {
        if let Ok(mut session) = session.lock() {
            let _ = session.stdin.write_all(b"quit\n");
            let _ = session.stdin.flush();
            let _ = session.child.kill();
        }
        log::info!("SFTP session closed");
    }
    Ok(())
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

    #[test]
    fn validates_permission_modes() {
        assert!(valid_mode("644"));
        assert!(valid_mode("0755"));
        assert!(!valid_mode("888"));
        assert!(!valid_mode("75"));
    }

    #[test]
    fn parses_transfer_percent() {
        assert_eq!(
            parse_progress_percent("file.bin 42% 4MB 1.2MB/s 00:03"),
            Some(42)
        );
        assert_eq!(parse_progress_percent("warning: message"), None);
    }

    #[test]
    fn extracts_safe_download_name() {
        assert_eq!(
            download_name("/srv/files/report.txt").unwrap(),
            "report.txt"
        );
        assert!(download_name("/").is_err());
    }
}
