use std::{env, path::PathBuf};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind};
const MAX_LOG_FILE_SIZE: u128 = 5 * 1024 * 1024;
const ROTATED_LOG_FILES: usize = 4;
fn log_directory() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir.join("data").join("logs"))
}
pub fn builder() -> Result<Builder, String> {
    let directory = log_directory()?;
    Ok(Builder::default()
        .level(log::LevelFilter::Info)
        .clear_targets()
        .target(Target::new(TargetKind::Folder {
            path: directory,
            file_name: Some("remotehand".to_string()),
        }))
        .max_file_size(MAX_LOG_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(ROTATED_LOG_FILES)))
}
