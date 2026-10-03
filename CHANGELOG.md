# Changelog

All notable changes to RemoteHand are documented here.

## Unreleased

## `1.3.5` - 2026-10-04

### Improved

- **Multiline terminal paste.** RemoteHand now honors xterm's bracketed-paste mode when the active shell supports it, submitting confirmed multiline input as one protected block instead of pacing individual lines through the PTY.

### Fixed

- **Terminal paste visual echo.** Fixed multiline paste output becoming visually interleaved or corrupted when later pasted commands were echoed while an earlier command was still producing output, including SSH sessions launched from a PowerShell panel.
- **SSH command rendering.** Confirmed multiline command blocks no longer leave chopped command fragments or glue future command text onto Git/remote command output when bracketed paste is available.

### Compatibility

- Plugin API remains **v1**.
- Existing terminal, SSH, PowerShell, Command Prompt, and workspace data require no migration.
- RemoteHand continues to use xterm.js for terminal rendering and `portable-pty` for PTY handling.

### Verification

- Production Windows Tauri build passed on the accepted terminal-fix branch.
- Manual Windows acceptance confirmed clean multiline paste rendering in:
  - RemoteHand native SSH terminal.
  - PowerShell → interactive `ssh` session (the original failure path).
  - Local PowerShell.
  - Local Command Prompt.
- The original five-command SSH reproduction completed without chopped command fragments, pasted command text glued onto command output, or later command echo leaking into earlier output.


## `1.3.4` - 2026-10-03

### Improved

- **Concurrent Vault startup access.** Multiple Vault-dependent plugin panels can request access during startup and share one host-owned unlock flow instead of leaving later panels blank until reopened.
- **Vault prompt focus ownership.** While RemoteHand is asking for the Vault passphrase, startup panel and popout activity no longer steals keyboard focus from the host-owned passphrase field.
- **Workspace restoration.** Main-workspace split proportions are restored against the final native window geometry, and popout workspaces retain their internal panel proportions across restarts.
- **Popout persistence.** Popout windows now restore their native desktop position and size reliably, including multiple simultaneous popouts and scaled Windows displays.
- **Popout reintegration.** Closing or docking a popout returns its panels to the main workspace without disturbing the existing main-workspace proportions.

### Fixed

- **Vault startup race.** Fixed concurrent Vault access requests where one startup plugin could succeed while another remained blank.
- **Popout geometry drift.** Fixed restored popouts gradually moving down/right or shrinking on each restart by persisting native window geometry instead of round-tripping browser-reported coordinates.
- **Popout focus during Vault unlock.** Restored popouts can be revealed without taking native focus while the Vault prompt is active.
- **Layout undo with popouts.** Ctrl+Z / Ctrl+Y workspace history no longer leaves empty native popout shells behind when a saved layout recreates a popout.
- **Workspace split reset.** Returning panels from a popout no longer resets the sizes of existing main-workspace panels.

### Compatibility

- Plugin API remains **v1**.
- Existing plugins require no migration.
- Vault cryptography, plugin Vault permissions, and stored Vault formats are unchanged.
- Existing workspace files remain compatible; RemoteHand simply records and restores popout geometry more precisely.

### Verification

- Frontend tests passed with **23 tests and 0 failures** on the accepted feature branch.
- Production frontend and optimized Windows Tauri builds passed during acceptance.
- Manual Windows acceptance confirmed concurrent Vault startup, Vault prompt focus retention, main and popout split restoration, multi-popout position persistence, clean popout reintegration, and popout-safe layout undo/redo.

## `1.3.3` - 2026-10-02

### Improved

- **Larger plugin clipboard writes.** The generic `clipboard.write` host service now accepts up to **4 MiB** of text per request instead of 64 KiB, allowing plugins to copy larger diagnostics, traces, and exported text while keeping a bounded host-side limit.

### Compatibility

- Plugin API remains **v1**.
- The `clipboard.write` request and response shapes are unchanged; only the maximum accepted text size increased.
- Existing plugins require no migration.

### Verification

- Manual Windows acceptance confirmed a Marielle Module Trace larger than the previous 64 KiB ceiling can be copied through the plugin host and pasted intact.


## `1.3.2` - 2026-10-01

### Added

- **Multi-file plugin picker.** `file.open` now accepts optional `multiple: true`; single-file callers keep the existing `path` response while multi-file callers receive `paths`.
- **External-link host service.** Plugin API v1 adds the `links.open` permission and `link.open` host method for opening validated HTTPS URLs in the user's default browser.

