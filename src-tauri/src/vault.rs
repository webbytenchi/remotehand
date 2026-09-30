use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use zeroize::{Zeroize, Zeroizing};

const VAULT_FORMAT_VERSION: u32 = 1;
const VAULT_DOCUMENT_VERSION: u32 = 1;
const VAULT_CONTEXT: &str = "ILoveYouAndami-Papa";
const KDF_ALGORITHM: &str = "argon2id";
const KDF_VERSION: u32 = 19;
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const CIPHER_ALGORITHM: &str = "xchacha20poly1305";
const SALT_BYTES: usize = 16;
const VAULT_ID_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
const MAX_VAULT_REF_BYTES: usize = 512;
const MAX_VAULT_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct VaultState {
    unlocked: Arc<Mutex<Option<UnlockedVault>>>,
    auto_lock_minutes: Arc<AtomicU64>,
    pending_plugin_access: Arc<Mutex<BTreeMap<String, mpsc::Sender<Result<(), String>>>>>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            unlocked: Arc::new(Mutex::new(None)),
            auto_lock_minutes: Arc::new(AtomicU64::new(15)),
            pending_plugin_access: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

struct UnlockedVault {
    key: Zeroizing<[u8; KEY_BYTES]>,
    metadata: VaultMetadata,
    document: VaultDocument,
    last_activity: Instant,
}

impl VaultState {
    pub fn start_auto_lock_worker(&self, app: AppHandle) {
        let unlocked = self.unlocked.clone();
        let auto_lock_minutes = self.auto_lock_minutes.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(15));
            let minutes = auto_lock_minutes.load(Ordering::Relaxed);
            if minutes == 0 {
                continue;
            }
            let timeout = Duration::from_secs(minutes.saturating_mul(60));
            let mut guard = match unlocked.lock() {
                Ok(guard) => guard,
                Err(_) => continue,
            };
            let should_lock = guard
                .as_ref()
                .map(|vault| vault.last_activity.elapsed() >= timeout)
                .unwrap_or(false);
            if should_lock {
                *guard = None;
                crate::vault_blob::abort_all_uploads();
                log::info!("Vault auto-locked after inactivity");
                if let Err(error) = app.emit(
                    "remotehand-vault-status-changed",
                    VaultStatus {
                        exists: true,
                        unlocked: false,
                    },
                ) {
                    log::warn!("Failed to emit Vault auto-lock status: {error}");
                }
            }
        });
    }

    pub fn set_auto_lock_minutes(&self, minutes: u64) {
        self.auto_lock_minutes.store(minutes, Ordering::Relaxed);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfConfig {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Clone, Debug)]
struct VaultMetadata {
    vault_id: String,
    kdf: KdfConfig,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultEnvelope {
    format_version: u32,
    vault_id: String,
    kdf: KdfConfig,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedHeader<'a> {
    format_version: u32,
    vault_id: &'a str,
    kdf: &'a KdfConfig,
    cipher: &'a str,
    context: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultDocument {
    version: u32,
    secrets: BTreeMap<String, String>,
    documents: BTreeMap<String, String>,
}

impl VaultDocument {
    fn empty() -> Self {
        Self {
            version: VAULT_DOCUMENT_VERSION,
            secrets: BTreeMap::new(),
            documents: BTreeMap::new(),
        }
    }
}

impl Drop for VaultDocument {
    fn drop(&mut self) {
        for secret in self.secrets.values_mut() {
            secret.zeroize();
        }
        for document in self.documents.values_mut() {
            document.zeroize();
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginVaultAccessRequest {
    request_id: String,
    plugin_id: String,
    reason: String,
    create: bool,
}

fn vault_path() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir.join("data").join("vault").join("vault.enc"))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn encode_bytes(bytes: &[u8]) -> String {
    STANDARD_NO_PAD.encode(bytes)
}

fn decode_fixed<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    let decoded = STANDARD_NO_PAD
        .decode(value)
        .map_err(|_| format!("vault {label} is invalid"))?;
    decoded
        .try_into()
        .map_err(|_| format!("vault {label} has an invalid length"))
}

fn validate_vault_file_size(size: u64) -> Result<(), String> {
    if size == 0 {
        return Err("vault file is empty".to_string());
    }
    if size > MAX_VAULT_FILE_BYTES {
        return Err("vault file exceeds the supported size limit".to_string());
    }
    Ok(())
}

fn read_vault_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| "vault not found".to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("vault path is not a regular file".to_string());
    }
    validate_vault_file_size(metadata.len())?;

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_VAULT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    validate_vault_file_size(bytes.len() as u64)?;
    Ok(bytes)
}

fn new_metadata() -> VaultMetadata {
    VaultMetadata {
        vault_id: encode_bytes(&random_bytes::<VAULT_ID_BYTES>()),
        kdf: KdfConfig {
            algorithm: KDF_ALGORITHM.to_string(),
            version: KDF_VERSION,
            memory_kib: KDF_MEMORY_KIB,
            iterations: KDF_ITERATIONS,
            parallelism: KDF_PARALLELISM,
            salt: encode_bytes(&random_bytes::<SALT_BYTES>()),
        },
    }
}

fn validate_kdf(kdf: &KdfConfig) -> Result<(), String> {
    if kdf.algorithm != KDF_ALGORITHM
        || kdf.version != KDF_VERSION
        || kdf.memory_kib != KDF_MEMORY_KIB
        || kdf.iterations != KDF_ITERATIONS
        || kdf.parallelism != KDF_PARALLELISM
    {
        return Err("unsupported vault KDF profile".to_string());
    }
    let _ = decode_fixed::<SALT_BYTES>(&kdf.salt, "salt")?;
    Ok(())
}

fn derive_key(passphrase: &str, kdf: &KdfConfig) -> Result<Zeroizing<[u8; KEY_BYTES]>, String> {
    validate_kdf(kdf)?;
    let salt = decode_fixed::<SALT_BYTES>(&kdf.salt, "salt")?;
    let params = Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(KEY_BYTES),
    )
    .map_err(|_| "vault KDF parameters are invalid".to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key[..])
        .map_err(|_| "failed to derive vault key".to_string())?;
    Ok(key)
}

