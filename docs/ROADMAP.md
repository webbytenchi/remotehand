# RemoteHand Roadmap

This roadmap records what V1 has completed and what remains for later releases. It describes intended sequencing rather than fixed dates.

## V1 - Complete Baseline

### Phase 0 - Foundation — Complete

- Repository and product vision
- Tauri + React + TypeScript scaffold
- Security principles
- Portable-only architecture
- Frontend checks and test tooling
- Windows/Linux-oriented native structure

### Phase 1 - Workspace Shell — Complete

- Application shell
- Dark/light/system themes
- Color schemes and typography settings
- Sidebar with expanded/collapsed modes
- Dockview integration
- Multiple tabs
- Horizontal/vertical splits
- Drag/drop docking
- Layout save/restore
- Popout panels
- Layout undo/redo/reset
- Home dashboard
- Persistent Recent Activity
- Responsive Connections/Activity cards
- Main-window geometry persistence

### Phase 2 - Local Terminal — Complete for V1

- xterm.js integration
- Native PTY backend
- Windows PowerShell
- Windows Command Prompt
- Platform shell support
- Resize handling
- Selection auto-copy
- Right-click paste workflow
- Multi-line paste confirmation/protection
- Terminal appearance settings

Additional shell-specific convenience features can continue post-V1.

### Phase 3 - SSH Terminal — Complete for V1 Scope

- Saved SSH connection profiles
- Host/port/user connection launch
- SSH sessions in dockable terminal panels
- Reconnect/open from Recent Activity
- System `ssh` client integration inside native PTY

Deferred beyond V1:

- RemoteHand-native SSH auth configuration
- Rich known-host management UI
- Explicit key/agent management UI
- Port-forward management UI

### Phase 4 - Portable Data and Credentials — Complete for V1

- Settings persisted beside executable
- Saved connections persisted beside executable
- Workspace persistence
- Recent Activity persistence
- Main-window state persistence
- Credential references separated from profiles
- Portable encrypted vault using `age`
- Vault initialize/unlock/lock/store/get/delete commands

Still desirable post-V1:

- Import/export UX
- Backup/restore UX
- Passphrase rotation/recovery design

### Phase 5 - SFTP — Complete for V1

- Native Rust SFTP path with `russh`/`russh-sftp`
- Known-host verification
- Password credentials through portable vault
- Directory browsing
- Upload/download
- Multi-entry operations
- Create directory
- Rename/move
- Delete
- Permission changes where supported
- Native transfer cancellation

Further transfer queue polish and richer progress/ETA UX can continue later.

## Post-V1 Roadmap

### Phase 6 - SSH and Productivity Expansion

- Native/richer SSH authentication UX
- Key and agent management
- Port-forward manager
- Connection groups
- Favorites
- Per-host notes
- Reusable connection templates
- Command palette
- Broader keyboard navigation
- Session logging
- Connection health/status
- Tailscale-aware conveniences

### Phase 7 - Remote Desktop

#### VNC

- Select and review VNC library
- Embedded viewer
- Clipboard handling
- Scaling/fullscreen
- Authentication

#### RDP

- Evaluate FreeRDP integration
- Embedded vs orchestrated-client decision
- Clipboard
- Display scaling
- Multi-monitor strategy
- Credential integration

### Phase 8 - X11

- Evaluate Windows X11 strategies
- Evaluate WSLg integration
- X11 forwarding UX
- Document limitations and security model

### Phase 9 - Hardening and Distribution

- Broader automated native integration tests
- Cross-platform packaging/archive validation
- Dependency/security review automation
- Backup/restore UX
- Import/export that does not expose secrets
- Failure/recovery UX for corrupt portable state
- Performance and long-session soak testing

## Guiding Rule

RemoteHand should remain useful as a focused SSH/SFTP/terminal workstation manager even as later protocols are added. New protocol work should not destabilize the clean portable V1 baseline.
Plugin architecture
v1.0.3 — Plugin foundation

Plugin API v1 foundation.

Portable plugins/ directory and persisted enable/disable state.

Plugin Manager UI.

Safe folder-based installation.

Strict manifest validation.

Defensive file-count, size, path, symlink, and removal controls.

Plugins disabled by default.

v1.0.4 — Plugin Runtime v1

Out-of-process executable plugin runtime.

Versioned IPC and startup handshake.

Process lifecycle and crash supervision.

Generic sidebar, dock-panel, and command contributions.

Plugin-owned web UI hosted through a controlled bridge.

Generic Host API.

Permission enforcement model.

Plugin-scoped storage.

Credential brokering.

Public Plugin SDK documentation foundation.

First production reference plugin developed separately as remotehand-plugin-vnc.

The core must remain protocol-agnostic. VNC, RDP, X11, and future protocol implementations belong in independent plugin repositories.
