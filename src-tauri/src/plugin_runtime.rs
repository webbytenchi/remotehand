use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use crate::plugins::{PluginInfo, PLUGIN_API_VERSION};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Component, Path},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Default)]
pub struct PluginRuntimeState {
    sessions: Mutex<BTreeMap<String, PluginSession>>,
    app_handle: Mutex<Option<AppHandle>>,
    panel_session_state: Mutex<BTreeMap<String, serde_json::Value>>,
    detached_calls: Mutex<BTreeMap<String, DetachedPluginCall>>,
    next_detached_call_id: AtomicU64,
}

struct DetachedPluginCall {
    plugin_id: String,
    outcome: Option<Result<serde_json::Value, String>>,
}
struct PluginSession {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<BTreeMap<u64, mpsc::Sender<Result<PluginResponse, String>>>>>,
    next_request_id: u64,
    stopping: Arc<AtomicBool>,
    call_lock: Arc<Mutex<()>>,
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
struct PluginRequest {
    #[serde(rename = "type")]
    message_type: String,
    request_id: u64,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    #[serde(rename = "type")]
    message_type: &'static str,
    request_id: u64,
    ok: bool,
    result: serde_json::Value,
    error: String,
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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginEvent {
    #[serde(rename = "type")]
    message_type: String,
    event: String,
    #[serde(default)]
    payload: serde_json::Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginEventEnvelope {
    plugin_id: String,
    event: String,
    payload: serde_json::Value,
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
        .and_then(|_length_written| writer.write_all(&payload))
        .and_then(|_payload_written| writer.flush())
        .map_err(|error| format!("failed to write plugin frame: {error}"))
}
fn valid_message_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
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
fn fail_pending(
    pending: &Arc<Mutex<BTreeMap<u64, mpsc::Sender<Result<PluginResponse, String>>>>>,
    error: String,
) {
    let senders = match pending.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_poison) => return,
    };
    for (_request_id, sender) in senders {
        let _ = sender.send(Err(error.clone()));
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialUseParams {
    credential_ref: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialStoreParams {
    credential_ref: String,
    secret: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultKeyParams {
    key: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultSecretSetParams {
    key: String,
    secret: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultDocumentSetParams {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultBlobBeginParams {
    key: String,
    size: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultBlobWriteParams {
    key: String,
    upload_id: String,
    index: u32,
    data: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultBlobUploadParams {
    key: String,
    upload_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultBlobReadParams {
    key: String,
    index: u32,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultAccessRequestParams {
    reason: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageGetParams {
    key: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageSetParams {
    key: String,
    value: serde_json::Value,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClipboardWriteParams {
    text: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSaveFilter {
    name: String,
    extensions: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileOpenParams {
    #[serde(default)]
    filters: Vec<FileSaveFilter>,
    #[serde(default)]
    multiple: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkOpenParams {
    url: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSaveParams {
    suggested_name: String,
    content: String,
    #[serde(default)]
    filters: Vec<FileSaveFilter>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginAvailableParams {
    plugin_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginOpenPanelParams {
    plugin_id: String,
    panel_id: String,
    #[serde(default)]
    context: serde_json::Value,
}
fn validate_file_open_params(params: &FileOpenParams) -> Result<(), String> {
    if params.filters.len() > 8 {
        return Err("file.open has too many file filters".to_string());
    }
    for filter in &params.filters {
        if filter.name.trim().is_empty()
            || filter.name.len() > 64
            || filter.extensions.is_empty()
            || filter.extensions.len() > 32
        {
            return Err("file.open contains an invalid file filter".to_string());
        }
        for extension in &filter.extensions {
            if extension == "*" {
                continue;
            }
            if extension.is_empty()
                || extension.len() > 16
                || !extension.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return Err("file.open contains an invalid file extension".to_string());
            }
        }
    }
    Ok(())
}
fn validate_file_save_params(params: &FileSaveParams) -> Result<(), String> {
    if params.suggested_name.trim().is_empty() || params.suggested_name.len() > 255 {
        return Err("file.save suggested name is missing or too long".to_string());
    }
    let path = Path::new(&params.suggested_name);
    if path.components().count() != 1 || path.is_absolute() {
        return Err("file.save suggested name must be a file name without a path".to_string());
    }
    if params.content.len() > 8 * 1024 * 1024 {
        return Err("file.save content exceeds 8 MiB".to_string());
    }
    if params.filters.len() > 8 {
        return Err("file.save has too many file filters".to_string());
    }
    for filter in &params.filters {
        if filter.name.trim().is_empty()
            || filter.name.len() > 64
            || filter.extensions.is_empty()
            || filter.extensions.len() > 8
        {
            return Err("file.save contains an invalid file filter".to_string());
        }
        for extension in &filter.extensions {
            if extension.is_empty()
                || extension.len() > 16
                || !extension.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return Err("file.save contains an invalid file extension".to_string());
            }
        }
    }
    Ok(())
}
fn validate_plugin_open_panel_params(params: &PluginOpenPanelParams) -> Result<(), String> {
    if params.context != serde_json::Value::Null && !params.context.is_object() {
        return Err("plugin.open_panel context must be an object".to_string());
    }
    if serde_json::to_vec(&params.context)
        .map_err(|error| format!("invalid plugin.open_panel context: {error}"))?
        .len()
        > 64 * 1024
    {
        return Err("plugin.open_panel context exceeds 64 KiB".to_string());
    }
    Ok(())
}

fn permission_granted(permissions: &[String], permission: &str) -> bool {
    permissions.iter().any(|value| value == permission)
}

fn vault_audit_action(method: &str) -> Option<&'static str> {
    match method {
        "credentials.use" => Some("legacy-secret.read"),
        "credentials.store" => Some("legacy-secret.write"),
        "vault.secret.get" => Some("secret.read"),
        "vault.secret.set" => Some("secret.write"),
        "vault.secret.delete" => Some("secret.delete"),
        "vault.document.get" => Some("document.read"),
        "vault.document.set" => Some("document.write"),
        "vault.document.delete" => Some("document.delete"),
        "vault.blob.begin" => Some("blob.begin"),
        "vault.blob.write" => Some("blob.write"),
        "vault.blob.commit" => Some("blob.commit"),
        "vault.blob.abort" => Some("blob.abort"),
        "vault.blob.info" => Some("blob.info"),
        "vault.blob.read" => Some("blob.read"),
        "vault.blob.delete" => Some("blob.delete"),
        "vault.request_access" => Some("access.request"),
        _ => None,
    }
}

fn log_vault_audit(plugin_id: &str, method: &str, outcome: &str) {
    if let Some(action) = vault_audit_action(method) {
        log::info!("Vault audit: plugin={plugin_id} action={action} outcome={outcome}");
    }
}

fn log_deprecated_vault_api(plugin_id: &str, method: &str) {
    match method {
        "credentials.use" => log::warn!(
            "Plugin {plugin_id} used deprecated credentials.use; migrate to vault.secret.get"
        ),
        "credentials.store" => log::warn!(
            "Plugin {plugin_id} used deprecated credentials.store; migrate to vault.secret.set"
        ),
        _ => {}
    }
}

fn validate_plugin_credential_ref(plugin_id: &str, credential_ref: &str) -> Result<(), String> {
    let expected_prefix = format!("plugin:{plugin_id}:");
    if credential_ref.starts_with(&expected_prefix) {
        Ok(())
    } else {
        Err("plugin credential ref must use its own namespace".to_string())
    }
}

fn validate_plugin_vault_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 {
        return Err("plugin Vault key is invalid".to_string());
    }
    if !key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_'))
    {
        return Err("plugin Vault key contains unsupported characters".to_string());
    }
    if key
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("plugin Vault key contains an invalid path segment".to_string());
    }
    Ok(())
}

fn plugin_vault_ref(plugin_id: &str, key: &str) -> Result<String, String> {
    validate_plugin_vault_key(key)?;
    Ok(format!("plugin:{plugin_id}/{key}"))
}
fn validate_plugin_request(permissions: &[String], request: &PluginRequest) -> Result<(), String> {
    if request.message_type != "plugin.request" {
        return Err("invalid plugin request message type".to_string());
    }
    match request.method.as_str() {
        "credentials.use" => {
            if !permission_granted(permissions, "credentials.use") {
                return Err("plugin lacks credentials.use permission".to_string());
            }
            Ok(())
        }
        "credentials.store" => {
            if !permission_granted(permissions, "credentials.store") {
                return Err("plugin lacks credentials.store permission".to_string());
            }
            Ok(())
        }
        "vault.secret.get" => {
            if !permission_granted(permissions, "vault.secrets.read") {
                return Err("plugin lacks vault.secrets.read permission".to_string());
            }
            Ok(())
        }
        "vault.secret.set" | "vault.secret.delete" => {
            if !permission_granted(permissions, "vault.secrets.write") {
                return Err("plugin lacks vault.secrets.write permission".to_string());
            }
            Ok(())
        }
        "vault.document.get" => {
            if !permission_granted(permissions, "vault.documents.read") {
                return Err("plugin lacks vault.documents.read permission".to_string());
            }
            Ok(())
        }
        "vault.document.set" | "vault.document.delete" => {
            if !permission_granted(permissions, "vault.documents.write") {
                return Err("plugin lacks vault.documents.write permission".to_string());
            }
            Ok(())
        }
        "vault.blob.info" | "vault.blob.read" => {
            if !permission_granted(permissions, "vault.blobs.read") {
                return Err("plugin lacks vault.blobs.read permission".to_string());
            }
            Ok(())
        }
        "vault.blob.begin"
        | "vault.blob.write"
        | "vault.blob.commit"
        | "vault.blob.abort"
        | "vault.blob.delete" => {
            if !permission_granted(permissions, "vault.blobs.write") {
                return Err("plugin lacks vault.blobs.write permission".to_string());
            }
            Ok(())
        }
        "vault.request_access" => {
            if !permission_granted(permissions, "vault.access.request") {
                return Err("plugin lacks vault.access.request permission".to_string());
            }
            Ok(())
        }
        "file_associations.set" => Ok(()),
        "storage.get" | "storage.set" => {
            if !permission_granted(permissions, "storage.plugin") {
                return Err("plugin lacks storage.plugin permission".to_string());
            }
            Ok(())
        }
        "clipboard.write" => {
            if !permission_granted(permissions, "clipboard.write") {
                return Err("plugin lacks clipboard.write permission".to_string());
            }
            Ok(())
        }
        "file.open" => {
            if !permission_granted(permissions, "files.open") {
                return Err("plugin lacks files.open permission".to_string());
            }
            Ok(())
        }
        "folder.open" => {
            if !permission_granted(permissions, "folders.open") {
                return Err("plugin lacks folders.open permission".to_string());
            }
            Ok(())
        }
        "file.save" => {
            if !permission_granted(permissions, "files.save") {
                return Err("plugin lacks files.save permission".to_string());
            }
            Ok(())
        }
        "link.open" => {
            if !permission_granted(permissions, "links.open") {
                return Err("plugin lacks links.open permission".to_string());
            }
            Ok(())
        }
        "plugin.available" | "plugin.open_panel" => {
            if !permission_granted(permissions, "plugins.open") {
                return Err("plugin lacks plugins.open permission".to_string());
            }
            Ok(())
        }
        "network.interfaces" => {
            if !permission_granted(permissions, "network.inspect") {
                return Err("plugin lacks network.inspect permission".to_string());
            }
            Ok(())
        }
        other => Err(format!("unsupported host API method: {other}")),
    }
}
fn validate_link_open_params(params: &LinkOpenParams) -> Result<(), String> {
    let url = params.url.trim();
    if url.is_empty() || url.len() > 2048 {
        return Err("link.open URL is missing or too long".to_string());
    }
    if !url.starts_with("https://") {
        return Err("link.open only supports https URLs".to_string());
    }
    Ok(())
}

fn open_external_link(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("failed to open external link: {error}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("failed to open external link: {error}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("failed to open external link: {error}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("opening external links is not supported on this platform".to_string())
}

fn focused_dialog_parent(app_handle: &AppHandle) -> Option<tauri::WebviewWindow> {
    app_handle
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app_handle.get_webview_window("main"))
}

fn handle_plugin_request(
    app_handle: &AppHandle,
    plugin_id: &str,
    permissions: &[String],
    request: &PluginRequest,
) -> Result<serde_json::Value, String> {
    if request.method == "file_associations.set"
        && !crate::plugins::plugin_has_declared_file_handlers(plugin_id)?
    {
        return Err("plugin has not declared file handlers in its manifest".to_string());
    }
    if let Err(error) = validate_plugin_request(permissions, request) {
        log_vault_audit(plugin_id, &request.method, "denied");
        return Err(error);
    }
    match request.method.as_str() {
        "credentials.use" => {
            log_deprecated_vault_api(plugin_id, &request.method);
            let params: CredentialUseParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid credentials.use params: {error}"))?;
            validate_plugin_credential_ref(plugin_id, &params.credential_ref)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let secret = crate::vault::get_secret(&vault_state, &params.credential_ref)?
                .ok_or_else(|| "credential was not found".to_string())?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "secret": secret }))
        }
        "credentials.store" => {
            log_deprecated_vault_api(plugin_id, &request.method);
            let params: CredentialStoreParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid credentials.store params: {error}"))?;
            if params.secret.is_empty() {
                return Err("credential secret is required".to_string());
            }
            validate_plugin_credential_ref(plugin_id, &params.credential_ref)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            crate::vault::store_secret(&vault_state, params.credential_ref.clone(), params.secret)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "credentialRef": params.credential_ref }))
        }
        "vault.secret.get" => {
            let params: VaultKeyParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.secret.get params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let secret = crate::vault::get_secret(&vault_state, &vault_ref)?
                .ok_or_else(|| "Vault secret was not found".to_string())?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "secret": secret }))
        }
        "vault.secret.set" => {
            let params: VaultSecretSetParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.secret.set params: {error}"))?;
            if params.secret.is_empty() || params.secret.len() > 64 * 1024 {
                return Err("Vault secret is empty or exceeds 64 KiB".to_string());
            }
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            crate::vault::store_secret(&vault_state, vault_ref, params.secret)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "stored": true }))
        }
        "vault.secret.delete" => {
            let params: VaultKeyParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.secret.delete params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let deleted = crate::vault::delete_secret(&vault_state, &vault_ref)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "deleted": deleted }))
        }
        "vault.document.get" => {
            let params: VaultKeyParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.document.get params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let value = crate::vault::get_document(&vault_state, &vault_ref)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "value": value }))
        }
        "vault.document.set" => {
            let params: VaultDocumentSetParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.document.set params: {error}"))?;
            if params.value.len() > 16 * 1024 * 1024 {
                return Err("Vault document exceeds 16 MiB".to_string());
            }
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            crate::vault::store_document(&vault_state, vault_ref, params.value)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "stored": true }))
        }
        "vault.document.delete" => {
            let params: VaultKeyParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.document.delete params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let deleted = crate::vault::delete_document(&vault_state, &vault_ref)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "deleted": deleted }))
        }
        "vault.blob.begin" => {
            let params: VaultBlobBeginParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.begin params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let (upload_id, chunk_size, chunks) =
                crate::vault::begin_blob_upload(&vault_state, &vault_ref, params.size)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({
                "uploadId": upload_id,
                "chunkSize": chunk_size,
                "chunks": chunks
            }))
        }
        "vault.blob.write" => {
            let params: VaultBlobWriteParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.write params: {error}"))?;
            if params.data.len() > 2 * 1024 * 1024 {
                return Err("Vault blob chunk encoding exceeds the supported limit".to_string());
            }
            let bytes = STANDARD_NO_PAD
                .decode(params.data.as_bytes())
                .map_err(|_| "Vault blob chunk data is invalid".to_string())?;
            if bytes.len() > 1024 * 1024 {
                return Err("Vault blob chunk exceeds 1 MiB".to_string());
            }
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let written = crate::vault::write_blob_chunk(
                &vault_state,
                &vault_ref,
                &params.upload_id,
                params.index,
                &bytes,
            )?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "written": written }))
        }
        "vault.blob.commit" => {
            let params: VaultBlobUploadParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.commit params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let info =
                crate::vault::commit_blob_upload(&vault_state, &vault_ref, &params.upload_id)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({
                "stored": true,
                "size": info.size,
                "chunkSize": info.chunk_size,
                "chunks": info.chunks
            }))
        }
        "vault.blob.abort" => {
            let params: VaultBlobUploadParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.abort params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let aborted =
                crate::vault::abort_blob_upload(&vault_state, &vault_ref, &params.upload_id)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "aborted": aborted }))
        }
        "vault.blob.info" => {
            let params: VaultKeyParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.info params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let info = crate::vault::get_blob_info(&vault_state, &vault_ref)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(match info {
                Some(info) => serde_json::json!({
                    "exists": true,
                    "size": info.size,
                    "chunkSize": info.chunk_size,
                    "chunks": info.chunks
                }),
                None => serde_json::json!({ "exists": false }),
            })
        }
        "vault.blob.read" => {
            let params: VaultBlobReadParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.read params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let bytes = crate::vault::read_blob_chunk(&vault_state, &vault_ref, params.index)?;
            let data = STANDARD_NO_PAD.encode(bytes);
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "index": params.index, "data": data }))
        }
        "vault.blob.delete" => {
            let params: VaultKeyParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid vault.blob.delete params: {error}"))?;
            let vault_ref = plugin_vault_ref(plugin_id, &params.key)?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            let deleted = crate::vault::delete_blob(&vault_state, &vault_ref)?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "deleted": deleted }))
        }
        "vault.request_access" => {
            let params: VaultAccessRequestParams =
                serde_json::from_value(request.params.clone())
                    .map_err(|error| format!("invalid vault.request_access params: {error}"))?;
            let vault_state = app_handle.state::<crate::vault::VaultState>();
            crate::vault::request_plugin_access(
                app_handle,
                &vault_state,
                plugin_id,
                &params.reason,
            )?;
            log_vault_audit(plugin_id, &request.method, "allowed");
            Ok(serde_json::json!({ "unlocked": true }))
        }
        "file_associations.set" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params { extensions: Vec<String> }
            let params: Params = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid file association settings: {error}"))?;
            if params.extensions.len() > 64 {
                return Err("at most 64 file extensions may be associated".to_string());
            }
            let mut seen = std::collections::BTreeSet::new();
            let mut normalized = Vec::new();
            for extension in params.extensions {
                let extension = extension.trim_start_matches('.').to_ascii_lowercase();
                if extension.is_empty() || extension.len() > 16 ||
                    !extension.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
                    return Err(format!("invalid file extension: {extension}"));
                }
                if !seen.insert(extension.clone()) {
                    return Err(format!("duplicate file extension: {extension}"));
                }
                normalized.push(extension);
            }
            let old_plugin = crate::plugins::require_installed(plugin_id)?;
            if !old_plugin.enabled {
                return Err("plugin must be enabled to change file associations".to_string());
            }
            crate::file_associations::sync_plugin_handlers(&old_plugin, false)?;
            crate::plugins::plugin_storage_set(plugin_id, "file-associations-v1", &serde_json::json!({ "extensions": normalized }))?;
            let updated_plugin = crate::plugins::require_installed(plugin_id)?;
            crate::file_associations::sync_plugin_handlers(&updated_plugin, true)?;
            Ok(serde_json::json!({ "extensions": normalized }))
        }
        "storage.get" => {
            let params: StorageGetParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid storage.get params: {error}"))?;
            let value = crate::plugins::plugin_storage_get(plugin_id, &params.key)?;
            Ok(serde_json::json!({ "value": value }))
        }
        "storage.set" => {
            let params: StorageSetParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid storage.set params: {error}"))?;
            crate::plugins::plugin_storage_set(plugin_id, &params.key, &params.value)?;
            Ok(serde_json::json!({ "stored": true }))
        }
        "clipboard.write" => {
            let params: ClipboardWriteParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid clipboard.write params: {error}"))?;
            if params.text.len() > 4 * 1024 * 1024 {
                return Err("clipboard text exceeds 4 MiB".to_string());
            }
            let mut clipboard = arboard::Clipboard::new()
                .map_err(|error| format!("clipboard is unavailable: {error}"))?;
            clipboard
                .set_text(params.text)
                .map_err(|error| format!("failed to write clipboard: {error}"))?;
            Ok(serde_json::json!({ "copied": true }))
        }
        "file.open" => {
            let params: FileOpenParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid file.open params: {error}"))?;
            validate_file_open_params(&params)?;
            let mut dialog = rfd::FileDialog::new();
            if let Some(window) = focused_dialog_parent(app_handle) {
                dialog = dialog.set_parent(&window);
            }
            for filter in &params.filters {
                let extensions = filter
                    .extensions
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
            if params.multiple {
                let Some(paths) = dialog.pick_files() else {
                    return Ok(serde_json::json!({"opened":false}));
                };
                return Ok(serde_json::json!({
                    "opened": true,
                    "paths": paths
                        .iter()
                        .map(|path| path.to_string_lossy().to_string())
                        .collect::<Vec<_>>()
                }));
            }
            let Some(path) = dialog.pick_file() else {
                return Ok(serde_json::json!({"opened":false}));
            };
            Ok(serde_json::json!({"opened":true,"path":path.to_string_lossy()}))
        }
        "folder.open" => {
            let mut dialog = rfd::FileDialog::new();
            if let Some(window) = focused_dialog_parent(app_handle) {
                dialog = dialog.set_parent(&window);
            }
            let Some(path) = dialog.pick_folder() else {
                return Ok(serde_json::json!({"opened":false}));
            };
            Ok(serde_json::json!({"opened":true,"path":path.to_string_lossy()}))
        }
        "link.open" => {
            let params: LinkOpenParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid link.open params: {error}"))?;
            validate_link_open_params(&params)?;
            open_external_link(params.url.trim())?;
            Ok(serde_json::json!({ "opened": true }))
        }
        "file.save" => {
            let params: FileSaveParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid file.save params: {error}"))?;
            validate_file_save_params(&params)?;
            let mut dialog = rfd::FileDialog::new().set_file_name(&params.suggested_name);
            if let Some(window) = focused_dialog_parent(app_handle) {
                dialog = dialog.set_parent(&window);
            }
            for filter in &params.filters {
                let extensions = filter
                    .extensions
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
            let Some(path) = dialog.save_file() else {
                return Ok(serde_json::json!({"saved":false}));
            };
            fs::write(&path, params.content.as_bytes())
                .map_err(|error| format!("failed to save file: {error}"))?;
            Ok(serde_json::json!({"saved":true,"path":path.to_string_lossy()}))
        }
        "plugin.available" => {
            let params: PluginAvailableParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid plugin.available params: {error}"))?;
            Ok(serde_json::json!({
                "available": crate::plugins::plugin_available(&params.plugin_id)?
            }))
        }
        "plugin.open_panel" => {
            let params: PluginOpenPanelParams = serde_json::from_value(request.params.clone())
                .map_err(|error| format!("invalid plugin.open_panel params: {error}"))?;
            validate_plugin_open_panel_params(&params)?;
            let target = crate::plugins::require_installed(&params.plugin_id)?;
            if !target.enabled {
                return Err("target plugin is disabled".to_string());
            }
            if !target
                .manifest
                .contributes
                .panels
                .iter()
                .any(|panel| panel.id == params.panel_id)
            {
                return Err("target plugin panel is not declared".to_string());
            }
            app_handle
                .emit(
                    "remotehand-open-plugin-panel",
                    serde_json::json!({
                        "pluginId": params.plugin_id,
                        "panelId": params.panel_id,
                        "context": params.context
                    }),
                )
                .map_err(|error| format!("failed to request plugin panel: {error}"))?;
            Ok(serde_json::json!({ "opened": true }))
        }
        "network.interfaces" => {
            let mut grouped: BTreeMap<String, (Option<String>, Vec<serde_json::Value>)> =
                BTreeMap::new();
            for interface in getifaddrs::getifaddrs()
                .map_err(|error| format!("failed to enumerate network interfaces: {error}"))?
            {
                let entry = grouped
                    .entry(interface.name.clone())
                    .or_insert_with(|| (None, Vec::new()));
                if let Some(mac) = interface.address.mac_addr() {
                    entry.0 = Some(
                        mac.iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<Vec<_>>()
                            .join(":"),
                    );
                }
                if let Some(ip) = interface.address.ip_addr() {
                    let value = serde_json::json!({
                        "address": ip.to_string(),
                        "family": if ip.is_ipv4() { "ipv4" } else { "ipv6" },
                    });
                    if !entry.1.contains(&value) {
                        entry.1.push(value);
                    }
                }
            }
            let interfaces: Vec<serde_json::Value> = grouped
                .into_iter()
                .map(|(name, (mac_address, addresses))| {
                    serde_json::json!({
                        "name": name,
                        "macAddress": mac_address,
                        "addresses": addresses,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "interfaces": interfaces }))
        }
        _ => unreachable!("validated host API method"),
    }
}
fn start_reader(
    plugin_id: String,
    mut stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<BTreeMap<u64, mpsc::Sender<Result<PluginResponse, String>>>>>,
    permissions: Vec<String>,
    app_handle: AppHandle,
    stopping: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        loop {
            let payload = match read_frame(&mut stdout) {
                Ok(payload) => payload,
                Err(error) => {
                    fail_pending(&pending, error.clone());
                    log::warn!("Plugin runtime {plugin_id} reader stopped: {error}");
                    break;
                }
            };
            let value: serde_json::Value = match serde_json::from_slice(&payload) {
                Ok(value) => value,
                Err(error) => {
                    log::warn!("Plugin runtime {plugin_id} sent invalid JSON: {error}");
                    continue;
                }
            };
            let Some(message_type) = value.get("type").and_then(|value| value.as_str()) else {
                log::warn!("Plugin runtime {plugin_id} sent a message without type");
                continue;
            };

            match message_type {
                "plugin.response" => {
                    let response: PluginResponse = match serde_json::from_value(value) {
                        Ok(response) => response,
                        Err(error) => {
                            log::warn!("Plugin runtime {plugin_id} sent invalid response: {error}");
                            continue;
                        }
                    };
                    let sender = pending
                        .lock()
                        .ok()
                        .and_then(|mut guard| guard.remove(&response.request_id));
                    if let Some(sender) = sender {
                        let _ = sender.send(Ok(response));
                    } else {
                        log::warn!(
                            "Plugin runtime {plugin_id} returned unknown request id {}",
                            response.request_id
                        );
                    }
                }
                "plugin.event" => {
                    let event: PluginEvent = match serde_json::from_value(value) {
                        Ok(event) => event,
                        Err(error) => {
                            log::warn!("Plugin runtime {plugin_id} sent invalid event: {error}");
                            continue;
                        }
                    };
                    if event.message_type != "plugin.event" || !valid_message_name(&event.event) {
                        log::warn!("Plugin runtime {plugin_id} sent invalid event name");
                        continue;
                    }
                    if event.event == "tray.update" {
                        if !permission_granted(&permissions, "tray.contribute") {
                            log::warn!("Plugin runtime {plugin_id} attempted tray.update without tray.contribute");
                            continue;
                        }
                        if let Some(state) =
                            app_handle.try_state::<crate::startup_tray::StartupTrayState>()
                        {
                            if let Err(error) = state.sync_plugin_trays(
                                &app_handle,
                                &plugin_id,
                                event.payload.clone(),
                            ) {
                                log::warn!(
                                    "Plugin runtime {plugin_id} tray.update rejected: {error}"
                                );
                                continue;
                            }
                        }
                    } else if event.event == "notification.show" {
                        if !permission_granted(&permissions, "notifications.show") {
                            log::warn!("Plugin runtime {plugin_id} attempted notification.show without notifications.show");
                            continue;
                        }
                        if let Some(state) =
                            app_handle.try_state::<crate::startup_tray::StartupTrayState>()
                        {
                            if let Err(error) = state.show_plugin_notification(
                                &app_handle,
                                &plugin_id,
                                event.payload.clone(),
                            ) {
                                log::warn!("Plugin runtime {plugin_id} notification.show rejected: {error}");
                                continue;
                            }
                        }
                    }
                    let envelope = PluginEventEnvelope {
                        plugin_id: plugin_id.clone(),
                        event: event.event,
                        payload: event.payload,
                    };
                    if let Err(error) = app_handle.emit("remotehand-plugin-event", envelope) {
                        log::warn!("Failed to emit plugin event for {plugin_id}: {error}");
                    }
                }
                "plugin.request" => {
                    let request: PluginRequest = match serde_json::from_value(value) {
                        Ok(request) => request,
                        Err(error) => {
                            log::warn!(
                                "Plugin runtime {plugin_id} sent invalid host request: {error}"
                            );
                            continue;
                        }
                    };
                    let request_id = request.request_id;
                    let response = match handle_plugin_request(
                        &app_handle,
                        &plugin_id,
                        &permissions,
                        &request,
                    ) {
                        Ok(result) => HostResponse {
                            message_type: "host.response",
                            request_id,
                            ok: true,
                            result,
                            error: String::new(),
                        },
                        Err(error) => HostResponse {
                            message_type: "host.response",
                            request_id,
                            ok: false,
                            result: serde_json::Value::Null,
                            error,
                        },
                    };
                    let write_result = stdin
                        .lock()
                        .map_err(|_| "plugin stdin lock poisoned".to_string())
                        .and_then(|mut writer| write_frame(&mut *writer, &response));
                    if let Err(error) = write_result {
                        fail_pending(&pending, error.clone());
                        log::warn!("Plugin runtime {plugin_id} host response failed: {error}");
                        break;
                    }
                }
                other => {
                    log::warn!("Plugin runtime {plugin_id} sent unexpected message type {other}");
                }
            }
        }

        if !stopping.load(Ordering::SeqCst) {
            if let Some(state) = app_handle.try_state::<crate::startup_tray::StartupTrayState>() {
                state.hide_plugin_trays(&app_handle, &plugin_id);
            }
            let envelope = PluginEventEnvelope {
                plugin_id: plugin_id.clone(),
                event: "topbar.update".to_string(),
                payload: serde_json::json!({ "items": [] }),
            };
            let _ = app_handle.emit("remotehand-plugin-event", envelope);
            log::warn!("Plugin runtime {plugin_id} exited unexpectedly; plugin UI contributions were hidden");
        }
    });
}
const MAX_PANEL_SESSION_STATE_BYTES: usize = 256 * 1024;

