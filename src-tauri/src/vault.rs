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
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;
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

#[derive(Default)]
pub struct VaultState {
    unlocked: Mutex<Option<UnlockedVault>>,
}

struct UnlockedVault {
    key: Zeroizing<[u8; KEY_BYTES]>,
    metadata: VaultMetadata,
    document: VaultDocument,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
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

    let mut password_material =
        Zeroizing::new(Vec::with_capacity(VAULT_CONTEXT.len() + 1 + passphrase.len()));
    password_material.extend_from_slice(VAULT_CONTEXT.as_bytes());
    password_material.push(0);
    password_material.extend_from_slice(passphrase.as_bytes());

    let mut key = Zeroizing::new([0u8; KEY_BYTES]);
    argon2
        .hash_password_into(&password_material, &salt, &mut key[..])
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
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
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
    let metadata = VaultMetadata {
        vault_id: envelope.vault_id,
        kdf: envelope.kdf,
    };
    if metadata.vault_id.is_empty() {
        return Err("vault identifier is invalid".to_string());
    }

    let key = derive_key(&passphrase, &metadata.kdf)?;
    passphrase.zeroize();
    let aad = authenticated_header(&metadata)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(&key[..]).map_err(|_| "vault key is invalid".to_string())?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
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

fn write_vault_bytes(path: &Path, encrypted: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve vault directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

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
        file.write_all(encrypted).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }

    if !path.exists() {
        return fs::rename(&temporary_path, path).map_err(|error| error.to_string());
    }

    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
    }
    fs::rename(path, &backup_path).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::rename(&backup_path, path);
        let _ = fs::remove_file(&temporary_path);
        return Err(error.to_string());
    }
    fs::remove_file(&backup_path).map_err(|error| error.to_string())?;
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
    if !vault_ref
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'/' | b'.' | b'-' | b'_'))
    {
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

pub(crate) fn get_secret(state: &VaultState, vault_ref: &str) -> Result<Option<String>, String> {
    validate_vault_ref(vault_ref)?;
    let guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_ref()
        .ok_or_else(|| "credential vault is locked".to_string())?;
    Ok(vault.document.secrets.get(vault_ref).cloned())
}

#[tauri::command]
pub fn vault_status<'a>(state: State<'a, VaultState>) -> Result<VaultStatus, String> {
    let exists = vault_path()?.exists();
    let unlocked = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?
        .is_some();
    Ok(VaultStatus { exists, unlocked })
}

#[tauri::command]
pub fn vault_initialize(state: State<'_, VaultState>, passphrase: String) -> Result<(), String> {
    validate_passphrase(&passphrase)?;
    let path = vault_path()?;
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
    });

    log::info!("Vault initialized");
    Ok(())
}

pub(crate) fn unlock_vault(state: &VaultState, passphrase: String) -> Result<(), String> {
    validate_passphrase(&passphrase)?;
    let encrypted = fs::read(vault_path()?).map_err(|_| "vault not found".to_string())?;
    let (metadata, key, document) = decrypt_document(Zeroizing::new(passphrase), &encrypted)?;

    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = Some(UnlockedVault {
        key,
        metadata,
        document,
    });

    log::info!("Vault unlocked");
    Ok(())
}

#[tauri::command]
pub fn vault_unlock<'a>(state: State<'a, VaultState>, passphrase: String) -> Result<(), String> {
    unlock_vault(state.inner(), passphrase)
}

#[tauri::command]
pub fn vault_lock<'a>(state: State<'a, VaultState>) -> Result<(), String> {
    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = None;
    log::info!("Vault locked");
    Ok(())
}

pub(crate) fn store_secret(
    state: &VaultState,
    vault_ref: String,
    secret: String,
) -> Result<(), String> {
    validate_vault_ref(&vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "credential vault is locked".to_string())?;

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
    log::info!("Vault secret updated");
    Ok(())
}

fn delete_secret(state: &VaultState, vault_ref: &str) -> Result<bool, String> {
    validate_vault_ref(vault_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "credential vault is locked".to_string())?;

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
    log::info!("Vault secret deleted");
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
        let result = decrypt_document(
            Zeroizing::new("wrong passphrase".to_string()),
            &encrypted,
        );
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
    fn vault_refs_require_scoped_namespaces() {
        assert!(validate_vault_ref("core:sftp/server-1/password").is_ok());
        assert!(validate_vault_ref("plugin:remotehand.marielle-chat/gemini/api-key").is_ok());
        assert!(validate_vault_ref("connection:legacy").is_err());
        assert!(validate_vault_ref("plugin:remotehand.notes/../other").is_err());
        assert!(validate_core_ref("plugin:remotehand.notes/private").is_err());
    }
}