### Security

- `link.open` accepts HTTPS URLs only, rejects other schemes such as `file:`, and bounds URLs to 2048 characters.
- External links remain host-mediated and require the plugin to declare and receive `links.open`.

### Compatibility

- Plugin API remains **v1**.
- Existing `file.open` callers that omit `multiple` retain the original single-file behavior and response shape.
- Plugins that do not request `links.open` are unaffected.

## `1.3.1` - 2026-10-01

### Added

- **Encrypted Vault blob storage.** Plugins can store large private binary payloads through generic, caller-scoped Vault blob APIs.
- **Plugin blob permissions.** Plugin API v1 adds `vault.blobs.read` and `vault.blobs.write`.
- **Chunked blob operations.** Added `vault.blob.begin`, `vault.blob.write`, `vault.blob.commit`, `vault.blob.abort`, `vault.blob.info`, `vault.blob.read`, and `vault.blob.delete`.
- **Vault status events.** Plugin panels receive Vault lock-state changes so decrypted UI can redact immediately when the Vault locks.
- **Serialized plugin runtime request lifetimes.** RemoteHand now keeps each plugin runtime request/response exchange ordered through nested host API calls, preventing concurrent panel requests from desynchronizing Plugin API v1 framing.

### Security

- Blob filenames are opaque keyed identifiers rather than logical plugin keys.
- Blob encryption uses domain-separated per-blob keys with XChaCha20-Poly1305 authenticated 1 MiB chunks.
- Blob authenticated data binds Vault ID, caller-scoped Vault reference, chunk index, total size, and format context.
- Incomplete uploads remain temporary and are aborted on Vault lock.
- Plugin blob access remains permission-gated and scoped to the authenticated plugin identity.

### Compatibility

- Plugin API remains **v1**.
- Existing API-v1 plugins remain compatible.
- The structured Vault document/secret API remains unchanged.
- The blob API is an additive generic host capability; plugins that do not request blob permissions are unaffected.


## `1.3.0` - 2026-10-01

### Added

- **RemoteHand Vault.** Core now provides encrypted, portable storage for credentials, API keys, and private plugin documents.
- **Host-owned Vault unlock.** Vault creation and unlock stay inside RemoteHand UI; plugins can request access without receiving the Vault passphrase or master/session key.
- **Scoped plugin Vault API.** Plugin API v1 gains namespace-scoped secret/document read and write permissions plus a host-owned Vault access request capability.
- **Vault Settings controls.** Settings shows Vault status, manual Lock/Unlock controls, and configurable inactivity auto-lock.
- **Recovery safeguards.** Encrypted last-known-good backup recovery and interrupted-write cleanup protect against incomplete Vault replacement.

### Security

- Vault uses Argon2id for passphrase-based key derivation and XChaCha20-Poly1305 authenticated encryption.
- Plugin Vault access is permission-gated and caller-namespace scoped.
- Vault file parsing, secret values, private documents, identifiers, and plugin access reasons are bounded.
- Security-relevant Vault logging avoids secret values, private document content, passphrases, master/session keys, and Vault entry references.
- Saved SFTP connection JSON retains only an opaque credential reference; passwords remain Vault-backed.
- The Rust dependency lockfile was reviewed with RustSec `cargo audit`; no vulnerability failures were reported, with tracked upstream maintenance/unsoundness warnings documented in the Vault security notes.

### Compatibility

- Plugin API remains **v1**.
- `credentials.use` and `credentials.store` remain accepted as deprecated v1 compatibility aliases.
- Raw plugin `vault.unlock` is not supported; plugins use the host-owned `vault.request_access` flow instead.
- Existing pre-v1.3 SFTP Vault data is intentionally not migrated.

### Verification

- Rust tests passed with **68 tests and 0 failures** on the completed Vault feature branch.
- Production frontend build passed.
- Vault recovery, tamper rejection, wrong-passphrase handling, size limits, namespace rules, auto-lock behavior, saved-connection serialization, and plugin access broker success/cancel paths are covered by automated tests.

## `1.2.26` - 2026-09-30

### Fixed

- **Top-bar popup stacking.** Plugin top-bar popup menus now render above Dockview workspace splitters, preventing resize-divider lines from cutting through menus such as Network Identity.

### Compatibility

- Plugin API remains **v1**.
- Existing top-bar contributions require no migration.
- Workspace resizing behavior is unchanged.

### Verification

