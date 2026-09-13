use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
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
