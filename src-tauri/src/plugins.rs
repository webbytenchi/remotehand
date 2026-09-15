use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Component, Path, PathBuf},
};
pub const PLUGIN_API_VERSION: u32 = 1;
const MAX_PLUGIN_FILES: usize = 2048;
const MAX_PLUGIN_COUNT: usize = 512;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_PLUGIN_BYTES: u64 = 64 * 1024 * 1024;
const ALLOWED_CAPABILITIES: &[&str] = &[
    "connection-type",
    "dock-panel",
    "settings",
    "network",
    "clipboard-read",
    "clipboard-write",
    "filesystem-read",
    "filesystem-write",
    "credential-use",
];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub directory: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginState {
    #[serde(default)]
    enabled: BTreeMap<String, bool>,
}
fn executable_dir() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve executable directory".to_string())
}
fn plugins_root() -> Result<PathBuf, String> {
    Ok(executable_dir()?.join("plugins"))
}
fn state_path() -> Result<PathBuf, String> {
    Ok(executable_dir()?
        .join("data")
        .join("config")
        .join("plugins.json"))
}
fn load_state() -> Result<PluginState, String> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(PluginState::default());
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_STATE_BYTES {
        return Err("plugin state file is too large".to_string());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}
fn save_state(state: &PluginState) -> Result<(), String> {
    let path = state_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve plugin state directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}
fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    value.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
    })
}
fn valid_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}
fn safe_directory_name(value: &str) -> bool {
    let path = Path::new(value);
    let mut components = path.components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}
fn validate_manifest(manifest: &PluginManifest) -> Result<(), String> {
    if !valid_identifier(&manifest.id) {
        return Err("plugin id must use lowercase letters, numbers, '.', '-' or '_'".to_string());
    }
    if manifest.name.trim().is_empty() || manifest.name.len() > 128 {
        return Err("plugin name is missing or too long".to_string());
    }
    if !valid_version(&manifest.version) {
        return Err("plugin version contains unsupported characters".to_string());
    }
    if manifest.api_version != PLUGIN_API_VERSION {
        return Err(format!(
            "plugin requires RemoteHand plugin API {}, but this build supports {}",
            manifest.api_version, PLUGIN_API_VERSION
        ));
    }
    if manifest.author.trim().is_empty() || manifest.author.len() > 256 {
        return Err("plugin author is missing or too long".to_string());
    }
    if manifest.description.len() > 4096 {
        return Err("plugin description is too long".to_string());
    }
    if manifest.capabilities.len() > 32 {
        return Err("plugin declares too many capabilities".to_string());
    }
    let allowed: BTreeSet<&str> = ALLOWED_CAPABILITIES.iter().copied().collect();
    let mut seen = BTreeSet::new();
    for capability in &manifest.capabilities {
        if !allowed.contains(capability.as_str()) {
            return Err(format!("unsupported plugin capability: {capability}"));
        }
        if !seen.insert(capability.as_str()) {
            return Err(format!("duplicate plugin capability: {capability}"));
        }
    }
    Ok(())
}
fn read_manifest(plugin_dir: &Path) -> Result<PluginManifest, String> {
    let manifest_path = plugin_dir.join("plugin.json");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("plugin manifest must be a regular file".to_string());
    }
    if metadata.len() > 64 * 1024 {
        return Err("plugin manifest is too large".to_string());
    }
    let contents = fs::read_to_string(&manifest_path).map_err(|error| error.to_string())?;
    let manifest: PluginManifest = serde_json::from_str(&contents)
        .map_err(|error| format!("invalid plugin manifest: {error}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn remove_tree_safe(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("refusing to remove a symbolic link from a plugin tree".to_string());
    }
    if metadata.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("refusing to remove an unsupported plugin filesystem entry".to_string());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        remove_tree_safe(&entry.path())?;
    }
    fs::remove_dir(path).map_err(|error| error.to_string())
}

