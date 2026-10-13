#[cfg(target_os = "windows")]
use std::{env, process::Command};
use crate::plugins::PluginInfo;

const SETTINGS_KEY: &str = "file-associations-v1";

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
        let prog_id = format!("RemoteHand.File.{}", plugin.manifest.id);
        // Register only as an Open With candidate. Do not publish Windows
        // Capabilities\FileAssociations, which can make Explorer treat RemoteHand
        // as the file type's primary application and replace the existing icon.
        let capabilities = "HKCU\\Software\\RemoteHand\\Capabilities";
        let registered = "HKCU\\Software\\RegisteredApplications";
        let mut failures = Vec::new();
        for extension in &extensions {
            if enabled {
                let command_value = format!("\"{}\" --open-file \"%1\"", executable);
                let label = format!("Open with RemoteHand ({})", plugin.manifest.name);
                let commands = format!("HKCU\\Software\\Classes\\{}\\shell\\open\\command", prog_id);
                if run_reg(&["add", &format!("HKCU\\Software\\Classes\\{}", prog_id), "/ve", "/t", "REG_SZ", "/d", &label, "/f"]).is_err()
                    || run_reg(&["add", &commands, "/ve", "/t", "REG_SZ", "/d", &command_value, "/f"]).is_err()
                    || run_reg(&["add", &format!("HKCU\\Software\\Classes\\.{}\\OpenWithProgids", extension), "/v", &prog_id, "/t", "REG_NONE", "/f"]).is_err()
                {
                    failures.push(extension.clone());
                }
            } else {
                let open_with = format!("HKCU\\Software\\Classes\\.{}\\OpenWithProgids", extension);
                let file_associations = format!("{}\\FileAssociations", capabilities);
                let _ = run_reg(&["delete", &open_with, "/v", &prog_id, "/f"]);
                // Clean entries written by the previous registration implementation.
                let _ = run_reg(&["delete", &file_associations, "/v", &format!(".{}", extension), "/f"]);
            }
        }
        // Remove the legacy application-level registration created by earlier
        // builds. OpenWithProgids remains sufficient for "Open with" discovery.
        let _ = run_reg(&["delete", registered, "/v", "RemoteHand", "/f"]);
        let _ = run_reg(&["delete", capabilities, "/f"]);
        if !enabled {
            let _ = run_reg(&["delete", &format!("HKCU\\Software\\Classes\\{}", prog_id), "/f"]);
        }
        if failures.is_empty() { Ok(()) } else {
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