fn panel_session_key(plugin_id: &str, panel_id: &str) -> Result<String, String> {
    if !valid_message_name(plugin_id) || !valid_message_name(panel_id) {
        return Err("invalid plugin panel session key".to_string());
    }
    Ok(format!("{plugin_id}:{panel_id}"))
}

#[tauri::command]
pub fn plugin_panel_session_get(
    state: tauri::State<'_, PluginRuntimeState>,
    plugin_id: String,
    panel_id: String,
) -> Result<serde_json::Value, String> {
    let key = panel_session_key(&plugin_id, &panel_id)?;
    let values = state
        .panel_session_state
        .lock()
        .map_err(|_| "plugin panel session state lock poisoned".to_string())?;
    Ok(values.get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub fn plugin_panel_session_set(
    state: tauri::State<'_, PluginRuntimeState>,
    plugin_id: String,
    panel_id: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let key = panel_session_key(&plugin_id, &panel_id)?;
    let mut values = state
        .panel_session_state
        .lock()
        .map_err(|_| "plugin panel session state lock poisoned".to_string())?;
    if value.is_null() {
        values.remove(&key);
        return Ok(());
    }
    let encoded = serde_json::to_vec(&value)
        .map_err(|error| format!("invalid plugin panel session state: {error}"))?;
    if encoded.len() > MAX_PANEL_SESSION_STATE_BYTES {
        return Err("plugin panel session state exceeds 256 KiB".to_string());
    }
    values.insert(key, value);
    Ok(())
}

const MAX_DETACHED_PLUGIN_CALLS: usize = 128;

fn validate_detached_call_id(call_id: &str) -> Result<(), String> {
    if call_id.len() < 8
        || call_id.len() > 96
        || !call_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid detached plugin call id".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_runtime_call_status(
    state: tauri::State<'_, PluginRuntimeState>,
    plugin_id: String,
    call_id: String,
) -> Result<serde_json::Value, String> {
    validate_detached_call_id(&call_id)?;
    let calls = state
        .detached_calls
        .lock()
        .map_err(|_| "detached plugin call lock poisoned".to_string())?;
    let call = calls
        .get(&call_id)
        .ok_or_else(|| "detached plugin call was not found".to_string())?;
    if call.plugin_id != plugin_id {
        return Err("detached plugin call belongs to another plugin".to_string());
    }
    Ok(match call.outcome.as_ref() {
        None => serde_json::json!({"status":"running"}),
        Some(Ok(result)) => serde_json::json!({"status":"completed","result":result}),
        Some(Err(error)) => serde_json::json!({"status":"failed","error":error}),
    })
}

#[tauri::command]
pub fn plugin_runtime_call_forget(
    state: tauri::State<'_, PluginRuntimeState>,
    plugin_id: String,
    call_id: String,
) -> Result<bool, String> {
    validate_detached_call_id(&call_id)?;
    let mut calls = state
        .detached_calls
        .lock()
        .map_err(|_| "detached plugin call lock poisoned".to_string())?;
    let Some(call) = calls.get(&call_id) else {
        return Ok(false);
    };
    if call.plugin_id != plugin_id {
        return Err("detached plugin call belongs to another plugin".to_string());
    }
    calls.remove(&call_id);
    Ok(true)
}

#[tauri::command]
pub async fn plugin_runtime_call_start(
    app: AppHandle,
    id: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !valid_message_name(&method) {
        return Err("invalid plugin method".to_string());
    }
    let call_id = {
        let runtime = app.state::<PluginRuntimeState>();
        let mut calls = runtime
            .detached_calls
            .lock()
            .map_err(|_| "detached plugin call lock poisoned".to_string())?;
        if calls.len() >= MAX_DETACHED_PLUGIN_CALLS {
            return Err("too many detached plugin calls are retained".to_string());
        }
        let sequence = runtime
            .next_detached_call_id
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_add(1);
        let call_id = format!("plugin-call-{sequence}");
        calls.insert(
            call_id.clone(),
            DetachedPluginCall {
                plugin_id: id.clone(),
                outcome: None,
            },
        );
        call_id
    };

    let task_app = app.clone();
    let task_call_id = call_id.clone();
    tauri::async_runtime::spawn(async move {
        let blocking_app = task_app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let runtime = blocking_app.state::<PluginRuntimeState>();
            runtime.call(&id, &method, params)
        })
        .await
        .map_err(|error| format!("Plugin runtime task failed: {error}"))
        .and_then(|value| value);

        let runtime = task_app.state::<PluginRuntimeState>();
        if let Ok(mut calls) = runtime.detached_calls.lock() {
            if let Some(call) = calls.get_mut(&task_call_id) {
                call.outcome = Some(result);
            }
        };
    });

    Ok(serde_json::json!({"callId":call_id}))
}

