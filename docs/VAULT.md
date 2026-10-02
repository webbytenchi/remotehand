# RemoteHand Vault v1.3.0 Design

Status: Implementation baseline
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

## Cryptographic Profile

Vault format v1 now uses the following fixed implementation profile:
- KDF: Argon2id, version 0x13 / 19;
- Argon2 memory: 64 MiB;
- Argon2 iterations: 3;
- Argon2 parallelism: 1;
- random salt: 16 bytes from the OS-backed RNG;
- derived key: 32 bytes;
- AEAD: XChaCha20-Poly1305;
- random nonce: 24 bytes per encrypted Vault write;
- Vault identifier: 16 random bytes;
- encrypted Vault file maximum: 128 MiB;
- secret value maximum: 64 KiB;
- private document maximum: 16 MiB.

The versioned envelope carries the format version, Vault identifier, KDF profile, cipher identifier, nonce, and ciphertext. Security-relevant header data is authenticated as AEAD associated data.

Unsupported KDF parameters, cipher identifiers, format versions, malformed identifiers/nonces/salts, failed authentication, and bounded-I/O violations are rejected. No custom cryptographic primitive or home-grown cipher is used.

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

## Plugin Permissions and API Compatibility

The finalized Plugin API v1 Vault permissions are:
- `vault.secrets.read`;
- `vault.secrets.write`;
- `vault.documents.read`;
- `vault.documents.write`;
- `vault.access.request`.

The corresponding host methods are `vault.secret.get`, `vault.secret.set`, `vault.secret.delete`, `vault.document.get`, `vault.document.set`, `vault.document.delete`, and `vault.request_access`.

Permission checks and caller-derived namespace checks are both required. Possessing a permission never grants cross-plugin or core-namespace access.

`vault.request_access` asks RemoteHand core to present the host-owned create/unlock UI. The plugin supplies only a bounded human-readable reason; it never receives or submits the passphrase or derived key. Raw plugin `vault.unlock` is unsupported.

Plugin API remains version 1 for Vault v1.3.0 because these capabilities are additive. The older `credentials.use` and `credentials.store` methods remain temporarily accepted as deprecated v1 compatibility aliases. They are not the canonical API for new plugins. Removing them would be a breaking plugin-API change and is deferred to a future Plugin API v2 or other explicitly breaking revision.

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

The v1.3.0 implementation uses one versioned encrypted Vault container rather than one encrypted file per secret. The active file is `data/vault/vault.enc`; `vault.bak` is the encrypted last-known-good backup used by the recovery path.

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

Vault distinguishes structural/format problems (unsupported version/profile, malformed header/metadata, bounded-I/O failures) and ordinary I/O failures from authentication failure.

Wrong passphrases and authenticated-ciphertext tampering intentionally converge on the same generic unlock/authentication failure path rather than revealing which condition occurred. Errors presented to users should avoid leaking secret information.

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


## Implementation Checkpoint — 2026-10-01

This checkpoint supersedes the earlier remaining-work notes where they differ.

### Recovery and Bounded I/O

The recovery/read/write hardening slice is now implemented:
- dedicated filesystem tests cover stale temporary-file cleanup when the active Vault exists;
- orphan temporary files are discarded when neither active nor backup exists;
- a missing active Vault is restored from a valid encrypted backup;
- unlock falls back to a valid backup when the active Vault is corrupt and the same passphrase authenticates the backup;
- a wrong passphrase does not cause the backup to replace the active file;
- successful second writes replace the active Vault and preserve the previous active ciphertext as `vault.bak`;
- oversized writes are rejected before touching disk;
- Vault reads use a single open file handle, inspect metadata on that handle, read through a `MAX_VAULT_FILE_BYTES + 1` limiter, and validate the resulting length again.

The maximum encrypted Vault file size remains 128 MiB.

### Host-Owned Plugin Access Requests

Plugins now have a dedicated capability for requesting host-owned Vault access:
- manifest permission: `vault.access.request`;
- host API method: `vault.request_access`;
- request parameters contain only a bounded human-readable reason;
- the host supplies the authenticated plugin identity separately;
- RemoteHand core emits a host UI request and waits for the host-owned prompt result;
- the plugin never receives or submits the Vault passphrase;
- the plugin never receives the derived/master key;
- concurrent Vault access requests share the active host-owned prompt; later requests remain pending and are settled with the same successful unlock or cancellation;
- plugin access requests time out instead of blocking indefinitely;
- successful completion means the Vault is unlocked before the plugin request returns.

The host UI identifies the requesting plugin before showing the plugin-provided reason. First-time Vault creation now requires entering the passphrase twice and matching both values.