- Frontend tests passed with **17 tests and 0 failures**.
- Production frontend build passed.
- Manual Windows acceptance confirmed the Network Identity top-bar popup renders cleanly above workspace dividers with normal menu interaction preserved.

## `1.2.25` - 2026-09-30

### Improved

- **WebView shortcut ownership.** RemoteHand now suppresses browser-only keyboard behaviors such as Find, Reload/Hard Reload, Save Page, Open, Print, View Source, address-bar focus, zoom, browser history navigation, tab/window commands, and common developer-tools accelerators in the main window, popouts, and plugin panels.
- **Plugin shortcut compatibility.** Suppressing the WebView default does not stop keyboard-event propagation, so plugins can continue to implement intentional shortcuts such as Editor Ctrl+F, Ctrl+S, and plain F5 without exposing Chromium/WebView2 behavior.

### Compatibility

- Plugin API remains **v1**.
- Normal editing shortcuts such as Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A, Ctrl+Z, and Ctrl+Y remain available.
- Existing function-key ownership behavior remains unchanged.

### Verification

- Frontend tests passed with **17 tests and 0 failures**.
- Production frontend build passed.
- Rust tests passed with **43 tests and 0 failures**.
- Optimized Windows Tauri release build passed.
- Manual Windows acceptance confirmed browser shortcut suppression in a normal plugin panel and preserved Editor-owned Ctrl+F, Ctrl+S, and F5 behavior.

## `1.2.24` - 2026-09-30

### Fixed

- **Large multi-line terminal paste rendering.** RemoteHand now forwards large multi-line paste input to the PTY in paced line-sized chunks and suppresses bracketed-paste buffering for that path, preventing SSH shells from visually overwriting or collapsing echoed here-document lines while preserving the exact remote file content.

### Compatibility

- Plugin API remains **v1**.
- Existing terminal workflows and single-line input remain unchanged.
- Multi-line paste confirmation remains in place.

### Verification

- Manual Windows acceptance confirmed a previously problematic large SSH here-document now renders cleanly in the RemoteHand terminal.
- The resulting remote `compose.yml` matched the source content after the paste completed.


## `1.2.23` - 2026-09-30

### Added

- **F1 About shortcut.** Pressing F1 anywhere in RemoteHand opens Settings directly on the About tab, including when a plugin panel currently has keyboard focus.

### Improved

- **Function-key ownership.** RemoteHand now consumes unassigned F1-F12 keys so browser/WebView actions do not leak through into the desktop app.
- **Plugin-safe F5.** Plain F5 remains available to intentional plugin handlers such as Editor timestamp insertion while RemoteHand still suppresses browser refresh behavior.
- **Settings focus handoff.** When F1 opens Settings from a plugin, focus moves to the host modal; after ESC closes Settings, focus returns to the exact previously focused plugin control so typing can resume immediately at the existing caret.

### Fixed

- **Alt+F4 close behavior.** The function-key guard now preserves native Alt+F4 handling so RemoteHand follows its normal close/minimize-to-tray behavior instead of swallowing the shortcut.

### Compatibility

- Plugin API remains **v1**.
- Existing plugins require no migration.
- Unassigned function keys are host-owned; plain F5 remains the intentional plugin exception.

### Verification

- Frontend unit tests passed with **12 tests and 0 failures**.
- Production frontend build passed.
- Optimized Windows Tauri release build passed.
- Manual Windows acceptance confirmed F1 opens Settings → About from core and plugin focus, ESC returns focus to the previous Editor caret, plain F5 still triggers Editor timestamp insertion, Alt+F4 closes normally, and all other function keys remain inert.


## `1.2.22` - 2026-09-29

### Added

- **Generic top-bar alert icon.** Plugin top-bar contributions can now use a host-rendered alert icon that sits in the upper-left corner without shifting the contribution's normal content.

### Improved

- **Corner-indicator layout.** Top-bar alert icons and numbered badges now align as opposite corner indicators, and title text reserves their space instead of colliding with them.
- **Long-title ellipsis.** Generic top-bar text now constrains long titles so they render with an ellipsis when they exceed the available width.

### Fixed

- **Rust lockfile synchronization.** The committed lockfile now records the existing direct WebView2 and Windows dependencies declared by RemoteHand.

### Compatibility

- Plugin API remains **v1**.
- Existing plugin top-bar contributions require no migration; the new alert icon is opt-in through the existing generic top-bar payload.

### Verification

- Frontend production build passed.
- Rust test suite passed with **43 tests and 0 failures**.
- Optimized Windows Tauri release build passed.
- Manual Windows acceptance confirmed alert-icon/badge alignment, title collision avoidance, and long-title ellipsis with Target Monitor v0.7.8.


