//! Opt-in, process-owned, loopback-only read API for RemoteHand.
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const ROUTES: &[&str] = &[
    "/api/docs",
    "/api/openapi.json",
    "/api/v1/health",
    "/api/v1/core/status",
    "/api/v1/plugins",
    "/api/v1/routes",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    enabled: bool,
    running: bool,
    port: u16,
    url: Option<String>,
    error: Option<String>,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

struct Inner {
    server: Option<Running>,
    error: Option<String>,
    requested_port: u16,
    credential: Arc<Mutex<String>>,
}

pub struct ApiServerState {
    inner: Mutex<Inner>,
    started: Instant,
}

impl Default for ApiServerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                server: None,
                error: None,
                requested_port: 8765,
                credential: Arc::new(Mutex::new(String::new())),
            }),
            started: Instant::now(),
        }
    }
}

impl Drop for ApiServerState {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            stop_server(&mut inner);
        }
    }
}

fn stop_server(inner: &mut Inner) {
    if let Some(running) = inner.server.take() {
        running.stop.store(true, Ordering::Release);
        let _ = running.worker.join();
    }
}

fn token_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("missing executable directory")?
        .join("data").join("config").join("api-server-token"))
}

fn load_or_create_token() -> Result<String, String> {
    let path = token_path()?;
    if path.exists() {
        let value = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let value = value.trim().to_owned();
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("API token file is invalid; regenerate it from Settings".into());
        }
        return Ok(value);
    }
    create_token()
}

fn create_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let path = token_path()?;
    fs::create_dir_all(path.parent().ok_or("missing config directory")?)
        .map_err(|e| e.to_string())?;
    // Create the credentials file with owner-only permissions on Unix.
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
    Ok(token)
}

impl ApiServerState {
    pub fn configure(&self, enabled: bool, port: u16) -> Result<ApiStatus, String> {
        if !(1024..=65535).contains(&port) {
            return Err("API port must be between 1024 and 65535".into());
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.requested_port = port;
        if !enabled {
            stop_server(&mut inner);
            inner.error = None;
            return Ok(self.status_inner(&inner));
        }
        if inner.server.as_ref().is_some_and(|running| running.port == port) {
            return Ok(self.status_inner(&inner));
        }
        stop_server(&mut inner);
        let token = match load_or_create_token() {
            Ok(token) => token,
            Err(error) => { inner.error = Some(error.clone()); return Err(error); }
        };
        *inner.credential.lock().map_err(|e| e.to_string())? = token;
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!("Could not bind localhost port {port}: {error}");
                inner.error = Some(message.clone());
                return Err(message);
            }
        };
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let credentials = inner.credential.clone();
        let since = self.started;
        let worker = thread::Builder::new()
            .name("remotehand-api".into())
            .spawn(move || {
                while !stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => serve_connection(stream, &credentials, since),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(40));
                        }
                        Err(error) => {
                            log::warn!("API accept failed: {error}");
                            thread::sleep(Duration::from_millis(100));
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        inner.server = Some(Running { port, stop, worker });
        inner.error = None;
        Ok(self.status_inner(&inner))
    }

    fn status_inner(&self, inner: &Inner) -> ApiStatus {
        let port = inner.server.as_ref().map_or(inner.requested_port, |s| s.port);
        ApiStatus {
            enabled: inner.server.is_some(),
            running: inner.server.is_some(),
            port,
            url: inner.server.as_ref().map(|_| format!("http://127.0.0.1:{port}")),
            error: inner.error.clone(),
        }
    }

    pub fn status(&self) -> Result<ApiStatus, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(self.status_inner(&inner))
    }

    pub fn token(&self) -> Result<String, String> {
        load_or_create_token()
    }

    pub fn rotate_token(&self) -> Result<String, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let token = create_token()?;
        *inner.credential.lock().map_err(|e| e.to_string())? = token.clone();
        Ok(token)
    }
}

#[tauri::command]
pub fn api_server_configure(
    state: tauri::State<'_, ApiServerState>,
    enabled: bool,
    port: u16,
) -> Result<ApiStatus, String> {
    state.configure(enabled, port)
}

