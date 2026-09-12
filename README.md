# RemoteHand
RemoteHand is a modern, open-source remote workstation manager designed for people who regularly work across servers, virtual machines, development systems, and desktops.
The goal is simple: provide a clean, modern interface for remote access without rebuilding mature network protocols from scratch.
RemoteHand will combine a native desktop shell with proven open-source protocol libraries and a flexible dockable workspace.
## Vision
RemoteHand should feel like a modern development tool rather than a legacy administration utility.
Core principles:

Modern, uncluttered desktop UI

Multiple tabs and split panes

Drag-and-drop docking and layout persistence

Portable-first Windows experience

Cross-platform architecture

Open-source components wherever practical

Security-conscious credential and connection handling

Reuse mature protocol implementations instead of reinventing SSH, RDP, VNC, or X11

Progressive complexity: common tasks stay simple, advanced settings stay available when needed

## Planned Capabilities
### V1

Saved connection profiles

SSH terminal sessions

Multiple tabs

Horizontal and vertical split panes

Drag-and-drop docking

Detachable/popout panels

Saved workspace layouts

Dark, light, and system themes

Portable configuration mode

Local terminal support

SSH key and password authentication

SSH port forwarding

### Later

SFTP file management

RDP sessions

VNC sessions

X11 forwarding/integration

Connection groups and workspaces

Reconnect/session recovery

Per-host notes

Session logging

Tailscale-aware conveniences

Server health/status indicators

Command palette and advanced keyboard navigation

## Proposed Technology Stack
LayerTechnologyDesktop shellTauriFrontendReact + TypeScriptStyling/UITailwind CSS + shadcn/uiDocking/layoutDockviewTerminal rendererxterm.jsApplication stateZustandNative/backend layerRustSSH/SFTPMature open-source library, final selection after security/license reviewRDPExisting open-source implementation such as FreeRDPVNCExisting open-source VNC implementationX11Existing X server/forwarding integration rather than a new implementation
The exact protocol libraries are intentionally not locked yet. Each dependency must pass a license, maintenance, security, and platform-fit review before adoption.
## UI Direction
RemoteHand uses a protocol-neutral pane model. A workspace pane may eventually contain:

SSH terminal

Local terminal

SFTP browser

RDP desktop

VNC desktop

X11-forwarded application

This allows layouts such as an SSH shell beside an RDP desktop, or several SSH sessions arranged across split panes.
## Portable Mode
Portable operation is a first-class requirement, especially on Windows.
A portable installation should be able to keep non-sensitive configuration, themes, connection profiles, and workspace layouts inside a self-contained application directory. Sensitive credentials must not be stored as plaintext merely to support portability.
## Project Status
Status: Planning / bootstrap
The repository currently contains the initial product, architecture, security, and roadmap documentation. Implementation has not started yet.
## Documentation

Requirements

Architecture

Roadmap

Security

Contributing

## License
RemoteHand is licensed under the MIT License.
Third-party components retain their own licenses. Dependencies must be reviewed before inclusion to ensure their licenses are compatible with the project and distribution model.
