# RemoteHand Vault v1.3.0 Design

Status: Design baseline
Target release: RemoteHand v1.3.0
Repository: webbytenchi/remotehand

## Purpose

RemoteHand Vault is a core-owned security service for protecting credentials, API keys, private plugin data, and other sensitive material used by RemoteHand and its plugins.

Initial known consumers:
- SFTP credentials and related secret material
- Notes encrypted-at-rest private data
- Marielle Chat Gemini API key and future AI-provider credentials

The design must remain generic enough for future authenticated plugins without forcing each plugin to invent its own encryption, key management, or credential-storage scheme.

## Design Goals

Vault should be simple to reason about and audit, secure enough for sysadmins and security-conscious users, suitable as a foundation for future enterprise hardening, standards-based, core-owned, portable with RemoteHand data, versioned, and evolvable without an architectural rewrite.

Vault security must not rely on obscurity. A technically competent reviewer should be able to know the file format, KDF, cipher, implementation details, and fixed application context strings without gaining the ability to decrypt Vault contents.

The user's unlock secret and the cryptographic key material derived from it are the actual security boundary.

## Clean-Break Decision

RemoteHand v1.3.0 Vault is a clean-slate design.

There is no requirement to preserve, migrate, or remain compatible with existing SFTP Vault entries or legacy Vault storage formats.

The existing src-tauri/src/vault.rs and SFTP credential flow should still be inspected to understand current consumers and integration points, but the old storage format is not a design constraint.

## Threat Model

Vault is designed to protect data at rest against:
- casual inspection of RemoteHand data files;
- theft or copying of the portable RemoteHand data directory;
- offline attempts to recover stored secrets;
- tampering with encrypted Vault contents;
- unauthorized plugin access to another plugin's secrets or private documents;
- accidental exposure through logs, diagnostics, configuration files, or plugin storage;
- malformed or corrupted Vault files;
- implementation mistakes around namespace boundaries and permission checks.

Vault does not attempt to protect secrets from an attacker who has already gained arbitrary code execution inside the same trusted RemoteHand process while the Vault is unlocked.

Future enterprise hardening may add stronger device-bound protections, managed policy, HSM/TPM-backed keys, or other controls, but these are outside the v1.3.0 requirement.

## Trust Model

### RemoteHand Core

RemoteHand core owns encryption/decryption, unlock and lock state, key derivation and key lifetime, namespace authorization, plugin permission enforcement, Vault persistence, corruption/tamper detection, audit boundaries, host-owned unlock UI, and backup/recovery behavior.

### Plugins

Plugins never receive:
- the Vault master key;
- the user's Vault unlock passphrase;
- unrestricted access to Vault contents;
- direct access to another plugin's namespace.

Plugins request narrow Vault operations through core APIs.

### User

The user controls the Vault unlock secret. The Vault must remain secure even if all other implementation details are public.

## Cryptographic Direction

The exact Rust crates and parameters must be chosen deliberately before implementation. Current preferred direction:
- password-based key derivation: Argon2id;
- authenticated encryption: XChaCha20-Poly1305 or another well-reviewed AEAD construction selected during implementation review;
- unique cryptographically random Vault salt;
- cryptographically random nonce per encrypted object/record as required by the chosen AEAD;
- OS-backed cryptographic randomness only;
- authenticated metadata where metadata affects security interpretation.

No custom cryptographic primitive or home-grown protocol should be introduced.

### Fixed Application Context

The string ILoveYouAndami-Papa may be used as non-secret application/domain-separation context.

It must contribute zero assumed secrecy. An attacker is assumed able to discover it from source code or binaries.

## Unlock Lifecycle

1. User enters the Vault unlock secret into host-owned RemoteHand UI.
2. Core derives a master/session key using the configured KDF and the Vault's random salt.
3. The unlock passphrase is discarded/zeroized as soon as practical.
4. Core retains only the derived key material needed for the unlocked session.
5. Vault operations use the in-memory derived key.
6. Locking removes/zeroizes derived key material and decrypted sensitive state as far as practical.
7. On application exit, Vault is locked automatically.

Plugins must not perform the unlock flow themselves and must not receive the passphrase.

A plugin may be allowed to request that the host present its Vault unlock UI, but the actual credential entry remains host-owned.

## Lock and Auto-Lock Behavior

v1.3.0 should support explicit manual lock, automatic lock on application exit, configurable or policy-driven auto-lock after inactivity once scoped, and clear error behavior when access is requested while locked.

There must be no insecure fallback to plaintext storage when the Vault is locked.

## Logical Data Model

Vault should distinguish at least two logical object classes.

### Secret Values

Examples: passwords, API keys, access tokens, passphrases, private-key material, and service credentials.

