use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

fn shell_command(shell: &str) -> Result<CommandBuilder, String> {
    #[cfg(windows)]
    {
        let program = match shell {
            "powershell" | "default" => "powershell.exe",
            "cmd" => "cmd.exe",
            "wsl" => "wsl.exe",
            other => return Err(format!("unsupported local shell: {other}")),
        };
        return Ok(CommandBuilder::new(program));
    }

    #[cfg(not(windows))]
    {
        if shell == "cmd" || shell == "powershell" || shell == "wsl" {
            return Err(format!("{shell} is only available on Windows"));
        }
        let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        Ok(CommandBuilder::new(program))
    }
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    shell: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session store is unavailable".to_string())?;

    if sessions.contains_key(&session_id) {
        return Ok(());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to create PTY: {error}"))?;

    let command = shell_command(&shell)?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start shell: {error}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to read PTY: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to write PTY: {error}"))?;
    let writer = Arc::new(Mutex::new(writer));

    let output_app = app.clone();
    let output_session_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let payload = TerminalOutput {
                        session_id: output_session_id.clone(),
                        data: String::from_utf8_lossy(&buffer[..count]).into_owned(),
                    };
                    let _ = output_app.emit("terminal-output", payload);
                }
                Err(_) => break,
            }
        }
        let _ = output_app.emit(
            "terminal-exit",
            TerminalExit {
                session_id: output_session_id,
            },
        );
    });

    drop(pair.slave);
    sessions.insert(
        session_id,
        TerminalSession {
            master: pair.master,
            writer,
            child,
        },
    );
    log::info!("Local terminal session started");

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session store is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "terminal writer is unavailable".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("failed to write to terminal: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("failed to flush terminal input: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session store is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to resize terminal: {error}"))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session store is unavailable".to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        session
            .child
            .kill()
            .map_err(|error| format!("failed to stop terminal: {error}"))?;
        log::info!("Terminal session closed");
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    host: String,
    port: u16,
    user: String,
    rows: u16,
    cols: u16,
    initial_command: Option<String>,
) -> Result<(), String> {
    let host = host.trim();
    let user = user.trim();
    if host.is_empty() {
        return Err("SSH host is required".to_string());
    }
    if user.is_empty() {
        return Err("SSH user is required".to_string());
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session store is unavailable".to_string())?;

    if sessions.contains_key(&session_id) {
        return Ok(());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to create SSH PTY: {error}"))?;

    let mut command = CommandBuilder::new("ssh");
    command.arg("-p");
    command.arg(port.max(1).to_string());
    let initial_command = initial_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty());
    if initial_command.is_some() {
        command.arg("-t");
    }
    command.arg(format!("{user}@{host}"));
    if let Some(initial_command) = initial_command {
        command.arg(format!("{initial_command} && exec ${{SHELL:-/bin/sh}} -l"));
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start ssh: {error}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to read SSH PTY : {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to write SSH PTY: {error}"))?;
    let writer = Arc::new(Mutex::new(writer));

    let output_app = app.clone();
    let output_session_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let payload = TerminalOutput {
                        session_id: output_session_id.clone(),
                        data: String::from_utf8_lossy(&buffer[..count]).into_owned(),
                    };
                    let _ = output_app.emit("terminal-output", payload);
                }
                Err(_) => break,
            }
        }
        let _ = output_app.emit(
            "terminal-exit",
            TerminalExit {
                session_id: output_session_id,
            },
        );
    });

    drop(pair.slave);
    sessions.insert(
        session_id,
        TerminalSession {
            master: pair.master,
            writer,
            child,
        },
    );
    log::info!("SSH session started");

    Ok(())
}
