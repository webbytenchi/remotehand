use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    env, fs,
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"RHVBLB01";
const FORMAT_VERSION: u32 = 1;
const CHUNK_SIZE: usize = 1024 * 1024;
const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;
const HEADER_BYTES: u64 = 8 + 4 + 4 + 8;
const MAX_BLOB_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CONTEXT: &str = "RemoteHand Vault Blob v1";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
struct UploadSession {
    vault_ref: String,
    temp_path: PathBuf,
    final_path: PathBuf,
    total_size: u64,
    next_index: u32,
    written: u64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct BlobInfo {
    pub(crate) size: u64,
    pub(crate) chunk_size: u32,
    pub(crate) chunks: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkAad<'a> {
    context: &'static str,
    vault_id: &'a str,
    vault_ref: &'a str,
    chunk_index: u32,
    total_size: u64,
    chunk_size: u32,
}

static UPLOADS: OnceLock<Mutex<BTreeMap<String, UploadSession>>> = OnceLock::new();
static CLEANUP_ONCE: OnceLock<()> = OnceLock::new();

fn uploads() -> &'static Mutex<BTreeMap<String, UploadSession>> {
    UPLOADS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn random_hex(bytes: usize) -> String {
    let mut random = vec![0u8; bytes];
    OsRng.fill_bytes(&mut random);
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hmac_bytes(key: &[u8], parts: &[&[u8]]) -> Result<[u8; 32], String> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|_| "failed to initialize Vault blob key derivation".to_string())?;
    for part in parts {
        mac.update(part);
    }
    let bytes = mac.finalize().into_bytes();
    let mut output = [0u8; 32];
    output.copy_from_slice(&bytes);
    Ok(output)
}

fn blob_key(master_key: &[u8; 32], vault_ref: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    Ok(Zeroizing::new(hmac_bytes(
        master_key,
        &[b"blob-encryption-v1\0", vault_ref.as_bytes()],
    )?))
}

fn blob_filename(master_key: &[u8; 32], vault_ref: &str) -> Result<String, String> {
    let digest = hmac_bytes(
        master_key,
        &[b"blob-path-v1\0", vault_ref.as_bytes()],
    )?;
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn vault_root() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "failed to resolve executable directory".to_string())?;
    Ok(executable_dir.join("data").join("vault"))
}

fn blobs_root() -> Result<PathBuf, String> {
    Ok(vault_root()?.join("blobs"))
}

fn cleanup_stale_uploads(root: &Path) {
    CLEANUP_ONCE.get_or_init(|| {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(".upload-") && name.ends_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
    });
}

fn final_path(master_key: &[u8; 32], vault_ref: &str) -> Result<PathBuf, String> {
    Ok(blobs_root()?.join(format!("{}.blob", blob_filename(master_key, vault_ref)?)))
}

fn validate_size(size: u64) -> Result<(), String> {
    if size > MAX_BLOB_BYTES {
        return Err("Vault blob exceeds the 4 GiB implementation limit".to_string());
    }
    Ok(())
}

fn chunk_count(size: u64) -> u32 {
    if size == 0 {
        0
    } else {
        ((size - 1) / CHUNK_SIZE as u64 + 1) as u32
    }
}

fn expected_chunk_len(total_size: u64, index: u32) -> Result<usize, String> {
    let chunks = chunk_count(total_size);
    if index >= chunks {
        return Err("Vault blob chunk index is out of range".to_string());
    }
    let start = index as u64 * CHUNK_SIZE as u64;
    let remaining = total_size - start;
    Ok(remaining.min(CHUNK_SIZE as u64) as usize)
}

fn write_header(file: &mut fs::File, total_size: u64) -> Result<(), String> {
    file.write_all(MAGIC)
        .and_then(|_| file.write_all(&FORMAT_VERSION.to_le_bytes()))
        .and_then(|_| file.write_all(&(CHUNK_SIZE as u32).to_le_bytes()))
        .and_then(|_| file.write_all(&total_size.to_le_bytes()))
        .map_err(|error| error.to_string())
}