fn inspect_tree(
    root: &Path,
    current: &Path,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err("plugin packages may not contain symbolic links".to_string());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|| "plugin path escaped package root".to_string())?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("plugin contains an unsafe path".to_string());
        }
        if file_type.is_dir() {
            inspect_tree(root, &path, files, bytes)?;
        } else if file_type.is_file() {
            *files += 1;
            *bytes = bytes.saturating_add(metadata.len());
            if *files > MAX_PLUGIN_FILES {
                return Err(format!(
                    "plugin contains more than {MAX_PLUGIN_FILES} files"
                ));
            }
            if *bytes > MAX_PLUGIN_BYTES {
                return Err(format!(
                    "plugin exceeds the {} MiB size limit",
                    MAX_PLUGIN_BYTES / 1024 / 1024
                ));
            }
        } else {
            return Err("plugin contains an unsupported filesystem entry".to_string());
        }
    }
    Ok(())
}
fn copy_tree(source_root: &Path, current: &Path, destination_root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("plugin packages may not contain symbolic links".to_string());
        }
        let relative = source
            .strip_prefix(source_root)
            .map_err(|_| "plugin path escaped package root".to_string())?;
        let destination = destination_root.join(relative);
        if metadata.is_dir() {
            fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            copy_tree(source_root, &source, destination_root)?;
        } else if metadata.is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source, &destination).map_err(|error| error.to_string())?;
        } else {
            return Err("plugin contains an unsupported filesystem entry".to_string());
        }
    }
    Ok(())
}
fn install_from_directory(source: &Path) -> Result<PluginInfo, String> {
    let source_metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if !source_metadata.file_type().is_dir() || source_metadata.file_type().is_symlink() {
        return Err("selected plugin source must be a regular directory".to_string());
    }
    let manifest = read_manifest(source)?;
    let installed = discover_plugins()?;
    if installed
        .iter()
        .any(|plugin| plugin.manifest.id == manifest.id)
    {
        return Err("a plugin with this id is already installed".to_string());
    }

    let mut files = 0usize;
    let mut bytes = 0u64;
    inspect_tree(source, source, &mut files, &mut bytes)?;

    let root = plugins_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let source_canonical = fs::canonicalize(source).map_err(|error| error.to_string())?;
    let root_canonical = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    if source_canonical.starts_with(&root_canonical)
        || root_canonical.starts_with(&source_canonical)
    {
        return Err("plugin source overlaps the RemoteHand plugins directory".to_string());
    }
    let destination = root.join(&manifest.id);
    if destination.exists() {
        return Err("plugin destination already exists".to_string());
    }

    let staging = root.join(format!(".install-{}", manifest.id));
    if staging.exists() {
        remove_tree_safe(&staging)?;
    }
    fs::create_dir(&staging).map_err(|error| error.to_string())?;

    let copy_result = copy_tree(source, source, &staging);
    if let Err(error) = copy_result {
        let _ = remove_tree_safe(&staging);
        return Err(error);
    }

    if let Err(error) = read_manifest(&staging) {
        let _ = remove_tree_safe(&staging);
        return Err(format!("copied plugin failed validation: {error}"));
    }

    if let Err(error) = fs::rename(&staging, &destination) {
        let _ = remove_tree_safe(&staging);
        return Err(error.to_string());
    }

    Ok(PluginInfo {
        manifest,
        enabled: false,
        directory: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
    })
}

fn discover_plugins() -> Result<Vec<PluginInfo>, String> {
    let root = plugins_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let state = load_state()?;
    let mut plugins = Vec::new();
    let mut ids = BTreeSet::new();
    let mut scanned = 0usize;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        scanned += 1;
        if scanned > MAX_PLUGIN_COUNT {
            log::warn!("Plugin discovery stopped after {MAX_PLUGIN_COUNT} entries");
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let directory = entry.file_name().to_string_lossy().to_string();
        if !safe_directory_name(&directory) {
            continue;
        }
        let manifest = match read_manifest(&entry.path()) {
            Ok(manifest) => manifest,
            Err(error) => {
                log::warn!("Ignoring invalid plugin directory {directory}: {error}");
                continue;
            }
        };
        if !ids.insert(manifest.id.clone()) {
            log::warn!("Ignoring duplicate plugin id {}", manifest.id);
            continue;
        }
        plugins.push(PluginInfo {
            enabled: state.enabled.get(&manifest.id).copied().unwrap_or(false),
            manifest,
            directory,
        });
    }

    plugins.sort_by(|left, right| left.manifest.name.cmp(&right.manifest.name));
    Ok(plugins)
}
fn require_installed(id: &str) -> Result<PluginInfo, String> {
    if !valid_identifier(id) {
        return Err("invalid plugin id".to_string());
    }
    discover_plugins()?
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .ok_or_else(|| "plugin is not installed".to_string())
}

