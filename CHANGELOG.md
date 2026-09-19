# Changelog

All notable changes to RemoteHand are documented here.

## `1.2.0` - unreleased

### Added

- **System tray integration.** Show RemoteHand in the desktop system tray, show or hide the main window, open Home, and exit from the tray menu.
- **Startup preference.** Optionally start RemoteHand automatically at user login on supported desktop platforms.
- **Start minimized.** Autostart launches can open hidden until the user chooses Show RemoteHand from the tray.
- **Minimize to tray on close.** The main-window close action can hide RemoteHand instead of exiting when the system tray is enabled.
- **Startup & system tray settings** in the existing Settings dialog, split into Appearance and Startup & Tray tabs.
- **Tray quick actions.** Context-aware Show/Hide RemoteHand, Home, Connections, New Terminal, Settings, and Exit.
- **Hidden Papa Easter egg.** Press `↑ ↑ ↓ ↓ ← → ← → B A` while Startup & Tray is active to reveal the Papa tab.

### Verification

- Windows startup, start-minimized, tray, minimize-to-tray, and tray-exit behavior were manually validated on the release build.

### Notes

- The application remains portable. Startup registration is maintained by the operating system and does not move RemoteHand's normal data out of the portable directory.
- Host Monitor and other plugins are unchanged by this feature.

The format is based on `Keep a Changelog` (https://keepachangelog.com/), and this project adheres to `Semantic Versioning` (https://semver.org/).

## `1.1.0` - 2026-09-19

### Added

- **Plugin Runtime v1** - out-of-process executable plugins, communicating over a versioned stdio IPC protocol. Core owns infrastructure; plugins own functionality.
- **Generic top-bar contribution API.** Plugins can publish live per-target widgets into the RemoteHand app bar, composed from generic content primitives (`stack`, `text`, `metric`, `sparkline`, `status`, `progress`).
- **Plugin panel hosting.** Plugins contribute dockable panels, hosted in a sandboxed iframe with a plugin-specific Content-Security-Policy and an injected bridge.
- **Sidebar and command contributions** from plugins.
- **Manifest-declared permissions** - network, clipboard, credentials, vault unlock, plugin storage - gated by the host and reported back at handshake.
- **Plugin-scoped storage** under `data/plugins/plugin-id/`.
- **Plugin Manager UI** for installing, enabling, disabling, and removing plugins.
- Full plugin developer guide at `docs/PLUGINS.md`.

### Fixed

- **Multi-line paste normalization.** Pasted text now normalizes line endings to CR before reaching the shell, so multi-line pastes execute cleanly in PowerShell, Command Prompt, and SSH sessions.

### Fixed

- **Release-build plugin panels.** Production plugin panels now execute correctly with the sandboxed srcdoc hosting path.
- **Top-bar sparkline headroom.** Generic top-bar sparkline rendering now leaves consistent vertical headroom while preserving per-widget scaling.

### Notes

- Plugin API v1. Plugins built for API v1 remain compatible with future API v1 releases.
- RemoteHand core remains plugin-agnostic. No protocol-specific or plugin-specific logic is embedded in core.
- Requires Rust toolchain 1.85+ to build from source.

### Known limitations

- Permissions are declarations of intent, not OS-level sandboxing. Plugins are native executables with the host process permissions.
- The recognized plugin event list is fixed. Plugins can only trigger UI behavior for events core already handles.
- SSH terminal sessions use the system `ssh` client and do not consume RemoteHand portable credential vault.
- Linux builds are not field-tested in this release.