fn read_header(file: &mut fs::File) -> Result<BlobInfo, String> {
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)
        .map_err(|_| "Vault blob header is incomplete".to_string())?;
    if &magic != MAGIC {
        return Err("Vault blob format is invalid".to_string());
    }

    let mut version = [0u8; 4];
    let mut chunk_size = [0u8; 4];
    let mut total_size = [0u8; 8];
    file.read_exact(&mut version)
        .and_then(|_| file.read_exact(&mut chunk_size))
        .and_then(|_| file.read_exact(&mut total_size))
        .map_err(|_| "Vault blob header is incomplete".to_string())?;

    let version = u32::from_le_bytes(version);
    let chunk_size = u32::from_le_bytes(chunk_size);
    let total_size = u64::from_le_bytes(total_size);
    if version != FORMAT_VERSION || chunk_size as usize != CHUNK_SIZE {
        return Err("unsupported Vault blob format".to_string());
    }
    validate_size(total_size)?;

    Ok(BlobInfo {
        size: total_size,
        chunk_size,
        chunks: chunk_count(total_size),
    })
}

fn aad(vault_id: &str, vault_ref: &str, index: u32, total_size: u64) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&ChunkAad {
        context: CONTEXT,
        vault_id,
        vault_ref,
        chunk_index: index,
        total_size,
        chunk_size: CHUNK_SIZE as u32,
    })
    .map_err(|error| error.to_string())
}

fn encrypt_chunk(
    master_key: &[u8; 32],
    vault_id: &str,
    vault_ref: &str,
    index: u32,
    total_size: u64,
    plaintext: &[u8],
) -> Result<([u8; NONCE_BYTES], Vec<u8>), String> {
    let key = blob_key(master_key, vault_ref)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "Vault blob key is invalid".to_string())?;
    let mut nonce = [0u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce);
    let nonce_ref = <&XNonce>::try_from(&nonce[..])
        .map_err(|_| "Vault blob nonce is invalid".to_string())?;
    let ciphertext = cipher
        .encrypt(
            nonce_ref,
            Payload {
                msg: plaintext,
                aad: &aad(vault_id, vault_ref, index, total_size)?,
            },
        )
        .map_err(|_| "failed to encrypt Vault blob chunk".to_string())?;
    Ok((nonce, ciphertext))
}

fn decrypt_chunk(
    master_key: &[u8; 32],
    vault_id: &str,
    vault_ref: &str,
    index: u32,
    total_size: u64,
    nonce: &[u8; NONCE_BYTES],
    ciphertext: &[u8],
) -> Result<Vec<u8>, String> {
    let key = blob_key(master_key, vault_ref)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "Vault blob key is invalid".to_string())?;
    let nonce_ref = <&XNonce>::try_from(&nonce[..])
        .map_err(|_| "Vault blob nonce is invalid".to_string())?;
    cipher
        .decrypt(
            nonce_ref,
            Payload {
                msg: ciphertext,
                aad: &aad(vault_id, vault_ref, index, total_size)?,
            },
        )
        .map_err(|_| "failed to decrypt Vault blob chunk".to_string())
}

