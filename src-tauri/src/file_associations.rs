#[cfg(target_os = "windows")]
use base64::Engine as _;
#[cfg(target_os = "windows")]
use std::{env, fs, path::PathBuf, process::Command};
use crate::plugins::PluginInfo;

const SETTINGS_KEY: &str = "file-associations-v1";
const LEGACY_PROGID_PREFIX: &str = "RemoteHand.File.";
#[cfg(target_os = "windows")]
const FILE_ICON_BASE64: &str = "AAABAAEAICAAAAAAIABeAQAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAASVJREFUeJztl70KwjAQxy+lPkefLATplEUcHKTYQariWBx0Ekl9sr6GIuegkfjRtIkXBfEPgSZNer/eXS4twF9fFjM7XGb47gP3mwVrn9UgLjM8HE/ejcsMXV8i8qZtUD4eOnmSHMAVIgiAC0QwgK4QQQG6QAQHaIP4CIANIqY2VCxL630uMzSLFSnAdlW0zkkH+V3/YyFoktUDs3JHYmQy7PsB2BZSiSwEvTjq1Kr1HPAqAKIk7MURJEI5r0NEJMmB6Sh1Nq5FngO1Ek9jiVBQK3HzknlNXoi0QRuQqd8LASmAr5rc/mo8CAAAvNyWZhJqBTkLdNa3JWAwAA2hQWx6CsHjcdlF1XpuBbFB+P/FGEJE9CnFtRLf/x4g8QDAxQvOxhljZ6VlsnEoW3wLAAAAAElFTkSuQmCC";

pub fn open_file_path_from_args(args: &[String]) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--open-file" {
            return args.get(index + 1).filter(|value| !value.trim().is_empty()).cloned();
        }
        index += 1;
    }
    None
}

fn configured_extensions(plugin: &PluginInfo) -> Result<Option<Vec<String>>, String> {
    let Some(value) = crate::plugins::plugin_storage_get(&plugin.manifest.id, SETTINGS_KEY)? else {
        return Ok(None);
    };
    let extensions = value.get("extensions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "saved file association settings are invalid".to_string())?;
    let mut normalized = std::collections::BTreeSet::new();
    for value in extensions {
        let extension = value.as_str().ok_or_else(|| "saved file association extension is invalid".to_string())?
            .trim_start_matches('.').to_ascii_lowercase();
        if extension.is_empty() || extension.len() > 16 ||
            !extension.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
            return Err(format!("saved file association extension is invalid: {extension}"));
        }
        normalized.insert(extension);
    }
    Ok(Some(normalized.into_iter().collect()))
}

pub fn sync_plugin_handlers(plugin: &PluginInfo, enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (plugin, enabled);
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let configured = configured_extensions(plugin)?;
        // Associations are opt-in. A manifest declaration describes the UI's
        // available choices; it must not register anything until the user applies.
        let extensions = match configured {
            Some(extensions) => extensions,
            None if enabled => return Ok(()),
            None => plugin.manifest.file_handlers.iter()
                .flat_map(|handler| handler.extensions.iter())
                .map(|value| value.trim_start_matches('.').to_ascii_lowercase())
                .collect(),
        };
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        let executable = executable.to_string_lossy().to_string();
        let app_key = "HKCU\\Software\\Classes\\Applications\\remotehand.exe";
        let app_command_key = format!("{app_key}\\shell\\open\\command");
        let app_icon_key = format!("{app_key}\\DefaultIcon");
        let supported_types = format!("{app_key}\\SupportedTypes");
        let legacy_progid = format!("{LEGACY_PROGID_PREFIX}{}", plugin.manifest.id);
        let mut failures = Vec::new();

        if enabled {
            let command_value = format!("\"{}\" --open-file \"%1\"", executable);
            let icon_path = ensure_file_icon()?;
            let icon_value = format!("\"{}\",0", icon_path.to_string_lossy());
            if run_reg(&["add", app_key, "/v", "FriendlyAppName", "/t", "REG_SZ", "/d", "RemoteHand", "/f"]).is_err()
                || run_reg(&["add", &app_command_key, "/ve", "/t", "REG_SZ", "/d", &command_value, "/f"]).is_err()
                || run_reg(&["add", &app_icon_key, "/ve", "/t", "REG_SZ", "/d", &icon_value, "/f"]).is_err()
            {
                failures.push("application registration".to_string());
            }
        }

        for extension in &extensions {
            let dotted_extension = format!(".{extension}");
            let open_with = format!("HKCU\\Software\\Classes\\{dotted_extension}\\OpenWithProgids");
            if enabled {
                // SupportedTypes makes RemoteHand discoverable in Open with while
                // preserving the existing extension class and its friendly type name.
                if run_reg(&["add", &supported_types, "/v", &dotted_extension, "/t", "REG_SZ", "/d", "", "/f"]).is_err() {
                    failures.push(extension.clone());
                }
                let _ = run_reg(&["delete", &open_with, "/v", &legacy_progid, "/f"]);
            } else {
                let _ = run_reg(&["delete", &supported_types, "/v", &dotted_extension, "/f"]);
                let _ = run_reg(&["delete", &open_with, "/v", &legacy_progid, "/f"]);
            }
        }

        // Remove legacy registration created by earlier builds. Never modify
        // Windows' protected UserChoice keys or the extension's existing ProgID.
        let _ = run_reg(&["delete", &format!("HKCU\\Software\\Classes\\{legacy_progid}"), "/f"]);
        let _ = run_reg(&["delete", "HKCU\\Software\\RegisteredApplications", "/v", "RemoteHand", "/f"]);
        let _ = run_reg(&["delete", "HKCU\\Software\\RemoteHand\\Capabilities", "/f"]);

        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("could not register Windows file handlers for: {}", failures.join(", ")))
        }
    }
}

#[cfg(target_os = "windows")]
fn ensure_file_icon() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "LOCALAPPDATA is not set; cannot install the RemoteHand file icon".to_string())?;
    let icon_path = PathBuf::from(local_app_data).join("RemoteHand").join("icons").join("text-rh.ico");
    if let Some(parent) = icon_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("could not create file icon directory: {error}"))?;
    }
    let icon_bytes = base64::engine::general_purpose::STANDARD
        .decode(FILE_ICON_BASE64)
        .map_err(|error| format!("could not decode embedded file icon: {error}"))?;
    if fs::read(&icon_path).ok().as_deref() != Some(icon_bytes.as_slice()) {
        fs::write(&icon_path, icon_bytes).map_err(|error| format!("could not write RemoteHand file icon: {error}"))?;
    }
    Ok(icon_path)
}

#[cfg(target_os = "windows")]
fn run_reg(args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let status = Command::new("reg.exe").args(args).creation_flags(0x08000000).status()
        .map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("reg.exe exited with {status}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_association_argument_without_trusting_other_arguments() {
        assert_eq!(open_file_path_from_args(&["RemoteHand.exe".into(), "--open-file".into(), "C:\\work\\notes.txt".into()]), Some("C:\\work\\notes.txt".into()));
        assert_eq!(open_file_path_from_args(&["RemoteHand.exe".into(), "--autostart".into()]), None);
    }
}