fn authenticated_header(metadata: &VaultMetadata) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&AuthenticatedHeader {
        format_version: VAULT_FORMAT_VERSION,
        vault_id: &metadata.vault_id,
        kdf: &metadata.kdf,
        cipher: CIPHER_ALGORITHM,
        context: VAULT_CONTEXT,
    })
    .map_err(|error| error.to_string())
}

fn encrypt_document(
    key: &[u8; KEY_BYTES],
    metadata: &VaultMetadata,
    document: &VaultDocument,
) -> Result<Vec<u8>, String> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(document).map_err(|error| error.to_string())?);
    let aad = authenticated_header(metadata)?;
    let nonce = random_bytes::<NONCE_BYTES>();
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| "vault key is invalid".to_string())?;
    let nonce_ref = <&XNonce>::try_from(&nonce[..])
        .map_err(|_| "vault nonce has an invalid length".to_string())?;
    let ciphertext = cipher
        .encrypt(
            nonce_ref,
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "failed to encrypt vault".to_string())?;

    let envelope = VaultEnvelope {
        format_version: VAULT_FORMAT_VERSION,
        vault_id: metadata.vault_id.clone(),
        kdf: metadata.kdf.clone(),
        cipher: CIPHER_ALGORITHM.to_string(),
        nonce: encode_bytes(&nonce),
        ciphertext: encode_bytes(&ciphertext),
    };
    serde_json::to_vec(&envelope).map_err(|error| error.to_string())
}

fn decrypt_document(
    mut passphrase: Zeroizing<String>,
    encrypted: &[u8],
) -> Result<(VaultMetadata, Zeroizing<[u8; KEY_BYTES]>, VaultDocument), String> {
    validate_vault_file_size(encrypted.len() as u64)?;
    let envelope: VaultEnvelope =
        serde_json::from_slice(encrypted).map_err(|_| "vault file is invalid".to_string())?;
    if envelope.format_version != VAULT_FORMAT_VERSION {
        return Err(format!(
            "unsupported vault format version: {}",
            envelope.format_version
        ));
    }
    if envelope.cipher != CIPHER_ALGORITHM {
        return Err("unsupported vault cipher".to_string());
    }
    validate_kdf(&envelope.kdf)?;
    let nonce = decode_fixed::<NONCE_BYTES>(&envelope.nonce, "nonce")?;
    let ciphertext = STANDARD_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| "vault ciphertext is invalid".to_string())?;
    let _ = decode_fixed::<VAULT_ID_BYTES>(&envelope.vault_id, "identifier")?;
    let metadata = VaultMetadata {
        vault_id: envelope.vault_id,
        kdf: envelope.kdf,
    };

    let key = derive_key(&passphrase, &metadata.kdf)?;
    passphrase.zeroize();
    let aad = authenticated_header(&metadata)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "vault key is invalid".to_string())?;
    let nonce_ref = <&XNonce>::try_from(&nonce[..])
        .map_err(|_| "vault nonce has an invalid length".to_string())?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                nonce_ref,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| "failed to unlock vault".to_string())?,
    );

    let document: VaultDocument =
        serde_json::from_slice(&plaintext).map_err(|_| "vault contents are invalid".to_string())?;
    if document.version != VAULT_DOCUMENT_VERSION {
        return Err(format!(
            "unsupported vault document version: {}",
            document.version
        ));
    }
    Ok((metadata, key, document))
}

fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(path: &Path, replacement: &Path, backup: Option<&Path>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS},
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let replaced = wide(path);
    let replacement = wide(replacement);
    let backup_wide = backup.map(wide);
    let backup_ptr = backup_wide
        .as_ref()
        .map(|value| PCWSTR(value.as_ptr()))
        .unwrap_or(PCWSTR::null());

    unsafe {
        ReplaceFileW(
            PCWSTR(replaced.as_ptr()),
            PCWSTR(replacement.as_ptr()),
            backup_ptr,
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
    }
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn replace_file(path: &Path, replacement: &Path, backup: Option<&Path>) -> Result<(), String> {
    if let Some(backup) = backup {
        if backup.exists() {
            fs::remove_file(backup).map_err(|error| error.to_string())?;
        }
        fs::copy(path, backup).map_err(|error| error.to_string())?;
        sync_file(backup)?;
    }
    fs::rename(replacement, path).map_err(|error| error.to_string())
}

fn restore_backup(path: &Path) -> Result<bool, String> {
    let backup_path = path.with_extension("bak");
    if !backup_path.exists() {
        return Ok(false);
    }
    let recovery_path = path.with_extension("recover.tmp");
    if recovery_path.exists() {
        fs::remove_file(&recovery_path).map_err(|error| error.to_string())?;
    }
    fs::copy(&backup_path, &recovery_path).map_err(|error| error.to_string())?;
    sync_file(&recovery_path)?;

    if path.exists() {
        replace_file(path, &recovery_path, None)?;
    } else {
        fs::rename(&recovery_path, path).map_err(|error| error.to_string())?;
    }
    log::warn!("Vault restored from last-known-good backup");
    Ok(true)
}

fn recover_interrupted_write(path: &Path) -> Result<(), String> {
    let temporary_path = path.with_extension("tmp");
    if path.exists() {
        if temporary_path.exists() {
            fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    if restore_backup(path)? {
        if temporary_path.exists() {
            fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    if temporary_path.exists() {
        fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_vault_bytes(path: &Path, encrypted: &[u8]) -> Result<(), String> {
    validate_vault_file_size(encrypted.len() as u64)?;

    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve vault directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    recover_interrupted_write(path)?;

    let temporary_path = path.with_extension("tmp");
    let backup_path = path.with_extension("bak");
    if temporary_path.exists() {
        fs::remove_file(&temporary_path).map_err(|error| error.to_string())?;
    }

    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| error.to_string())?;
        file.write_all(encrypted)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }

    if !path.exists() {
        fs::rename(&temporary_path, path).map_err(|error| error.to_string())?;
        sync_file(path)?;
        return Ok(());
    }

    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
    }
    replace_file(path, &temporary_path, Some(&backup_path))?;
    sync_file(path)?;
    sync_file(&backup_path)?;
    Ok(())
}

fn save_document(
    key: &[u8; KEY_BYTES],
    metadata: &VaultMetadata,
    document: &VaultDocument,
) -> Result<(), String> {
    let encrypted = encrypt_document(key, metadata, document)?;
    write_vault_bytes(&vault_path()?, &encrypted)
}

fn register_plugin_access_request(
    state: &VaultState,
    plugin_id: &str,
    reason: &str,
    create: bool,
) -> Result<
    (
        PluginVaultAccessRequest,
        mpsc::Receiver<Result<(), String>>,
    ),
    String,
> {
    if reason.trim().is_empty() || reason.len() > 256 {
        return Err("Vault access reason is missing or too long".to_string());
    }

    let request_id = encode_bytes(&random_bytes::<16>());
    let (sender, receiver) = mpsc::channel();
    state
        .pending_plugin_access
        .lock()
        .map_err(|_| "Vault access request state is unavailable".to_string())?
        .insert(request_id.clone(), sender);

    Ok((
        PluginVaultAccessRequest {
            request_id,
            plugin_id: plugin_id.to_string(),
            reason: reason.trim().to_string(),
            create,
        },
        receiver,
    ))
}

fn resolve_plugin_access_request(
    state: &VaultState,
    request_id: &str,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("invalid Vault access request id".to_string());
    }
    let sender = state
        .pending_plugin_access
        .lock()
        .map_err(|_| "Vault access request state is unavailable".to_string())?
        .remove(request_id)
        .ok_or_else(|| "Vault access request is no longer active".to_string())?;

    let result = if ok {
        Ok(())
    } else {
        Err(error
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .unwrap_or_else(|| "Vault access was cancelled".to_string()))
    };
    sender
        .send(result)
        .map_err(|_| "Vault access requester is no longer available".to_string())
}

pub(crate) fn request_plugin_access(
    app: &AppHandle,
    state: &VaultState,
    plugin_id: &str,
    reason: &str,
) -> Result<(), String> {
    if state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?
        .is_some()
    {
        return Ok(());
    }

    let path = vault_path()?;
    recover_interrupted_write(&path)?;
    let (request, receiver) =
        register_plugin_access_request(state, plugin_id, reason, !path.exists())?;
    let request_id = request.request_id.clone();

    if let Err(error) = app.emit("remotehand-vault-plugin-access-request", request) {
        if let Ok(mut pending) = state.pending_plugin_access.lock() {
            pending.remove(&request_id);
        }
        return Err(format!("failed to request Vault access: {error}"));
    }

    log::info!("Vault audit: plugin access requested for {plugin_id}");
    match receiver.recv_timeout(Duration::from_secs(300)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = state.pending_plugin_access.lock() {
                pending.remove(&request_id);
            }
            log::warn!("Vault audit: plugin access request timed out for {plugin_id}");
            Err("Vault access request timed out".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            if let Ok(mut pending) = state.pending_plugin_access.lock() {
                pending.remove(&request_id);
            }
            Err("Vault access request was interrupted".to_string())
        }
    }
}

#[tauri::command]
pub fn vault_resolve_plugin_access_request<'a>(
    state: State<'a, VaultState>,
    request_id: String,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    resolve_plugin_access_request(state.inner(), &request_id, ok, error)
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.trim().is_empty() {
        return Err("vault passphrase is required".to_string());
    }
    Ok(())
}

fn validate_vault_ref(vault_ref: &str) -> Result<(), String> {
    if vault_ref.is_empty() || vault_ref.len() > MAX_VAULT_REF_BYTES {
        return Err("vault reference is invalid".to_string());
    }
    if !(vault_ref.starts_with("core:") || vault_ref.starts_with("plugin:")) {
        return Err("vault reference must use a core or plugin namespace".to_string());
    }
    if !vault_ref.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'/' | b'.' | b'-' | b'_')
    }) {
        return Err("vault reference contains unsupported characters".to_string());
    }
    if vault_ref
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("vault reference contains an invalid path segment".to_string());
    }
    Ok(())
}

