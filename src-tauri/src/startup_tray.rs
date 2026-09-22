use std::{cell::RefCell, collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex}};

use serde::{Deserialize, Serialize};

use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Wry, Window,
};
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone)]
pub struct StartupTrayState {
    tray: Arc<Mutex<Option<TrayIcon>>>,
    window_item: Arc<Mutex<Option<MenuItem<Wry>>>>,
    minimize_to_tray_on_close: Arc<Mutex<bool>>,
    show_in_system_tray: Arc<Mutex<bool>>,
    plugin_tray_actions: Arc<Mutex<BTreeMap<String, PluginTrayAction>>>,
}

impl Default for StartupTrayState {
    fn default() -> Self {
        Self {
            tray: Arc::new(Mutex::new(None)),
            window_item: Arc::new(Mutex::new(None)),
            minimize_to_tray_on_close: Arc::new(Mutex::new(false)),
            show_in_system_tray: Arc::new(Mutex::new(true)),
            plugin_tray_actions: Arc::new(Mutex::new(BTreeMap::new())),
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

    pub fn sync_window_menu(&self, app: &AppHandle) {
        update_window_item(app, self);
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


#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginTrayAction {
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(default)]
    pub panel: String,
    #[serde(default)]
    pub context: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginTrayPoint {
    #[serde(default)]
    value: Option<f64>,
    #[serde(default)]
    tone: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginTrayItem {
    id: String,
    title: String,
    #[serde(default)]
    tooltip: String,
    #[serde(default)]
    tone: String,
    #[serde(default = "default_true")]
    visible: bool,
    #[serde(default)]
    series: Vec<PluginTrayPoint>,
    #[serde(default)]
    action: Option<PluginTrayAction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginTrayUpdate {
    #[serde(default)]
    items: Vec<PluginTrayItem>,
}

fn default_true() -> bool {
    true
}

fn valid_tray_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
}

fn tray_color(tone: &str) -> [u8; 4] {
    match tone {
        "success" => [56, 189, 126, 255],
        "warning" => [232, 176, 74, 255],
        "danger" => [226, 91, 91, 255],
        "accent" => [87, 156, 231, 255],
        _ => [155, 166, 180, 255],
    }
}

fn set_pixel(bytes: &mut [u8], x: usize, y: usize, color: [u8; 4]) {
    const SIZE: usize = 32;
    if x >= SIZE || y >= SIZE {
        return;
    }
    let offset = (y * SIZE + x) * 4;
    bytes[offset..offset + 4].copy_from_slice(&color);
}

fn plugin_tray_icon(item: &PluginTrayItem) -> Result<tray_icon::Icon, String> {
    const SIZE: usize = 32;
    let mut bytes = vec![0u8; SIZE * SIZE * 4];
    let border = [210, 218, 228, 210];
    for x in 3..29 {
        set_pixel(&mut bytes, x, 3, border);
        set_pixel(&mut bytes, x, 28, border);
    }
    for y in 3..29 {
        set_pixel(&mut bytes, 3, y, border);
        set_pixel(&mut bytes, 28, y, border);
    }

    let points = if item.series.len() > 12 {
        &item.series[item.series.len() - 12..]
    } else {
        &item.series[..]
    };
    let max = points
        .iter()
        .filter_map(|point| point.value)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .fold(1.0f64, f64::max);

    if points.is_empty() {
        let color = tray_color(&item.tone);
        for y in 13..19 {
            for x in 13..19 {
                set_pixel(&mut bytes, x, y, color);
            }
        }
    } else {
        let bar_width = 2usize;
        let total_width = points.len() * bar_width;
        let start_x = 16usize.saturating_sub(total_width / 2);
        for (index, point) in points.iter().enumerate() {
            let height = match point.value {
                Some(value) if value.is_finite() && value >= 0.0 => {
                    ((value / max) * 20.0).round().clamp(3.0, 20.0) as usize
                }
                _ => 3,
            };
            let color = tray_color(point.tone.as_deref().unwrap_or(&item.tone));
            let x0 = start_x + index * bar_width;
            for x in x0..(x0 + bar_width).min(28) {
                for y in (27usize.saturating_sub(height))..27 {
                    set_pixel(&mut bytes, x, y, color);
                }
            }
        }
    }

    tray_icon::Icon::from_rgba(bytes, SIZE as u32, SIZE as u32)
        .map_err(|error| error.to_string())
}

fn plugin_tray_key(plugin_id: &str, item_id: &str) -> String {
    format!("plugin-tray:{plugin_id}:{item_id}")
}

fn stable_plugin_tray_guid(key: &str) -> u128 {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;

    let mut hash = OFFSET;
    for byte in key.as_bytes() {
        hash ^= *byte as u128;
        hash = hash.wrapping_mul(PRIME);
    }

    let mut bytes = hash.to_be_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    u128::from_be_bytes(bytes)
}

thread_local! {
    static PLUGIN_TRAYS: RefCell<BTreeMap<String, tray_icon::TrayIcon>> =
        RefCell::new(BTreeMap::new());
}

fn apply_plugin_tray_update(plugin_id: &str, update: PluginTrayUpdate) -> Result<(), String> {
    PLUGIN_TRAYS.with(|slot| {
        let mut trays = slot.borrow_mut();
        let prefix = format!("plugin-tray:{plugin_id}:");
        let wanted: BTreeSet<String> = update
            .items
            .iter()
            .map(|item| plugin_tray_key(plugin_id, &item.id))
            .collect();

        let stale: Vec<String> = trays
            .keys()
            .filter(|key| key.starts_with(&prefix) && !wanted.contains(*key))
            .cloned()
            .collect();
        for key in stale {
            if let Some(tray) = trays.remove(&key) {
                let _ = tray.set_visible(false);
            }
        }

        for item in update.items {
            let key = plugin_tray_key(plugin_id, &item.id);
            let tooltip = if item.tooltip.is_empty() {
                item.title.clone()
            } else {
                item.tooltip.clone()
            };
            let icon = plugin_tray_icon(&item)?;

            if let Some(tray) = trays.get(&key) {
                tray.set_icon(Some(icon)).map_err(|error| error.to_string())?;
                tray.set_tooltip(Some(&tooltip)).map_err(|error| error.to_string())?;
                tray.set_visible(item.visible).map_err(|error| error.to_string())?;
                continue;
            }

            let tray = tray_icon::TrayIconBuilder::with_id(key.clone())
                .with_guid(stable_plugin_tray_guid(&key))
                .with_icon(icon)
                .with_tooltip(&tooltip)
                .with_menu_on_left_click(false)
                .with_menu_on_right_click(false)
                .build()
                .map_err(|error| error.to_string())?;
            tray.set_visible(item.visible).map_err(|error| error.to_string())?;
            trays.insert(key, tray);
        }

        Ok(())
    })
}

impl StartupTrayState {
    pub fn sync_plugin_trays(
        &self,
        app: &AppHandle,
        plugin_id: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let update: PluginTrayUpdate = serde_json::from_value(payload)
            .map_err(|error| format!("invalid tray.update payload: {error}"))?;
        if update.items.len() > 64 {
            return Err("tray.update exceeds the 64 item limit".to_string());
        }

        let mut seen = BTreeSet::new();
        for item in &update.items {
            if !valid_tray_id(&item.id) || !seen.insert(item.id.clone()) {
                return Err("tray.update contains an invalid or duplicate item id".to_string());
            }
            if item.title.trim().is_empty() || item.title.len() > 128 || item.tooltip.len() > 256 {
                return Err("tray.update contains invalid text".to_string());
            }
            if item.series.len() > 60 {
                return Err("tray.update series exceeds the 60 point limit".to_string());
            }
            if let Some(action) = item.action.as_ref() {
                if action.action_type != "open-panel"
                    || action.panel.is_empty()
                    || action.panel.len() > 128
                {
                    return Err("tray.update contains an unsupported action".to_string());
                }
            }
        }

        let prefix = format!("plugin-tray:{plugin_id}:");
        let mut actions = self
            .plugin_tray_actions
            .lock()
            .map_err(|_| "plugin tray action lock poisoned".to_string())?;
        actions.retain(|key, _| !key.starts_with(&prefix));
        for item in &update.items {
            if let Some(action) = item.action.clone() {
                actions.insert(plugin_tray_key(plugin_id, &item.id), action);
            }
        }
        drop(actions);

        let plugin_id = plugin_id.to_string();
        app.run_on_main_thread(move || {
            if let Err(error) = apply_plugin_tray_update(&plugin_id, update) {
                log::warn!("Failed to apply plugin tray update for {plugin_id}: {error}");
            }
        })
        .map_err(|error| error.to_string())
    }

    pub fn hide_plugin_trays(&self, app: &AppHandle, plugin_id: &str) {
        let prefix = format!("plugin-tray:{plugin_id}:");
        if let Ok(mut actions) = self.plugin_tray_actions.lock() {
            actions.retain(|key, _| !key.starts_with(&prefix));
        }

        let plugin_id = plugin_id.to_string();
        if let Err(error) = app.run_on_main_thread(move || {
            let prefix = format!("plugin-tray:{plugin_id}:");
            PLUGIN_TRAYS.with(|slot| {
                for (key, tray) in slot.borrow().iter() {
                    if key.starts_with(&prefix) {
                        let _ = tray.set_visible(false);
                    }
                }
            });
        }) {
            log::warn!("Failed to hide plugin trays for {plugin_id}: {error}");
        }
    }
}

pub fn handle_plugin_tray_event(app: &AppHandle, event: TrayIconEvent) {
    let TrayIconEvent::Click {
        id,
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    else {
        return;
    };

    let key = id.as_ref();
    let Some(rest) = key.strip_prefix("plugin-tray:") else {
        return;
    };
    let Some((plugin_id, item_id)) = rest.split_once(':') else {
        return;
    };

    let action = app
        .try_state::<StartupTrayState>()
        .and_then(|state| {
            state
                .plugin_tray_actions
                .lock()
                .ok()
                .and_then(|actions| actions.get(key).cloned())
        });

    show_main(app);
    if let Some(action) = action {
        let envelope = serde_json::json!({
            "pluginId": plugin_id,
            "event": "tray.action",
            "payload": {
                "itemId": item_id,
                "action": action,
            }
        });
        let _ = app.emit("remotehand-plugin-event", envelope);
    }
}

fn build_menu(app: &AppHandle<Wry>, window_item: &MenuItem<Wry>, home_item: &MenuItem<Wry>, connections_item: &MenuItem<Wry>, terminal_item: &MenuItem<Wry>, settings_item: &MenuItem<Wry>, separator: &PredefinedMenuItem<Wry>, quit_item: &MenuItem<Wry>) -> Result<tauri::menu::Menu<Wry>, Box<dyn std::error::Error + Send + Sync>> {
    Ok(MenuBuilder::new(app)
        .items(&[
            window_item,
            home_item,
            connections_item,
            terminal_item,
            settings_item,
            separator,
            quit_item,
        ])
        .build()?)
}

fn update_window_item(app: &AppHandle, state: &StartupTrayState) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(true);
    if let Ok(guard) = state.window_item.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(if visible { "Hide RemoteHand" } else { "Show RemoteHand" });
        }
    }
}

pub fn install(app: &tauri::AppHandle<Wry>, state: &StartupTrayState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(true);

    let window_item = MenuItemBuilder::with_id(
        "window",
        if visible { "Hide RemoteHand" } else { "Show RemoteHand" },
    ).build(app)?;
    let home_item = MenuItemBuilder::with_id("home", "Home").build(app)?;
    let connections_item = MenuItemBuilder::with_id("connections", "Connections").build(app)?;
    let terminal_item = MenuItemBuilder::with_id("terminal", "New Terminal").build(app)?;
    let settings_item = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Exit").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = build_menu(app, &window_item, &home_item, &connections_item, &terminal_item, &settings_item, &separator, &quit_item)?;

    if let Ok(mut guard) = state.window_item.lock() {
        *guard = Some(window_item.clone());
    }

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "default application icon is unavailable")?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("RemoteHand")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "window" => {
                    let visible = app
                        .get_webview_window("main")
                        .and_then(|window| window.is_visible().ok())
                        .unwrap_or(true);
                    if visible {
                        hide_main(app);
                    } else {
                        show_main(app);
                    }
                }
                "home" => {
                    show_main(app);
                    let _ = app.emit("remotehand-tray-home", ());
                }
                "connections" => {
                    show_main(app);
                    let _ = app.emit("remotehand-tray-connections", ());
                }
                "terminal" => {
                    show_main(app);
                    let _ = app.emit("remotehand-tray-terminal", ());
                }
                "settings" => {
                    show_main(app);
                    let _ = app.emit("remotehand-tray-settings", ());
                }
                "quit" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.destroy();
                    }
                    app.exit(0);
                }
                _ => {}
            }
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
    if let Some(state) = app.try_state::<StartupTrayState>() {
        update_window_item(app, &state);
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(state) = app.try_state::<StartupTrayState>() {
        update_window_item(app, &state);
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

#[cfg(test)]
mod plugin_tray_tests {
    use super::stable_plugin_tray_guid;

    #[test]
    fn plugin_tray_guid_is_stable_and_unique_per_item() {
        let a = stable_plugin_tray_guid("plugin-tray:remotehand.host-monitor:google-dns");
        let b = stable_plugin_tray_guid("plugin-tray:remotehand.host-monitor:google-dns");
        let c = stable_plugin_tray_guid("plugin-tray:remotehand.host-monitor:router");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn plugin_tray_guid_has_uuid_v5_variant_bits() {
        let bytes =
            stable_plugin_tray_guid("plugin-tray:remotehand.host-monitor:google-dns").to_be_bytes();
        assert_eq!(bytes[6] >> 4, 5);
        assert_eq!(bytes[8] >> 6, 2);
    }
}
