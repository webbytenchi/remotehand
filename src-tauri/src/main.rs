// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::var_os("REMOTEHAND_ASKPASS").is_some() {
        if let Some(secret) = std::env::var_os("REMOTEHAND_ASKPASS_SECRET") {
            print!("{}", secret.to_string_lossy());
        }
        return;
    }

    remotehand_lib::run();
}
