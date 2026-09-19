use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};
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
        }
    }
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
#[tauri::command]
pub fn save_workspace(workspace: serde_json::Value) -> Result<(), String> {
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
