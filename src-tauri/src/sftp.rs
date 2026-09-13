use crate::vault::{self, VaultState};
use serde::Serialize;
use std::{
    env,
    io::Write,
    process::{Command, Stdio},
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

#[tauri::command]
pub async fn sftp_list(
    host: String,
    port: u16,
    user: String,
    path: String,
    credential_ref: Option<String>,
    vault_state: State<'_, VaultState>,
) -> Result<SftpListing, String> {
    let password = credential_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|credential_ref| vault::get_secret(&vault_state, credential_ref))
        .transpose()?
        .flatten();

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
