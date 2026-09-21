use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow, Window, WindowEvent, Wry,
};

const MIN_VISIBLE_PIXELS: i32 = 80;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

impl WindowState {
    fn from_window(window: &Window<Wry>) -> Result<Self, String> {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        Ok(Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized: window.is_maximized().map_err(|error| error.to_string())?,
            fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
        })
    }

    fn from_webview_window(window: &WebviewWindow<Wry>) -> Result<Self, String> {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        Ok(Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized: window.is_maximized().map_err(|error| error.to_string())?,
            fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
        })
    }
}

#[derive(Clone, Default)]
pub struct WindowStateTracker {
    normal: Arc<Mutex<Option<WindowState>>>,
}

fn data_root() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir.join("data"))
}

fn window_state_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("config").join("window.json"))
}

fn load_window_state() -> Result<Option<WindowState>, String> {
    let path = window_state_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn save_window_state(state: &WindowState) -> Result<(), String> {
    let path = window_state_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve config directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn overlap_pixels(state: &WindowState, monitor: &Monitor) -> (i32, i32) {
    let work = monitor.work_area();
    let left = state.x.max(work.position.x);
    let top = state.y.max(work.position.y);
    let right = (state.x + state.width as i32).min(work.position.x + work.size.width as i32);
    let bottom = (state.y + state.height as i32).min(work.position.y + work.size.height as i32);
    ((right - left).max(0), (bottom - top).max(0))
}

fn is_visible_on_any_monitor(state: &WindowState, monitors: &[Monitor]) -> bool {
    monitors.iter().any(|monitor| {
        let (width, height) = overlap_pixels(state, monitor);
        width >= MIN_VISIBLE_PIXELS && height >= MIN_VISIBLE_PIXELS
    })
}

fn clamp_size_to_monitor(state: &WindowState, monitor: &Monitor) -> PhysicalSize<u32> {
    let work = monitor.work_area();
    PhysicalSize::new(
        state.width.max(900).min(work.size.width),
        state.height.max(600).min(work.size.height),
    )
}

pub fn restore(app: &tauri::App, tracker: &WindowStateTracker) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let saved = load_window_state()?;
    if let Some(saved) = saved {
        let monitors = window
            .available_monitors()
            .map_err(|error| error.to_string())?;
        if is_visible_on_any_monitor(&saved, &monitors) {
            let target_monitor = monitors.iter().max_by_key(|monitor| {
                let (width, height) = overlap_pixels(&saved, monitor);
                width as i64 * height as i64
            });
            let size = target_monitor
                .map(|monitor| clamp_size_to_monitor(&saved, monitor))
                .unwrap_or_else(|| PhysicalSize::new(saved.width.max(900), saved.height.max(600)));
            window.set_size(size).map_err(|error| error.to_string())?;
            let position = if let Some(monitor) = target_monitor {
                let work = monitor.work_area();
                let max_x = work.position.x + work.size.width as i32 - size.width as i32;
                let max_y = work.position.y + work.size.height as i32 - size.height as i32;
                PhysicalPosition::new(
                    saved.x.clamp(work.position.x, max_x.max(work.position.x)),
                    saved.y.clamp(work.position.y, max_y.max(work.position.y)),
                )
            } else {
                PhysicalPosition::new(saved.x, saved.y)
            };
            window
                .set_position(position)
                .map_err(|error| error.to_string())?;
        } else {
            window
                .set_size(PhysicalSize::new(
                    saved.width.max(900),
                    saved.height.max(600),
                ))
                .map_err(|error| error.to_string())?;
            window.center().map_err(|error| error.to_string())?;
        }

        if let Ok(mut normal) = tracker.normal.lock() {
            *normal = Some(WindowState {
                maximized: false,
                fullscreen: false,
                ..saved.clone()
            });
        }

        if saved.maximized {
            window.maximize().map_err(|error| error.to_string())?;
        }
        if saved.fullscreen {
            window
                .set_fullscreen(true)
                .map_err(|error| error.to_string())?;
        }

    } else if let Ok(state) = WindowState::from_webview_window(&window) {
        if let Ok(mut normal) = tracker.normal.lock() {
            *normal = Some(state);
        }
    }

    Ok(())
}

pub fn handle_event(tracker: &WindowStateTracker, window: &Window<Wry>, event: &WindowEvent) {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let is_fullscreen = window.is_fullscreen().unwrap_or(false);
    match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            if !is_maximized && !is_fullscreen {
                if let Ok(state) = WindowState::from_window(window) {
                    if let Ok(mut normal) = tracker.normal.lock() {
                        *normal = Some(state.clone());
                    }
                    let mut normal_state = state;
                    normal_state.maximized = false;
                    normal_state.fullscreen = false;
                    if let Err(error) = save_window_state(&normal_state) {
                        log::error!("Failed to save window state: {error}");
                    }
                }
            }
        }
        WindowEvent::CloseRequested { .. } => {
            let normal = tracker.normal.lock().ok().and_then(|state| state.clone());
            let current = WindowState::from_window(window).ok();
            let mut state = normal.or(current).unwrap_or(WindowState {
                x: 0,
                y: 0,
                width: 1280,
                height: 800,
                maximized: false,
                fullscreen: false,
            });
            state.maximized = is_maximized;
            state.fullscreen = is_fullscreen;
            if let Err(error) = save_window_state(&state) {
                log::error!("Failed to save window state: {error}");
            }
        }
        _ => {}
    }
}
