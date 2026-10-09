# Security Policy

RemoteHand is a remote-access application. Security-sensitive behavior is a core product requirement rather than a later hardening task.

## Security Rules

- Do not implement custom cryptography.
- Do not silently disable SSH/SFTP host-key verification.
- Do not persist plaintext passwords in ordinary profile/configuration files.
- Do not embed private-key contents in normal connection-profile files.
- Do not log credentials, private keys, vault passphrases, authentication tokens, or sensitive terminal contents by default.
- Do not enable analytics or telemetry without an explicit user-visible decision.
- Treat filenames, hostnames, URLs, terminal escape sequences, clipboard contents, remote paths, and remote protocol data as untrusted input.
- Protocol and cryptography dependencies must be reviewed for advisories and maintenance status.

## Startup and System Tray

RemoteHand remains portable-first. Optional startup registration is an operating-system user-level launch preference, separate from the portable `data/` directory. It should not require administrator/root privileges or silently install a system-wide service.

Startup registration can persist the path to the current executable in the user's OS startup configuration. Users who move or copy the portable RemoteHand directory should be aware that an existing startup registration may need to be refreshed.

System-tray controls do not expand plugin permissions or create a new network or credential capability; they only control the local desktop application's visibility and lifecycle.

## Current V1 Authentication Model

RemoteHand V1 has two distinct SSH-related paths.

### SSH terminal sessions

Interactive SSH terminals launch the operating system's `ssh` client inside a PTY. Host-key verification, SSH config, private keys, agents, and interactive authentication therefore follow the behavior and policy of the installed client.

The portable RemoteHand vault is not currently injected into SSH terminal authentication. This avoids silently passing saved passwords to an external SSH process without an explicit design for that behavior.

### SFTP

The native SFTP path uses `russh` and `russh-sftp`. Password credentials can be resolved from the portable vault through an opaque credential reference. The native client checks host keys through known-hosts handling and must not silently accept an unknown or changed key without the intended verification path.

Compatibility SFTP helpers also exist in the codebase and must preserve the same rule that secrets are resolved separately from saved profile JSON.

## Portable Vault Threat Model

RemoteHand Vault protects persisted credentials, API keys, and private Vault-backed documents when the application directory is copied, lost, backed up, or inspected while the Vault is locked.

The active encrypted Vault is stored at:

```text
data/vault/vault.enc
```

The recovery path may retain an encrypted last-known-good `data/vault/vault.bak`. Temporary write state uses `vault.tmp` and is never treated as authenticated Vault plaintext.

Vault format v1 uses Argon2id for passphrase-based key derivation and XChaCha20-Poly1305 for authenticated encryption. The implementation uses reviewed RustCrypto crates rather than custom cryptographic primitives. The format, KDF/cipher identifiers, Vault identifier, parameters, nonce, and fixed RemoteHand context are treated as public implementation details; secrecy depends on the user's unlock secret and derived key material, not obscurity.

The current fixed v1 KDF profile is Argon2id v0x13 with 64 MiB memory, 3 iterations, and parallelism 1. Vault writes use a fresh 16-byte salt for a new Vault identity and a fresh 24-byte XChaCha20 nonce for each encrypted write as defined by the implementation format.

The user's passphrase is accepted only by host-owned RemoteHand UI. Plugins do not receive or submit the Vault passphrase and do not receive the derived key. Core retains the derived key and decrypted logical Vault state only while unlocked and zeroizes sensitive buffers where practical on replacement, deletion, lock, and drop.

The Vault does **not** protect secrets from a process, debugger, malware, or user that can inspect or execute code inside the trusted RemoteHand process while the Vault is unlocked. It also cannot protect a passphrase captured by a compromised operating system or input environment.

Vault v1 also does not provide monotonic anti-rollback state. An attacker who can replace both `vault.enc` and `vault.bak` with older, previously valid authenticated copies may roll the Vault back to that older state without forging ciphertext.

## Portable Data

Normal V1 state is stored relative to the executable directory under `data/`. Because portable data may be copied or synchronized as a unit, all non-vault JSON files should be treated as non-secret material.

Do not write credentials into:

- `data/config/settings.json`
- `data/connections/connections.json`
- `data/activity/recent.json`
- `data/workspaces/default.json`

Recent Activity may include connection metadata such as host and username, so users should treat the portable directory as potentially sensitive even when secrets remain encrypted.

