use age::{secrecy::SecretString, Decryptor, Encryptor};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::State;
use zeroize::{Zeroize, Zeroizing};
const VAULT_VERSION: u32 = 1;
#[derive(Default)]
pub struct VaultState {
    unlocked: Mutex<Option<UnlockedVault>>,
}
struct UnlockedVault {
    passphrase: SecretString,
    document: VaultDocument,
}
#[derive(Debug, Default, Deserialize, Serialize)]
struct VaultDocument {
    version: u32,
    entries: BTreeMap<String, String>,
}

impl Drop for VaultDocument {
    fn drop(&mut self) {
        for secret in self.entries.values_mut() {
            secret.zeroize();
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
    Ok(executable_dir
        .join("data")
        .join("vault")
        .join("credentials.enc"))
}
fn encrypt_document(passphrase: SecretString, document: &VaultDocument) -> Result<Vec<u8>, String> {
    let plaintext =
        Zeroizing::new(serde_json::to_vec(document).map_err(|error| error.to_string())?);
    let encryptor = Encryptor::with_user_passphrase(passphrase);
    let mut encrypted = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut encrypted)
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&plaintext)
        .map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())?;
    Ok(encrypted)
}
fn decrypt_document(passphrase: SecretString, encrypted: &[u8]) -> Result<VaultDocument, String> {
    let decryptor = Decryptor::new(encrypted).map_err(|error| error.to_string())?;
    let identity = age::scrypt::Identity::new(passphrase);
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| "failed to unlock vault".to_string())?;
    let mut plaintext = Zeroizing::new(Vec::new());
    reader
        .read_to_end(&mut plaintext)
        .map_err(|error| error.to_string())?;
    let document: VaultDocument =
        serde_json::from_slice(&plaintext).map_err(|_| "vault contents are invalid".to_string())?;
    if document.version != VAULT_VERSION {
        return Err(format!("unsupported vault version: {}", document.version));
    }
    Ok(document)
}
fn save_document(passphrase: SecretString, document: &VaultDocument) -> Result<(), String> {
    let path = vault_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "failed to resolve vault directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let encrypted = encrypt_document(passphrase, document)?;
    let temporary_path = path.with_extension("enc.tmp");
    fs::write(&temporary_path, encrypted).map_err(|error| error.to_string())?;

    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }

    fs::rename(temporary_path, path).map_err(|error| error.to_string())
}
fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.trim().is_empty() {
        return Err("vault passphrase is required".to_string());
    }
    Ok(())
}
fn validate_credential_ref(credential_ref: &str) -> Result<(), String> {
    if credential_ref.trim().is_empty() {
        return Err("credential reference is required".to_string());
    }
    Ok(())
}
pub(crate) fn get_secret(
    state: &VaultState,
    credential_ref: &str,
) -> Result<Option<String>, String> {
    validate_credential_ref(credential_ref)?;
    let guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_ref()
        .ok_or_else(|| "credential vault is locked".to_string())?;
    Ok(vault.document.entries.get(credential_ref).cloned())
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
    let passphrase = SecretString::from(passphrase);
    let document = VaultDocument {
        version: VAULT_VERSION,
        entries: BTreeMap::new(),
    };
    save_document(passphrase.clone(), &document)?;

    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = Some(UnlockedVault {
        passphrase,
        document,
    });

    log::info!("Credential vault initialized");
    Ok(())
}
pub(crate) fn unlock_vault(state: &VaultState, passphrase: String) -> Result<(), String> {
    validate_passphrase(&passphrase)?;
    let encrypted =
        fs::read(vault_path()?).map_err(|_| "credential vault not found".to_string())?;
    let passphrase = SecretString::from(passphrase);
    let document = decrypt_document(passphrase.clone(), &encrypted)?;
    *state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())? = Some(UnlockedVault {
        passphrase,
        document,
    });

    log::info!("Credential vault unlocked");
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
    log::info!("Credential vault locked");
    Ok(())
}
pub(crate) fn store_secret(
    state: &VaultState,
    credential_ref: String,
    secret: String,
) -> Result<(), String> {
    validate_credential_ref(&credential_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "credential vault is locked".to_string())?;
    if let Some(mut replaced) = vault.document.entries.insert(credential_ref, secret) {
        replaced.zeroize();
    }
    save_document(vault.passphrase.clone(), &vault.document)?;
    log::info!("Credential vault updated");
    Ok(())
}
#[tauri::command]
pub fn vault_store_secret<'a>(
    state: State<'a, VaultState>,
    credential_ref: String,
    secret: String,
) -> Result<(), String> {
    store_secret(&state, credential_ref, secret)
}
#[tauri::command]
pub fn vault_delete_secret<'a>(
    state: State<'a, VaultState>,
    credential_ref: String,
) -> Result<bool, String> {
    validate_credential_ref(&credential_ref)?;
    let mut guard = state
        .unlocked
        .lock()
        .map_err(|_| "vault state is unavailable".to_string())?;
    let vault = guard
        .as_mut()
        .ok_or_else(|| "credential vault is locked".to_string())?;
    let mut removed = vault.document.entries.remove(&credential_ref);
    if let Some(secret) = removed.as_mut() {
        secret.zeroize();
        save_document(vault.passphrase.clone(), &vault.document)?;
        log::info!("Credential removed from vault");
    }
    Ok(removed.is_some())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample_document() -> VaultDocument {
        let mut entries = BTreeMap::new();
        entries.insert(
            "credential:test".to_string(),
            "REMOTEHAND_TEST_SECRET_914".to_string(),
        );
        VaultDocument {
            version: VAULT_VERSION,
            entries,
        }
    }

    #[test]
    fn encrypted_vault_round_trips() {
        let passphrase = SecretString::from("correct horse battery staple".to_string());
        let document = sample_document();

        let encrypted = encrypt_document(passphrase.clone(), &document).unwrap();
        let decrypted = decrypt_document(passphrase, &encrypted).unwrap();

        assert_eq!(decrypted.version, VAULT_VERSION);
        assert_eq!(
            decrypted.entries.get("credential:test").map(String::as_str),
            Some("REMOTEHAND_TEST_SECRET_914")
        );
    }

    #[test]
    fn wrong_passphrase_cannot_decrypt_vault() {
        let encrypted = encrypt_document(
            SecretString::from("correct passphrase".to_string()),
            &sample_document(),
        )
        .unwrap();

        let result = decrypt_document(
            SecretString::from("wrong passphrase".to_string()),
            &encrypted,
        );

        assert!(result.is_err());
    }

    #[test]
    fn encrypted_payload_does_not_contain_plaintext_secret() {
        let encrypted = encrypt_document(
            SecretString::from("portable vault passphrase".to_string()),
            &sample_document(),
        )
        .unwrap();

        assert!(!encrypted
            .windows(b"REMOTEHAND_TEST_SECRET_914".len())
            .any(|window| window == b"REMOTEHAND_TEST_SECRET_914"));
    }
}
