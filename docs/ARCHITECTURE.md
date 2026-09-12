# RemoteHand Architecture

Overview
RemoteHand is planned as a Tauri desktop application with a React/TypeScript frontend and a Rust/native backend.
The architecture intentionally separates presentation, workspace management, connection profiles, protocol adapters, and credential handling.
RemoteHand
|
+-- Tauri desktop shell
|   |
|   +-- React / TypeScript UI
|       +-- shadcn/ui
|       +-- Tailwind CSS
|       +-- Dockview
|       +-- xterm.js
|       +-- Zustand
|
+-- Native/backend services
+-- Connection manager
+-- Credential abstraction
+-- SSH adapter
+-- SFTP adapter
+-- RDP adapter
+-- VNC adapter
+-- X11 integration adapter
+-- Local terminal adapter
Architectural Principles
1. Protocol-neutral workspace panes
The layout layer should not care whether a pane contains SSH, RDP, VNC, SFTP, or another view.
Each pane is a host for a session/view component identified by type and state.
2. Protocol adapters
Every remote protocol should sit behind an internal adapter boundary.
For example:
ConnectionProfile
|
ConnectionManager
|
+------+------+------+------+
| SSH  | RDP  | VNC  | ...  |
+------+------+------+------+
This prevents the UI from becoming tightly coupled to one library.
3. Mature libraries over protocol reimplementation
RemoteHand should orchestrate mature open-source implementations.
Candidates must be evaluated on:

License

Security history

Maintenance activity

Windows support

Linux support

API stability

Packaging complexity

Tauri/Rust integration cost

4. Frontend/backend separation
The frontend owns:

Layout

Tabs

Themes

Forms

Connection/profile editing

User interaction

Terminal rendering

The backend owns:

Network sessions

Process spawning

Secure credential access

Protocol libraries

File-system operations requiring native APIs

Platform-specific integration

5. Portable mode
Portable mode should alter configuration/data locations without weakening credential handling.
A future portable directory may resemble:
RemoteHand/
+-- RemoteHand.exe
+-- data/
+-- config/
+-- layouts/
+-- themes/
+-- logs/
Secrets should use an encrypted vault or OS credential storage unless the user explicitly chooses another supported model.
Proposed Frontend Stack
Tauri
Provides the native desktop shell and Rust backend while keeping application size and resource use lower than a typical Electron application.
React + TypeScript
Used for application UI and strong component ecosystem.
shadcn/ui + Tailwind CSS
Provides modern components and theme flexibility without requiring us to build common controls from scratch.
Dockview
Provides:

Dockable tabs

Split panes

Drag/drop

Floating groups

Popout groups/windows

Layout serialization

Custom panel/header components

xterm.js
Provides terminal rendering. It is not the SSH implementation; it displays terminal input/output provided by the backend.
Zustand
Provides lightweight shared application state without forcing protocol/business logic into UI components.
Session Lifecycle
User selects connection
|
v
ConnectionManager validates profile
|
v
Credential provider resolves authentication
|
v
Protocol adapter opens session
|
v
Session event stream
|
+--> terminal / desktop / file UI
|
v
Disconnect / reconnect / close
Data Model Direction
Likely high-level entities:

ConnectionProfile

ConnectionGroup

Workspace

Pane

Session

CredentialReference

PortForward

ApplicationSettings

Credentials should be referenced, not embedded directly inside ordinary profile serialization.
Testing Strategy
Testing should be layered:

Pure unit tests for profile/layout/state logic

Adapter contract tests

Mock protocol-session tests

Local integration tests

Live SSH integration against disposable test hosts

UI tests for tab/split/docking behavior

Platform packaging tests

Human acceptance for real remote workflows