pub(crate) fn begin_upload(
    master_key: &[u8; 32],
    vault_ref: &str,
    total_size: u64,
) -> Result<(String, u32, u32), String> {
    validate_size(total_size)?;
    let root = blobs_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    cleanup_stale_uploads(&root);

    let destination = final_path(master_key, vault_ref)?;
    if destination.exists() {
        return Err("Vault blob already exists; delete it before replacing it".to_string());
    }

    let upload_id = random_hex(16);
    let temp_path = root.join(format!(".upload-{upload_id}.tmp"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| error.to_string())?;
    write_header(&mut file, total_size)?;
    file.flush().map_err(|error| error.to_string())?;

    uploads()
        .lock()
        .map_err(|_| "Vault blob upload state is unavailable".to_string())?
        .insert(
            upload_id.clone(),
            UploadSession {
                vault_ref: vault_ref.to_string(),
                temp_path,
                final_path: destination,
                total_size,
                next_index: 0,
                written: 0,
            },
        );

    Ok((upload_id, CHUNK_SIZE as u32, chunk_count(total_size)))
}

pub(crate) fn write_upload_chunk(
    master_key: &[u8; 32],
    vault_id: &str,
    vault_ref: &str,
    upload_id: &str,
    index: u32,
    plaintext: &[u8],
) -> Result<u64, String> {
    if upload_id.is_empty() || upload_id.len() > 128 {
        return Err("Vault blob upload id is invalid".to_string());
    }

    let mut guard = uploads()
        .lock()
        .map_err(|_| "Vault blob upload state is unavailable".to_string())?;
    let session = guard
        .get_mut(upload_id)
        .ok_or_else(|| "Vault blob upload is not active".to_string())?;
    if session.vault_ref != vault_ref {
        return Err("Vault blob upload does not belong to this key".to_string());
    }

    if index != session.next_index {
        return Err("Vault blob chunks must be written in order".to_string());
    }
    let expected = expected_chunk_len(session.total_size, index)?;
    if plaintext.len() != expected {
        return Err(format!(
            "Vault blob chunk has invalid size: expected {expected} bytes"
        ));
    }

    let (nonce, ciphertext) = encrypt_chunk(
        master_key,
        vault_id,
        &session.vault_ref,
        index,
        session.total_size,
        plaintext,
    )?;

    let mut file = OpenOptions::new()
        .append(true)
        .open(&session.temp_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&nonce)
        .and_then(|_| file.write_all(&ciphertext))
        .and_then(|_| file.flush())
        .map_err(|error| error.to_string())?;

    session.written += plaintext.len() as u64;
    session.next_index += 1;
    Ok(session.written)
}

pub(crate) fn commit_upload(vault_ref: &str, upload_id: &str) -> Result<BlobInfo, String> {
    let mut guard = uploads()
        .lock()
        .map_err(|_| "Vault blob upload state is unavailable".to_string())?;
    let matches = guard
        .get(upload_id)
        .map(|session| session.vault_ref == vault_ref)
        .unwrap_or(false);
    if !matches {
        return Err("Vault blob upload does not belong to this key".to_string());
    }
    let session = guard
        .remove(upload_id)
        .ok_or_else(|| "Vault blob upload is not active".to_string())?;
    drop(guard);

    if session.written != session.total_size
        || session.next_index != chunk_count(session.total_size)
    {
        let _ = fs::remove_file(&session.temp_path);
        return Err("Vault blob upload is incomplete".to_string());
    }
    if session.final_path.exists() {
        let _ = fs::remove_file(&session.temp_path);
        return Err("Vault blob already exists".to_string());
    }

    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&session.temp_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&session.temp_path, &session.final_path).map_err(|error| error.to_string())?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&session.final_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;

    Ok(BlobInfo {
        size: session.total_size,
        chunk_size: CHUNK_SIZE as u32,
        chunks: chunk_count(session.total_size),
    })
}

pub(crate) fn abort_upload(vault_ref: &str, upload_id: &str) -> Result<bool, String> {
    let mut guard = uploads()
        .lock()
        .map_err(|_| "Vault blob upload state is unavailable".to_string())?;
    let Some(existing) = guard.get(upload_id) else {
        return Ok(false);
    };
    if existing.vault_ref != vault_ref {
        return Err("Vault blob upload does not belong to this key".to_string());
    }
    let session = guard
        .remove(upload_id)
        .ok_or_else(|| "Vault blob upload is not active".to_string())?;
    drop(guard);
    match fs::remove_file(&session.temp_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}


pub(crate) fn abort_all_uploads() {
    let sessions = match uploads().lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => return,
    };
    for session in sessions.into_values() {
        let _ = fs::remove_file(session.temp_path);
    }
}