## Clipboard and Terminal Safety

Terminal paste can execute remote or local commands. V1 includes configurable multi-line paste confirmation/protection. Changes to clipboard behavior should preserve a clear path for preventing accidental execution of multi-line content.

Remote terminal output is untrusted. Escape-sequence handling is delegated to the terminal rendering stack and should be kept current with upstream security fixes.

## Dependency Review

Before adding or upgrading a security-sensitive dependency, review:

- License
- Maintainer activity
- Recent releases
- Known vulnerabilities/security advisories
- Windows/Linux support
- Transitive dependency risk
- Whether a safer maintained alternative exists

For release-readiness checks, audit the resolved Rust dependency graph rather than relying only on direct dependency versions:

```powershell
cargo audit --file .\src-tauri\Cargo.lock
```

If `cargo audit` is not installed, install the RustSec tool first with `cargo install cargo-audit --locked`, then rerun the command. A targeted manual advisory review does not replace a full lockfile audit.

## Reporting Vulnerabilities

The preferred reporting route is GitHub Private Vulnerability Reporting, when it is enabled for this repository. Use the repository's **Security and quality → Advisories → Report a vulnerability** form to disclose security issues privately.

If private vulnerability reporting is not available, do not publish exploitable details in a public issue. Open a non-sensitive issue asking the maintainer for private reporting instructions; do not include exploit steps, secrets, or sensitive system details in that issue.

## Plugin security

Plugin API v1 runs plugins as out-of-process native executables with a conservative trust model.

Trust model:

- Plugins are disabled by default after installation.
- Manifests are strictly validated. Unknown fields, unknown permission strings, and incompatible apiVersion values are rejected.
- Plugin folder installation rejects symlinks, unsafe paths, oversized packages, excessive file counts, and overlapping source and destination trees.
- Plugin removal requires the plugin to be disabled first and does not follow symbolic links.
- Sensitive capabilities are explicit declarations in the manifest, checked by the host before the corresponding host service is invoked.
- The host reports granted permissions back to the plugin at handshake, so a plugin can verify what it was actually granted.

Runtime isolation:

- Each plugin runs as a separate OS process, launched by RemoteHand with the host own OS permissions. There is no additional OS-level sandboxing beyond the host own process permissions.
- Plugin IPC is stdio - no network sockets, no shared memory.
- Frames are length-prefixed JSON, capped at 16 MiB. Larger frames terminate the session.
- The handshake has a hard 5-second timeout.

UI isolation:

- Plugin panels render in a sandboxed iframe with sandbox=allow-scripts allow-same-origin - scripts and same-origin document access are enabled for the hosted srcdoc panel, while forms, popups, and top-level navigation remain unavailable.
- A plugin-specific Content-Security-Policy is injected into each panel, including connect-src none. Plugin UI cannot make direct network requests. The production desktop host preserves the inline-script policy needed by the current srcdoc panel-hosting implementation.
- All panel to host communication flows through an injected bridge that the host validates.

Vault handling:

- New plugins use the scoped `vault.*` host APIs rather than raw Vault access.
- Secret reads/writes require `vault.secrets.read` / `vault.secrets.write`; private-document reads/writes require `vault.documents.read` / `vault.documents.write`.
- Plugin keys are caller-relative. Core derives the full namespace as `plugin:<authenticated-plugin-id>/<key>`, preventing a plugin from naming another plugin or a core namespace.
- `vault.access.request` allows a plugin with `vault.access.request` permission to ask RemoteHand's host UI to create or unlock the Vault. The plugin supplies only a bounded reason and never receives or submits the passphrase.
- A raw plugin `vault.unlock` API is intentionally unsupported.
- `credentials.use` and `credentials.store` remain deprecated Plugin API v1 compatibility aliases. New plugins must not build new integrations on those aliases.
- Audit records for plugin Vault actions contain plugin identity, fixed action category, and outcome only; they must not contain secret values, private document content, passphrases, derived keys, or Vault entry references.

What the permission model does not do:

Declared permissions are not a complete security boundary. A plugin is a native executable with the host process privileges. A plugin that declares no permissions can still open network sockets, read files, and execute code through its own logic. Permissions exist to make intent explicit and to gate host-mediated capabilities - vault access, plugin storage - not to sandbox the plugin.

Only install plugins you trust.
