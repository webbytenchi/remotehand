use crate::vault::VaultState;
use crate::{plugins, vault};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Response, AppHandle, Emitter, State};
use tokio::{net::TcpStream, sync::mpsc};
use vnc::{PixelFormat, VncConnector, VncEncoding, VncEvent, X11Event};
const VNC_PLUGIN_ID: &str = "remotehand.vnc";
const MAX_FRAMEBUFFER_BYTES: usize = 256 * 1024 * 1024;
#[derive(Default)]
pub struct VncState {
    sessions: Arc<Mutex<BTreeMap<String, VncSession>>>,
}
struct VncSession {
    input: mpsc::Sender<VncInput>,
    framebuffer: Arc<Mutex<Framebuffer>>,
}
#[derive(Default)]
struct Framebuffer {
    width: u16,
    height: u16,
    generation: u64,
    rgba: Vec<u8>,
}
enum VncInput {
    Pointer { x: u16, y: u16, buttons: u8 },
    Key { keycode: u32, down: bool },
    Clipboard(String),
    FullRefresh,
    Close,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VncFrameEvent {
    session_id: String,
    width: u16,
    height: u16,
    generation: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VncStatusEvent {
    session_id: String,
    status: String,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncSessionInfo {
    session_id: String,
    width: u16,
    height: u16,
}
fn emit_status(app: &AppHandle, session_id: &str, status: &str, message: impl Into<String>) {
    let _ = app.emit(
        "vnc-status",
        VncStatusEvent {
            session_id: session_id.to_string(),
            status: status.to_string(),
            message: message.into(),
        },
    );
}
fn resize_framebuffer(
    framebuffer: &mut Framebuffer,
    width: u16,
    height: u16,
) -> Result<(), String> {
    let bytes = usize::from(width)
        .checked_mul(usize::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "VNC framebuffer dimensions overflow".to_string())?;
    if bytes > MAX_FRAMEBUFFER_BYTES {
        return Err("VNC framebuffer exceeds the 256 MiB safety limit".to_string());
    }
    framebuffer.width = width;
    framebuffer.height = height;
    framebuffer.rgba.resize(bytes, 0);
    framebuffer.generation = framebuffer.generation.wrapping_add(1);
    Ok(())
}
fn apply_raw(framebuffer: &mut Framebuffer, rect: vnc::Rect, data: &[u8]) -> Result<(), String> {
    let rect_bytes = usize::from(rect.width)
        .checked_mul(usize::from(rect.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "VNC update dimensions overflow".to_string())?;
    if data.len() != rect_bytes {
        return Err("VNC update payload size does not match rectangle".to_string());
    }
    let right = u32::from(rect.x) + u32::from(rect.width);
    let bottom = u32::from(rect.y) + u32::from(rect.height);
    if right > u32::from(framebuffer.width) || bottom > u32::from(framebuffer.height) {
        return Err("VNC update rectangle is outside the framebuffer".to_string());
    }
    let frame_width = usize::from(framebuffer.width);
    let row_bytes = usize::from(rect.width) * 4;
    for row in 0..usize::from(rect.height) {
        let source_start = row * row_bytes;
        let destination_pixel = (usize::from(rect.y) + row) * frame_width + usize::from(rect.x);
        let destination_start = destination_pixel * 4;
        framebuffer.rgba[destination_start..destination_start + row_bytes]
            .copy_from_slice(&data[source_start..source_start + row_bytes]);
    }
    framebuffer.generation = framebuffer.generation.wrapping_add(1);
    Ok(())
}
fn emit_frame(app: &AppHandle, session_id: &str, framebuffer: &Framebuffer) {
    let _ = app.emit(
        "vnc-frame",
        VncFrameEvent {
            session_id: session_id.to_string(),
            width: framebuffer.width,
            height: framebuffer.height,
            generation: framebuffer.generation,
        },
    );
}
async fn run_session(
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    password: Option<String>,
    framebuffer: Arc<Mutex<Framebuffer>>,
    allow_clipboard_read: bool,
    mut input_rx: mpsc::Receiver<VncInput>,
) {
    emit_status(
        &app,
        &session_id,
        "connecting",
        format!("Connecting to {host}:{port}"),
    );
    let result = async {
        let tcp = tokio::time::timeout(
            Duration::from_secs(15),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| "VNC TCP connection timed out".to_string())?
        .map_err(|error| format!("VNC TCP connection failed: {error}"))?;

        let auth_password = password.unwrap_or_default();
        let client = VncConnector::new(tcp)
            .set_auth_method(async move { Ok(auth_password) })
            .add_encoding(VncEncoding::Raw)
            .add_encoding(VncEncoding::DesktopSizePseudo)
            .allow_shared(true)
            .set_pixel_format(PixelFormat::rgba())
            .build()
            .map_err(|error| error.to_string())?
            .try_start()
            .await
            .map_err(|error| error.to_string())?
            .finish()
            .map_err(|error| error.to_string())?;

        emit_status(&app, &session_id, "connected", "Connected");
        let mut last_refresh = Instant::now() - Duration::from_millis(100);
        let mut last_permission_check = Instant::now();

        loop {
            while let Ok(input) = input_rx.try_recv() {
                match input {
                    VncInput::Pointer { x, y, buttons } => client
                        .input(X11Event::PointerEvent((x, y, buttons).into()))
                        .await
                        .map_err(|error| error.to_string())?,
                    VncInput::Key { keycode, down } => client
                        .input(X11Event::KeyEvent((keycode, down).into()))
                        .await
                        .map_err(|error| error.to_string())?,
                    VncInput::Clipboard(text) => client
                        .input(X11Event::CopyText(text))
                        .await
                        .map_err(|error| error.to_string())?,
                    VncInput::FullRefresh => client
                        .input(X11Event::FullRefresh)
                        .await
                        .map_err(|error| error.to_string())?,
                    VncInput::Close => {
                        let _ = client.close().await;
                        return Ok::<(), String>(());
                    }
                }
            }

            let mut changed = false;
            for _ in 0..64 {
                let event = match client.poll_event().await {
                    Ok(Some(event)) => event,
                    Ok(None) => break,
                    Err(error) => return Err(error.to_string()),
                };
                match event {
                    VncEvent::SetResolution(screen) => {
                        let mut guard = framebuffer
                            .lock()
                            .map_err(|_| "VNC framebuffer state is unavailable".to_string())?;
                        resize_framebuffer(&mut guard, screen.width, screen.height)?;
                        changed = true;
                    }
                    VncEvent::RawImage(rect, data) => {
                        let mut guard = framebuffer.lock().map_err(|error| {
                            drop(error);
                            "VNC framebuffer state is unavailable".to_string()
                        })?;
                        apply_raw(&mut guard, rect, &data)?;
                        changed = true;
                    }
                    VncEvent::Text(text) => {
                        if allow_clipboard_read {
                            let _ = app.emit(
                                "vnc-clipboard",
                                serde_json::json!({ "sessionId": session_id, "text": text }),
                            );
                        }
                    }
                    VncEvent::Bell => {
                        let _ =
                            app.emit("vnc-bell", serde_json::json!({ "sessionId": session_id }));
                    }
                    VncEvent::Error(message) => return Err(message),
                    _ => {}
                }
            }

            if changed {
                let guard = framebuffer
                    .lock()
                    .map_err(|_| "VNC framebuffer state is unavailable".to_string())?;
                emit_frame(&app, &session_id, &guard);
            }

            if last_permission_check.elapsed() >= Duration::from_secs(1) {
                require_vnc_plugin()?;
                last_permission_check = Instant::now();
            }

            if last_refresh.elapsed() >= Duration::from_millis(33) {
                client
                    .input(X11Event::Refresh)
                    .await
                    .map_err(|error| error.to_string())?;
                last_refresh = Instant::now();
            }

            tokio::time::sleep(Duration::from_millis(4)).await;
        }
    }
    .await;

    match result {
        Ok(()) => emit_status(&app, &session_id, "closed", "Disconnected"),
        Err(error) => emit_status(&app, &session_id, "error", error),
    }
}
fn require_vnc_plugin() -> Result<plugins::PluginInfo, String> {
    plugins::require_enabled_capabilities(
        VNC_PLUGIN_ID,
        &["connection-type", "dock-panel", "network"],
    )
}
fn session_input(state: &VncState, session_id: &str) -> Result<mpsc::Sender<VncInput>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "VNC session state is unavailable".to_string())?
        .get(session_id)
        .map(|session| session.input.clone())
        .ok_or_else(|| "VNC session not found".to_string())
}
#[tauri::command]
pub async fn vnc_start(
    app: AppHandle,
    state: State<VncState>,
    vault_state: State<VaultState>,
    session_id: String,
    host: String,
    port: u16,
    credential_ref: Option<String>,
) -> Result<VncSessionInfo, String> {
    let plugin = require_vnc_plugin()?;
    if session_id.trim().is_empty() || session_id.len() > 160 {
        return Err("invalid VNC session id".to_string());
    }
    if host.trim().is_empty() || host.len() > 253 {
        return Err("invalid VNC host".to_string());
    }
    if port == 0 {
        return Err("invalid VNC port".to_string());
    }
    if let Some(reference) = credential_ref.as_deref() {
        plugins::require_enabled_capabilities(VNC_PLUGIN_ID, &["credential-use"])?;
        validate_vnc_credential_ref(reference)?;
    }
    let allow_clipboard_read = plugin
        .manifest
        .capabilities
        .iter()
        .any(|item| item == "clipboard-read");
    let password = match credential_ref {
        Some(reference) => vault::get_secret(&vault_state, &reference)?
            .ok_or_else(|| "saved VNC credential was not found".to_string())
            .map(Some)?,
        None => None,
    };

    let framebuffer = Arc::new(Mutex::new(Framebuffer::default()));
    let (input_tx, input_rx) = mpsc::channel(256);

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "VNC session state is unavailable".to_string())?;
        if sessions.contains_key(&session_id) {
            return Err("VNC session already exists".to_string());
        }
        sessions.insert(
            session_id.clone(),
            VncSession {
                input: input_tx,
                framebuffer: framebuffer.clone(),
            },
        );
    }