impl PluginRuntimeState {
    pub fn set_app_handle(&self, app_handle: AppHandle) -> Result<(), String> {
        let mut slot = self
            .app_handle
            .lock()
            .map_err(|_| "plugin runtime app handle lock poisoned".to_string())?;
        *slot = Some(app_handle);
        Ok(())
    }
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
        let app_handle = self
            .app_handle
            .lock()
            .map_err(|_| "plugin runtime app handle lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "plugin runtime app handle is unavailable".to_string())?;
        let (plugin_root, entrypoint) = resolve_entrypoint(plugin)?;

        let mut command = Command::new(&entrypoint);
        command
            .current_dir(&plugin_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("REMOTEHAND_PLUGIN_ID", &plugin.manifest.id)
            .env(
                "REMOTEHAND_PLUGIN_API_VERSION",
                PLUGIN_API_VERSION.to_string(),
            );
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
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

        let stdin = Arc::new(Mutex::new(stdin));
        let pending = Arc::new(Mutex::new(BTreeMap::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        start_reader(
            plugin.manifest.id.clone(),
            stdout,
            stdin.clone(),
            pending.clone(),
            plugin.manifest.permissions.clone(),
            app_handle,
            stopping.clone(),
        );

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "plugin runtime lock poisoned".to_string())?;
        sessions.insert(
            plugin.manifest.id.clone(),
            PluginSession {
                child,
                stdin,
                pending,
                next_request_id: 1,
                stopping,
                call_lock: Arc::new(Mutex::new(())),
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
        if !valid_message_name(method) {
            return Err("invalid plugin method".to_string());
        }

        let call_lock = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_poison| "plugin runtime lock poisoned".to_string())?;
            sessions
                .get(id)
                .ok_or_else(|| "plugin runtime is not running".to_string())?
                .call_lock
                .clone()
        };
        let _call_guard = call_lock
            .lock()
            .map_err(|_| "plugin call lock poisoned".to_string())?;

        let receiver = {
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

            let (sender, receiver) = mpsc::channel();
            session
                .pending
                .lock()
                .map_err(|_| "plugin pending request lock poisoned".to_string())?
                .insert(request_id, sender);

            let write_result = session
                .stdin
                .lock()
                .map_err(|_| "plugin stdin lock poisoned".to_string())
                .and_then(|mut writer| write_frame(&mut *writer, &request));
            if let Err(error) = write_result {
                if let Ok(mut pending) = session.pending.lock() {
                    pending.remove(&request_id);
                }
                return Err(error);
            }
            receiver
        };

        let response = receiver
            .recv()
            .map_err(|_| "plugin response channel closed".to_string())??;
        if response.message_type != "plugin.response" {
            return Err("plugin returned an unexpected message type".to_string());
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
        session.stopping.store(true, Ordering::SeqCst);
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
        fail_pending(&session.pending, "plugin runtime stopped".to_string());
        if let Ok(slot) = self.app_handle.lock() {
            if let Some(app_handle) = slot.as_ref() {
                if let Some(state) = app_handle.try_state::<crate::startup_tray::StartupTrayState>()
                {
                    state.hide_plugin_trays(app_handle, id);
                }
            }
        }
        log::info!("Plugin runtime {id} stopped");
        Ok(())
    }
}

#[tauri::command]
pub async fn plugin_runtime_call(
    app: AppHandle,
    id: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<PluginRuntimeState>();
        runtime.call(&id, &method, params)
    })
    .await
    .map_err(|error| format!("Plugin runtime task failed: {error}"))?
}
impl Drop for PluginRuntimeState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for (_, session) in sessions.iter_mut() {
                session.stopping.store(true, Ordering::SeqCst);
                let _ = session.child.kill();
                let _ = session.child.wait();
                fail_pending(&session.pending, "plugin runtime dropped".to_string());
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

