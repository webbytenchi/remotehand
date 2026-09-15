use crate::plugins::{PluginInfo, PLUGIN_API_VERSION};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Default)]
pub struct PluginRuntimeState {
    sessions: Mutex<BTreeMap<String, PluginSession>>,
}
struct PluginSession {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    next_request_id: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginHello {
    #[serde(rename = "type")]
    message_type: String,
    plugin_id: String,
    api_version: u32,
    plugin_version: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostReady<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    plugin_id: &'a str,
    api_version: u32,
    granted_permissions: &'a [String],
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostRequest<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    request_id: u64,
    method: &'a str,
    params: serde_json::Value,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginResponse {
    #[serde(rename = "type")]
    message_type: String,
    request_id: u64,
    ok: bool,
    #[serde(default)]
    result: serde_json::Value,
    #[serde(default)]
    error: String,
}
fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|error| format!("failed to read plugin frame length: {error}"))?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(format!("invalid plugin frame length: {length}"));
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("failed to read plugin frame payload: {error}"))?;
    Ok(payload)
}
fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), String> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| format!("failed to encode plugin frame: {error}"))?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err("plugin frame exceeds runtime limit".to_string());
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("failed to write plugin frame: {error}"))
}
fn resolve_entrypoint(
    plugin: &PluginInfo,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let plugin_root = crate::plugins::plugins_root_for_runtime()?.join(&plugin.directory);
    let target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let configured = plugin
        .manifest
        .runtime
        .entrypoints
        .get(&target)
        .ok_or_else(|| format!("plugin does not provide a runtime entrypoint for {target}"))?;
    let entrypoint = Path::new(configured);
    if entrypoint.is_absolute()
        || entrypoint
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("plugin runtime entrypoint escaped package root".to_string());
    }

    let root = fs::canonicalize(&plugin_root)
        .map_err(|error| format!("failed to resolve plugin package: {error}"))?;
    let path = plugin_root.join(entrypoint);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("plugin runtime entrypoint is unavailable: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("plugin runtime entrypoint must be a regular file".to_string());
    }

    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("failed to resolve plugin runtime entrypoint: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err("plugin runtime entrypoint escaped package root".to_string());
    }
    Ok((root, canonical))
}
fn perform_handshake(
    plugin: &PluginInfo,
    stdin: &mut ChildStdin,
    stdout: ChildStdout,
) -> Result<ChildStdout, String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut stdout = stdout;
        let result = read_frame(&mut stdout)
            .and_then(|payload| {
                serde_json::from_slice::<PluginHello>(&payload)
                    .map_err(|error| format!("invalid plugin hello: {error}"))
            })
            .map(|hello| (hello, stdout));
        let _ = sender.send(result);
    });

    let (hello, stdout) = receiver
        .recv_timeout(HANDSHAKE_TIMEOUT)
        .map_err(|_| "plugin handshake timed out".to_string())??;

    if hello.message_type != "plugin.hello" {
        return Err("plugin first message must be plugin.hello".to_string());
    }
    if hello.plugin_id != plugin.manifest.id {
        return Err("plugin hello id does not match installed manifest".to_string());
    }
    if hello.plugin_version != plugin.manifest.version {
        return Err("plugin hello version does not match installed manifest".to_string());
    }
    if hello.api_version != PLUGIN_API_VERSION {
        return Err(format!(
            "plugin hello API {} is incompatible with host API {}",
            hello.api_version, PLUGIN_API_VERSION
        ));
    }

    let ready = HostReady {
        message_type: "host.ready",
        plugin_id: &plugin.manifest.id,
        api_version: PLUGIN_API_VERSION,
        granted_permissions: &plugin.manifest.permissions,
    };
    write_frame(stdin, &ready)?;
    Ok(stdout)
}
impl PluginRuntimeState {
    pub fn start(&self, plugin: &PluginInfo) -> Result<(), String> {
        {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "plugin runtime lock poisoned".to_string())?;
            if sessions.contains_key(&plugin.manifest.id) {
                return Ok(());
            }
        }
        let (plugin_root, entrypoint) = resolve_entrypoint(plugin)?;