#[tauri::command]
pub fn api_server_status(state: tauri::State<'_, ApiServerState>) -> Result<ApiStatus, String> {
    state.status()
}

#[tauri::command]
pub fn api_server_token(state: tauri::State<'_, ApiServerState>) -> Result<String, String> {
    state.token()
}

#[tauri::command]
pub fn api_server_rotate_token(state: tauri::State<'_, ApiServerState>) -> Result<String, String> {
    state.rotate_token()
}

#[tauri::command]
pub fn api_server_open_docs(state: tauri::State<'_, ApiServerState>) -> Result<(), String> {
    let status = state.status()?;
    let url = status.url.ok_or("API server is not running")? + "/api/docs";
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer.exe");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    return Err("opening documentation is not supported on this platform".into());
    command.arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn authorized(provided: Option<&str>, expected: &str) -> bool {
    let Some(provided) = provided else { return false; };
    let Some(provided) = provided.strip_prefix("Bearer ") else { return false; };
    if expected.len() != provided.len() || expected.is_empty() { return false; }
    expected.bytes().zip(provided.bytes())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right)) == 0
}

fn openapi_spec() -> Value {
    let response = json!({
        "type": "object",
        "required": ["status", "data"],
        "properties": {
            "status": { "type": "string", "enum": ["ok"] },
            "data": { "type": "object" }
        }
    });
    let operation = |summary: &str, description: &str, authenticated: bool, data: Value| {
        let mut value = json!({
            "summary": summary,
            "description": description,
            "responses": {
                "200": {
                    "description": "Successful JSON response",
                    "content": {
                        "application/json": {
                            "schema": {
                                "allOf": [response.clone(), {
                                    "type": "object",
                                    "properties": { "data": data }
                                }]
                            }
                        }
                    }
                }
            }
        });
        if authenticated {
            value["security"] = json!([{ "bearerAuth": [] }]);
            value["responses"]["401"] = json!({ "description": "Missing or invalid bearer token" });
        }
        value
    };
    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "RemoteHand Core API",
            "version": "1.0.0",
            "description": "Opt-in, localhost-only read API. Runs only while RemoteHand is running. Plugin API publication and LAN access are not implemented yet."
        },
        "servers": [{ "url": "/", "description": "Current RemoteHand API listener" }],
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "Token from RemoteHand Settings > API Server"
                }
            }
        },
        "paths": {
            "/api/docs": {
                "get": {
                    "summary": "Interactive API documentation",
                    "description": "Local browser-based API explorer. No external assets or CDN.",
                    "responses": { "200": { "description": "HTML documentation page" } }
                }
            },
            "/api/openapi.json": {
                "get": {
                    "summary": "OpenAPI specification",
                    "description": "Machine-readable OpenAPI 3.0 specification, suitable for client code generators.",
                    "responses": { "200": { "description": "OpenAPI JSON document" } }
                }
            },
            "/api/v1/health": { "get": operation(
                "Service health", "Public localhost-only availability check.", false,
                json!({ "type": "object", "properties": { "service": { "type": "string", "example": "remotehand-api" } } })
            )},
            "/api/v1/core/status": { "get": operation(
                "Core application status", "RemoteHand version, operating system, and application uptime.", true,
                json!({ "type": "object", "properties": {
                    "application": { "type": "string", "example": "RemoteHand" },
                    "version": { "type": "string", "example": env!("CARGO_PKG_VERSION") },
                    "platform": { "type": "string", "example": "windows" },
                    "uptimeSeconds": { "type": "integer", "format": "int64", "minimum": 0 }
                } })
            )},
            "/api/v1/plugins": { "get": operation(
                "API-enabled plugins", "Currently returns an empty list until plugin API publication is implemented.", true,
                json!({ "type": "array", "items": { "type": "object" } })
            )},
            "/api/v1/routes": { "get": operation(
                "Route discovery", "Lists the currently active HTTP paths and their authentication requirements.", true,
                json!({ "type": "array", "items": {
                    "type": "object", "properties": {
                        "method": { "type": "string" },
                        "path": { "type": "string" },
                        "authRequired": { "type": "boolean" }
                    }
                } })
            )}
        }
    })
}