    #[test]
    fn decodes_plugin_request() {
        let json = serde_json::json!({
            "type": "plugin.request",
            "requestId": 7,
            "method": "credentials.use",
            "params": { "credentialRef": "cred-1" }
        });
        let request: PluginRequest = serde_json::from_value(json).unwrap();
        assert_eq!(request.message_type, "plugin.request");
        assert_eq!(request.request_id, 7);
        assert_eq!(request.method, "credentials.use");
        assert_eq!(request.params["credentialRef"], "cred-1");
    }

    #[test]
    fn encodes_host_response() {
        let response = HostResponse {
            message_type: "host.response",
            request_id: 9,
            ok: true,
            result: serde_json::json!({ "secret": "value" }),
            error: String::new(),
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["type"], "host.response");
        assert_eq!(json["requestId"], 9);
        assert_eq!(json["ok"], true);
        assert_eq!(json["result"]["secret"], "value");
    }

    #[test]
    fn matches_permissions_exactly() {
        let permissions = vec!["network.connect".to_string(), "credentials.use".to_string()];
        assert!(permission_granted(&permissions, "credentials.use"));
        assert!(!permission_granted(&permissions, "credentials"));
        assert!(!permission_granted(&permissions, "storage.plugin"));
    }

    #[test]
    fn rejects_missing_host_api_permission() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 10,
            method: "credentials.use".to_string(),
            params: serde_json::json!({ "credentialRef": "cred-1" }),
        };
        let error = validate_plugin_request(&[], &request).unwrap_err();
        assert_eq!(error, "plugin lacks credentials.use permission");
    }

    #[test]
    fn validates_plugin_credential_namespace() {
        assert!(validate_plugin_credential_ref(
            "remotehand.vnc",
            "plugin:remotehand.vnc:profile-1"
        )
        .is_ok());
        let error =
            validate_plugin_credential_ref("remotehand.vnc", "plugin:other.plugin:profile-1")
                .unwrap_err();
        assert_eq!(error, "plugin credential ref must use its own namespace");
    }

    #[test]
    fn validates_credentials_store_permission() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 12,
            method: "credentials.store".to_string(),
            params: serde_json::json!({ "credentialRef": "cred-1", "secret": "secret" }),
        };
        let error = validate_plugin_request(&[], &request).unwrap_err();
        assert_eq!(error, "plugin lacks credentials.store permission");
        assert!(validate_plugin_request(&["credentials.store".to_string()], &request).is_ok());
    }

    #[test]
    fn validates_clipboard_write_permission() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 1,
            method: "clipboard.write".to_string(),
            params: serde_json::json!({ "text": "hello" }),
        };
        assert!(validate_plugin_request(&["clipboard.write".to_string()], &request).is_ok());
        assert!(validate_plugin_request(&[], &request).is_err());
    }

    #[test]
    fn validates_file_open_permission_and_params() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 1,
            method: "file.open".to_string(),
            params: serde_json::json!({ "filters": [{ "name": "Text", "extensions": ["txt", "md"] }] }),
        };
        assert!(validate_plugin_request(&["files.open".to_string()], &request).is_ok());
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "plugin lacks files.open permission"
        );
        let params: FileOpenParams = serde_json::from_value(request.params.clone()).unwrap();
        assert!(!params.multiple);
        assert!(validate_file_open_params(&params).is_ok());

        let multiple: FileOpenParams = serde_json::from_value(serde_json::json!({
            "multiple": true,
            "filters": [{ "name": "Images", "extensions": ["png", "jpg", "webp"] }]
        }))
        .unwrap();
        assert!(multiple.multiple);
        assert!(validate_file_open_params(&multiple).is_ok());
    }

    #[test]
    fn validates_folder_open_permission() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 3,
            method: "folder.open".to_string(),
            params: serde_json::json!({}),
        };
        assert!(validate_plugin_request(&["folders.open".to_string()], &request).is_ok());
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "plugin lacks folders.open permission"
        );
    }

    #[test]
    fn validates_link_open_permission_and_params() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 2,
            method: "link.open".to_string(),
            params: serde_json::json!({ "url": "https://aistudio.google.com/apikey" }),
        };
        assert!(validate_plugin_request(&["links.open".to_string()], &request).is_ok());
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "plugin lacks links.open permission"
        );
        let params: LinkOpenParams = serde_json::from_value(request.params.clone()).unwrap();
        assert!(validate_link_open_params(&params).is_ok());
        assert!(validate_link_open_params(&LinkOpenParams {
            url: "http://example.com".to_string()
        })
        .is_err());
        assert!(validate_link_open_params(&LinkOpenParams {
            url: "file:///etc/passwd".to_string()
        })
        .is_err());
    }

    #[test]
    fn validates_file_save_permission_and_params() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 1,
            method: "file.save".to_string(),
            params: serde_json::json!({ "suggestedName": "report.csv", "content": "a,b\n1,2", "filters": [{ "name": "CSV", "extensions": ["csv"] }] }),
        };
        assert!(validate_plugin_request(&["files.save".to_string()], &request).is_ok());
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "plugin lacks files.save permission"
        );
        let params: FileSaveParams = serde_json::from_value(request.params.clone()).unwrap();
        assert!(validate_file_save_params(&params).is_ok());
        let invalid = FileSaveParams {
            suggested_name: "../report.csv".into(),
            content: String::new(),
            filters: Vec::new(),
        };
        assert!(validate_file_save_params(&invalid).is_err());
    }

    #[test]
    fn validates_plugins_open_permission_and_params() {
        for method in ["plugin.available", "plugin.open_panel"] {
            let request = PluginRequest {
                message_type: "plugin.request".to_string(),
                request_id: 21,
                method: method.to_string(),
                params: serde_json::json!({}),
            };
            assert_eq!(
                validate_plugin_request(&[], &request).unwrap_err(),
                "plugin lacks plugins.open permission"
            );
            assert!(validate_plugin_request(&["plugins.open".to_string()], &request).is_ok());
        }

        let available: PluginAvailableParams =
            serde_json::from_value(serde_json::json!({ "pluginId": "remotehand.editor" })).unwrap();
        assert_eq!(available.plugin_id, "remotehand.editor");

        let valid: PluginOpenPanelParams = serde_json::from_value(serde_json::json!({
            "pluginId": "remotehand.editor",
            "panelId": "editor",
            "context": { "path": "C:/test.txt" }
        }))
        .unwrap();
        assert!(validate_plugin_open_panel_params(&valid).is_ok());

        let invalid_context = PluginOpenPanelParams {
            plugin_id: "remotehand.editor".to_string(),
            panel_id: "editor".to_string(),
            context: serde_json::json!("not-an-object"),
        };
        assert_eq!(
            validate_plugin_open_panel_params(&invalid_context).unwrap_err(),
            "plugin.open_panel context must be an object"
        );

        let oversized_context = PluginOpenPanelParams {
            plugin_id: "remotehand.editor".to_string(),
            panel_id: "editor".to_string(),
            context: serde_json::json!({ "data": "x".repeat(64 * 1024) }),
        };
        assert_eq!(
            validate_plugin_open_panel_params(&oversized_context).unwrap_err(),
            "plugin.open_panel context exceeds 64 KiB"
        );
    }

    #[test]
    fn validates_network_inspect_permission() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 1,
            method: "network.interfaces".to_string(),
            params: serde_json::json!({}),
        };
        assert!(validate_plugin_request(&["network.inspect".to_string()], &request).is_ok());
        assert!(validate_plugin_request(&[], &request).is_err());
    }

    #[test]
    fn validates_notification_permission_name() {
        assert!(permission_granted(
            &["notifications.show".to_string()],
            "notifications.show"
        ));
        assert!(!permission_granted(
            &["tray.contribute".to_string()],
            "notifications.show"
        ));
    }

    #[test]
    fn validates_plugin_storage_permission() {
        for method in ["storage.get", "storage.set"] {
            let request = PluginRequest {
                message_type: "plugin.request".to_string(),
                request_id: 14,
                method: method.to_string(),
                params: serde_json::json!({ "key": "profiles" }),
            };
            let error = validate_plugin_request(&[], &request).unwrap_err();
            assert_eq!(error, "plugin lacks storage.plugin permission");
            assert!(validate_plugin_request(&["storage.plugin".to_string()], &request).is_ok());
        }
    }

    #[test]
    fn validates_plugin_vault_access_request_permission() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 22,
            method: "vault.request_access".to_string(),
            params: serde_json::json!({ "reason": "Use the configured provider credential." }),
        };
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "plugin lacks vault.access.request permission"
        );
        assert!(validate_plugin_request(&["vault.access.request".to_string()], &request).is_ok());
        let params: VaultAccessRequestParams =
            serde_json::from_value(request.params.clone()).unwrap();
        assert_eq!(params.reason, "Use the configured provider credential.");
    }

    #[test]
    fn rejects_plugin_vault_unlock_api() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 13,
            method: "vault.unlock".to_string(),
            params: serde_json::json!({ "passphrase": "secret" }),
        };
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "unsupported host API method: vault.unlock"
        );
    }

    #[test]
    fn validates_scoped_vault_permissions_and_keys() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 15,
            method: "vault.secret.get".to_string(),
            params: serde_json::json!({ "key": "providers/gemini/api-key" }),
        };
        assert_eq!(
            validate_plugin_request(&[], &request).unwrap_err(),
            "plugin lacks vault.secrets.read permission"
        );
        assert!(validate_plugin_request(&["vault.secrets.read".to_string()], &request).is_ok());

        assert_eq!(
            plugin_vault_ref("remotehand.marielle-chat", "providers/gemini/api-key").unwrap(),
            "plugin:remotehand.marielle-chat/providers/gemini/api-key"
        );
        assert!(plugin_vault_ref("remotehand.marielle-chat", "../notes").is_err());
        assert!(plugin_vault_ref("remotehand.marielle-chat", "other:plugin").is_err());
    }

    #[test]
    fn validates_vault_blob_permissions() {
        let read = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 31,
            method: "vault.blob.read".to_string(),
            params: serde_json::json!({ "key": "attachment/a", "index": 0 }),
        };
        assert_eq!(
            validate_plugin_request(&[], &read).unwrap_err(),
            "plugin lacks vault.blobs.read permission"
        );
        assert!(validate_plugin_request(&["vault.blobs.read".to_string()], &read).is_ok());

        let write = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 32,
            method: "vault.blob.begin".to_string(),
            params: serde_json::json!({ "key": "attachment/a", "size": 10 }),
        };
        assert_eq!(
            validate_plugin_request(&[], &write).unwrap_err(),
            "plugin lacks vault.blobs.write permission"
        );
        assert!(validate_plugin_request(&["vault.blobs.write".to_string()], &write).is_ok());
        assert_eq!(
            plugin_vault_ref("remotehand.notes", "attachment/a").unwrap(),
            "plugin:remotehand.notes/attachment/a"
        );
    }

    #[test]
    fn keeps_legacy_vault_methods_inside_plugin_api_v1() {
        for (method, permission) in [
            ("credentials.use", "credentials.use"),
            ("credentials.store", "credentials.store"),
        ] {
            let request = PluginRequest {
                message_type: "plugin.request".to_string(),
                request_id: 23,
                method: method.to_string(),
                params: serde_json::json!({}),
            };
            assert!(validate_plugin_request(&[permission.to_string()], &request).is_ok());
        }
    }

    #[test]
    fn maps_vault_audit_actions_without_secret_references() {
        assert_eq!(vault_audit_action("vault.secret.get"), Some("secret.read"));
        assert_eq!(
            vault_audit_action("vault.document.set"),
            Some("document.write")
        );
        assert_eq!(
            vault_audit_action("vault.request_access"),
            Some("access.request")
        );
        assert_eq!(vault_audit_action("storage.get"), None);
    }

    #[test]
    fn rejects_unknown_host_api_method() {
        let request = PluginRequest {
            message_type: "plugin.request".to_string(),
            request_id: 11,
            method: "unknown.method".to_string(),
            params: serde_json::Value::Null,
        };
        let error = validate_plugin_request(&[], &request).unwrap_err();
        assert_eq!(error, "unsupported host API method: unknown.method");
    }

    #[test]
    fn validates_message_names() {
        assert!(valid_message_name("vnc.frame"));
        assert!(valid_message_name("runtime_ping-1"));
        assert!(!valid_message_name(""));
        assert!(!valid_message_name("VNC.Frame"));
        assert!(!valid_message_name("vnc/frame"));
    }
}