## `1.2.21` - 2026-09-29

### Added

- **Native Explorer file drop for plugins.** Plugins with `files.open` can receive host-resolved native file paths from Windows Explorer drops while keeping normal HTML5 drag/drop behavior inside plugin panels.
- **Frame-aware WebView2 drop bridge.** RemoteHand handles plugin `srcdoc` iframe messages at the WebView2 frame level and resolves `ICoreWebView2File.Path` values without exposing browser pseudo-paths.

### Fixed

- **Multi-file drop freeze.** Suppresses Chromium/WebView2 default native-file drop handling after the host bridge accepts the drop, preventing the application from becoming unresponsive while preserving plugin drop handlers.
- **Popout file-dialog focus.** Plugin Open and Save As dialogs now parent to the currently focused RemoteHand window, with main as fallback, so popped-out plugin panels remain correctly in front after native dialogs close.
- **Workspace drag behavior.** Workspace-tab drags can surface hidden plugin popouts when appropriate, while Explorer/file drags do not incorrectly bring plugin popouts forward.

### Compatibility

- Plugin API remains **v1**.
- Native file-drop delivery is permission-gated by `files.open`.
- Tauri native drag/drop remains disabled so WebView HTML5 drag/drop semantics are preserved.
- Existing plugins that do not use native file-drop require no migration.

### Verification

- Manual Windows acceptance passed for main-window and popped-out Editor native drops, multi-file drops, caret-path insertion, popout Open/Save As focus, and workspace-tab versus Explorer-drag popout behavior.

## `1.2.20` - 2026-09-28

### Added

- **Generic plugin-to-plugin panel opening.** Plugins with the new `plugins.open` permission can check whether another plugin is installed and enabled, then request one of that plugin's declared panels through the host.
- **Structured panel context.** Plugin-open requests can carry a bounded object context so the target panel can receive a specific resource, such as a local file path, without hard-coding plugin-specific behavior into RemoteHand core.

### Safety and compatibility

- Plugin API remains **v1**.
- `plugins.open` is opt-in and is required for both availability checks and panel-open requests.
- Target plugins must be installed, enabled, and declare the requested panel.
- Open-panel context must be an object and is limited to **64 KiB**.
- Existing plugins require no migration.

### Verification

- Added targeted Rust coverage for the `plugins.open` manifest permission, host API permission checks, availability parameters, and panel-context validation.
- Manual Windows acceptance confirmed File Manager can open supported files in Editor through the generic host path and react immediately when Editor is enabled or disabled.

## `1.2.19` - 2026-09-28

### Improved

- **Native desktop interaction polish.** RemoteHand suppresses the browser/WebView context menu on normal application chrome while preserving native context menus for editable controls.
- **Accidental text-selection prevention.** Normal RemoteHand chrome is non-selectable by default, while terminals, editable controls, and explicitly selectable surfaces retain text selection.
- **Plugin panel consistency.** Sandboxed plugin panels receive the same host-owned context-menu suppression and non-selectable-by-default behavior, with opt-in hooks for plugin surfaces that intentionally need native context menus or selectable text.

### Compatibility

- Plugin API remains **v1**.
- Plugins can opt a surface back into text selection with `data-remotehand-selectable="true"`.
- Plugins can opt a surface into the native WebView context menu with `data-remotehand-native-context-menu="true"`.

### Verification

- Manual Windows acceptance confirmed browser/WebView context menus are suppressed across normal RemoteHand chrome and plugin panels.
- Manual Windows acceptance confirmed normal application chrome no longer exposes accidental text selection.
- Terminal, Editor, input, and other intentionally interactive surfaces were spot-checked to preserve expected selection/editing behavior.



## `1.2.18` - 2026-09-28

### Improved

- **Modern scrollbar styling.** RemoteHand core scrollbars now use a slimmer rounded thumb with a transparent track for a cleaner, more consistent desktop appearance.
- **Plugin scrollbar consistency.** Sandboxed plugin panels receive the same host-owned scrollbar styling automatically, so existing plugins can follow RemoteHand's visual treatment without plugin-specific changes.
- **Terminal scrollbar polish.** Local Terminal, PowerShell, and Command Prompt xterm surfaces now use the same rounded scrollbar treatment while preserving xterm's existing scroll behavior.
- **Plugin Manager scrolling.** Settings → Plugins now uses the Settings modal as the single scroll owner instead of nesting a second independently scrolling plugin list.