pub(crate) fn info(master_key: &[u8; 32], vault_ref: &str) -> Result<Option<BlobInfo>, String> {
    let path = final_path(master_key, vault_ref)?;
    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    Ok(Some(read_header(&mut file)?))
}

pub(crate) fn read_chunk(
    master_key: &[u8; 32],
    vault_id: &str,
    vault_ref: &str,
    index: u32,
) -> Result<Vec<u8>, String> {
    let path = final_path(master_key, vault_ref)?;
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Vault blob was not found".to_string()
            } else {
                error.to_string()
            }
        })?;
    let info = read_header(&mut file)?;
    let plaintext_len = expected_chunk_len(info.size, index)?;
    let record_size = NONCE_BYTES as u64 + CHUNK_SIZE as u64 + TAG_BYTES as u64;
    let offset = HEADER_BYTES + index as u64 * record_size;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;

    let mut nonce = [0u8; NONCE_BYTES];
    let mut ciphertext = vec![0u8; plaintext_len + TAG_BYTES];
    file.read_exact(&mut nonce)
        .and_then(|_| file.read_exact(&mut ciphertext))
        .map_err(|_| "Vault blob chunk is incomplete".to_string())?;

    let plaintext = decrypt_chunk(
        master_key,
        vault_id,
        vault_ref,
        index,
        info.size,
        &nonce,
        &ciphertext,
    )?;
    if plaintext.len() != plaintext_len {
        return Err("Vault blob chunk has an invalid decrypted size".to_string());
    }
    Ok(plaintext)
}

pub(crate) fn delete(master_key: &[u8; 32], vault_ref: &str) -> Result<bool, String> {
    let path = final_path(master_key, vault_ref)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "remotehand-vault-blob-test-{}-{}",
            std::process::id(),
            random_hex(6)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn chunk_count_handles_boundaries() {
        assert_eq!(chunk_count(0), 0);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(CHUNK_SIZE as u64), 1);
        assert_eq!(chunk_count(CHUNK_SIZE as u64 + 1), 2);
    }

    #[test]
    fn blob_chunk_round_trip_and_tamper_rejection() {
        let key = [7u8; 32];
        let vault_id = "vault-test";
        let vault_ref = "plugin:remotehand.notes/attachment/example";
        let plaintext = b"private attachment bytes";
        let (nonce, mut ciphertext) =
            encrypt_chunk(&key, vault_id, vault_ref, 0, plaintext.len() as u64, plaintext).unwrap();
        let decoded = decrypt_chunk(
            &key,
            vault_id,
            vault_ref,
            0,
            plaintext.len() as u64,
            &nonce,
            &ciphertext,
        )
        .unwrap();
        assert_eq!(decoded, plaintext);

        ciphertext[0] ^= 0x80;
        assert!(decrypt_chunk(
            &key,
            vault_id,
            vault_ref,
            0,
            plaintext.len() as u64,
            &nonce,
            &ciphertext,
        )
        .is_err());
    }

    #[test]
    fn blob_path_is_keyed_and_stable() {
        let key = [3u8; 32];
        let first = blob_filename(&key, "plugin:remotehand.notes/attachment/a").unwrap();
        let again = blob_filename(&key, "plugin:remotehand.notes/attachment/a").unwrap();
        let other = blob_filename(&key, "plugin:remotehand.notes/attachment/b").unwrap();
        assert_eq!(first, again);
        assert_ne!(first, other);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn header_round_trip() {
        let root = test_root();
        let path = root.join("blob");
        {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&path).unwrap();
            write_header(&mut file, CHUNK_SIZE as u64 + 10).unwrap();
        }
        let mut file = OpenOptions::new().read(true).open(&path).unwrap();
        let info = read_header(&mut file).unwrap();
        assert_eq!(info.size, CHUNK_SIZE as u64 + 10);
        assert_eq!(info.chunks, 2);
        let _ = fs::remove_dir_all(root);
    }
}
