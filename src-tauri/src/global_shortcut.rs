use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone, Default)]
pub struct GlobalShortcutState {
    registered: Arc<Mutex<Option<String>>>,
}

fn toggle_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is not available".to_string())?;

    let visible = window.is_visible().map_err(|error| error.to_string())?;
    let focused = window.is_focused().map_err(|error| error.to_string())?;

    if visible && focused {
        if let Some(tray_state) = app.try_state::<crate::startup_tray::StartupTrayState>() {
            if tray_state.show_in_tray() {
                window.hide().map_err(|error| error.to_string())?;
            } else {
                window.minimize().map_err(|error| error.to_string())?;
            }
            tray_state.sync_window_menu(app);
        } else {
            window.minimize().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    if window.is_minimized().map_err(|error| error.to_string())? {
        window.unminimize().map_err(|error| error.to_string())?;
    }

    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(tray_state) = app.try_state::<crate::startup_tray::StartupTrayState>() {
        tray_state.sync_window_menu(app);
    }
    window
        .emit("remotehand-global-shortcut-restored", ())
        .map_err(|error| error.to_string())
}

fn register(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }

            if let Err(error) = toggle_main_window(app) {
                log::warn!("Failed to toggle RemoteHand from global shortcut: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

pub fn configure(
    app: &AppHandle,
    state: &GlobalShortcutState,
    enabled: bool,
    shortcut: &str,
) -> Result<(), String> {
    let shortcut = shortcut.trim();
    if enabled && shortcut.is_empty() {
        return Err("shortcut cannot be empty".to_string());
    }

    let mut registered = state
        .registered
        .lock()
        .map_err(|_| "global shortcut state lock poisoned".to_string())?;

    if !enabled {
        if let Some(current) = registered.as_deref() {
            app.global_shortcut()
                .unregister(current)
                .map_err(|error| error.to_string())?;
        }
        *registered = None;
        return Ok(());
    }

    if registered.as_deref() == Some(shortcut) {
        return Ok(());
    }

    register(app, shortcut).map_err(|error| {
        format!("could not register {shortcut}: {error}")
    })?;

    if let Some(current) = registered.as_deref() {
        if let Err(error) = app.global_shortcut().unregister(current) {
            let _ = app.global_shortcut().unregister(shortcut);
            return Err(format!(
                "registered {shortcut}, but could not replace {current}: {error}"
            ));
        }
    }

    *registered = Some(shortcut.to_string());
    Ok(())
}

#[tauri::command]
pub fn set_global_shortcut(
    app: AppHandle,
    state: State<'_, GlobalShortcutState>,
    enabled: bool,
    shortcut: String,
) -> Result<(), String> {
    configure(&app, &state, enabled, &shortcut)
}