#[tauri::command]
pub fn plugin_install_from_folder() -> Result<Option<PluginInfo>, String> {
    let Some(source) = rfd::FileDialog::new()
        .set_title("Select RemoteHand plugin folder")
        .pick_folder()
    else {
        return Ok(None);
    };
    let installed = install_from_directory(&source)?;
    log::info!("Plugin {} installed from folder", installed.manifest.id);
    Ok(Some(installed))
}

#[tauri::command]
pub fn plugin_list() -> Result<Vec<PluginInfo>, String> {
    discover_plugins()
}
#[tauri::command]
pub fn plugin_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    require_installed(&id)?;
    let mut state = load_state()?;
    state.enabled.insert(id.clone(), enabled);
    save_state(&state)?;
    log::info!(
        "Plugin {} {}",
        id,
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}
#[tauri::command]
pub fn plugin_remove(id: String) -> Result<(), String> {
    let plugin = require_installed(&id)?;
    if plugin.enabled {
        return Err("disable the plugin before removing it".to_string());
    }
    let root = plugins_root()?;
    let path = root.join(&plugin.directory);
    if path.parent() != Some(root.as_path()) {
        return Err("refusing unsafe plugin path".to_string());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("refusing to remove an unsafe plugin path".to_string());
    }
    remove_tree_safe(&path)?;
    let mut state = load_state()?;
    state.enabled.remove(&id);
    save_state(&state)?;
    log::info!("Plugin {} removed", id);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(id: &str, capabilities: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: "Test Plugin".to_string(),
            version: "1.0.0".to_string(),
            api_version: PLUGIN_API_VERSION,
            author: "RemoteHand tests".to_string(),
            description: "test".to_string(),
            capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
        }
    }

    #[test]
    fn accepts_valid_manifest() {
        assert!(validate_manifest(&manifest(
            "remotehand.vnc",
            &["connection-type", "dock-panel", "network"]
        ))
        .is_ok());
    }

    #[test]
    fn rejects_path_like_plugin_id() {
        let error = validate_manifest(&manifest("../escape", &[])).unwrap_err();
        assert!(error.contains("plugin id"));
    }

    #[test]
    fn rejects_unknown_capability() {
        let error = validate_manifest(&manifest("remotehand.test", &["shell-exec"])).unwrap_err();
        assert!(error.contains("unsupported plugin capability"));
    }

    #[test]
    fn rejects_duplicate_capability() {
        let error =
            validate_manifest(&manifest("remotehand.test", &["network", "network"])).unwrap_err();
        assert!(error.contains("duplicate plugin capability"));
    }

    #[test]
    fn rejects_incompatible_api() {
        let mut item = manifest("remotehand.test", &[]);
        item.api_version = PLUGIN_API_VERSION + 1;
        let error = validate_manifest(&item).unwrap_err();
        assert!(error.contains("plugin API"));
    }

    #[test]
    fn enforces_plugin_package_limits() {
        assert_eq!(MAX_PLUGIN_FILES, 2048);
        assert_eq!(MAX_PLUGIN_COUNT, 512);
        assert_eq!(MAX_STATE_BYTES, 1024 * 1024);
        assert_eq!(MAX_PLUGIN_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn safe_directory_names_are_single_components() {
        assert!(safe_directory_name("remotehand.vnc"));
        assert!(!safe_directory_name("../remotehand.vnc"));
        assert!(!safe_directory_name("nested/plugin"));
    }
}
