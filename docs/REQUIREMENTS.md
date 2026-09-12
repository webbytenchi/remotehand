# RemoteHand Requirements

Product Goal
Build a modern, open-source desktop application for managing remote computer sessions while keeping everyday use simple.
RemoteHand should provide the convenience of an all-in-one remote administration application without forcing users into an enterprise infrastructure-management workflow.
Core UX Requirements
Tabs

Multiple sessions may be open simultaneously.

Each session can live in its own tab.

Tabs can be reordered by drag and drop.

Tabs can move between pane groups.

A tab may be detachable into another window when supported by the desktop/layout stack.

Split View

Horizontal and vertical splits are required.

Nested splits are required.

Pane sizes must be adjustable interactively.

Different protocols may coexist in one workspace.

Layout state should be serializable and restorable.

Workspaces

Users can save useful arrangements of connections and panes.

Reopening a workspace should restore its layout.

Session reconnection behavior must be explicit and configurable.

Connections
Each connection profile should support:

Friendly display name

Hostname/IP

Port

Protocol

Username where applicable

Authentication method

Optional tags/groups

Optional notes

Protocol-specific advanced settings

V1 Functional Requirements

Windows-first desktop application.

Portable Windows mode.

SSH connections.

Local terminal sessions.

Saved connection profiles.

Multiple tabs.

Split panes.

Docking and tab movement.

Workspace layout persistence.

Dark/light/system themes.

SSH key authentication.

SSH password authentication.

SSH port forwarding.

Clear connection-state indicators.

Safe disconnect/reconnect behavior.

Keyboard-first navigation.

Command palette.

Settings import/export that does not silently expose credentials.

Post-V1 Functional Requirements

SFTP browser

RDP

VNC

X11 integration/forwarding

File transfer queue

Session logging

Connection health information

Tailscale-aware host conveniences

Host groups

Favorites

Reusable connection templates

Optional synchronized configuration

Non-Functional Requirements
Security

Never implement custom cryptography.

Do not store passwords or private keys in plaintext by default.

Clearly identify when credentials are persisted.

Host-key verification must not be silently disabled.

Security-sensitive defaults should favor safety over convenience.

Protocol libraries must have active maintenance and an acceptable security history.

Performance

Opening a new terminal should feel immediate.

UI responsiveness must remain smooth with multiple active sessions.

Background protocol activity must not block rendering.

Idle sessions should have low CPU use.

Portability

Windows portable mode must not require installation.

Portable mode must not require administrative privileges for ordinary use.

The application should make it clear which data remains outside the portable directory if OS credential storage is used.

Maintainability

Protocol implementations should be isolated behind interfaces/adapters.

UI components should not depend directly on protocol-library internals.

Core application state should be testable without launching real remote sessions.

Dependency licensing must be documented.

Explicit Non-Goals for V1

Implementing SSH from scratch

Implementing RDP from scratch

Implementing VNC from scratch

Building a new X server

Enterprise asset discovery

Centralized fleet policy management

Remote monitoring/management agent deployment

Cloud account requirement
