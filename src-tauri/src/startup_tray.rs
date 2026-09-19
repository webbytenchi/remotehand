use std::sync::{Arc, Mutex};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Window,
};
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone)]
pub struct StartupTrayState {
    tray: Arc<Mutex<Option<TrayIcon>>>,
    minimize_to_tray_on_close: Arc<Mutex<bool>>,
    show_in_system_tray: Arc<Mutex<bool>>,
}

impl Default for StartupTrayState {
    fn default() -> Self {
        Self {
            tray: Arc::new(Mutex::new(None)),
            minimize_to_tray_on_close: Arc::new(Mutex::new(false)),
            show_in_system_tray: Arc::new(Mutex::new(true)),
        }
    }
}

impl StartupTrayState {
    pub fn set_close_to_tray(&self, value: bool) {
        if let Ok(mut guard) = self.minimize_to_tray_on_close.lock() {
            *guard = value;
        }
    }

    pub fn close_to_tray(&self) -> bool {
        self.minimize_to_tray_on_close.lock().map(|guard| *guard).unwrap_or(false)
    }

    pub fn set_show_in_tray(&self, app: &AppHandle, value: bool) -> Result<(), String> {
        if let Ok(mut guard) = self.show_in_system_tray.lock() {
            *guard = value;
        }
        let tray = self.tray.lock().map_err(|_| "tray state lock poisoned".to_string())?;
        if let Some(tray) = tray.as_ref() {
            tray.set_visible(value).map_err(|error| error.to_string())?;
        }
        let _ = app.emit("remotehand-tray-visibility-changed", value);
        Ok(())
    }
}

pub fn install(app: &tauri::AppHandle, state: &StartupTrayState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let show_item = MenuItemBuilder::with_id("show", "Show RemoteHand").build(app)?;
    let home_item = MenuItemBuilder::with_id("home", "Home").build(app)?;
    let hide_item = MenuItemBuilder::with_id("hide", "Hide RemoteHand").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Exit").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &home_item, &hide_item, &separator, &quit_item])
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "default application icon is unavailable")?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("RemoteHand")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "hide" => hide_main(app),
            "home" => {
                show_main(app);
                let _ = app.emit("remotehand-tray-home", ());
            }
            "quit" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.destroy();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(&tray.app_handle());
            }
        })
        .build(app)?;

    tray.set_visible(
        state
            .show_in_system_tray
            .lock()
            .map(|guard| *guard)
            .unwrap_or(true),
    )?;

    if let Ok(mut guard) = state.tray.lock() {
        *guard = Some(tray);
    }
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn set_startup_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn startup_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_tray_visible(visible: bool, app: AppHandle, state: State<'_, StartupTrayState>) -> Result<(), String> {
    state.set_show_in_tray(&app, visible)
}

#[tauri::command]
pub fn set_close_to_tray(value: bool, state: State<'_, StartupTrayState>) -> Result<(), String> {
    state.set_close_to_tray(value);
    Ok(())
}

pub fn should_minimize_at_startup() -> bool {
    std::env::args().any(|arg| arg == "--autostart")
        && crate::storage::load_settings().map(|settings| settings.start_minimized).unwrap_or(false)
}

pub fn handle_close(_window: &Window, state: &StartupTrayState) -> bool {
    state.close_to_tray() && state.show_in_system_tray.lock().map(|guard| *guard).unwrap_or(false)
}
