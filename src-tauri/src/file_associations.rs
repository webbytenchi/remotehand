#[cfg(target_os = "windows")]
use std::{env, process::Command};
use crate::plugins::PluginInfo;

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

pub fn sync_plugin_handlers(plugin: &PluginInfo, enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (plugin, enabled);
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let executable = env::current_exe().map_err(|error| error.to_string())?;
        let executable = executable.to_string_lossy().to_string();
        let prog_id = format!("RemoteHand.File.{}", plugin.manifest.id);
        let capabilities = "HKCU\\Software\\RemoteHand\\Capabilities";
        let registered = "HKCU\\Software\\RegisteredApplications";
        let mut failures = Vec::new();
        for handler in &plugin.manifest.file_handlers {
            for extension in &handler.extensions {
                let extension = extension.trim_start_matches('.').to_ascii_lowercase();
                if enabled {
                    let command_value = format!("\"{}\" --open-file \"%1\"", executable);
                    let label = format!("Open with RemoteHand ({})", plugin.manifest.name);
                    let commands = format!("HKCU\\Software\\Classes\\{}\\shell\\open\\command", prog_id);
                    if run_reg(&["add", &format!("HKCU\\Software\\Classes\\{}", prog_id), "/ve", "/t", "REG_SZ", "/d", &label, "/f"]).is_err()
                        || run_reg(&["add", &commands, "/ve", "/t", "REG_SZ", "/d", &command_value, "/f"]).is_err()
                        || run_reg(&["add", &format!("HKCU\\Software\\Classes\\.{}\\OpenWithProgids", extension), "/v", &prog_id, "/t", "REG_NONE", "/f"]).is_err()
                        || run_reg(&["add", capabilities, "/v", "ApplicationName", "/t", "REG_SZ", "/d", "RemoteHand", "/f"]).is_err()
                        || run_reg(&["add", capabilities, "/v", "ApplicationDescription", "/t", "REG_SZ", "/d", "Open supported files with RemoteHand plugins", "/f"]).is_err()
                        || run_reg(&["add", &format!("{}\\FileAssociations", capabilities), "/v", &format!(".{}", extension), "/t", "REG_SZ", "/d", &prog_id, "/f"]).is_err()
                        || run_reg(&["add", registered, "/v", "RemoteHand", "/t", "REG_SZ", "/d", "Software\\RemoteHand\\Capabilities", "/f"]).is_err()
                    {
                        failures.push(extension);
                    }
                } else {
                    let open_with = format!("HKCU\\Software\\Classes\\.{}\\OpenWithProgids", extension);
                    let file_associations = format!("{}\\FileAssociations", capabilities);
                    let _ = run_reg(&["delete", &open_with, "/v", &prog_id, "/f"]);
                    let _ = run_reg(&["delete", &file_associations, "/v", &format!(".{}", extension), "/f"]);
                }
            }
        }
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
