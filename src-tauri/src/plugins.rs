use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use zip::ZipArchive;
pub const PLUGIN_API_VERSION: u32 = 1;
const MAX_PLUGIN_FILES: usize = 2048;
const MAX_PLUGIN_COUNT: usize = 512;
const MAX_STATE_BYTES: u64 = 1024 * 1024;
const MAX_PLUGIN_STORAGE_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PLUGIN_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(test)]
const DEPRECATED_V1_PERMISSIONS: &[&str] = &["credentials.use", "credentials.store"];
const ALLOWED_PERMISSIONS: &[&str] = &[
    "network.connect",
    "network.inspect",
    "clipboard.read",
    "clipboard.write",
    "files.open",
    "files.save",
    "credentials.use",
    "credentials.store",
    "vault.secrets.read",
    "vault.secrets.write",
    "vault.documents.read",
    "vault.documents.write",
    "vault.blobs.read",
    "vault.blobs.write",
    "vault.access.request",
    "storage.plugin",
    "tray.contribute",
    "notifications.show",
    "plugins.open",
];
const ALLOWED_CONTRIBUTION_KINDS: &[&str] = &["sidebar", "panel", "command"];
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
    pub runtime: PluginRuntime,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: PluginContributions,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginRuntime {
    pub kind: String,
    pub entrypoints: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginContributions {
    #[serde(default)]
    pub sidebar: Vec<PluginContribution>,
    #[serde(default)]
    pub panels: Vec<PluginContribution>,
    #[serde(default)]
    pub commands: Vec<PluginContribution>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub panel: String,
    #[serde(default)]
    pub entry: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIconData {
    pub mime_type: String,
    pub bytes: Vec<u8>,
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
pub(crate) fn plugins_root_for_runtime() -> Result<PathBuf, String> {
    Ok(executable_dir()?.join("plugins"))
}

fn plugin_storage_root(plugin_id: &str) -> Result<PathBuf, String> {
    if !valid_identifier(plugin_id) {
        return Err("invalid plugin id".to_string());
    }
    Ok(executable_dir()?
        .join("data")
        .join("plugins")
        .join(plugin_id))
}

fn valid_storage_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

pub(crate) fn plugin_storage_get(
    plugin_id: &str,
    key: &str,
) -> Result<Option<serde_json::Value>, String> {
    if !valid_storage_key(key) {
        return Err("invalid plugin storage key".to_string());
    }
    let path = plugin_storage_root(plugin_id)?.join(format!("{key}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("plugin storage entry must be a regular file".to_string());
    }
    if metadata.len() > MAX_PLUGIN_STORAGE_ENTRY_BYTES {
        return Err("plugin storage entry exceeds 16 MiB".to_string());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("invalid plugin storage JSON: {error}"))
}

pub(crate) fn plugin_storage_set(
    plugin_id: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    if !valid_storage_key(key) {
        return Err("invalid plugin storage key".to_string());
    }
    let root = plugin_storage_root(plugin_id)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let contents = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    if contents.len() as u64 > MAX_PLUGIN_STORAGE_ENTRY_BYTES {
        return Err("plugin storage entry exceeds 16 MiB".to_string());
    }
    let path = root.join(format!("{key}.json"));
    let temporary = root.join(format!(".{key}.tmp"));
    fs::write(&temporary, &contents).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
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
    if manifest.runtime.kind != "executable" {
        return Err("plugin runtime kind must be 'executable'".to_string());
    }
    if manifest.runtime.entrypoints.is_empty() || manifest.runtime.entrypoints.len() > 16 {
        return Err(
            "plugin runtime must declare between 1 and 16 platform entrypoints".to_string(),
        );
    }
    for (target, entrypoint) in &manifest.runtime.entrypoints {
        if !valid_identifier(target) {
            return Err(format!("invalid plugin runtime target: {target}"));
        }
        validate_relative_package_path(entrypoint, "plugin runtime entrypoint")?;
    }
    if manifest.permissions.len() > 32 {
        return Err("plugin declares too many permissions".to_string());
    }
    let allowed: BTreeSet<&str> = ALLOWED_PERMISSIONS.iter().copied().collect();
    let mut seen = BTreeSet::new();
    for permission in &manifest.permissions {
        if !allowed.contains(permission.as_str()) {
            return Err(format!("unsupported plugin permission: {permission}"));
        }
        if !seen.insert(permission.as_str()) {
            return Err(format!("duplicate plugin permission: {permission}"));
        }
    }
    validate_contributions(&manifest.contributes)?;
    Ok(())
}

fn validate_relative_package_path(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is missing"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("{label} must stay inside the plugin package"));
    }
    Ok(())
}
fn validate_contribution_id(value: &str) -> bool {
    valid_identifier(value)
}
fn validate_contribution_icon(value: &str) -> Result<(), String> {
    if value.is_empty() || value == "monitor-pulse" {
        return Ok(());
    }
    validate_relative_package_path(value, "contribution icon")?;
    let extension = Path::new(value)
        .extension()
        .and_then(|item| item.to_str())
        .map(|item| item.to_ascii_lowercase())
        .ok_or_else(|| "contribution icon must use svg, png, or webp".to_string())?;
    if !matches!(extension.as_str(), "svg" | "png" | "webp") {
        return Err("contribution icon must use svg, png, or webp".to_string());
    }
    Ok(())
}
fn validate_contribution_list(
    kind: &str,
    values: &[PluginContribution],
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    if !ALLOWED_CONTRIBUTION_KINDS.contains(&kind) {
        return Err(format!("unsupported contribution kind: {kind}"));
    }
    for contribution in values {
        if !validate_contribution_id(&contribution.id) {
            return Err(format!("invalid {kind} contribution id"));
        }
        if contribution.title.trim().is_empty() || contribution.title.len() > 128 {
            return Err(format!("{kind} contribution title is missing or too long"));
        }
        let scoped = format!("{kind}:{}", contribution.id);
        if !seen.insert(scoped) {
            return Err(format!(
                "duplicate {kind} contribution id: {}",
                contribution.id
            ));
        }
        validate_contribution_icon(&contribution.icon)?;
        if !contribution.entry.is_empty() {
            validate_relative_package_path(&contribution.entry, "panel entry")?;
        }
        if kind == "sidebar" && contribution.panel.is_empty() {
            return Err("sidebar contribution must reference a panel".to_string());
        }
        if !contribution.panel.is_empty() && !validate_contribution_id(&contribution.panel) {
            return Err(format!("invalid {kind} panel reference"));
        }
    }
    Ok(())
}
fn validate_contributions(contributes: &PluginContributions) -> Result<(), String> {
    let total = contributes.sidebar.len() + contributes.panels.len() + contributes.commands.len();
    if total > 128 {
        return Err("plugin declares too many contributions".to_string());
    }
    let mut seen = BTreeSet::new();
    validate_contribution_list("sidebar", &contributes.sidebar, &mut seen)?;
    validate_contribution_list("panel", &contributes.panels, &mut seen)?;
    validate_contribution_list("command", &contributes.commands, &mut seen)?;
    let panel_ids: BTreeSet<&str> = contributes
        .panels
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    for sidebar in &contributes.sidebar {
        if !panel_ids.contains(sidebar.panel.as_str()) {
            return Err(format!(
                "sidebar contribution {} references unknown panel {}",
                sidebar.id, sidebar.panel
            ));
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
    let contents = strip_utf8_bom(&contents);
    let manifest: PluginManifest = serde_json::from_str(contents)
        .map_err(|error| format!("invalid plugin manifest: {error}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn strip_utf8_bom(value: &str) -> &str {
    let bom = char::from_u32(0xfeff).expect("valid BOM code point");
    value.strip_prefix(bom).unwrap_or(value)
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
            .map_err(|_| "plugin path escaped package root".to_string())?;
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

    let root = plugins_root_for_runtime()?;
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

fn safe_archive_entry_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\0') {
        return Err("plugin ZIP contains an invalid path".to_string());
    }
    // ZIP paths conventionally use '/', but normalize backslashes too so the
    // same archive cannot be safe on one platform and unsafe on another.
    let normalized = name.replace('\\', "/");
    let path = PathBuf::from(normalized);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("plugin ZIP contains an unsafe path: {name}"));
    }
    Ok(path)
}

fn install_from_zip(source: &Path) -> Result<PluginInfo, String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("selected plugin package must be a regular ZIP file".to_string());
    }

    let file = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("invalid plugin ZIP: {error}"))?;
    if archive.len() > MAX_PLUGIN_FILES {
        return Err(format!(
            "plugin ZIP contains more than {MAX_PLUGIN_FILES} entries"
        ));
    }

    let mut seen = BTreeSet::new();
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut has_root_manifest = false;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("cannot read plugin ZIP entry: {error}"))?;
        let relative = safe_archive_entry_path(entry.name())?;
        if !seen.insert(relative.clone()) {
            return Err(format!(
                "plugin ZIP contains a duplicate path: {}",
                relative.display()
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("plugin ZIP may not contain symbolic links".to_string());
        }
        if entry.is_file() {
            files += 1;
            bytes = bytes.saturating_add(entry.size());
            if files > MAX_PLUGIN_FILES {
                return Err(format!(
                    "plugin contains more than {MAX_PLUGIN_FILES} files"
                ));
            }
            if bytes > MAX_PLUGIN_BYTES {
                return Err(format!(
                    "plugin exceeds the {} MiB uncompressed size limit",
                    MAX_PLUGIN_BYTES / 1024 / 1024
                ));
            }
            if relative == Path::new("plugin.json") {
                has_root_manifest = true;
            }
        }
    }

    if !has_root_manifest {
        return Err("plugin ZIP must contain plugin.json at the archive root".to_string());
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = env::temp_dir().join(format!(
        "remotehand-plugin-install-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;

    let extract_result = (|| -> Result<(), String> {
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("cannot read plugin ZIP entry: {error}"))?;
            let relative = safe_archive_entry_path(entry.name())?;
            let destination = staging.join(&relative);
            if entry.is_dir() {
                fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = fs::File::create(&destination).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();

    if let Err(error) = extract_result {
        let _ = remove_tree_safe(&staging);
        return Err(error);
    }

    let install_result = install_from_directory(&staging);
    let cleanup_result = remove_tree_safe(&staging);
    match (install_result, cleanup_result) {
        (Ok(installed), _) => Ok(installed),
        (Err(error), _) => Err(error),
    }
}

fn discover_plugins() -> Result<Vec<PluginInfo>, String> {
    let root = plugins_root_for_runtime()?;
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
pub(crate) fn require_installed(id: &str) -> Result<PluginInfo, String> {
    if !valid_identifier(id) {
        return Err("invalid plugin id".to_string());
    }
    discover_plugins()?
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .ok_or_else(|| "plugin is not installed".to_string())
}

#[tauri::command]
pub fn plugin_install_from_zip() -> Result<Option<PluginInfo>, String> {
    let Some(source) = rfd::FileDialog::new()
        .set_title("Select RemoteHand plugin ZIP")
        .add_filter("RemoteHand plugin", &["zip"])
        .pick_file()
    else {
        return Ok(None);
    };
    let installed = install_from_zip(&source)?;
    log::info!("Plugin {} installed from ZIP", installed.manifest.id);
    Ok(Some(installed))
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

pub(crate) fn plugin_has_permission(id: &str, permission: &str) -> Result<bool, String> {
    if !ALLOWED_PERMISSIONS.contains(&permission) {
        return Err("unsupported plugin permission".to_string());
    }
    let plugin = require_installed(id)?;
    Ok(plugin.enabled
        && plugin
            .manifest
            .permissions
            .iter()
            .any(|value| value == permission))
}

pub(crate) fn plugin_available(id: &str) -> Result<bool, String> {
    if !valid_identifier(id) {
        return Ok(false);
    }
    Ok(discover_plugins()?
        .into_iter()
        .any(|plugin| plugin.manifest.id == id && plugin.enabled))
}
#[tauri::command]
pub fn plugin_read_panel_html(id: String, panel_id: String) -> Result<String, String> {
    const MAX_PANEL_HTML_BYTES: u64 = 2 * 1024 * 1024;
    let plugin = require_installed(&id)?;
    if !plugin.enabled {
        return Err("plugin is disabled".to_string());
    }
    let panel = plugin
        .manifest
        .contributes
        .panels
        .iter()
        .find(|panel| panel.id == panel_id)
        .ok_or_else(|| "plugin panel is not declared".to_string())?;
    if panel.entry.is_empty() {
        return Err("plugin panel entry is missing".to_string());
    }
    validate_relative_package_path(&panel.entry, "panel entry")?;
    let root = fs::canonicalize(plugins_root_for_runtime()?.join(&plugin.directory))
        .map_err(|error| error.to_string())?;
    let path = root.join(&panel.entry);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("plugin panel entry must be a regular file".to_string());
    }
    if metadata.len() > MAX_PANEL_HTML_BYTES {
        return Err("plugin panel HTML is too large".to_string());
    }
    let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("plugin panel entry escaped the plugin package".to_string());
    }
    fs::read_to_string(canonical).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_read_sidebar_icon(id: String, icon: String) -> Result<PluginIconData, String> {
    const MAX_PLUGIN_ICON_BYTES: u64 = 256 * 1024;
    let plugin = require_installed(&id)?;
    if !plugin.enabled {
        return Err("plugin is disabled".to_string());
    }
    let declared = plugin
        .manifest
        .contributes
        .sidebar
        .iter()
        .any(|sidebar| sidebar.icon == icon);
    if !declared {
        return Err("plugin sidebar icon is not declared".to_string());
    }
    validate_relative_package_path(&icon, "contribution icon")?;
    let extension = Path::new(&icon)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "plugin sidebar icon must use svg, png, or webp".to_string())?;
    let mime_type = match extension.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return Err("plugin sidebar icon must use svg, png, or webp".to_string()),
    };
    let root = fs::canonicalize(plugins_root_for_runtime()?.join(&plugin.directory))
        .map_err(|error| error.to_string())?;
    let path = root.join(&icon);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("plugin sidebar icon must be a regular file".to_string());
    }
    if metadata.len() > MAX_PLUGIN_ICON_BYTES {
        return Err("plugin sidebar icon exceeds 256 KiB".to_string());
    }
    let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("plugin sidebar icon escaped the plugin package".to_string());
    }
    let bytes = fs::read(canonical).map_err(|error| error.to_string())?;
    Ok(PluginIconData {
        mime_type: mime_type.to_string(),
        bytes,
    })
}

#[tauri::command]
pub fn plugin_set_enabled(
    id: String,
    enabled: bool,
    runtime: tauri::State<'_, crate::plugin_runtime::PluginRuntimeState>,
) -> Result<(), String> {
    let plugin = require_installed(&id)?;
    if enabled {
        runtime.start(&plugin)?;
    } else {
        runtime.stop(&id)?;
    }
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

pub fn start_enabled_plugins(
    runtime: &crate::plugin_runtime::PluginRuntimeState,
) -> Result<(), String> {
    for plugin in discover_plugins()? {
        if plugin.enabled {
            if let Err(error) = runtime.start(&plugin) {
                log::error!(
                    "Failed to start enabled plugin {}: {}",
                    plugin.manifest.id,
                    error
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let plugin = require_installed(&id)?;
    if plugin.enabled {
        return Err("disable the plugin before removing it".to_string());
    }
    let root = plugins_root_for_runtime()?;
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
    if let Some(tray_state) = app.try_state::<crate::startup_tray::StartupTrayState>() {
        tray_state.remove_plugin_trays(&app, &id);
    }
    log::info!("Plugin {} removed", id);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(id: &str, permissions: &[&str]) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: "Test Plugin".to_string(),
            version: "1.0.0".to_string(),
            api_version: PLUGIN_API_VERSION,
            author: "RemoteHand tests".to_string(),
            description: "test".to_string(),
            runtime: PluginRuntime {
                kind: "executable".to_string(),
                entrypoints: BTreeMap::from([(
                    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                    "bin/plugin".to_string(),
                )]),
            },
            permissions: permissions.iter().map(|value| value.to_string()).collect(),
            contributes: PluginContributions::default(),
        }
    }
    #[test]
    fn strips_utf8_bom() {
        let bom = char::from_u32(0xfeff).unwrap();
        let value = format!("{bom}hello");
        assert_eq!(strip_utf8_bom(&value), "hello");
    }

    #[test]
    fn accepts_valid_manifest() {
        assert!(validate_manifest(&manifest(
            "remotehand.test",
            &["network.connect", "storage.plugin"]
        ))
        .is_ok());
    }

    #[test]
    fn accepts_vault_permissions_without_bumping_plugin_api_v1() {
        assert_eq!(PLUGIN_API_VERSION, 1);
        assert!(validate_manifest(&manifest(
            "remotehand.test",
            &[
                "vault.secrets.read",
                "vault.secrets.write",
                "vault.documents.read",
                "vault.documents.write",
                "vault.blobs.read",
                "vault.blobs.write",
                "vault.access.request",
            ],
        ))
        .is_ok());
    }

    #[test]
    fn keeps_legacy_credential_permissions_for_v1_compatibility() {
        assert_eq!(DEPRECATED_V1_PERMISSIONS, &["credentials.use", "credentials.store"]);
        assert!(validate_manifest(&manifest(
            "remotehand.test",
            DEPRECATED_V1_PERMISSIONS,
        ))
        .is_ok());
    }

    #[test]
    fn accepts_plugins_open_permission() {
        assert!(validate_manifest(&manifest("remotehand.test", &["plugins.open"])).is_ok());
    }

    #[test]
    fn rejects_path_like_plugin_id() {
        let error = validate_manifest(&manifest("../escape", &[])).unwrap_err();
        assert!(error.contains("plugin id"));
    }

    #[test]
    fn rejects_unknown_permission() {
        let error = validate_manifest(&manifest("remotehand.test", &["shell-exec"])).unwrap_err();
        assert!(error.contains("unsupported plugin permission"));
    }

    #[test]
    fn rejects_duplicate_permission() {
        let error = validate_manifest(&manifest(
            "remotehand.test",
            &["network.connect", "network.connect"],
        ))
        .unwrap_err();
        assert!(error.contains("duplicate plugin permission"));
    }

    #[test]
    fn rejects_incompatible_api() {
        let mut item = manifest("remotehand.test", &[]);
        item.api_version = PLUGIN_API_VERSION + 1;
        let error = validate_manifest(&item).unwrap_err();
        assert!(error.contains("plugin API"));
    }

    #[test]
    fn contribution_icons_allow_legacy_or_supported_assets() {
        assert!(validate_contribution_icon("").is_ok());
        assert!(validate_contribution_icon("monitor-pulse").is_ok());
        assert!(validate_contribution_icon("assets/sidebar.svg").is_ok());
        assert!(validate_contribution_icon("assets/sidebar.png").is_ok());
        assert!(validate_contribution_icon("assets/sidebar.webp").is_ok());
        assert!(validate_contribution_icon("assets/sidebar.exe").is_err());
    }

    #[test]
    fn contribution_icons_stay_package_relative() {
        let mut item = manifest("remotehand.test", &[]);
        item.contributes.panels.push(PluginContribution {
            id: "panel".to_string(),
            title: "Panel".to_string(),
            icon: String::new(),
            panel: String::new(),
            entry: "ui/index.html".to_string(),
        });
        item.contributes.sidebar.push(PluginContribution {
            id: "sidebar".to_string(),
            title: "Sidebar".to_string(),
            icon: "../escape.svg".to_string(),
            panel: "panel".to_string(),
            entry: String::new(),
        });
        assert!(validate_manifest(&item).is_err());
    }

    #[test]
    fn enforces_plugin_package_limits() {
        assert_eq!(MAX_PLUGIN_FILES, 2048);
        assert_eq!(MAX_PLUGIN_COUNT, 512);
        assert_eq!(MAX_STATE_BYTES, 1024 * 1024);
        assert_eq!(MAX_PLUGIN_STORAGE_ENTRY_BYTES, 16 * 1024 * 1024);
        assert_eq!(MAX_PLUGIN_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn archive_paths_reject_traversal_and_absolute_paths() {
        assert_eq!(
            safe_archive_entry_path("plugin.json").unwrap(),
            PathBuf::from("plugin.json")
        );
        assert_eq!(
            safe_archive_entry_path("ui/index.html").unwrap(),
            PathBuf::from("ui/index.html")
        );
        assert!(safe_archive_entry_path("../plugin.json").is_err());
        assert!(safe_archive_entry_path("ui/../../plugin.json").is_err());
        assert!(safe_archive_entry_path("/plugin.json").is_err());
        assert!(safe_archive_entry_path("..\\plugin.json").is_err());
    }

    #[test]
    fn safe_directory_names_are_single_components() {
        assert!(safe_directory_name("remotehand.vnc"));
        assert!(!safe_directory_name("../remotehand.vnc"));
        assert!(!safe_directory_name("nested/plugin"));
    }
}
