# Changelog

All notable changes to RemoteHand are documented here.

## `1.2.7` - 2026-09-23

### Added

- **Cross-window panel drag and drop.** Tabs can now be dragged between the main RemoteHand window and popouts, and directly between separate popout windows.
- **Hovered-window drag targeting.** While dragging a tab, entering another RemoteHand window raises that specific window so it becomes the visible drop target; moving to a different popout or back to main raises that window instead.
- **Dock to main window.** Popout tabs now use an explicit main-window destination rule: Dock to main always returns the panel to RemoteHand, regardless of which popout it originated from or moved through.

### Improved

- **HTML5 drag/drop on Windows.** RemoteHand now uses Dockview's cross-window-capable drag backend and disables Tauri's native drag/drop interception in both the main WebView and dynamically created popout WebViews.
- **Main-group return behavior.** Dock to main prefers the panel's remembered valid main-window Dockview group and falls back to the active/default main group.
- **Popout lifecycle tracking.** Popouts are tracked individually by Dockview popout id and exact native window identity so source windows can be closed precisely when their final panel moves away.

### Fixed

- **Empty source popouts after drag.** Moving the last tab from a popout to main or another popout now closes the emptied native popout instead of leaving an empty window behind.
- **Multi-tab and multi-group popout closure.** Closing one tab or the last tab in one Dockview group no longer closes the whole popout while other panels remain.
- **Racy group-level cleanup.** Removed legacy mutation/group cleanup that could intermittently close a popout and throw surviving panels back into RemoteHand.
- **Cross-window drag reliability.** Main-to-popout, popout-to-main, and popout-to-popout drag operations now use the same browser drag/drop path on Windows.

### Verification

- Frontend tests: 7 passed.
- Production frontend build: passed.
- `cargo check --locked`: passed.
- Rust tests: 31 passed, 0 failed.
- Manual Windows acceptance covered main ↔ popout drag/drop, popout ↔ popout moves, Dock to main after cross-popout moves, exact empty-popout cleanup, multi-tab and multi-group popout behavior, restart persistence, hovered-window foreground targeting, and explicit Pop out / Dock to main controls.


## `1.2.6` - 2026-09-23

### Improved

- **Shell-focused sidebar.** Removed visible Split right, Split below, Pop out active, Undo, Redo, and Reset layout controls from the sidebar while keeping their underlying commands and shortcuts available.
- **Contextual tab controls.** Docked tabs now expose a pop-out action beside Close; popped-out tabs switch that action to dock back, with matching icon styling.
- **Source-aware dock-back.** Popped-out tabs return to their originating Dockview group when available, preserving tab grouping instead of creating arbitrary new splits.
- **Plugins in Settings.** Plugin management now lives under Settings → Plugins. The top-bar puzzle button was removed while the plugin runtime/controller remains continuously mounted.
- **Interface settings cleanup.** Settings → Interface now contains both Reset interface order and Reset workspace layout.

### Fixed

- **Single-tab pop-out restore.** Docking back a single-tab pop-out now restores the tab/group to its original Dockview position and closes the exact native Tauri pop-out window.
- **Multi-tab pop-out lifecycle.** Closing or docking one tab from a restored multi-tab pop-out no longer closes the entire pop-out while other tabs remain.
- **Empty native pop-out windows.** RemoteHand now tracks exact native pop-out window labels so emptied Tauri wrappers are closed reliably.
- **Persistent Cargo.toml normalization noise.** The repository now uses Cargo's normalized `tauri-build` declaration and enforces LF for TOML files, preventing repeated Windows-only dirty-tree churn after Cargo commands.

### Verification

- Frontend tests: 7 passed.
- Production frontend build: passed.
- `cargo check --locked`: passed.
- Rust tests: 31 passed, 0 failed.
- Manual Windows acceptance covered tab pop-out/dock-back positioning, restored multi-tab pop-outs, Plugins-in-Settings enable/disable behavior and contribution restoration, Interface reset controls, and clean Cargo.toml recurrence checks.


