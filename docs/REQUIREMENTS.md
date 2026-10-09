# RemoteHand Requirements

## Product Goal

RemoteHand is a modern, open-source desktop application for local and remote workstation workflows. V1 focuses on portable terminal, SSH, SFTP, connection, and workspace management without requiring an installer, cloud account, or enterprise infrastructure service.

## V1 Functional Baseline

The following are part of the current V1 baseline.

### Desktop and Portability

- Windows and Linux desktop architecture
- Tauri-based native shell
- Portable-only runtime model
- Normal operation without administrator/root privileges
- Application state stored relative to the executable
- No required installer or cloud account
- Main-window geometry persistence

### Workspace

- Multiple tabs/panels
- Horizontal and vertical splits
- Drag-and-drop docking
- Popout windows
- Workspace serialization and restoration
- Layout undo, redo, and reset
- Home dashboard
- Persistent Recent Activity
- Responsive narrow-panel behavior

### Local Terminal

- Native PTY-backed terminal sessions
- xterm.js rendering
- PowerShell shortcut on Windows
- Command Prompt shortcut on Windows
- Platform shell support
- Terminal resize handling
- Selection auto-copy
- Right-click paste workflow
- Configurable multi-line paste protection
- Configurable terminal appearance

### SSH Terminal

- SSH sessions inside terminal panels
- Host, port, and username from saved connection profiles
- System `ssh` client executed inside a PTY
- Interactive authentication through the installed SSH client
- Installed-client host-key, key-file, config, and agent behavior
- Reopen/reconnect actions from recent activity

V1 does not claim an independent native SSH-terminal authentication stack. Rich native SSH auth configuration and explicit port-forward management are post-V1 work.

### Saved Connections

Each V1 saved connection supports:

- ID
- Friendly display name
- Host/IP
- Port
- Username
- Optional credential reference

Credentials must not be embedded directly in connection JSON.

### SFTP

- SFTP file browser
- Directory listing/navigation
- Upload/download
- Multi-entry transfer operations
- Create directory
- Rename
- Move
- Delete
- Permission changes where supported
- Native transfer cancellation path
- Known-host verification in the native Rust SFTP path
- Password retrieval from the encrypted portable credential vault

### Credential Vault

- Portable encrypted secret storage
- Passphrase-based unlock
- Explicit lock
- Store/get/delete by opaque credential reference
- Argon2id passphrase-based key derivation
- XChaCha20-Poly1305 authenticated encryption
- Vault stored separately from ordinary profile/configuration JSON

### Appearance and Settings

- Dark theme
- Light theme
- System theme
- Accent/color scheme
- UI font family and size
- Terminal theme
- Terminal foreground/background configuration
- Terminal font family and size

## Startup and System Tray

RemoteHand v1.2 requires optional, user-controlled startup and tray behavior:

- Start RemoteHand with the operating system at user login
- Start minimized when launched through the startup registration
- Show RemoteHand in the system tray
- Use a single context-aware Show/Hide tray action
- Provide tray shortcuts for Home, Connections, New Terminal, Settings, and Exit
- Minimize to tray on close when enabled
- Keep normal application data portable beside the executable
- Do not require an installer, service, or administrator/root privileges for normal startup/tray use

### Settings

Startup and system-tray controls belong in their own Settings tab, separate from Appearance controls.

## Core UX Requirements

### Tabs and Panes

- Sessions may be open simultaneously.
- Tabs can move between Dockview groups.
- Pane sizes must be interactively adjustable.
- Different panel types may coexist in one workspace.
- Saved layouts should reopen without breaking older compatible panel identifiers.

### Home

- Home should remain useful as a stable dashboard rather than an animated distraction.
- Greeting text is randomized on app start and when Home is opened, not continuously rotated.
- Recent Activity should survive app restarts.
- Recent Activity should reopen/reconnect the recorded workflow when possible.

### Sidebar

- Expanded and collapsed modes are required.
- Icons must remain understandable in collapsed mode through tooltips/titles.
- Spacing must remain visually consistent when headings become hidden.

### Terminal Safety

- Selecting terminal text automatically copies it to the clipboard.
- Right-click paste remains available as the fast workflow.
- Multi-line paste protection must be able to require confirmation before executable multi-line text is sent.

## Non-Functional Requirements

### Security

- Never implement custom cryptography.
- Do not store passwords/private keys in plaintext profile files.
- Do not silently disable host-key verification.
- Do not log vault passphrases or secrets.
- Security-sensitive defaults should favor safety over convenience.

### Performance

- Local terminals should open quickly.
- UI rendering must remain responsive with multiple panels.
- Remote/file activity must not block the UI thread.
- Idle sessions should use minimal CPU.

### Portability

- No required MSI, DEB, RPM, AppImage, or system package manager.
- No required registry installation.
- Normal V1 state stays with the portable application directory.
- Sensitive secrets remain encrypted separately from ordinary portable JSON.

### Maintainability

- Frontend components should not depend directly on protocol-library internals.
- Native functions should expose narrow commands/events to the frontend.
- Saved-state compatibility should be considered when renaming serialized Dockview components or persisted fields.
- Dependency licensing and security posture must remain reviewable.

## Explicit V1 Non-Goals

- Implementing SSH from scratch
- Implementing cryptography from scratch
- RDP
- VNC
- X11 server implementation
- Enterprise asset discovery
- Fleet policy management
- Remote monitoring/management agent deployment
- Required cloud account
- Installer-based distribution

## Plugin Runtime and Extensibility

The shipped plugin baseline includes:

- Out-of-process executable plugins
- Versioned Plugin API v1 handshake and IPC
- Manifest-declared permissions and plugin-scoped storage
- Dockable plugin panels hosted in sandboxed iframes
- Sidebar and command contributions
- Generic live top-bar widget contributions
- Plugin Manager install/enable/disable/remove workflows
- A separate Host Monitor reference plugin using the generic API

## Post-V1 Requirements

Candidate post-V1 capabilities include:

- Rich native SSH authentication UX
- Explicit SSH key/agent/profile management in RemoteHand
- SSH port-forwarding UI
- RDP
- VNC
- X11 forwarding/integration
- Connection groups and favorites
- Per-host notes
- Reusable templates
- Session logging
- Connection health/status
- Tailscale-aware conveniences
- More advanced transfer queue/progress controls
- Command palette and expanded keyboard workflows
- Import/export and backup/restore UX