### Encrypted Structured Documents / Blobs

Examples: Notes content, private structured plugin state, and future sensitive documents or records.

The API should keep these logical types separate even if the initial physical storage format uses one encrypted container.

## Namespace Model

Vault access is namespace-scoped.

Examples:
- core:sftp/...
- plugin:remotehand.notes/...
- plugin:remotehand.marielle-chat/...

A plugin may access only its own namespace unless a separate, explicit future capability grants otherwise.

Namespace validation must be applied consistently to reads, writes, deletes, metadata queries, and any future list/search operations.

## Plugin Permissions

The plugin permission system must gate Vault capabilities explicitly.

Current credential-related permissions should be reviewed rather than copied forward blindly.

The v1.3.0 API should avoid exposing a raw vault.unlock method to plugins.

Likely permission categories include secret read/use, secret write/store, private-document read, private-document write, and host unlock prompt request if needed.

Permission checks and namespace checks are both required. Possessing a permission must not grant access outside the caller's authorized namespace.

## SFTP Integration

Current native SFTP retrieves a password from core Vault state and uses it to authenticate the SSH/SFTP session. The transport layer does not depend on the old Vault file format, so SFTP can move cleanly to the new Vault.

The new model should use a core-owned namespace such as core:sftp/<connection-id>/password or an equivalent structure chosen during API finalization.

Existing local SFTP connections/credentials do not need migration support.

## Notes Integration

Notes should not implement separate crypto.

Private/encrypted-at-rest Notes data should use Vault-backed structured documents or blobs under a Notes-specific namespace.

Vault should protect Notes content without exposing the master key or raw cross-plugin access.

## Marielle Chat Integration

Marielle Chat should store the Gemini API key through Vault under its own plugin namespace.

The Marielle Chat plugin must not store the Gemini API key in plaintext plugin storage, receive the Vault master key, receive the user's Vault unlock passphrase, or access another plugin's namespace.

Future provider credentials should use the same Vault abstraction.

## Physical Storage Direction

The initial implementation may use one versioned Vault container rather than one encrypted file per secret.

Conceptually:
- metadata
- secrets/core:sftp/...
- secrets/plugin:remotehand.marielle-chat/...
- documents/plugin:remotehand.notes/...

The caller-facing API must not depend on whether physical storage uses one file or multiple files.

## File Format

The Vault format should be versioned and sufficiently self-describing to support future upgrades.

Relevant metadata may include format version, Vault identifier, KDF identifier, KDF parameters, random salt, cipher suite identifier, encrypted payload metadata, and optional format flags.

Security-relevant metadata must be authenticated as appropriate.

The format should allow future crypto/compliance profiles without replacing the entire Vault architecture.

## Persistence and Atomicity

Vault writes must avoid leaving a partially written or silently lost Vault.

Intended write pattern:
1. serialize the new logical state;
2. encrypt/authenticate it;
3. write to a temporary file;
4. flush/sync as appropriate;
5. atomically replace the active Vault file using platform-safe behavior;
6. optionally retain a known-good backup if the recovery design includes one.

The implementation must not simply delete the active Vault and hope a later rename succeeds.

## Corruption and Tamper Handling

Vault must distinguish between wrong unlock secret, unsupported format version, malformed header/metadata, failed authentication/tamper detection, truncated/corrupt storage, and ordinary I/O failures.

Errors presented to users should avoid leaking secret information.

Corrupt or unauthenticated data must never be treated as valid plaintext.

## Backup, Restore, and Recovery

v1.3.0 should define a simple, explicit backup and recovery story.

At minimum:
- Vault files should be safely copyable as encrypted data;
- backup must not require decrypting contents;
- restore behavior should be deterministic;
- corruption recovery should not silently overwrite the last known-good copy;
- recovery design must not introduce a plaintext fallback or hidden master key.

Complex enterprise escrow/recovery is not required for v1.3.0.

## Auditability

Vault should support security-relevant audit events without logging secret values or decrypted private content.

Safe examples:
- Vault initialized;
- Vault unlocked;
- Vault locked;
- authorized plugin accessed an entry within its namespace;
- authorized plugin updated an encrypted document;
- unauthorized namespace request rejected;
- integrity/corruption check failed.

Audit output must never contain passwords, API keys, tokens, unlock secrets, decrypted Notes, private document contents, or raw master/session keys.

## Logging and Diagnostics

Secrets must never appear in normal application logs, error logs, plugin runtime logs, crash diagnostics controlled by RemoteHand, configuration files, or telemetry if telemetry is ever added.

Errors should use references/identifiers rather than secret values.

## Memory Hygiene

Use zeroization and secret-aware container types where practical.