fn validate_core_ref(vault_ref: &str) -> Result<(), String> {
    validate_vault_ref(vault_ref)?;
    if !vault_ref.starts_with("core:") {
        return Err("core Vault command requires a core namespace".to_string());
    }
    Ok(())
}

fn validate_secret_value(secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("Vault secret is required".to_string());
    }
    if secret.len() > MAX_SECRET_BYTES {
        return Err("Vault secret exceeds 64 KiB".to_string());
    }
    Ok(())
}

fn validate_document_value(document: &str) -> Result<(), String> {
    if document.len() > MAX_DOCUMENT_BYTES {
        return Err("Vault document exceeds 16 MiB".to_string());
    }
    Ok(())
}

pub(crate) fn get_secret(state: &VaultState, vault_ref: &str) -> Result<Option<String>, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    vault.last_activity = Instant::now();
    Ok(vault.document.secrets.get(vault_ref).cloned())
}

pub(crate) fn get_document(state: &VaultState, vault_ref: &str) -> Result<Option<String>, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    vault.last_activity = Instant::now();
    Ok(vault.document.documents.get(vault_ref).cloned())
}


pub(crate) fn begin_blob_upload(
    state: &VaultState,
    vault_ref: &str,
    total_size: u64,
) -> Result<(String, u32, u32), String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let result = crate::vault_blob::begin_upload(&*vault.key, vault_ref, total_size)?;
    vault.last_activity = Instant::now();
    Ok(result)
}

pub(crate) fn write_blob_chunk(
    state: &VaultState,
    vault_ref: &str,
    upload_id: &str,
    index: u32,
    bytes: &[u8],
) -> Result<u64, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let written = crate::vault_blob::write_upload_chunk(
        &*vault.key,
        &vault.metadata.vault_id,
        vault_ref,
        upload_id,
        index,
        bytes,
    )?;
    vault.last_activity = Instant::now();
    Ok(written)
}

pub(crate) fn commit_blob_upload(
    state: &VaultState,
    vault_ref: &str,
    upload_id: &str,
) -> Result<crate::vault_blob::BlobInfo, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let info = crate::vault_blob::commit_upload(vault_ref, upload_id)?;
    vault.last_activity = Instant::now();
    Ok(info)
}

pub(crate) fn abort_blob_upload(
    state: &VaultState,
    vault_ref: &str,
    upload_id: &str,
) -> Result<bool, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let aborted = crate::vault_blob::abort_upload(vault_ref, upload_id)?;
    vault.last_activity = Instant::now();
    Ok(aborted)
}

pub(crate) fn get_blob_info(
    state: &VaultState,
    vault_ref: &str,
) -> Result<Option<crate::vault_blob::BlobInfo>, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let info = crate::vault_blob::info(&*vault.key, vault_ref)?;
    vault.last_activity = Instant::now();
    Ok(info)
}

