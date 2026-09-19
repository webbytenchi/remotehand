# RemoteHand

RemoteHand is an open-source, portable remote workstation manager for Windows and Linux. It combines local terminals, SSH sessions, SFTP file management, saved connections, encrypted portable credentials, and a dockable multi-pane workspace in one desktop application.

RemoteHand V1 is intentionally focused on the workflows needed for day-to-day terminal and file-based remote administration. Later protocols such as RDP, VNC, and X11 remain roadmap items.

## V1 Highlights

- Portable-only desktop application: extract and run, with no installer required
- Local terminal sessions through a native PTY
- Windows PowerShell and Command Prompt shortcuts
- SSH terminal sessions in dockable tabs and panes
- Saved connection profiles
- SFTP browser and file operations
- Portable encrypted credential vault
- Dockable tabs, drag/drop groups, splits, and popout windows
- Workspace layout persistence
- Main-window size and position persistence
- Home dashboard with persistent Recent Activity
- Dark, light, and system themes
- Configurable color scheme, UI font, and terminal appearance
- Optional startup at user login and system-tray integration
- Start minimized and minimize-to-tray support
- Tray shortcuts for Home, Connections, New Terminal, and Settings
- Terminal selection auto-copy, right-click paste, and multi-line paste confirmation
- Responsive Connections and Recent Activity cards

## Current V1 Architecture

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19 + TypeScript |
| Build tooling | Vite |
| Docking / layout | Dockview |
| Terminal renderer | xterm.js |
| Shared frontend state | Zustand |
| Native backend | Rust |
| Local terminal / SSH PTY | portable-pty |
| SSH terminal transport | System `ssh` client launched inside a PTY |
| Native SFTP | `russh` + `russh-sftp` |
| Portable credential vault | `age` passphrase encryption |

RemoteHand deliberately reuses mature protocol implementations rather than implementing SSH or cryptography from scratch.

## Workspace

The application shell uses Dockview so sessions and tools can be arranged as tabs or split panes. V1 supports:

- Multiple terminal, SSH, SFTP, Connections, and Home panels
- Horizontal and vertical splits
- Drag-and-drop tab/pane movement
- Popout windows
- Layout undo, redo, and reset
- Automatic workspace save/restore

The Home panel shows recent local-terminal, SSH, and SFTP activity. Recent Activity is persisted and can reopen or reconnect a previous item. The welcome message is randomized when the app starts and when Home is opened; it does not continuously rotate.

## Terminal and SSH

Local terminals are backed by a native PTY and rendered with xterm.js.

On Windows, RemoteHand exposes quick actions for PowerShell and Command Prompt. Other supported local shells use the platform's normal shell path.

SSH terminal sessions currently launch the operating system's `ssh` client inside a PTY. This means host-key handling, key files, agents, SSH configuration, and interactive authentication follow the installed SSH client's behavior. RemoteHand does not currently inject portable-vault passwords into SSH terminal sessions.

Terminal interaction includes:

- Automatic clipboard copy when terminal text is selected
- Right-click paste workflow
- Multi-line paste confirmation/protection
- Resize propagation to the native PTY
- Configurable terminal font and theme

## SFTP

V1 includes SFTP file management with a native Rust implementation based on `russh` and `russh-sftp`, plus supporting compatibility paths used by the application.

Current operations include:

- Directory listing and navigation
- File upload and download
- Multi-file / multi-entry transfers
- Create directory
- Rename and move entries
- Delete entries
- Permission changes where supported
- Transfer cancellation in the native path
- Native host-key verification through known-hosts handling

SFTP password credentials can be stored in the portable encrypted vault and referenced from saved connection profiles.

## Saved Connections

Saved profiles currently contain:

- Friendly name
- Host
- Port
- Username
- Optional credential reference

Connection profiles never contain the corresponding saved secret. Passwords stored for SFTP are kept separately in the encrypted vault.

## Portable Data

RemoteHand resolves application data relative to the executable directory. A typical V1 portable layout is:

```text
RemoteHand/
├── RemoteHand.exe            # Windows build
└── data/
    ├── activity/
    │   └── recent.json
    ├── config/
    │   └── settings.json
    ├── connections/
    │   └── connections.json
    ├── vault/
    │   └── credentials.enc
    └── workspaces/
        └── default.json
```