### Compatibility

- Plugin API remains **v1**.
- Existing plugins require no migration.
- Scrollbar presentation remains host-owned; plugin functionality and runtime behavior are unchanged.

### Verification

- Frontend lint completed with **18 warnings and 0 errors**.
- Frontend tests passed with **7 tests and 0 failures**.
- Production frontend build passed.
- `cargo check` passed.
- Manual Windows acceptance confirmed the modern scrollbar treatment across Settings, plugin panels, Local Terminal, PowerShell, and Command Prompt, including removal of the nested Plugins scrollbar.


## `1.2.17` - 2026-09-27

### Added

- **Generic plugin file-open host API.** Plugins with the `files.open` permission can request a host-owned native file picker and receive the selected local path without implementing their own top-level dialog process.
- **Plugin terminal appearance propagation.** Plugin panels now receive RemoteHand's configured terminal font family, font size, foreground, and background in addition to the existing UI appearance values.

### Improved

- **Host-owned file dialog behavior.** Plugin Save dialogs are parented to the main RemoteHand window, keeping native Open/Save flows associated with RemoteHand instead of behaving as unrelated top-level windows.
- **Reusable editor-style appearance.** Plugins that render code, logs, consoles, or other monospace surfaces can inherit the same terminal appearance chosen by the user without editor-specific logic in core.

### Compatibility

- Plugin API remains **v1**.
- Existing plugins require no migration.
- `files.open` is opt-in through the plugin permission list.
- Existing `files.save` behavior remains compatible.

### Verification

- Rust tests passed with **41 tests and 0 failures** on the feature branch.
- Production Windows builds passed during development.
- Manual Windows acceptance confirmed host-owned Open and Save As dialogs remain in front of RemoteHand.
- Manual acceptance confirmed plugin code surfaces can follow RemoteHand terminal font, size, foreground, and background settings.

## `1.2.16` - 2026-09-26

### Added

- **Plugin-owned sidebar icon assets.** Sidebar contributions may now reference a relative SVG, PNG, or WebP asset from the plugin package instead of requiring RemoteHand core to know a plugin-specific icon.
- **Safe sidebar icon loading.** RemoteHand validates the declared asset path, package containment, supported format, regular-file/symlink constraints, and a 256 KiB size limit before exposing the icon to the frontend.
- **Theme-aware SVG icons.** Plugin SVG sidebar assets are rendered as host-colored masks so the icon follows RemoteHand's current theme while the plugin continues to own the icon shape.

### Improved

- **Host-owned icon sizing.** Sidebar icon layout is constrained by RemoteHand so oversized plugin assets cannot spill outside the normal sidebar slot.
- **Plugin independence.** New plugins can ship their own sidebar icon without requiring a RemoteHand source update for each icon shape.

### Compatibility

- Plugin API remains **v1**.
- Existing built-in/legacy sidebar icon identifiers continue to work.
- Existing plugins that do not provide an asset icon continue to use the normal fallback behavior.
- PNG/WebP assets retain their own raster colors; SVG assets use the host's current sidebar color.

### Verification

- Production frontend build passed.
- Rust tests passed with **40 tests and 0 failures**.
- Windows Tauri build passed.
- Manual Windows acceptance confirmed a plugin-owned System Monitor SVG rendered at the correct size and followed the RemoteHand theme.

## `1.2.15` - 2026-09-26

### Improved

- **Global shortcut toggle.** Pressing the configured global shortcut while RemoteHand is already focused now tucks the main window away; pressing it again restores and focuses the existing window.
- **Tray-aware shortcut behavior.** When the system tray icon is enabled, the focused main window hides to the tray. When the tray icon is disabled, the shortcut minimizes RemoteHand to the taskbar instead of hiding it completely.
- **Foreground-safe behavior.** If RemoteHand is visible but another application has focus, the shortcut brings RemoteHand forward rather than hiding it.
- **Focus resume preserved.** Restoring RemoteHand through the shortcut continues to return keyboard focus to the last focused in-app control when that control is still available.
- **Settings wording.** Startup & Tray now describes the global shortcut as a show/focus/tuck-away control and explains its tray-versus-taskbar behavior.

### Compatibility

- The default shortcut remains **Ctrl + Shift + Space**.
- Existing saved shortcut settings remain compatible and require no migration.
- Plugin API remains **v1**.

### Verification

