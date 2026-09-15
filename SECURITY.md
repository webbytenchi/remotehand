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

## Current V1 Authentication Model

RemoteHand V1 has two distinct SSH-related paths.

### SSH terminal sessions

Interactive SSH terminals launch the operating system's `ssh` client inside a PTY. Host-key verification, SSH config, private keys, agents, and interactive authentication therefore follow the behavior and policy of the installed client.

The portable RemoteHand vault is not currently injected into SSH terminal authentication. This avoids silently passing saved passwords to an external SSH process without an explicit design for that behavior.

### SFTP

The native SFTP path uses `russh` and `russh-sftp`. Password credentials can be resolved from the portable vault through an opaque credential reference. The native client checks host keys through known-hosts handling and must not silently accept an unknown or changed key without the intended verification path.

Compatibility SFTP helpers also exist in the codebase and must preserve the same rule that secrets are resolved separately from saved profile JSON.

## Portable Credential Vault Threat Model

RemoteHand's portable vault protects persisted credentials when the application directory is copied, lost, backed up, or inspected while the vault is locked.

Vault data is stored separately from connection profiles at:

```text
data/vault/credentials.enc
```

The vault uses the established `age` file format with passphrase-based encryption rather than custom cryptographic primitives.

Connection profiles may contain only an opaque `credentialRef`; they must not contain the corresponding secret.

The master passphrase and decrypted secrets exist in process memory only while the vault is unlocked. Locking the vault drops RemoteHand's in-memory unlocked vault state.

The vault does **not** protect secrets from a process, debugger, malware, or user that can inspect RemoteHand's memory while the vault is unlocked. It also cannot protect a passphrase captured by a compromised operating system or input environment.

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

## Reporting Vulnerabilities

Until a dedicated private security-reporting channel is configured, avoid publishing exploitable details in a public issue. For private deployments of this repository, contact the repository owner directly.
