# RemoteHand Architecture

## Overview

RemoteHand V1 is a Tauri 2 desktop application with a React/TypeScript frontend and a Rust native backend. The architecture separates workspace/UI concerns from native process, terminal, file-transfer, persistence, and credential operations.

```text
RemoteHand
├── Tauri desktop shell
│   ├── React + TypeScript UI
│   │   ├── Dockview workspace
│   │   ├── xterm.js terminal renderer
│   │   ├── Home / Recent Activity
│   │   ├── Connections
│   │   ├── SFTP browser
│   │   └── Settings
│   └── Rust backend
│       ├── Portable persistence
│       ├── Window-state persistence
│       ├── Local PTY sessions
│       ├── SSH PTY sessions
│       ├── Native SFTP
│       ├── Portable credential vault
│       └── Logging
└── data/ beside executable
```

## Frontend

The frontend owns:

- Application shell and sidebar
- Dockview panels, tabs, splits, drag/drop, and popouts
- Home dashboard and Recent Activity presentation
- Connection/profile editing
- SFTP UI
- Terminal rendering and interaction
- Theme, font, and color-scheme settings
- Layout undo/redo/reset actions

Current frontend technologies:

- React 19
- TypeScript
- Vite
- Dockview
- xterm.js
- Zustand
- CSS-based application styling

The original bootstrap plan mentioned Tailwind/shadcn/ui, but V1 does not depend on them; the shipped UI is implemented with the current React/CSS component set.

## Native Backend

The Rust backend owns operations that need native APIs or must remain outside the browser sandbox:

- Portable filesystem paths and persistence
- Native window geometry tracking/restoration
- PTY process creation and lifecycle
- System `ssh` process startup inside a PTY
- SFTP networking and filesystem transfer operations
- Credential-vault encryption/decryption
- Native file/folder pickers
- Application logging

## Workspace Model

Dockview provides the protocol-neutral pane model. V1 panels include Home, terminals, SSH sessions, Connections, and SFTP.

Saved layouts are serialized to:

```text
data/workspaces/default.json
```

The visible Home panel retains its original internal Dockview component key (`welcome`) for compatibility with layouts created before the panel was renamed from Welcome to Home.

Workspace behavior includes:

- Multiple groups and tabs
- Horizontal/vertical splits
- Drag/drop docking
- Popouts
- Layout persistence
- Undo/redo/reset

## Home and Recent Activity

Recent Activity records local terminal, SSH, and SFTP activity. Entries are deduplicated by activity/session identity and capped by the UI to a short recent list.

Persistence path:

```text
data/activity/recent.json
```

Home selects a random greeting at application startup and another different greeting when Home is explicitly opened/focused. There is no timer-based greeting rotation.

## Terminal Architecture

`portable-pty` provides the native PTY layer. The backend exposes start/write/resize/close commands and emits terminal output/exit events to the frontend.

Local terminals launch the platform's shell or an explicitly selected shell such as PowerShell or Command Prompt on Windows.

### SSH terminal path

SSH terminal sessions currently launch the host operating system's `ssh` executable in the PTY. This deliberately delegates SSH config, keys, agents, host-key behavior, and interactive auth to the installed SSH client.

This path is distinct from the native Rust SFTP stack.

## SFTP Architecture

V1 contains a native persistent SFTP path using:

- `russh`
- `russh-sftp`

It supports persistent sessions and operations such as listing, mkdir, rename, upload, download, and cancellation.

The codebase also contains compatibility/helper SFTP operations used for additional file actions. Both paths must preserve the credential-separation and host-verification security rules.

The native SFTP client verifies server keys through known-hosts handling.

## Credential Architecture

Saved connections contain an optional opaque `credentialRef`, never the secret itself.

The portable credential vault is stored at:

```text
data/vault/credentials.enc
```

The vault uses `age` passphrase encryption. While unlocked, the backend holds the decrypted vault document in process memory. Locking clears the in-memory unlocked state.

SFTP can resolve passwords through a credential reference. SSH terminal sessions currently do not consume the portable vault.

## Portable Persistence

The executable directory is the root of the portable data model:

```text
<executable-dir>/
└── data/
    ├── activity/recent.json
    ├── config/settings.json
    ├── connections/connections.json
    ├── vault/credentials.enc
    └── workspaces/default.json
```

This is intentional: portable operation should not depend on installer-created registry keys or system-wide directories.

## Window State

The native window-state tracker restores the main window on startup and tracks changes during runtime. V1 persists client-area size in a way that matches Tauri's restore API, avoiding cumulative titlebar/frame growth on Windows.

## Data Model

Current persisted high-level entities include:

- `Settings`
- `SavedConnection`
- `RecentActivity`
- Dockview workspace JSON
- Vault document keyed by credential reference

Future entities such as groups, favorites, notes, templates, RDP/VNC sessions, and richer SSH settings should extend this model without embedding secrets in ordinary profile serialization.

## Testing Strategy

Testing should remain layered:

- Frontend unit/component tests through Vitest
- TypeScript build validation
- Lint and formatting checks
- Rust unit tests where applicable
- Native integration checks for PTY/SFTP/vault/window-state behavior
- Human acceptance on real Windows and Linux desktop builds
- Disposable-host testing for remote protocols

Native/portable behavior should always be validated on the affected target platform, because path, PTY, window-frame, shell, and SSH-client behavior differs across operating systems.