- Frontend lint completed with **17 warnings and 0 errors**.
- Frontend tests passed with **7 tests and 0 failures**.
- Production frontend build passed.
- `cargo check` passed.
- Rust tests passed with **38 tests and 0 failures**.
- Manual Windows acceptance confirmed toggle behavior with the tray icon enabled and disabled, foreground-safe summon behavior, and immediate terminal typing after restore.

## `1.2.14` - 2026-09-25

### Added

- **Global show shortcut.** RemoteHand can register a system-wide shortcut that shows, restores, and focuses the existing main window even when another application has focus.
- **Default shortcut.** New and existing settings default to **Ctrl + Shift + Space**.
- **Shortcut capture UX.** Settings → Startup & Tray lets users click the shortcut field and press the desired key combination instead of typing shortcut syntax manually.
- **Enable/disable control.** The global shortcut can be disabled without removing the saved binding.

### Improved

- **Safe live re-registration.** Applying a new shortcut registers the replacement before releasing the current working shortcut so a rejected/conflicting binding does not silently destroy the previous registration.
- **Unapplied draft behavior.** Captured shortcut changes are discarded when Settings closes unless the user explicitly clicks Apply.
- **Startup persistence.** The saved shortcut and enabled state are loaded from `data/config/settings.json` and registered when RemoteHand starts.
- **Single-instance integration.** Triggering the shortcut restores/focuses the existing main window and never launches another RemoteHand instance.
- **Focus resume after summon.** When the global shortcut restores RemoteHand, the last focused in-app control is focused again when it is still available, so terminal users can continue typing without an extra click.

### Compatibility

- Existing settings remain compatible; missing global-shortcut fields default to enabled with **Ctrl + Shift + Space**.
- Plugin API remains **v1**. The shortcut is RemoteHand core infrastructure and requires no plugin changes.

### Verification

- Frontend lint completed with **17 warnings and 0 errors**.
- Frontend tests passed with **7 tests and 0 failures**.
- Production frontend build passed.
- `cargo check` passed.
- Rust tests passed with **38 tests and 0 failures**.
- Manual Windows acceptance confirmed default shortcut restore/focus, enable/disable behavior, captured custom shortcut replacement, unapplied-draft discard, and persistence across a full application restart.

## `1.2.13` - 2026-09-25

### Fixed

- **Plugin top-bar overlays after responsive paging.** Restored RemoteHand-rendered hover tooltips and interactive plugin top-bar menus after the v1.2.12 responsive contribution strip began clipping overlays that were positioned inside it.
- **Network Identity top-bar menu.** Clicking the Network Identity contribution once again opens its interactive menu while preserving the v1.2.12 bounded top-bar paging and alignment behavior.

### Implementation

- Top-bar tooltip and menu overlays now render through a document-level portal with fixed positioning anchored to the contributing button, so they are not clipped by the horizontally scrollable top-bar viewport.

### Compatibility

- Plugin API remains **v1**. Existing plugin top-bar contributions require no changes.
- The v1.2.12 fixed shell, workspace-only scrolling, anchored Settings control, paging, and Left/Center/Right alignment behavior remain intact.

### Verification

- Frontend lint completed with **17 warnings and 0 errors**.
- Frontend tests passed with **7 tests and 0 failures**.
- Production frontend build passed.
- `cargo check` passed.
- Rust tests passed with **38 tests and 0 failures**.
- Manual Windows acceptance confirmed plugin top-bar hover tooltips are visible again and the Network Identity top-bar menu opens and remains interactive.

## `1.2.12` - 2026-09-25

### Added

- **Responsive top-bar paging.** Plugin top-bar contributions now stay inside a bounded host-owned strip and expose previous/next controls only when the available width is too small to show every contribution.
- **Configurable top-bar alignment.** Settings → Interface now lets users align plugin top-bar contributions Left, Center, or Right, with Center as the default. The preference is persisted in RemoteHand settings.

### Improved

- **Anchored core controls.** RemoteHand's Settings button remains fixed on the far right instead of being displaced by plugin contributions.
- **Small-window shell behavior.** The application shell now contains overflow inside the workspace area so the top bar and sidebar remain fixed while panel content owns scrolling.
- **Dockview containment.** Removed the old fixed minimum workspace height that could force outer-window scrollbars on smaller RemoteHand windows.
- **Top-bar responsiveness.** When contributions overflow, the strip switches to predictable paged navigation while preserving contribution order and the fixed Settings control.

### Compatibility

- Plugin API remains **v1** and existing plugin top-bar contributions require no changes.
- Existing saved settings remain compatible; missing `topbarAlignment` defaults to `center`.
- RemoteHand core continues to own generic contribution layout and shell behavior while plugins continue to own their content and semantics.