fn response_for(path: &str, auth: Option<&str>, expected: &str, since: Instant)
    -> (u16, Value)
{
    if path == "/api/docs" {
        return (200, json!({ "status": "ok" }));
    }
    if path == "/api/openapi.json" {
        return (200, openapi_spec());
    }
    if path == "/api/v1/health" {
        return (200, json!({ "status": "ok", "data": { "service": "remotehand-api" } }));
    }
    if !authorized(auth, expected) {
        return (401, json!({ "status": "error", "error": "unauthorized" }));
    }
    match path {
        "/api/v1/core/status" => (200, json!({
            "status": "ok", "data": {
                "application": "RemoteHand",
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "uptimeSeconds": since.elapsed().as_secs()
            }
        })),
        // Plugin API publication is not implemented yet. Do not expose plugin
        // package paths, permissions, or installed names prematurely.
        "/api/v1/plugins" => (200, json!({ "status": "ok", "data": [] })),
        "/api/v1/routes" => (200, json!({
            "status": "ok", "data": ROUTES.iter().map(|path| json!({
                "method": "GET", "path": path,
                "authRequired": *path != "/api/v1/health" && *path != "/api/docs" && *path != "/api/openapi.json"
            })).collect::<Vec<_>>()
        })),
        _ => (404, json!({ "status": "error", "error": "not_found" })),
    }
}

fn serve_connection(mut stream: TcpStream, credentials: &Arc<Mutex<String>>, since: Instant) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let mut buf = [0u8; 4096];
    let size = match stream.read(&mut buf) { Ok(size) => size, Err(_) => return };
    let request = match std::str::from_utf8(&buf[..size]) { Ok(value) => value, Err(_) => return };
    let mut lines = request.split("\r\n");
    let first = lines.next().unwrap_or("");
    let parts: Vec<&str> = first.split_whitespace().collect();
    let (code, body) = if !request.contains("\r\n\r\n") {
        (400, json!({ "status": "error", "error": "bad_request" }))
    } else if parts.len() != 3 || parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0" {
        (400, json!({ "status": "error", "error": "bad_request" }))
    } else if parts[0] != "GET" {
        (405, json!({ "status": "error", "error": "method_not_allowed" }))
    } else {
        let auth = lines.find_map(|line| line.split_once(':').and_then(|(name, value)| {
            name.eq_ignore_ascii_case("authorization").then_some(value.trim())
        }));
        let expected = match credentials.lock() { Ok(token) => token.clone(), Err(_) => return };
        response_for(parts[1], auth, &expected, since)
    };
    let is_docs = parts.len() == 3 && parts[0] == "GET" && parts[1] == "/api/docs"
        && request.contains("\r\n\r\n") && code == 200;
    let (code, body, content_type) = if is_docs {
        (200, include_str!("api_docs.html").to_owned(), "text/html; charset=utf-8")
    } else {
        (code, body.to_string(), "application/json; charset=utf-8")
    };
    let reason = match code { 200 => "OK", 400 => "Bad Request", 401 => "Unauthorized",
        404 => "Not Found", 405 => "Method Not Allowed", _ => "Error" };
    let headers = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n", body.len());
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_are_read_only_and_protected() {
        let since = Instant::now();
        assert_eq!(response_for("/api/v1/health", None, "secret", since).0, 200);
        for path in &ROUTES[3..] {
            assert_eq!(response_for(path, None, "secret", since).0, 401);
            assert_eq!(response_for(path, Some("Bearer secret"), "secret", since).0, 200);
        }
        assert_eq!(response_for("/api/docs", None, "secret", since).0, 200);
        assert_eq!(response_for("/api/openapi.json", None, "secret", since).0, 200);
        let spec = openapi_spec();
        for route in ROUTES {
            assert!(spec["paths"].get(route).is_some(), "Missing OpenAPI path: {route}");
        }
        assert_eq!(spec["openapi"], "3.0.3");
        assert_eq!(response_for("/api/v1/unknown", Some("Bearer secret"), "secret", since).0, 404);
        assert!(!authorized(Some("Bearer secrex"), "secret"));
    }
}
