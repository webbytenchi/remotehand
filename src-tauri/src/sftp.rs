use crate::vault::{self, VaultState};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    env,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::State;

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

fn start_session(
    config: SftpSessionConfig,
    password: Option<String>,
) -> Result<SftpSession, String> {
    let mut command = Command::new("sftp");
    command
        .arg("-q")
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
    let requested_path = if path.trim().is_empty() {
        "."
    } else {
        path.trim()
    };
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
            std::thread::sleep(std::time::Duration::from_millis(20));
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
    if session_id.is_empty() {
        return Err("SFTP session id is required".to_string());
    }
    if config.host.is_empty() {
        return Err("SFTP host is required".to_string());
    }
    if config.user.is_empty() {
        return Err("SFTP user is required".to_string());
    }

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
        config
            .credential_ref
            .as_deref()
            .map(|credential_ref| vault::get_secret(&vault_state, credential_ref))
            .transpose()?
            .flatten()
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
}
