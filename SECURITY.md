# Security Policy

Security Philosophy
RemoteHand is a remote-access application. Security-sensitive design is therefore a core product requirement rather than a later hardening task.
Rules

Do not implement custom cryptography.

Do not silently disable SSH host-key verification.

Do not persist plaintext passwords by default.

Do not embed private-key contents in normal connection-profile files.

Do not log credentials, private keys, authentication tokens, or sensitive terminal contents by default.

Do not enable analytics or telemetry without a clear user-visible decision.

Do not make remote connections merely by rendering/importing untrusted content.

Treat filenames, hostnames, URLs, escape sequences, clipboard contents, and remote protocol data as untrusted input.

Protocol/library updates must be reviewed for security advisories.

Dependency Review
Before adding a security-sensitive dependency, review:

License

Maintainer activity

Recent releases

Known vulnerabilities/security advisories

Platform support

Transitive dependency risk

Whether safer maintained alternatives exist

Credential Storage
The final credential system is not yet selected.
The design must support a credential reference separate from ordinary connection-profile serialization.
Portable-only distribution must not quietly downgrade secrets to plaintext storage.

Normal configuration files may travel with the RemoteHand directory, but credentials must remain separate. Initial releases should prefer prompting for passwords over persisting them insecurely. A future portable credential vault must use established cryptographic libraries and a documented threat model.
Reporting Vulnerabilities
Until a dedicated security-reporting channel is configured, please avoid publishing exploitable details in a public issue.
For private deployments of this repository, contact the repository owner directly.
This policy will be updated before the first public production release.
## Portable Credential Vault Threat Model
RemoteHand's portable vault is designed to protect persisted credentials when the application directory is copied, lost, backed up, or inspected while RemoteHand is not unlocked.

Vault data is stored separately from connection profiles in data/vault/credentials.enc.

The vault uses the established age file format with passphrase-based encryption rather than custom cryptographic primitives.

Connection profiles may contain only an opaque credentialRef; they must not contain the corresponding secret.

The master passphrase and decrypted secrets exist in process memory only while the vault is unlocked and are never written to logs.

Locking the vault drops RemoteHand's in-memory unlocked vault state.

This design does not protect secrets from a process or user that can inspect RemoteHand's memory while the vault is unlocked.

RemoteHand does not automatically persist SSH passwords in this foundation slice. Credential capture and user-visible persistence controls must be implemented separately.