    let sessions = state.sessions.clone();
    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        run_session(
            app,
            task_session_id.clone(),
            host,
            port,
            password,
            framebuffer,
            allow_clipboard_read,
            input_rx,
        )
        .await;
        if let Ok(mut guard) = sessions.lock() {
            guard.remove(&task_session_id);
        }
    });

    Ok(VncSessionInfo {
        session_id,
        width: 0,
        height: 0,
    })
}
#[tauri::command]
pub fn vnc_frame(state: State<VncState>, session_id: String) -> Result<Response, String> {
    require_vnc_plugin()?;
    let framebuffer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "VNC session state is unavailable".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| session.framebuffer.clone())
            .ok_or_else(|| "VNC session not found".to_string())?
    };
    let rgba = framebuffer
        .lock()
        .map_err(|_| "VNC framebuffer state is unavailable".to_string())?
        .rgba
        .clone();
    Ok(Response::new(rgba))
}
#[tauri::command]
pub async fn vnc_pointer(
    state: State<VncState>,
    session_id: String,
    x: u16,
    y: u16,
    buttons: u8,
) -> Result<(), String> {
    require_vnc_plugin()?;
    session_input(&state, &session_id)?
        .send(VncInput::Pointer { x, y, buttons })
        .await
        .map_err(|_| "VNC session is closed".to_string())
}
#[tauri::command]
pub async fn vnc_key(
    state: State<VncState>,
    session_id: String,
    keycode: u32,
    down: bool,
) -> Result<(), String> {
    require_vnc_plugin()?;
    session_input(&state, &session_id)?
        .send(VncInput::Key { keycode, down })
        .await
        .map_err(|error| {
            drop(error);
            "VNC session is closed".to_string()
        })
}
#[tauri::command]
pub async fn vnc_clipboard(
    state: State<VncState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    require_vnc_plugin()?;
    plugins::require_enabled_capabilities(VNC_PLUGIN_ID, &["clipboard-write"])?;
    if text.len() > 1024 * 1024 {
        return Err("VNC clipboard text is too large".to_string());
    }
    session_input(&state, &session_id)?
        .send(VncInput::Clipboard(text))
        .await
        .map_err(|_| "VNC session is closed".to_string())
}
#[tauri::command]
pub async fn vnc_refresh(state: State<VncState>, session_id: String) -> Result<(), String> {
    require_vnc_plugin()?;
    session_input(&state, &session_id)?
        .send(VncInput::FullRefresh)
        .await
        .map_err(|_| "VNC session is closed".to_string())
}
#[tauri::command]
pub async fn vnc_close(state: State<VncState>, session_id: String) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "VNC session state is unavailable".to_string())?
        .remove(&session_id);
    if let Some(session) = session {
        let _ = session.input.send(VncInput::Close).await;
    }
    Ok(())
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncSavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
}
fn vnc_connections_path() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir
        .join("data")
        .join("plugins")
        .join(VNC_PLUGIN_ID)
        .join("connections.json"))
}
fn validate_vnc_credential_ref(value: &str) -> Result<(), String> {
    if !value.starts_with("vnc:") || value.len() <= 4 || value.len() > 192 {
        return Err("invalid VNC credential reference".to_string());
    }
    Ok(())
}
fn validate_saved_connection(connection: &VncSavedConnection) -> Result<(), String> {
    if connection.id.trim().is_empty() || connection.id.len() > 160 {
        return Err("invalid VNC connection id".to_string());
    }
    if connection.name.trim().is_empty() || connection.name.len() > 160 {
        return Err("invalid VNC connection name".to_string());
    }
    if connection.host.trim().is_empty() || connection.host.len() > 253 {
        return Err("invalid VNC host".to_string());
    }
    if connection.port == 0 {
        return Err("invalid VNC port".to_string());
    }
    if let Some(reference) = connection.credential_ref.as_deref() {
        validate_vnc_credential_ref(reference)?;
    }
    Ok(())
}
#[tauri::command]
pub fn vnc_load_connections() -> Result<Vec<VncSavedConnection>, String> {
    require_vnc_plugin()?;
    plugins::require_enabled_capabilities(VNC_PLUGIN_ID, &["filesystem-read"])?;
    let path = vnc_connections_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > 1024 * 1024 {
        return Err("VNC connection data exceeds the 1 MiB safety limit".to_string());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let connections: Vec<VncSavedConnection> =
        serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    if connections.len() > 512 {
        return Err("too many saved VNC connections".to_string());
    }
    for connection in &connections {
        validate_saved_connection(connection)?;
    }
    Ok(connections)
}
#[tauri::command]
pub fn vnc_save_connections(connections: Vec<VncSavedConnection>) -> Result<(), String> {
    require_vnc_plugin()?;
    plugins::require_enabled_capabilities(VNC_PLUGIN_ID, &["filesystem-write"])?;
    if connections.len() > 512 {
        return Err("too many saved VNC connections".to_string());
    }
    for connection in &connections {
        validate_saved_connection(connection)?;
    }
    let path = vnc_connections_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve VNC plugin data directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&connections).map_err(|error| error.to_string())?;
    if contents.len() > 1024 * 1024 {
        return Err("VNC connection data exceeds the 1 MiB safety limit".to_string());
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn vnc_store_credential(
    state: State<VaultState>,
    credential_ref: String,
    secret: String,
) -> Result<(), String> {
    require_vnc_plugin()?;
    plugins::require_enabled_capabilities(VNC_PLUGIN_ID, &["credential-use"])?;
    validate_vnc_credential_ref(&credential_ref)?;
    vault::vault_store_secret(state, credential_ref, secret)
}
#[tauri::command]
pub fn vnc_delete_credential(
    state: State<VaultState>,
    credential_ref: String,
) -> Result<bool, String> {
    require_vnc_plugin()?;
    plugins::require_enabled_capabilities(VNC_PLUGIN_ID, &["credential-use"])?;
    validate_vnc_credential_ref(&credential_ref)?;
    vault::vault_delete_secret(state, credential_ref)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framebuffer_resize_and_raw_update_work() {
        let mut framebuffer = Framebuffer::default();
        resize_framebuffer(&mut framebuffer, 2, 2).expect("resize framebuffer");

        let rect = vnc::Rect {
            x: 1,
            y: 0,
            width: 1,
            height: 2,
        };
        let pixels = [10, 20, 30, 40, 50, 60, 70, 80];
        apply_raw(&mut framebuffer, rect, &pixels).expect("apply raw update");

        assert_eq!(framebuffer.rgba.len(), 16);
        assert_eq!(&framebuffer.rgba[4..8], &[10, 20, 30, 40]);
        assert_eq!(&framebuffer.rgba[12..16], &[50, 60, 70, 80]);
    }

    #[test]
    fn raw_update_rejects_out_of_bounds_rectangles() {
        let mut framebuffer = Framebuffer::default();
        resize_framebuffer(&mut framebuffer, 2, 2).expect("resize framebuffer");

        let rect = vnc::Rect {
            x: 2,
            y: 0,
            width: 1,
            height: 1,
        };
        let error = apply_raw(&mut framebuffer, rect, &[0, 0, 0, 0])
            .expect_err("out-of-bounds update must fail");

        assert!(error.contains("outside the framebuffer"));
    }

    #[test]
    fn vnc_credentials_are_namespaced() {
        assert!(validate_vnc_credential_ref("vnc:desktop-1").is_ok());
        assert!(validate_vnc_credential_ref("ssh:desktop-1").is_err());
        assert!(validate_vnc_credential_ref("vnc:").is_err());
    }

    #[test]
    fn saved_connections_validate_credential_namespace() {
        let valid = VncSavedConnection {
            id: "vnc-1".to_string(),
            name: "Desktop".to_string(),
            host: "127.0.0.1".to_string(),
            port: 5900,
            credential_ref: Some("vnc:vnc-1".to_string()),
        };
        assert!(validate_saved_connection(&valid).is_ok());

        let invalid = VncSavedConnection {
            credential_ref: Some("ssh:server-1".to_string()),
            ..valid
        };
        assert!(validate_saved_connection(&invalid).is_err());
    }
}