pub(crate) fn read_blob_chunk(
    state: &VaultState,
    vault_ref: &str,
    index: u32,
) -> Result<Vec<u8>, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let bytes = crate::vault_blob::read_chunk(
        &*vault.key,
        &vault.metadata.vault_id,
        vault_ref,
        index,
    )?;
    vault.last_activity = Instant::now();
    Ok(bytes)
}

pub(crate) fn delete_blob(state: &VaultState, vault_ref: &str) -> Result<bool, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;
    let deleted = crate::vault_blob::delete(&*vault.key, vault_ref)?;
    vault.last_activity = Instant::now();
    Ok(deleted)
}

#[tauri::command]
pub fn vault_status<'a>(state: State<'a, VaultState>) -> Result<VaultStatus, String> {
    let path = vault_path()?;
    recover_interrupted_write(&path)?;
    let exists = path.exists();
    let unlocked = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?
        .is_some();
    Ok(VaultStatus { exists, unlocked })
}

#[tauri::command]
pub fn vault_initialize(
    app: AppHandle,
    state: State<'_, VaultState>,
    passphrase: String,
) -> Result<(), String> {
    validate_passphrase(&passphrase)?;
    let path = vault_path()?;
    recover_interrupted_write(&path)?;
    if path.exists() {
        return Err("vault already exists".to_string());
    }

    let passphrase = Zeroizing::new(passphrase);
    let metadata = new_metadata();
    let key = derive_key(&passphrase, &metadata.kdf)?;
    let document = VaultDocument::empty();
    save_document(&key, &metadata, &document)?;

    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = Some(UnlockedVault {
        key,
        metadata,
        document,
        last_activity: Instant::now(),
    });

    log::info!("Vault initialized");
    let _ = app.emit(
        "remotehand-vault-status-changed",
        VaultStatus {
            exists: true,
            unlocked: true,
        },
    );
    Ok(())
}

fn unlock_vault_from_path(
    state: &VaultState,
    path: &Path,
    passphrase: String,
) -> Result<(), String> {
    validate_passphrase(&passphrase)?;
    recover_interrupted_write(path)?;
    let encrypted = read_vault_file(path)?;
    let passphrase = Zeroizing::new(passphrase);
    let decrypted = decrypt_document(Zeroizing::new(passphrase.to_string()), &encrypted);

    let (metadata, key, document) = match decrypted {
        Ok(value) => value,
        Err(primary_error) => {
            let backup_path = path.with_extension("bak");
            if !backup_path.exists() {
                return Err(primary_error);
            }
            let backup = read_vault_file(&backup_path).map_err(|_| primary_error.clone())?;
            match decrypt_document(Zeroizing::new(passphrase.to_string()), &backup) {
                Ok(value) => {
                    restore_backup(path)?;
                    value
                }
                Err(_) => return Err(primary_error),
            }
        }
    };

    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = Some(UnlockedVault {
        key,
        metadata,
        document,
        last_activity: Instant::now(),
    });

    log::info!("Vault unlocked");
    Ok(())
}

pub(crate) fn unlock_vault(state: &VaultState, passphrase: String) -> Result<(), String> {
    let path = vault_path()?;
    unlock_vault_from_path(state, &path, passphrase)
}

#[tauri::command]
pub fn vault_unlock<'a>(
    app: AppHandle,
    state: State<'a, VaultState>,
    passphrase: String,
) -> Result<(), String> {
    unlock_vault(state.inner(), passphrase)?;
    let _ = app.emit(
        "remotehand-vault-status-changed",
        VaultStatus {
            exists: true,
            unlocked: true,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn vault_set_auto_lock<'a>(state: State<'a, VaultState>, minutes: u64) -> Result<(), String> {
    if !matches!(minutes, 0 | 5 | 15 | 30 | 60) {
        return Err("unsupported Vault auto-lock interval".to_string());
    }
    state.set_auto_lock_minutes(minutes);
    Ok(())
}

#[tauri::command]
pub fn vault_lock<'a>(app: AppHandle, state: State<'a, VaultState>) -> Result<(), String> {
    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = None;
    crate::vault_blob::abort_all_uploads();
    log::info!("Vault locked");
    let exists = vault_path()?.exists();
    let _ = app.emit(
        "remotehand-vault-status-changed",
        VaultStatus {
            exists,
            unlocked: false,
        },
    );
    Ok(())
}

pub(crate) fn store_secret(
    state: &VaultState,
    vault_ref: String,
    secret: String,
) -> Result<(), String> {
    validate_vault_ref(&vault_ref)?;
    validate_secret_value(&secret)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;

    let mut previous = vault.document.secrets.insert(vault_ref.clone(), secret);
    if let Err(error) = save_document(&vault.key, &vault.metadata, &vault.document) {
        if let Some(mut failed) = vault.document.secrets.remove(&vault_ref) {
            failed.zeroize();
        }
        if let Some(previous) = previous.take() {
            vault.document.secrets.insert(vault_ref, previous);
        }
        return Err(error);
    }

    if let Some(secret) = previous.as_mut() {
        secret.zeroize();
    }
    vault.last_activity = Instant::now();
    log::info!("Vault secret updated");
    Ok(())
}

pub(crate) fn delete_secret(state: &VaultState, vault_ref: &str) -> Result<bool, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;

    let Some(mut removed) = vault.document.secrets.remove(vault_ref) else {
        return Ok(false);
    };
    if let Err(error) = save_document(&vault.key, &vault.metadata, &vault.document) {
        vault
            .document
            .secrets
            .insert(vault_ref.to_string(), removed);
        return Err(error);
    }
    removed.zeroize();
    vault.last_activity = Instant::now();
    log::info!("Vault secret deleted");
    Ok(true)
}

