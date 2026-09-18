# Changelog

All notable changes to RemoteHand are documented here.

The format is based on `Keep a Changelog` (https://keepachangelog.com/), and this project adheres to `Semantic Versioning` (https://semver.org/).

## `1.1.0` - 2026-09-19

### Added

- **Plugin Runtime v1** - out-of-process executable plugins, communicating over a versioned stdio IPC protocol. Core owns infrastructure; plugins own functionality.
- **Generic top-bar contribution API.** Plugins can publish live per-target widgets into the RemoteHand app bar, composed from generic content primitives (`stack`, `text`, `metric`, `sparkline`, `status`, `progress`).
- **Plugin panel hosting.** Plugins contribute dockable panels, hosted in a sandboxed iframe with a strict Content-Security-Policy and an injected bridge.
- **Sidebar and command contributions** from plugins.
- **Manifest-declared permissions** - network, clipboard, credentials, vault unlock, plugin storage - gated by the host and reported back at handshake.
- **Plugin-scoped storage** under `data/plugins/plugin-id/`.
- **Plugin Manager UI** for installing, enabling, disabling, and removing plugins.
- Full plugin developer guide at `docs/PLUGINS.md`.

### Fixed

- **Multi-line paste normalization.** Pasted text now normalizes line endings to CR before reaching the shell, so multi-line pastes execute cleanly in PowerShell, Command Prompt, and SSH sessions.

### Notes

- Plugin API v1. Plugins built for API v1 remain compatible with future API v1 releases.
- RemoteHand core remains plugin-agnostic. No protocol-specific or plugin-specific logic is embedded in core.
- Requires Rust toolchain 1.85+ to build from source.

### Known limitations

- Permissions are declarations of intent, not OS-level sandboxing. Plugins are native executables with the host process permissions.
- The recognized plugin event list is fixed. Plugins can only trigger UI behavior for events core already handles.
- SSH terminal sessions use the system `ssh` client and do not consume RemoteHand portable credential vault.
- Linux builds are not field-tested in this release.