A raw plugin `vault.unlock` API remains rejected.

### Audit-Safe Plugin Boundaries

Plugin Vault operations now produce security-relevant audit log entries using only:
- authenticated plugin ID;
- a fixed action category such as `secret.read`, `secret.write`, `document.read`, `document.write`, or `access.request`;
- an outcome such as allowed or denied.

Secret values, document contents, Vault keys, passphrases, and Vault entry references are intentionally not included in these audit records.

The older `credentials.use` / `credentials.store` paths remain temporarily supported and are explicitly labeled as legacy actions in audit output. Their final deprecation/removal decision is still pending.

### Frontend Prompt Robustness

The frontend Vault request helper no longer uses an async Promise executor. Listener setup is completed before the request event is emitted, and cleanup runs deterministically after success or failure.

First-time Vault creation now includes a confirmation field so an accidental passphrase typo cannot silently create a Vault that the user cannot reopen.

When multiple Vault-dependent plugins restore at startup while the Vault is locked, the first request owns the visible prompt and additional requests are queued in the host UI. A successful unlock releases every queued request, so each plugin can continue its original initialization without being closed and reopened.

### Current Validation Target

The last accepted checkpoint before this batch was:
- Rust tests: 59 passed, 0 failed;
- production frontend build: passed.

This batch adds plugin-access permission tests and audit-action tests. Run the full Rust suite and production frontend build before marking this checkpoint accepted.

### Still Open

Remaining higher-level decisions/work include:
- decide the final deprecation/removal path for legacy `credentials.use` and `credentials.store`;
- decide whether plugin API v1 remains appropriate once the Vault API is finalized;
- broaden audit coverage if persistent audit storage or enterprise export is desired later;
- document the rollback limitation for an attacker able to replace both active and backup with older authenticated ciphertext;
- document that the decrypted Vault document remains in memory while the Vault is unlocked;
- decide whether passphrase rotation belongs in v1.3.0 or a later release;
- do not claim FIPS compliance for the current Argon2id + XChaCha20-Poly1305 profile.


## Finalized v1.3.0 API Decision — 2026-10-01

Plugin API remains **v1** for the Vault milestone.

Rationale:
- the new Vault permissions and host methods are additive;
- existing non-Vault Plugin API v1 plugins remain compatible;
- `credentials.use` and `credentials.store` are retained as deprecated aliases rather than removed;
- raw plugin `vault.unlock` is rejected and is not part of the supported v1 API;
- a future removal of the deprecated credential aliases should coincide with an explicitly breaking Plugin API revision.

The parked VNC plugin currently carries the old credential permissions and a legacy `vault.unlock` declaration. It is not being migrated as part of the Vault v1.3.0 core milestone; its manifest/runtime must be updated before it is treated as compatible with the finalized Vault surface.

### Accepted in-memory tradeoff

While unlocked, the current implementation retains the decrypted logical Vault document in RemoteHand core memory together with the derived session key. Secret/document strings are zeroized where practical on replacement, deletion, lock, and drop, but the design does not claim protection against an attacker with arbitrary code execution in the trusted RemoteHand process while the Vault is unlocked.

### Rollback limitation

AEAD authenticates the contents and security-relevant metadata of each Vault file, but v1.3.0 does not provide monotonic anti-rollback state. An attacker able to replace both `vault.enc` and `vault.bak` with older, previously valid encrypted copies may roll the Vault back to that older authenticated state without forging ciphertext.


## Security Readiness Checkpoint — 2026-10-01

A release-readiness review of the Vault integration now includes the following controls:

- host/core Vault logging was inspected for passphrase, secret, credential-reference, and Vault-reference leakage; current Vault security logs use fixed event text, authenticated plugin identity, fixed action categories, and outcomes rather than secret values or entry references;
- saved SFTP connection state contains an opaque `credentialRef` only; an automated serialization regression test rejects the introduction of JSON fields named `password` or `secret`;
- `SECURITY.md` has been updated from the obsolete age/`credentials.enc`/plugin-`vault.unlock` description to the implemented Argon2id + XChaCha20-Poly1305 `vault.enc` model and host-owned plugin access request flow;
- the resolved lockfile currently contains `russh 0.62.2`, `russh-cryptovec 0.62.0`, `zip 2.4.2`, `argon2 0.5.3` for Vault plus another transitive Argon2 version, and `chacha20poly1305 0.11.0`;
- targeted RustSec review confirmed the known 2026 `russh` allocation advisory is patched from `russh >=0.60.3`, while RemoteHand resolves 0.62.2;
- targeted RustSec review confirmed the known `zip` extraction advisory is patched from `zip >=2.3.0`, while RemoteHand resolves 2.4.2;
- RustSec notes the historical ChaCha20 counter-overflow advisory does not affect users of the `chacha20poly1305` crate.