At minimum:
- discard the user's unlock passphrase after key derivation;
- zeroize replaced/deleted secret buffers where practical;
- zeroize derived key material on lock/drop where supported;
- avoid unnecessary cloning of secrets;
- keep decrypted secret lifetimes as short as practical;
- avoid retaining decrypted whole-Vault state longer than required.

Rust and the operating system cannot guarantee that every historical copy disappears from memory, so documentation should not claim impossible guarantees.

## Security Testing

Vault v1.3.0 must have dedicated security/adversarial tests in addition to normal functional tests.

Test categories should include:
- correct unlock;
- wrong unlock secret;
- ciphertext tampering;
- header/metadata tampering;
- truncated Vault file;
- unsupported format version;
- malformed KDF/cipher parameters;
- namespace escape attempts;
- plugin-to-plugin access attempts;
- plugin-to-core namespace access attempts;
- missing permission;
- permission present but wrong namespace;
- plugin impersonation/identity mismatch;
- secret replacement/deletion;
- lock-state enforcement;
- no plaintext secret in persisted Vault;
- failed save/atomic replacement behavior;
- corruption recovery behavior;
- audit logs contain no secret values.

## Enterprise Security Posture

RemoteHand may be used by sysadmins and in enterprise environments. Vault must therefore be designed for security-conscious review, not merely personal convenience.

v1.3.0 should not attempt to implement every enterprise feature.

Future possibilities, not v1.3.0 requirements:
- FIPS-oriented crypto profiles;
- validated cryptographic modules;
- TPM-backed keys;
- HSM integration;
- Active Directory or directory-service policy;
- centralized enterprise policy;
- managed key recovery or escrow;
- device trust/pairing policies;
- managed deployment controls.

However, the v1.3.0 format, key-management abstraction, permission model, and host/plugin API should not make these future capabilities impossible without a full rewrite.

## Security Review Standard

A security reviewer may know every implementation detail, including source code, file format, algorithms, KDF parameters, and fixed RemoteHand context strings, and Vault contents should still remain protected unless the user unlock secret is recovered or the cryptography/host is compromised.

## Current Code Findings

The existing Vault implementation:
- is core-owned;
- stores a flat String -> String credential map;
- encrypts the whole document with the Rust age crate;
- keeps the passphrase in memory while unlocked;
- exposes host commands for initialize/unlock/lock/store/delete;
- provides internal get_secret/store_secret helpers;
- is used by native SFTP for password authentication.

The current plugin runtime already has credential-related permissions and namespace validation for credential writes.

However:
- the existing plugin credential read path does not apply the same namespace validation as writes;
- plugins can currently be granted a vault.unlock capability that accepts a passphrase;
- those behaviors do not match the new v1.3.0 trust model and should be redesigned.

## Implementation Order

Before coding:
1. finalize threat/trust model;
2. finalize crypto profile and Rust crates;
3. define Vault file format;
4. define key lifecycle;
5. define namespace and permission rules;
6. define host/plugin Vault APIs;
7. define lock/auto-lock UX;
8. define corruption/backup/recovery behavior;
9. define audit model.

Then implement on a dedicated feature branch with focused tests and manual acceptance.

## Release Position

RemoteHand public/stable remains v1.2.25.

v1.2.26 is a prepared/tagged checkpoint and remains intentionally unpublished unless explicitly approved.

Vault is the planned architectural milestone for RemoteHand v1.3.0.

## Implementation Checkpoint — 2026-09-30

The Vault is now actively implemented on branch `emma/vault-v1.3.0`. This section records the implemented/accepted state and supersedes older wording in this document that describes the crypto profile, lock behavior, or file format as merely provisional.

### Current Branch State

- Current remote feature-branch tip: `d128a99` (`Lock updated Vault AEAD dependency`).
- RemoteHand version metadata is still `1.2.26` on the feature branch.
- Public/stable RemoteHand remains v1.2.25.
- Prepared/tagged v1.2.26 remains intentionally unpublished.
- Vault remains targeted for v1.3.0; do not tag or publish the feature branch.

### Implemented Cryptographic Profile

Current implementation uses:
- Argon2id via `argon2 = 0.5.3`;
- Argon2 version 19;
- 64 MiB memory;
- 3 iterations;
- parallelism 1;
- 16-byte cryptographically random salt;
- XChaCha20-Poly1305 via `chacha20poly1305 = 0.11.0`;
- 24-byte random nonce per Vault encryption;
- 32-byte derived key;
- 16-byte random Vault identifier;
- OS-backed randomness;
- authenticated header/AAD including format version, Vault ID, KDF profile, cipher identifier, and the fixed RemoteHand context string.

`ILoveYouAndami-Papa` remains public/non-secret context only. Security does not rely on hiding it.