### Verification

- Frontend lint completed with **17 warnings and 0 errors**.
- Frontend tests passed with **7 tests and 0 failures**.
- Production frontend build passed.
- `cargo check` passed.
- Rust tests passed with **38 tests and 0 failures**.
- Manual Windows acceptance confirmed fixed topbar/sidebar shell behavior, workspace-only scrolling, anchored Settings, responsive contribution paging, and live Left/Center/Right alignment changes.
- Manual acceptance confirmed Center as the default alignment and persistence through RemoteHand settings.

## `1.2.11` - 2026-09-25

### Added

- **Native plugin ZIP installation.** Settings → Plugins can install a plugin directly from a `.zip` package while preserving the existing folder-install workflow for development.
- **Safe ZIP staging and validation.** ZIP packages are checked for unsafe paths, duplicate entries, symbolic links, excessive entry/file counts, and the existing 64 MiB uncompressed plugin-size limit before installation. The archive must place `plugin.json` at its root.
- **Compact plugin tray labels.** Generic plugin tray items can publish an optional four-character `label` with `textColor`, allowing numeric/status tiles such as CPU or memory percentages without plugin-specific rendering in core.

### Improved

- **Plugin package workflow.** ZIP installation reuses the existing manifest validation and atomic plugin-directory installation path after extraction into temporary staging.
- **Tray presentation flexibility.** A label takes precedence over graph series for the same stable tray item, while existing graph, background, border, tooltip, visibility, and action behavior remains compatible.

### Compatibility

- Plugin API remains **v1**. ZIP installation and tray labels are backward-compatible host capabilities.
- Existing folder packages and installed plugins require no migration.
- RemoteHand core remains plugin-agnostic; plugins decide when to publish labels versus live graph series.

### Verification

- Production frontend build and Rust tests passed on the development branch before v1.2.11 packaging.
- Native ZIP installation was manually validated with the packaged System Monitor plugin.
- Compact tray-label rendering was manually validated on Windows with a live numeric tile.
- Final Windows v1.2.11 package will receive a fresh post-merge smoke test before tagging or GitHub Release publication.

## `1.2.10` - 2026-09-24

### Improved

- **Stable plugin top-bar tooltips.** Plugin top-bar hover details now use a RemoteHand-rendered tooltip instead of the browser-native `title` popup, so live plugin updates no longer dismiss and recreate the tooltip while the pointer remains over the contribution.
- **Readable multiline details.** Plugin-provided tooltip line breaks are preserved without wrapping individual lines, while the tooltip remains bounded to the application window.

### Fixed

- **Live-update hover flicker.** Rapidly updating top-bar contributions such as monitoring sparklines no longer make their hover tooltip flicker on each refresh.

### Verification

- Production frontend build passed on Windows.
- Manual Windows acceptance confirmed the tooltip remains continuously visible while Target Monitor live graph updates arrive.
- Manual acceptance confirmed multiline exposed-field details remain unwrapped and readable.

## `1.2.8` - 2026-09-24

RemoteHand v1.2.8 is the next public release after v1.2.3 and includes all accumulated changes from the internal v1.2.4-v1.2.7 milestones plus the final plugin notification/storage infrastructure.

### Added

- **Generic plugin system-tray contributions.** Plugins with `tray.contribute` can publish per-item tray icons with live bounded series data, semantic tones, custom graph/background/border colors, visibility control, tooltips, and generic panel actions.
- **Stable Windows plugin tray identity.** Plugin tray items use deterministic GUID-backed identities so Windows can preserve shell identity across updates, restarts, disable/re-enable cycles, and tooltip changes.
- **Generic top-bar menus, icons, colors, and badges.** Plugin top-bar contributions gained bounded dropdown menus, built-in vector icons, validated color overrides, and a generic compact `badge` primitive for unread/status counts.
- **Host-owned interface contribution ordering.** Settings → Interface can reorder built-in and plugin sidebar/top-bar contributions, persist that order under `data/config/ui-contributions.json`, and reset it safely.
- **Cross-window panel drag and drop.** Dockview tabs can move between the main RemoteHand window and popouts, and directly between separate popouts.
- **Contextual tab popout controls.** Docked tabs expose Pop out beside Close; popped-out tabs expose Dock to main and return to their remembered main-window group when possible.
- **Generic native plugin notifications.** Plugins with `notifications.show` can request bounded native notifications associated with a plugin tray item.
- **Windows notification queueing and actions.** Per-tray-item notifications queue instead of blindly overwriting each other. Click, hide, and timeout lifecycle events advance the queue.
- **Generic notification deep-link routing.** Notification actions can restore RemoteHand, open/focus a plugin panel, and deliver bounded panel context such as target/report identifiers without adding plugin-specific semantics to core.
- **Larger plugin storage entries.** `storage.plugin` entries now allow up to 16 MiB per key while RemoteHand's internal state-file limit remains 1 MiB.
- **Host network/clipboard services.** Plugin API v1 gained `network.interfaces` behind `network.inspect` and bounded `clipboard.write` behind `clipboard.write`.

