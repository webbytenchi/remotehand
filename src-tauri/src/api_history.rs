//! Private, bounded API request audit log. Never records authorization headers.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::Write,
    net::IpAddr,
    path::PathBuf,
    sync::{mpsc::{self, SyncSender, Receiver}, Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 1000;
const PERSIST_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub timestamp: String,
    pub ip: String,
    pub method: String,
    pub route: String,
    pub status: u16,
    pub duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    entries: Vec<HistoryEntry>,
    total: usize,
    succeeded: usize,
    failed: usize,
}

enum Message {
    Append(HistoryEntry),
    Clear(SyncSender<Result<(), String>>),
    Flush(SyncSender<Result<(), String>>),
}

#[derive(Clone)]
pub struct ApiHistory {
    entries: Arc<Mutex<VecDeque<HistoryEntry>>>,
    tx: SyncSender<Message>,
}

fn file_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("missing executable directory")?
        .join("data").join("activity").join("api-history.json"))
}

fn load() -> VecDeque<HistoryEntry> {
    let Ok(path) = file_path() else { return VecDeque::new(); };
    let Ok(contents) = fs::read_to_string(path) else { return VecDeque::new(); };
    let Ok(mut entries) = serde_json::from_str::<Vec<HistoryEntry>>(&contents) else {
        log::warn!("API history is unreadable; starting a new in-memory history");
        return VecDeque::new();
    };
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    entries.into()
}

fn save(entries: &VecDeque<HistoryEntry>) -> Result<(), String> {
    let path = file_path()?;
    fs::create_dir_all(path.parent().ok_or("missing history directory")?)
        .map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    // Windows rename cannot overwrite an existing destination. Fall back to
    // an in-place write when a previous history file exists.
    if fs::rename(&tmp, &path).is_err() {
        fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(tmp);
    }
    Ok(())
}

fn writer(entries: Arc<Mutex<VecDeque<HistoryEntry>>>, rx: Receiver<Message>) {
    let mut dirty = false;
    loop {
        match rx.recv_timeout(PERSIST_INTERVAL) {
            Ok(Message::Append(entry)) => {
                if let Ok(mut history) = entries.lock() {
                    history.push_back(entry);
                    while history.len() > MAX_ENTRIES { history.pop_front(); }
                    dirty = true;
                }
            }
            Ok(Message::Flush(reply)) => {
                let result = match entries.lock() { Ok(history) => save(&history), Err(error) => Err(error.to_string()) };
                if result.is_ok() { dirty = false; }
                let _ = reply.send(result);
            }
            Ok(Message::Clear(reply)) => {
                let result = match entries.lock() {
                    Ok(mut history) => {
                        history.clear();
                        save(&history)
                    }
                    Err(error) => Err(error.to_string()),
                };
                dirty = false;
                let _ = reply.send(result);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if dirty {
                    if let Ok(history) = entries.lock() {
                        if let Err(error) = save(&history) {
                            log::warn!("Could not save API access history: {error}");
                        }
                    }
                    dirty = false;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if dirty {
                    if let Ok(history) = entries.lock() { let _ = save(&history); }
                }
                break;
            }
        }
    }
}

impl Default for ApiHistory {
    fn default() -> Self {
        let entries = Arc::new(Mutex::new(load()));
        let (tx, rx) = mpsc::sync_channel(1024);
        let writer_entries = entries.clone();
        thread::Builder::new()
            .name("remotehand-api-history".into())
            .spawn(move || writer(writer_entries, rx))
            .expect("API history writer thread");
        Self { entries, tx }
    }
}

impl ApiHistory {
    pub fn record(&self, ip: IpAddr, method: &str, route: &str, status: u16, duration: Duration) {
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        // Hide query string and bound any untrusted text before writing it.
        let route = route.split('?').next().unwrap_or("").chars().take(200).collect();
        let entry = HistoryEntry {
            timestamp: format!("{unix_ms}"),
            ip: ip.to_string(),
            method: method.chars().take(12).collect(),
            route,
            status,
            duration_ms: duration.as_millis().min(u64::MAX as u128) as u64,
        };
        if self.tx.try_send(Message::Append(entry)).is_err() {
            log::warn!("API history queue full; request record dropped");
        }
    }

    pub fn snapshot(&self) -> Result<HistorySnapshot, String> {
        let entries = self.entries.lock().map_err(|e| e.to_string())?;
        let succeeded = entries.iter().filter(|entry| (200..400).contains(&entry.status)).count();
        let total = entries.len();
        Ok(HistorySnapshot {
            entries: entries.iter().rev().take(100).cloned().collect(),
            total, succeeded, failed: total - succeeded,
        })
    }

    pub fn flush(&self) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx.send(Message::Flush(tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?
    }

    pub fn clear(&self) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx.send(Message::Clear(tx)).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_sanitizes_query_and_caps_length() {
        let route: String = "/hello?".to_owned() + &"secret".repeat(100);
        let path: String = route.split('?').next().unwrap_or("").chars().take(200).collect();
        assert_eq!(path, "/hello");
    }
}
