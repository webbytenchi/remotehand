use serde::Serialize;
use tauri::{Emitter, WebviewWindow};

#[cfg(target_os = "windows")]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
        ICoreWebView2WebMessageReceivedEventArgs2,
    },
    take_pwstr, WebMessageReceivedEventHandler,
};
#[cfg(target_os = "windows")]
use windows::core::{Interface, PWSTR};

const DROP_MESSAGE_TYPE: &str = "remotehand.files.drop";
const MAX_DROP_FILES: u32 = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDropPayload {
    plugin_id: String,
    panel_id: String,
    paths: Vec<String>,
    position: NativeFileDropPosition,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct NativeFileDropPosition {
    x: f64,
    y: f64,
}

#[cfg(target_os = "windows")]
fn handle_web_message(
    window: &WebviewWindow,
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) -> Result<(), String> {
    let mut message_json = PWSTR::null();
    unsafe {
        args.WebMessageAsJson(&mut message_json)
            .map_err(|error| format!("cannot read WebView2 drop message: {error}"))?;
    }
    let message_json = take_pwstr(message_json);
    let message: serde_json::Value = serde_json::from_str(&message_json)
        .map_err(|error| format!("invalid WebView2 drop message JSON: {error}"))?;

    if message.get("type").and_then(serde_json::Value::as_str) != Some(DROP_MESSAGE_TYPE) {
        return Ok(());
    }

    let plugin_id = message
        .get("pluginId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let panel_id = message
        .get("panelId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let position = message.get("position").and_then(serde_json::Value::as_object);
    let x = position
        .and_then(|value| value.get("x"))
        .and_then(serde_json::Value::as_f64);
    let y = position
        .and_then(|value| value.get("y"))
        .and_then(serde_json::Value::as_f64);

    if plugin_id.is_empty() || panel_id.is_empty() || x.is_none() || y.is_none() {
        return Err("native file-drop message is missing plugin, panel, or position".to_string());
    }

    if !crate::plugins::plugin_has_permission(
        plugin_id.to_string(),
        "files.open".to_string(),
    )? {
        return Err(format!(
            "plugin {plugin_id} is not enabled with files.open permission"
        ));
    }

    let args2: ICoreWebView2WebMessageReceivedEventArgs2 = args
        .cast()
        .map_err(|error| format!("WebView2 does not expose additional drop objects: {error}"))?;
    let objects = unsafe {
        args2
            .AdditionalObjects()
            .map_err(|error| format!("cannot read WebView2 drop objects: {error}"))?
    };

    let mut count = 0u32;
    unsafe {
        objects
            .Count(&mut count)
            .map_err(|error| format!("cannot count WebView2 drop objects: {error}"))?;
    }
    if count == 0 {
        return Ok(());
    }
    if count > MAX_DROP_FILES {
        return Err(format!(
            "native file drop contains too many files ({count}; maximum {MAX_DROP_FILES})"
        ));
    }

    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let object = unsafe {
            objects
                .GetValueAtIndex(index)
                .map_err(|error| format!("cannot read dropped object {index}: {error}"))?
        };
        let file: ICoreWebView2File = match object.cast() {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut path = PWSTR::null();
        unsafe {
            file.Path(&mut path)
                .map_err(|error| format!("cannot read dropped file path: {error}"))?;
        }
        let path = take_pwstr(path);
        if !path.trim().is_empty() {
            paths.push(path);
        }
    }

    if paths.is_empty() {
        return Ok(());
    }

    window
        .emit(
            "remotehand-native-file-drop",
            NativeFileDropPayload {
                plugin_id: plugin_id.to_string(),
                panel_id: panel_id.to_string(),
                paths,
                position: NativeFileDropPosition {
                    x: x.unwrap_or_default(),
                    y: y.unwrap_or_default(),
                },
            },
        )
        .map_err(|error| format!("cannot deliver native file drop: {error}"))
}

#[cfg(target_os = "windows")]
pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let event_window = window.clone();
    window
        .with_webview(move |platform_webview| {
            let core = unsafe { platform_webview.controller().CoreWebView2() };
            let core = match core {
                Ok(core) => core,
                Err(error) => {
                    log::error!("Failed to access WebView2 for native file drops: {error}");
                    return;
                }
            };

            let handler_window = event_window.clone();
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    if let Err(error) = handle_web_message(&handler_window, &args) {
                        log::warn!("Native file-drop message rejected: {error}");
                    }
                }
                Ok(())
            }));

            let mut token = 0i64;
            if let Err(error) = unsafe { core.add_WebMessageReceived(&handler, &mut token) } {
                log::error!("Failed to register WebView2 native file-drop handler: {error}");
            }
        })
        .map_err(|error| format!("cannot access native webview for file drops: {error}"))
}

#[cfg(not(target_os = "windows"))]
pub fn install(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}