pub(crate) fn store_document(
    state: &VaultState,
    vault_ref: String,
    document: String,
) -> Result<(), String> {
    validate_vault_ref(&vault_ref)?;
    validate_document_value(&document)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;

    let mut previous = vault.document.documents.insert(vault_ref.clone(), document);
    if let Err(error) = save_document(&vault.key, &vault.metadata, &vault.document) {
        if let Some(mut failed) = vault.document.documents.remove(&vault_ref) {
            failed.zeroize();
        }
        if let Some(previous) = previous.take() {
            vault.document.documents.insert(vault_ref, previous);
        }
        return Err(error);
    }

    if let Some(document) = previous.as_mut() {
        document.zeroize();
    }
    vault.last_activity = Instant::now();
    log::info!("Vault document updated");
    Ok(())
}

pub(crate) fn delete_document(state: &VaultState, vault_ref: &str) -> Result<bool, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "vault is locked".to_string())?;

    let Some(mut removed) = vault.document.documents.remove(vault_ref) else {
        return Ok(false);
    };
    if let Err(error) = save_document(&vault.key, &vault.metadata, &vault.document) {
        vault
            .document
            .documents
            .insert(vault_ref.to_string(), removed);
        return Err(error);
    }
    removed.zeroize();
    vault.last_activity = Instant::now();
    log::info!("Vault document deleted");
    Ok(true)
}

#[tauri::command]
pub fn vault_store_secret<'a>(
    state: State<'a, VaultState>,
    credential_ref: String,
    secret: String,
) -> Result<(), String> {
    validate_core_ref(&credential_ref)?;
    store_secret(&state, credential_ref, secret)
}