Window state is also persisted by the native application so the main window can reopen at its previous size and position.

The portable model is a core product requirement: normal operation should not require administrator/root privileges, an installer, or a cloud account.

## Credential Vault

RemoteHand includes a portable encrypted credential vault at:

```text
data/vault/credentials.enc
```

The vault uses the established `age` format with passphrase-based encryption. Saved connection profiles store only an opaque credential reference. The master passphrase and decrypted secrets are held in process memory only while the vault is unlocked.

See [SECURITY.md](SECURITY.md) for the threat model and limitations.

## Settings

V1.2 adds a separate Startup & Tray settings tab alongside the existing Appearance tab.

Startup & Tray settings include:

- Start RemoteHand with the system at user login
- Start minimized for automatic launches
- Show RemoteHand in the system tray
- Minimize to tray when closing

The tray menu provides context-aware Show/Hide control plus quick access to Home, Connections, New Terminal, Settings, and Exit.

The system-start registration is an operating-system user preference; normal application data remains portable under `data/`.

V1 settings include:

- Dark, light, or system theme
- Accent/color scheme
- UI font family and size
- Terminal theme
- Custom terminal foreground/background
- Terminal font family and size

Settings are stored portably under `data/config/settings.json`.

## Plugins

RemoteHand supports out-of-process executable plugins that extend the app without modifying core. Plugins can contribute panels, sidebar buttons, commands, and live top-bar widgets. Plugin API v1 is shipping in the v1.1.0 release.

The plugin system is built on a simple rule: core owns infrastructure, plugins own functionality. RemoteHand core provides lifecycle, permissions, storage, IPC, and generic UI surfaces. Plugins provide protocol-specific behavior - for example, VNC, RDP, or host monitoring - that core does not need to know about.

Plugin API v1 is documented in docs/PLUGINS.md. It covers package layout, the manifest, the IPC protocol, host services, panel hosting, and top-bar contributions.

Plugins are disabled by default after install. Only install plugins you trust - a plugin is a native executable with the host process privileges. See SECURITY.md for the plugin threat model.

## Development

Prerequisites:

- Node.js and npm
- Rust toolchain compatible with Tauri 2
- Platform prerequisites required by Tauri
- An `ssh` client available on the host for SSH terminal sessions

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run tauri dev
```

Run frontend checks:

```bash
npm run check
```

Build the frontend:

```bash
npm run build
```

RemoteHand is configured as portable-only. Tauri bundling/installers are disabled in `src-tauri/tauri.conf.json`. Startup registration is an OS-level user preference; application data remains beside the executable.

## V1 Status

**Status: V1 feature baseline complete. Plugin Runtime v1 is shipping in v1.1.0. The separate RemoteHand Host Monitor reference plugin v0.5.0 is also released and validated with v1.1.0 on Windows x86_64.**

The current V1 has been exercised on the Windows Tauri build for the primary workspace, terminal, connection, Home, persistence, credential-vault, and SFTP workflows. Remaining work belongs to post-V1 expansion and hardening rather than the original bootstrap phase.

## Post-V1 Direction

Planned areas include:

- Plugin ecosystem expansion: additional contribution surfaces, plugin SDK, and sample plugins
- Richer SSH-native integration and authentication UX
- SSH port forwarding management
- RDP
- VNC
- X11 integration/forwarding
- Connection groups, favorites, notes, and templates
- Session logging
- Connection health/status information
- Tailscale-aware conveniences
- More advanced transfer queue UX
- Command palette and broader keyboard workflows
- Additional automated integration and packaging validation

See [docs/ROADMAP.md](docs/ROADMAP.md) for the current sequencing.

## Documentation

- [Requirements](docs/REQUIREMENTS.md)
- [Plugins](docs/PLUGINS.md)
- [Roadmap](docs/ROADMAP.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

RemoteHand is licensed under the [MIT License](LICENSE).

Third-party components retain their own licenses. Security-sensitive and protocol dependencies should continue to be reviewed for license compatibility, maintenance, security history, and platform fit.