RemoteHand declares Rust 1.85. The AEAD 0.11 upgrade was tested successfully. Argon2 remains on the stable 0.5.3 line rather than moving to a release candidate.

### Current File Format and Limits

The current implementation uses:
- format version 1;
- Vault document version 1;
- portable path `data/vault/vault.enc`;
- one encrypted document containing logical `secrets` and `documents` maps;
- max Vault reference length 512 bytes;
- max Vault file size 128 MiB before full parsing;
- secret values: non-empty, max 64 KiB;
- document values: max 16 MiB.

The Vault path must be a regular file. Zero-length Vault files are rejected. Vault IDs must decode to exactly 16 bytes.

### Key Lifecycle and Locking

The user passphrase is used to derive the key and is not retained as the unlocked-state credential. The unlocked state retains the derived key plus the decrypted Vault document.

Implemented controls:
- locked by default after application restart;
- host-owned unlock prompt;
- explicit Lock Vault / Unlock Vault controls in Settings -> Vault;
- configurable core-owned auto-lock after Vault inactivity;
- supported intervals: 5, 15, 30, 60 minutes, or Never;
- default: 15 minutes;
- Vault activity means protected Vault data was read or changed;
- live status events update Settings immediately when the core locks/unlocks.

Papa manually accepted restart-lock, host unlock, manual lock/unlock, and 5-minute auto-lock behavior.

### Namespace and Plugin Boundary

Current scoped plugin Vault APIs remain:
- `vault.secret.get` gated by `vault.secrets.read`;
- `vault.secret.set/delete` gated by `vault.secrets.write`;
- `vault.document.get` gated by `vault.documents.read`;
- `vault.document.set/delete` gated by `vault.documents.write`.

Plugin-facing keys are caller-relative and core constructs `plugin:<plugin-id>/<key>`. Plugins cannot use a raw Vault unlock API. Plugins never receive the user's Vault passphrase or the Vault master key.

A future plugin-safe host-prompt request mechanism is still required for Marielle Chat and Notes so a locked Vault can trigger host-owned unlock UX without giving plugins passphrase handling.

### Windows Persistence / Backup

Current write strategy:
1. serialize/encrypt to a temporary file;
2. write and sync temporary bytes;
3. first Vault creation renames the temporary file into place and syncs the active file;
4. subsequent Windows writes use `ReplaceFileW` with `vault.bak` as last-known-good backup;
5. active and backup files are synced;
6. startup/status/unlock recovery removes stale temp files and can restore backup if the active file is missing;
7. if primary decrypt/authentication fails but the same passphrase successfully decrypts the backup, the backup is restored and used.

A Windows bug discovered during manual acceptance caused `Access is denied (os error 5)` because the post-rename durability helper reopened the file read-only before `sync_all`. It was fixed by reopening with read+write access. The original failed UI operation had already created a valid Vault, which was confirmed when the same passphrase later unlocked it.

Recovery is improved but is not yet considered fully validated. Dedicated filesystem recovery tests are the next planned slice.

### Validation and Acceptance

Latest observed automated validation:
- Rust tests: 51 passed, 0 failed.
- AEAD 0.11 migration compiles cleanly with no deprecated `XNonce::from_slice` warnings.
- Earlier production frontend builds passed after Vault Settings and auto-lock changes.
- Cargo.lock was updated, reviewed, committed, and pushed.

Manual acceptance completed:
- host-owned Create RemoteHand Vault prompt;
- connection password saved through Vault;
- restart returns Vault to locked state;
- correct passphrase unlocks and allows subsequent credential save;
- Settings status and manual Lock/Unlock;
- 5-minute core auto-lock;
- live Settings status transition from Unlocked to Locked without reopening the dialog.

### Important Remaining Work

Next planned implementation slice:
- dedicated recovery-path filesystem tests covering stale temp files, missing active file with valid backup, backup restoration, interrupted writes, and failure behavior.

Still open:
- add passphrase confirmation on first Vault creation;
- clean up the frontend `requestVaultAccess` Promise/listener implementation;
- define plugin-safe host unlock-prompt request semantics for Marielle Chat/Notes;
- decide legacy `credentials.use/store` deprecation and API-version implications;
- add systematic audit events without secret content;
- review backup rotation so failure after deleting an older `.bak` cannot unnecessarily reduce recovery options;
- document the rollback limitation for an attacker who can replace both active and backup with older authenticated ciphertext;
- document the whole decrypted Vault document being held in memory while unlocked;
- decide whether passphrase rotation belongs in v1.3.0 or a later release;
- add broader corruption/recovery/adversarial tests;
- do not claim FIPS compliance.

The core threat-model limitation remains: Vault cannot protect secrets from an attacker with arbitrary code execution inside the trusted RemoteHand process while the Vault is unlocked.
