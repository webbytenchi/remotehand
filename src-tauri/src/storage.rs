use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, env, fs, path::PathBuf};
use tauri::Manager;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub color_scheme: String,
    pub ui_font_family: String,
    pub ui_font_size: u8,
    pub terminal_theme: String,
    pub terminal_background: String,
    pub terminal_foreground: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u8,
    pub start_with_system: bool,
    pub start_minimized: bool,
    pub show_in_system_tray: bool,
    pub minimize_to_tray_on_close: bool,
    pub topbar_alignment: String,
    pub global_shortcut_enabled: bool,
    pub global_shortcut: String,
    pub function_key_shortcuts: BTreeMap<String, String>,
    pub vault_auto_lock_minutes: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            color_scheme: "blue".to_string(),
            ui_font_family: "Inter".to_string(),
            ui_font_size: 13,
            terminal_theme: "comfort".to_string(),
            terminal_background: "#11151a".to_string(),
            terminal_foreground: "#d8dde6".to_string(),
            terminal_font_family: "JetBrains Mono".to_string(),
            terminal_font_size: 13,
            start_with_system: false,
            start_minimized: false,
            show_in_system_tray: true,
            minimize_to_tray_on_close: false,
            topbar_alignment: "center".to_string(),
            global_shortcut_enabled: true,
            global_shortcut: "Ctrl+Shift+Space".to_string(),
            function_key_shortcuts: BTreeMap::from([(
                "core.commandPalette".to_string(),
                "Ctrl+F12".to_string(),
            )]),
            vault_auto_lock_minutes: 15,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UiContributionLayout {
    pub sidebar_order: Vec<String>,
    pub topbar_order: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivity {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<SavedConnection>,
}
fn data_root() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir.join("data"))
}
fn connections_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("connections").join("connections.json"))
}
fn workspace_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("workspaces").join("default.json"))
}
fn settings_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("config").join("settings.json"))
}
fn recent_activity_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("activity").join("recent.json"))
}
fn ui_contribution_layout_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("config").join("ui-contributions.json"))
}
#[tauri::command]
pub fn load_settings() -> Result<Settings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let path = settings_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve config directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn load_ui_contribution_layout() -> Result<UiContributionLayout, String> {
    let path = ui_contribution_layout_path()?;
    if !path.exists() {
        return Ok(UiContributionLayout::default());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_ui_contribution_layout(layout: UiContributionLayout) -> Result<(), String> {
    let path = ui_contribution_layout_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve config directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&layout).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_connections() -> Result<Vec<SavedConnection>, String> {
    let path = connections_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn save_connections(connections: Vec<SavedConnection>) -> Result<(), String> {
    let path = connections_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve connections directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&connections).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn load_recent_activities() -> Result<Vec<RecentActivity>, String> {
    let path = recent_activity_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn save_recent_activities(activities: Vec<RecentActivity>) -> Result<(), String> {
    let path = recent_activity_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve activity directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&activities).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn load_workspace() -> Result<Option<serde_json::Value>, String> {
    let path = workspace_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let workspace = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    Ok(Some(workspace))
}
fn apply_native_popout_geometry(
    workspace: &mut serde_json::Value,
    geometries: &[(f64, f64, f64, f64)],
) {
    let Some(popouts) = workspace
        .get_mut("popoutGroups")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };

    for (popout, (left, top, width, height)) in popouts.iter_mut().zip(geometries.iter()) {
        let Some(object) = popout.as_object_mut() else {
            continue;
        };
        object.insert(
            "position".to_string(),
            serde_json::json!({
                "left": left,
                "top": top,
                "width": width,
                "height": height,
            }),
        );
    }
}

#[tauri::command]
pub fn save_workspace(
    app: tauri::AppHandle,
    mut workspace: serde_json::Value,
) -> Result<(), String> {
    // Dockview reports popout screenX/screenY from the WebView document. On
    // Windows/WebView2 those coordinates can be offset from the native outer
    // window origin by non-client chrome, which caused a small down/right drift
    // every time the serialized position was restored and saved again. Replace
    // Dockview's popout geometry with the exact native window geometry before
    // persisting the workspace.
    let mut popouts: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("panel-popout-"))
        .collect();
    popouts.sort_by_key(|(label, _)| {
        label
            .strip_prefix("panel-popout-")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    });

    let geometries: Vec<_> = popouts
        .into_iter()
        .filter_map(|(_, window)| {
            let scale = window.scale_factor().ok()?;
            let position = window.outer_position().ok()?.to_logical::<f64>(scale);
            let size = window.inner_size().ok()?.to_logical::<f64>(scale);
            Some((position.x, position.y, size.width, size.height))
        })
        .collect();
    apply_native_popout_geometry(&mut workspace, &geometries);

    let path = workspace_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve workspace directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(&workspace).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}
#[tauri::command]
pub fn clear_workspace() -> Result<(), String> {
    let path = workspace_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_popout_geometry_replaces_serialized_browser_geometry_in_order() {
        let mut workspace = serde_json::json!({
            "popoutGroups": [
                { "position": { "left": 101, "top": 102, "width": 500, "height": 400 } },
                { "position": { "left": 201, "top": 202, "width": 600, "height": 450 } }
            ]
        });

        apply_native_popout_geometry(
            &mut workspace,
            &[
                (10.0, 20.0, 800.0, 600.0),
                (30.0, 40.0, 900.0, 700.0),
            ],
        );

        assert_eq!(
            workspace["popoutGroups"][0]["position"],
            serde_json::json!({ "left": 10.0, "top": 20.0, "width": 800.0, "height": 600.0 })
        );
        assert_eq!(
            workspace["popoutGroups"][1]["position"],
            serde_json::json!({ "left": 30.0, "top": 40.0, "width": 900.0, "height": 700.0 })
        );
    }

    #[test]
    fn saved_connection_serialization_never_contains_password_material() {
        let connection = SavedConnection {
            id: "server-1".to_string(),
            name: "Server 1".to_string(),
            host: "192.0.2.10".to_string(),
            port: 22,
            user: "admin".to_string(),
            credential_ref: Some("core:sftp/server-1/password".to_string()),
        };

        let serialized = serde_json::to_string(&connection).unwrap();
        let value: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(
            object.get("credentialRef").and_then(serde_json::Value::as_str),
            Some("core:sftp/server-1/password")
        );
        assert!(!object.contains_key("password"));
        assert!(!object.contains_key("secret"));
    }
}
