# Changelog

All notable changes to RemoteHand are documented here.

## `1.2.3` - 2026-09-22

### Fixed

- **Restored terminal session isolation.** Each mounted terminal panel now owns a unique backend PTY session and closes that exact session during cleanup. Restored Dockview panels no longer reuse stale backend sessions across React mount lifecycles, preventing the first typed or pasted character from being swallowed after restart.
- **Terminal paste semantics.** Toolbar, right-click, and confirmed multi-line paste now use xterm's native paste path instead of rewriting newlines and bulk-writing clipboard text directly to the PTY.
- **Ordered terminal input forwarding.** xterm-generated terminal replies and user input are serialized before they reach the native PTY so control replies cannot be overtaken by typing or paste data.

### Verification

- Windows x86_64 manual testing covered restoring a PowerShell panel across application restart, typing directly into the restored terminal, and pasting multi-line PowerShell without the previous single beep or missing first character.
- SSH paste testing covered multi-line commands, shell continuations, loops, and here-documents, with behavior compared against Windows Terminal/OpenSSH and MobaXterm.
- Restored SSH terminal rendering and resize behavior from v1.2.2 remained intact during regression testing.

### Notes

- RemoteHand continues to use the existing `portable-pty` backend. The fix isolates runtime PTY ownership without changing the terminal backend architecture.

## `1.2.2` - 2026-09-22

### Fixed

- **Restored terminal geometry.** Restored terminal and SSH panels now wait for the workspace layout to settle, refit xterm, and explicitly synchronize the final rows and columns with the native PTY. This prevents corrupted redraws in full-screen terminal applications such as `top` after restarting RemoteHand with an SSH panel left open.

### Verification

- Windows x86_64 manual regression testing covered restarting RemoteHand with a saved SSH panel, reconnecting the restored session, running `top` through repeated refreshes, and resizing/splitting the restored terminal without the previous missing headers or duplicated rows.

### Notes

- The terminal backend remains the existing `portable-pty` architecture. The direct Windows ConPTY prototype was diagnostic only and is not part of this release.

## `1.2.1` - 2026-09-21

### Added

- **SFTP parent navigation polish.** The parent-directory action now uses a left-arrow affordance and clearer tooltip.
- **SFTP download destination.** Completed downloads show their destination path, which can be clicked to reveal the downloaded item using the native platform file manager.
- **Single-instance behavior.** Starting RemoteHand again restores and focuses the existing application instance instead of opening a second instance.
- **Main-window restoration.** RemoteHand persists normal window size and position and restores maximized state across launches.

### Improved

- **Plugin top-bar lifecycle.** Plugin context updates no longer cause unnecessary panel lifecycle churn, keeping live top-bar contributions stable while panels are opened, closed, or popped out.
- **Popout lifecycle.** Empty native popout windows are hidden before their final tab is removed, and disabling a plugin closes its active plugin panels/popouts.
- **Plugin popout rendering.** Plugin panels wait for repaired cross-document styles to complete a rendering cycle before the moved iframe is revealed, reducing unstyled flashes in native popouts.

### Fixed

- **SFTP download summary.** Zero-value counts are omitted from completed download status.
- **Terminal popout continuity.** Terminal styling, input, and cursor rendering remain intact when terminals move between the main workspace and popout windows.

### Verification

- Windows x86_64 release-build regression testing covered normal and maximized window restoration, single-instance behavior, SFTP navigation/download/reveal, plugin disable/re-enable lifecycle, last-tab popout behavior, Host Monitor top-bar updates and popouts, and terminal movement between the main workspace and popout windows.

### Known observations

- A brief unstyled plugin-panel frame was observed intermittently during one manual Host Monitor popout attempt but was not consistently reproducible during final release smoke testing.
- A cosmetic title-bar animation can still be visible when RemoteHand starts maximized.

## `1.2.0` - 2026-09-20

### Added

- **System tray integration.** Show RemoteHand in the desktop system tray, show or hide the main window, open Home, and exit from the tray menu.
- **Startup preference.** Optionally start RemoteHand automatically at user login on supported desktop platforms.
- **Start minimized.** Autostart launches can open hidden until the user chooses Show RemoteHand from the tray.
- **Minimize to tray on close.** The main-window close action can hide RemoteHand instead of exiting when the system tray is enabled.
- **Startup & system tray settings** in the existing Settings dialog, split into Appearance and Startup & Tray tabs.
- **Tray quick actions.** Context-aware Show/Hide RemoteHand, Home, Connections, New Terminal, Settings, and Exit.

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