        let mut child = Command::new(&entrypoint)
            .current_dir(&plugin_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("REMOTEHAND_PLUGIN_ID", &plugin.manifest.id)
            .env(
                "REMOTEHAND_PLUGIN_API_VERSION",
                PLUGIN_API_VERSION.to_string(),
            )
            .spawn()
            .map_err(|error| format!("failed to launch plugin runtime: {error}"))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open plugin stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open plugin stdout".to_string())?;

        let stdout = match perform_handshake(plugin, &mut stdin, stdout) {
            Ok(stdout) => stdout,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "plugin runtime lock poisoned".to_string())?;
        sessions.insert(
            plugin.manifest.id.clone(),
            PluginSession {
                child,
                stdin,
                stdout,
                next_request_id: 1,
            },
        );
        log::info!("Plugin runtime {} started", plugin.manifest.id);
        Ok(())
    }

    pub fn call(
        &self,
        id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if method.is_empty()
            || method.len() > 128
            || !method.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'-' | b'_')
            })
        {
            return Err("invalid plugin method".to_string());
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_poison| "plugin runtime lock poisoned".to_string())?;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| "plugin runtime is not running".to_string())?;
        if let Some(status) = session
            .child
            .try_wait()
            .map_err(|error| format!("failed to inspect plugin runtime: {error}"))?
        {
            return Err(format!("plugin runtime exited with {status}"));
        }
        let request_id = session.next_request_id;
        session.next_request_id = session.next_request_id.wrapping_add(1).max(1);
        let request = HostRequest {
            message_type: "host.request",
            request_id,
            method,
            params,
        };
        write_frame(&mut session.stdin, &request)?;
        let payload = read_frame(&mut session.stdout)?;
        let response: PluginResponse = serde_json::from_slice(&payload)
            .map_err(|error| format!("invalid plugin response: {error}"))?;
        if response.message_type != "plugin.response" {
            return Err("plugin returned an unexpected message type".to_string());
        }
        if response.request_id != request_id {
            return Err("plugin response request id does not match".to_string());
        }
        if !response.ok {
            if response.error.is_empty() {
                return Err("plugin request failed".to_string());
            }
            return Err(response.error);
        }
        Ok(response.result)
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "plugin runtime lock poisoned".to_string())?;
        let Some(mut session) = sessions.remove(id) else {
            return Ok(());
        };
        match session
            .child
            .try_wait()
            .map_err(|error| format!("failed to inspect plugin runtime: {error}"))?
        {
            Some(_) => {}
            None => {
                session
                    .child
                    .kill()
                    .map_err(|error| format!("failed to stop plugin runtime: {error}"))?;
                let _ = session.child.wait();
            }
        }
        log::info!("Plugin runtime {id} stopped");
        Ok(())
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(id))
            .unwrap_or(false)
    }
}
#[tauri::command]
pub fn plugin_runtime_call(
    runtime: tauri::State<'_, PluginRuntimeState>,
    id: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    runtime.call(&id, &method, params)
}

impl Drop for PluginRuntimeState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for (_, session) in sessions.iter_mut() {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
            sessions.clear();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_round_trip() {
        let value = HostReady {
            message_type: "host.ready",
            plugin_id: "remotehand.test",
            api_version: 1,
            granted_permissions: &[],
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &value).unwrap();
        let payload = read_frame(&mut bytes.as_slice()).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(json["type"], "host.ready");
        assert_eq!(json["pluginId"], "remotehand.test");
    }

    #[test]
    fn rejects_oversized_frame() {
        let mut bytes = ((MAX_FRAME_BYTES as u32) + 1).to_le_bytes().to_vec();
        bytes.extend_from_slice(b"x");
        let error = read_frame(&mut bytes.as_slice()).unwrap_err();
        assert!(error.contains("frame length"));
    }
}