This targeted review is not a substitute for scanning the complete dependency graph. Before merge/release acceptance, run `cargo audit` against `src-tauri/Cargo.lock` and resolve or explicitly evaluate any reported advisory.

The final manual acceptance slice should also exercise the plugin-owned `vault.request_access` flow end to end: locked Vault -> plugin request -> host-owned prompt -> unlock -> plugin request resumes successfully, plus user cancellation returning an error without exposing the passphrase to the plugin.


### Full Lockfile Audit Result — 2026-10-01

The first full `cargo audit --file .\src-tauri\Cargo.lock` run completed against 658 resolved crate dependencies and reported **no vulnerability failures**. It reported seven allowed warnings:

- `proc-macro-error 1.0.4`: unmaintained;
- `unic-char-property 0.9.0`: unmaintained;
- `unic-char-range 0.9.0`: unmaintained;
- `unic-common 0.9.0`: unmaintained;
- `unic-ucd-ident 0.9.0`: unmaintained;
- `unic-ucd-version 0.9.0`: unmaintained;
- `glib 0.18.5`: RustSec unsoundness warning RUSTSEC-2024-0429.

Dependency tracing shows the `unic-*` warnings arrive through `tauri-utils -> urlpattern`. The `proc-macro-error` and `glib` warnings arrive through the GTK/Tauri desktop dependency graph (including GTK3-related dependencies used for non-Windows desktop targets), not through the Vault cryptography stack.

RUSTSEC-2024-0429 affects `glib::VariantStrIter` iterator implementations in `glib >=0.15,<0.20` and is patched in `glib >=0.20`. The current GTK3/Tauri dependency graph resolves `glib 0.18.5`, so the warning remains tracked rather than silently ignored. This is an upstream/platform dependency issue and must be reconsidered for Linux release readiness or when the Tauri/GTK dependency graph can move to a patched `glib` line.

The unmaintained warnings likewise remain tracked. They do not have direct patched releases within their current package lines and should be eliminated through future upstream dependency migrations rather than ad-hoc Vault-specific replacements.


## Test-Only Plugin Access Broker Acceptance — 2026-10-01

The final Vault broker acceptance uses RemoteHand's own test suite rather than a disposable plugin repository.

The production broker was factored so the host event/UI wrapper and the pending-request broker share the same registration/resolution path. Test-only coverage now verifies:
- a plugin access request is registered with authenticated plugin identity, bounded reason text, and create/unlock intent;
- resolving the host prompt as successful resumes the waiting plugin request with success and removes the pending request;
- resolving the host prompt as cancelled resumes the waiting plugin request with the expected cancellation error and removes the pending request.

This intentionally avoids adding a throwaway plugin or starting Marielle Chat implementation early. The UI event wiring itself remains exercised by the existing host prompt implementation and can receive a final manual smoke test before merge if desired.


## Encrypted Blob Storage

Post-v1.3.0 core adds generic encrypted binary blob storage for plugin-owned attachments and future large private payloads.

Blob storage is physically separate from the monolithic `data/vault/vault.enc` document. Each logical blob key is converted to an opaque keyed filename, so plugin IDs and logical blob keys are not written directly into filesystem names.

Each blob uses:

- a domain-separated per-blob key derived with HMAC-SHA256 from the unlocked Vault master key;
- XChaCha20-Poly1305 per 1 MiB chunk with a fresh 24-byte random nonce;
- authenticated associated data binding Vault ID, caller-scoped Vault reference, chunk index, total size, and format context;
- an authenticated fixed header containing only format version, chunk size, and total payload size.

Writes are sequential and staged in a temporary file. A blob becomes visible only when every declared byte is present and the temporary file is synced and renamed to its final opaque path. Active uploads are aborted when Vault locks. Stale temporary upload files are cleaned on the next blob-storage initialization.

Blob keys are immutable in the initial API; replacement is delete + create/new key. This avoids non-atomic overwrite semantics.

Current implementation bounds:

- 1 MiB plaintext per chunk;
- 4 GiB maximum blob payload;
- Plugin API framing remains 16 MiB, with blob chunks base64-encoded inside bounded requests/responses.

These are core implementation/resource constraints, not product-level Notes attachment defaults.

The initial blob design intentionally does not add passphrase rotation. Because blob path/key derivation is tied to the current Vault master key, any future passphrase-rotation feature must include a coordinated blob rekey/migration design.
