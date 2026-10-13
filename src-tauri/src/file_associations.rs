#[cfg(target_os = "windows")]
use std::{env, process::Command};
use crate::plugins::PluginInfo;

const SETTINGS_KEY: &str = "file-associations-v1";
const LEGACY_PROGID_PREFIX: &str = "RemoteHand.File.";

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
        let supported_types = format!("{app_key}\\SupportedTypes");
        let legacy_progid = format!("{LEGACY_PROGID_PREFIX}{}", plugin.manifest.id);
        let mut failures = Vec::new();

        // Register RemoteHand as an application that can open these extensions,
        // without making a RemoteHand-specific ProgID the file type itself.
        if enabled {
            let command_value = format!("\"{}\" --open-file \"%1\"", executable);
            let friendly_name = "RemoteHand";
            if run_reg(&["add", app_key, "/v", "FriendlyAppName", "/t", "REG_SZ", "/d", friendly_name, "/f"]).is_err()
                || run_reg(&["add", &app_command_key, "/ve", "/t", "REG_SZ", "/d", &command_value, "/f"]).is_err()
            {
                failures.push("application registration".to_string());
            }
        }

        for extension in &extensions {
            let dotted_extension = format!(".{extension}");
            let open_with = format!("HKCU\\Software\\Classes\\{dotted_extension}\\OpenWithProgids");
            if enabled {
                // SupportedTypes makes RemoteHand discoverable in Open with while
                // leaving the existing extension class and its friendly type name
                // untouched. Remove the old ProgID that surfaced as the file type.
                if run_reg(&["add", &supported_types, "/v", &dotted_extension, "/t", "REG_SZ", "/d", "", "/f"]).is_err() {
                    failures.push(extension.clone());
                }
                let _ = run_reg(&["delete", &open_with, "/v", &legacy_progid, "/f"]);
            } else {
                let _ = run_reg(&["delete", &supported_types, "/v", &dotted_extension, "/f"]);
                let _ = run_reg(&["delete", &open_with, "/v", &legacy_progid, "/f"]);
            }
        }

        // Remove the legacy ProgID and application-level association metadata
        // created by earlier builds. Do not touch Windows' protected UserChoice.
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