### Improved

- **Adaptive tray graph rendering.** Sparse plugin tray histories expand graph bars while retaining readable gaps; dense histories drop gaps when necessary so bars remain visible.
- **Plugin tray lifecycle.** Normal disable hides contributed tray icons without destroying stable shell handles; unexpected runtime exit hides stale contributions; uninstall purges retained tray handles.
- **Plugin panel targeting and focus.** Top-bar, tray, and notification actions restore/focus the correct docked or popout panel and preserve plugin context.
- **Plugin panel context startup.** Panel context is cached and replayed through the bridge so deep links still work when a plugin panel is opened for the first time.
- **Shell-focused sidebar.** Visible Split right, Split below, Pop out active, Undo, Redo, and Reset layout controls were removed from the sidebar while underlying commands/shortcuts remain available.
- **Plugins moved into Settings.** Plugin management now lives under Settings → Plugins while the runtime/controller remains continuously mounted.
- **Interface settings cleanup.** Settings → Interface groups Reset interface order and Reset workspace layout.
- **Cross-window drag targeting.** Hovering another RemoteHand window while dragging raises that exact window as the visible drop target.
- **Main-window dock-back behavior.** Dock to main consistently targets the main RemoteHand workspace, preferring the panel's remembered valid group and falling back safely.
- **Release workflow documentation.** A standard release process, artifact naming scheme, checksum workflow, and release-note format are documented in `docs/RELEASES.md`.

### Fixed

- **Plugin disable freeze.** Removed duplicate tray cleanup paths that could block while disabling a plugin.
- **Tray target routing.** Clicking a plugin tray item now delivers the clicked item's context instead of falling back to a previously selected/default target.
- **GUID tray tooltip updates.** Windows GUID-backed tray icons now update tooltip text correctly.
- **Plugin remove-confirm layering.** The Remove plugin confirmation is elevated correctly above the Plugin Manager/Settings modal.
- **Single-tab popout restore.** Docking back a single-tab popout restores the tab/group to its original workspace position and closes the exact native popout.
- **Multi-tab/multi-group popout lifecycle.** Closing or docking one tab no longer closes the entire popout while other panels remain.
- **Empty source popouts after drag.** Moving the final panel away from a popout closes the now-empty native window.
- **Racy popout cleanup.** Legacy group-level cleanup that could close a popout and throw surviving panels back into the main window was removed.
- **Cross-window drag reliability on Windows.** Dockview's browser drag/drop path is used consistently while Tauri native drag interception is disabled for main and dynamic popout WebViews.
- **Cargo.toml Windows line-ending churn.** Repository normalization prevents recurring Windows-only dirty-tree changes after Cargo commands.

### Compatibility

- Plugin API remains **v1**. The additions above are backward-compatible API-v1 host capabilities.
- RemoteHand core remains plugin-agnostic: plugins own monitoring/protocol semantics while core owns generic runtime, storage, tray, notification, panel, and contribution infrastructure.
- The vendored `tray-icon` crate remains in use for the Windows GUID/notification backports required by the current release.

### Verification

Windows release-branch validation covered:

- Frontend lint: 17 warnings, 0 errors.
- Frontend tests: 7 passed, 0 failed.
- Production frontend build: passed.
- Rust tests: 35 passed, 0 failed.
- `cargo check --locked`: passed.
- Interface contribution ordering and restart persistence.
- Plugin disable/re-enable lifecycle.
- Per-target plugin tray identity/routing.
- Main ↔ popout and popout ↔ popout drag/drop.
- Multi-tab/multi-group popout lifecycle.
- Generic native Windows notifications.
- Notification queueing and click-through panel routing.
- Adaptive tray graph rendering.
- Plugin remove-confirm modal layering.
- Target Monitor v0.7.0 integration against the new generic plugin capabilities.

The final Windows release binary still requires the standard post-merge build and smoke test before packaging/tag publication.


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