#[tauri::command]
pub fn vault_delete_secret<'a>(
    state: State<'a, VaultState>,
    credential_ref: String,
) -> Result<bool, String> {
    validate_core_ref(&credential_ref)?;
    delete_secret(&state, &credential_ref)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(label: &str) -> Self {
            let suffix = encode_bytes(&random_bytes::<8>());
            let path = env::temp_dir().join(format!("remotehand-vault-{label}-{suffix}"));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn vault_path(&self) -> PathBuf {
            self.path.join("vault.enc")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_document() -> VaultDocument {
        let mut secrets = BTreeMap::new();
        secrets.insert(
            "core:sftp/test/password".to_string(),
            "REMOTEHAND_TEST_SECRET_914".to_string(),
        );
        VaultDocument {
            version: VAULT_DOCUMENT_VERSION,
            secrets,
            documents: BTreeMap::new(),
        }
    }

    fn sample_encrypted(passphrase: &str) -> Vec<u8> {
        let metadata = new_metadata();
        let key = derive_key(passphrase, &metadata.kdf).unwrap();
        encrypt_document(&key, &metadata, &sample_document()).unwrap()
    }

    #[test]
    fn write_rejects_vault_larger_than_file_limit() {
        let dir = TestDir::new("oversized-write");
        let path = dir.vault_path();
        let oversized = vec![0u8; (MAX_VAULT_FILE_BYTES + 1) as usize];

        let result = write_vault_bytes(&path, &oversized);

        assert!(result.is_err());
        assert!(!path.exists());
        assert!(!path.with_extension("tmp").exists());
        assert!(!path.with_extension("bak").exists());
    }

    #[test]
    fn second_write_replaces_active_and_preserves_previous_backup() {
        let dir = TestDir::new("replace-with-backup");
        let path = dir.vault_path();
        let backup_path = path.with_extension("bak");
        let first = sample_encrypted("first write passphrase");
        let second = sample_encrypted("second write passphrase");

        write_vault_bytes(&path, &first).unwrap();
        assert_eq!(fs::read(&path).unwrap(), first);
        assert!(!backup_path.exists());

        write_vault_bytes(&path, &second).unwrap();

        assert_eq!(fs::read(&path).unwrap(), second);
        assert_eq!(fs::read(&backup_path).unwrap(), first);
        assert!(!path.with_extension("tmp").exists());
    }

    #[test]
    fn recovery_restores_backup_when_active_vault_is_missing() {
        let dir = TestDir::new("restore-backup");
        let path = dir.vault_path();
        let backup_path = path.with_extension("bak");
        let temporary_path = path.with_extension("tmp");
        let backup_bytes = sample_encrypted("recovery backup passphrase");

        fs::write(&backup_path, &backup_bytes).unwrap();
        fs::write(&temporary_path, b"unfinished temporary data").unwrap();

        recover_interrupted_write(&path).unwrap();

        assert!(path.exists());
        assert_eq!(fs::read(&path).unwrap(), backup_bytes);
        assert!(backup_path.exists());
        assert!(!temporary_path.exists());
    }

    #[test]
    fn unlock_restores_valid_backup_when_active_vault_is_corrupt() {
        let dir = TestDir::new("unlock-backup-fallback");
        let path = dir.vault_path();
        let backup_path = path.with_extension("bak");
        let passphrase = "backup recovery passphrase";
        let backup_bytes = sample_encrypted(passphrase);

        fs::write(&path, b"corrupt active vault").unwrap();
        fs::write(&backup_path, &backup_bytes).unwrap();

        let state = VaultState::default();
        let result = unlock_vault_from_path(&state, &path, passphrase.to_string());

        assert!(result.is_ok());
        assert_eq!(fs::read(&path).unwrap(), backup_bytes);
        let guard = state.unlocked.lock().unwrap();
        let vault = guard.as_ref().expect("Vault should be unlocked");
        assert_eq!(
            vault
                .document
                .secrets
                .get("core:sftp/test/password")
                .map(String::as_str),
            Some("REMOTEHAND_TEST_SECRET_914")
        );
    }

    #[test]
    fn unlock_does_not_restore_backup_when_passphrase_is_wrong() {
        let dir = TestDir::new("unlock-backup-wrong-passphrase");
        let path = dir.vault_path();
        let backup_path = path.with_extension("bak");
        let original_active = b"corrupt active vault".to_vec();

        fs::write(&path, &original_active).unwrap();
        fs::write(&backup_path, sample_encrypted("correct backup passphrase")).unwrap();

        let state = VaultState::default();
        let result = unlock_vault_from_path(&state, &path, "wrong backup passphrase".to_string());

        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), original_active);
        assert!(state.unlocked.lock().unwrap().is_none());
    }

    #[test]
    fn recovery_discards_temp_when_no_active_or_backup_exists() {
        let dir = TestDir::new("discard-orphan-temp");
        let path = dir.vault_path();
        let temporary_path = path.with_extension("tmp");

        fs::write(&temporary_path, b"unfinished temporary data").unwrap();

        recover_interrupted_write(&path).unwrap();

        assert!(!path.exists());
        assert!(!path.with_extension("bak").exists());
        assert!(!temporary_path.exists());
    }

    #[test]
    fn recovery_discards_stale_temp_when_active_vault_exists() {
        let dir = TestDir::new("discard-stale-temp");
        let path = dir.vault_path();
        let temporary_path = path.with_extension("tmp");
        let active_bytes = sample_encrypted("active vault passphrase");

        fs::write(&path, &active_bytes).unwrap();
        fs::write(&temporary_path, b"unfinished temporary data").unwrap();

        recover_interrupted_write(&path).unwrap();

        assert_eq!(fs::read(&path).unwrap(), active_bytes);
        assert!(!temporary_path.exists());
    }

    #[test]
    fn plugin_access_broker_resumes_after_host_unlock_success() {
        let state = VaultState::default();
        let (request, receiver) = register_plugin_access_request(
            &state,
            "remotehand.test",
            "Use the configured provider credential.",
            false,
        )
        .unwrap();

        assert_eq!(request.plugin_id, "remotehand.test");
        assert_eq!(
            request.reason,
            "Use the configured provider credential."
        );
        assert!(!request.create);

        resolve_plugin_access_request(&state, &request.request_id, true, None).unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            Ok(())
        );
        assert!(state.pending_plugin_access.lock().unwrap().is_empty());
    }

    #[test]
    fn plugin_access_broker_returns_host_cancel_to_waiting_plugin() {
        let state = VaultState::default();
        let (request, receiver) = register_plugin_access_request(
            &state,
            "remotehand.test",
            "Store the provider credential.",
            true,
        )
        .unwrap();

        assert!(request.create);

        resolve_plugin_access_request(&state, &request.request_id, false, None).unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err("Vault access was cancelled".to_string())
        );
        assert!(state.pending_plugin_access.lock().unwrap().is_empty());
    }

    #[test]
    fn plugin_access_request_ids_and_reasons_are_bounded() {
        assert!("reason".len() <= 256);
        let request_id = encode_bytes(&random_bytes::<16>());
        assert!(!request_id.is_empty());
        assert!(request_id.len() <= 128);
    }

    #[test]
    fn enforces_secret_and_document_limits() {
        assert!(validate_secret_value("").is_err());
        assert!(validate_secret_value(&"x".repeat(MAX_SECRET_BYTES)).is_ok());
        assert!(validate_secret_value(&"x".repeat(MAX_SECRET_BYTES + 1)).is_err());

        assert!(validate_document_value(&"x".repeat(MAX_DOCUMENT_BYTES)).is_ok());
        assert!(validate_document_value(&"x".repeat(MAX_DOCUMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn bounded_reader_rejects_oversized_vault_file() {
        let dir = TestDir::new("oversized-read");
        let path = dir.vault_path();
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.set_len(MAX_VAULT_FILE_BYTES + 1).unwrap();

        let result = read_vault_file(&path);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_invalid_vault_file_sizes() {
        assert!(validate_vault_file_size(0).is_err());
        assert!(validate_vault_file_size(MAX_VAULT_FILE_BYTES).is_ok());
        assert!(validate_vault_file_size(MAX_VAULT_FILE_BYTES + 1).is_err());
    }

    #[test]
    fn rejects_invalid_vault_identifier_length() {
        let encrypted = sample_encrypted("identifier test passphrase");
        let mut envelope: VaultEnvelope = serde_json::from_slice(&encrypted).unwrap();
        envelope.vault_id = encode_bytes(b"short");
        let malformed = serde_json::to_vec(&envelope).unwrap();

        let result = decrypt_document(
            Zeroizing::new("identifier test passphrase".to_string()),
            &malformed,
        );
        assert!(result.is_err());
    }

    #[test]
    fn encrypted_vault_round_trips() {
        let encrypted = sample_encrypted("correct horse battery staple");
        let (_, _, decrypted) = decrypt_document(
            Zeroizing::new("correct horse battery staple".to_string()),
            &encrypted,
        )
        .unwrap();

        assert_eq!(decrypted.version, VAULT_DOCUMENT_VERSION);
        assert_eq!(
            decrypted
                .secrets
                .get("core:sftp/test/password")
                .map(String::as_str),
            Some("REMOTEHAND_TEST_SECRET_914")
        );
    }

    #[test]
    fn wrong_passphrase_cannot_decrypt_vault() {
        let encrypted = sample_encrypted("correct passphrase");
        let result = decrypt_document(Zeroizing::new("wrong passphrase".to_string()), &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn ciphertext_tampering_is_rejected() {
        let encrypted = sample_encrypted("tamper test passphrase");
        let mut envelope: VaultEnvelope = serde_json::from_slice(&encrypted).unwrap();
        let mut ciphertext = STANDARD_NO_PAD.decode(&envelope.ciphertext).unwrap();
        ciphertext[0] ^= 0x01;
        envelope.ciphertext = STANDARD_NO_PAD.encode(ciphertext);
        let tampered = serde_json::to_vec(&envelope).unwrap();

        let result = decrypt_document(
            Zeroizing::new("tamper test passphrase".to_string()),
            &tampered,
        );
        assert!(result.is_err());
    }

    #[test]
    fn authenticated_header_tampering_is_rejected() {
        let encrypted = sample_encrypted("header test passphrase");
        let mut envelope: VaultEnvelope = serde_json::from_slice(&encrypted).unwrap();
        envelope.vault_id.push('A');
        let tampered = serde_json::to_vec(&envelope).unwrap();

        let result = decrypt_document(
            Zeroizing::new("header test passphrase".to_string()),
            &tampered,
        );
        assert!(result.is_err());
    }

    #[test]
    fn encrypted_payload_does_not_contain_plaintext_secret() {
        let encrypted = sample_encrypted("portable vault passphrase");
        assert!(!encrypted
            .windows(b"REMOTEHAND_TEST_SECRET_914".len())
            .any(|window| window == b"REMOTEHAND_TEST_SECRET_914"));
    }

    #[test]
    fn supported_auto_lock_intervals_can_be_applied() {
        for minutes in [0, 5, 15, 30, 60] {
            let state = VaultState::default();
            state.set_auto_lock_minutes(minutes);
            assert_eq!(state.auto_lock_minutes.load(Ordering::Relaxed), minutes);
        }
    }

    #[test]
    fn vault_refs_require_scoped_namespaces() {
        assert!(validate_vault_ref("core:sftp/server-1/password").is_ok());
        assert!(validate_vault_ref("plugin:remotehand.marielle-chat/gemini/api-key").is_ok());
        assert!(validate_vault_ref("connection:legacy").is_err());
        assert!(validate_vault_ref("plugin:remotehand.notes/../other").is_err());
        assert!(validate_core_ref("plugin:remotehand.notes/private").is_err());
    }
}