## `1.2.5` - 2026-09-23

### Added

- **Host-owned interface contribution ordering.** RemoteHand now controls ordering for built-in and plugin sidebar/top-bar contributions using stable contribution identities.
- **Interface ordering settings.** Settings → Interface lets users reorder sidebar and top-bar items and reset them to defaults.
- **Portable ordering persistence.** Interface order is stored in `data/config/ui-contributions.json` and restored across application restarts.

### Improved

- **Plugin responsibility boundary.** Plugins publish or declare their contributions while RemoteHand owns final presentation order.
- **Dynamic contribution handling.** Temporarily unavailable plugin items retain their remembered positions, while newly discovered items are appended deterministically.
- **Safe ordering fallback.** Missing, partial, or invalid saved ordering falls back to the default/legacy contribution order without blocking the UI.

### Verification

- Frontend tests: 7 passed.
- Production frontend build: passed.
- `cargo check`: passed.
- Rust tests: 31 passed, 0 failed.
- Manual Windows acceptance covered sidebar ordering, Host Monitor top-bar ordering, restart persistence, plugin disable/re-enable position restoration, reset behavior, and corrupt-config fallback.

## `1.2.4` - 2026-09-23

### Added

- **Generic plugin system-tray contributions.** Running plugins with the `tray.contribute` permission can publish per-item tray icons with bounded live series data, semantic tones, optional `#RRGGBB` graph/background/border overrides, visibility control, tooltips, and `open-panel` actions carrying panel context.
- **Stable Windows plugin tray identity.** Plugin tray items use deterministic GUIDs derived from plugin and item ids, preserving their shell identity across updates and application restarts.
- **Generic plugin top-bar menus and icons.** Top-bar items can expose bounded dropdown menus whose rows invoke plugin runtime methods, plus built-in `globe`, `ethernet`, `wifi`, `shield`, and `ipv6` vector icons.
- **Generic top-bar color overrides.** Top-bar content and series points can supply validated text/graph, background, and border colors.
- **Plugin host services for network identity and clipboard writes.** `network.interfaces` exposes local interface names, MAC addresses, and IP addresses behind `network.inspect`; `clipboard.write` writes bounded text behind `clipboard.write`.

### Improved

- **Plugin tray lifecycle.** Normal plugin disable hides contributed tray icons without destroying their stable shell handles, so re-enable and restart behavior remains predictable. Unexpected runtime exit hides stale plugin tray/top-bar UI, while uninstall permanently purges retained tray handles.
- **Plugin panel targeting and focus.** Tray and top-bar `open-panel` actions preserve live target context and focus the owning docked or single-popout Host Monitor panel, including restoration from minimized state.
- **Generic contribution validation.** New tray, top-bar menu, icon, and color fields are parsed defensively with bounded item counts, text sizes, series sizes, and strict color/method formats.

### Fixed

- **Plugin disable freeze.** Removed duplicate tray cleanup during runtime shutdown that could block while disabling a plugin.
- **Tray target routing.** Clicking a per-target tray graph now delivers the clicked target context rather than falling back to a previously selected or default target.
- **GUID tray tooltip updates.** Windows GUID-backed tray icons now update tooltip text correctly.

### Verification

- Host Monitor integration was manually exercised on Windows with multiple per-target tray icons, disable/re-enable, target disable/re-enable, stable tray ordering/identity, docked and popped-out panel focus, exact target routing, and top-bar interaction.
- RemoteHand frontend builds and Rust checks/tests were run repeatedly throughout the feature branch. A final pre-tag validation pass is required before the `v1.2.4` fallback tag is created.

### Notes

- Plugin API remains version 1; these are backward-compatible additions to the existing generic plugin host surface.
- The `tray-icon` crate remains vendored temporarily to backport upstream Windows GUID support.

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

