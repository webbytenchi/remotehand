# RemoteHand Plugins
RemoteHand v1.0.3 introduced the plugin-management foundation. RemoteHand v1.0.4 evolves that foundation into Plugin Runtime v1: an out-of-process executable plugin model intended for independently distributed first-party and third-party plugins.
Design rule
RemoteHand core owns infrastructure. Plugins own functionality.
Core may understand plugin lifecycle, generic UI contributions, permissions, storage, credentials, IPC, and process supervision. Core must not contain protocol-specific knowledge such as VNC, RDP, RFB, framebuffer decoding, or protocol-specific connection schemas.
Package layout
A production plugin is distributed independently from RemoteHand core.
Example:
remotehand.example/
├── plugin.json
├── icon.svg
├── bin/
│   ├── windows-x86_64/
│   │   └── remotehand-example.exe
│   ├── linux-x86_64/
│   │   └── remotehand-example
│   └── linux-aarch64/
│       └── remotehand-example
└── ui/
└── index.html
Installed plugins live in RemoteHand's portable plugins/ directory. Plugin enable/disable state remains under data/config/plugins.json.
Manifest v1 direction
JSON{
"id": "remotehand.example",
"name": "Example",
"version": "1.0.0",
"apiVersion": 1,
"author": "Example Developer",
"description": "Example RemoteHand plugin.",
"runtime": {
"kind": "executable",
"entrypoints": {
"windows-x86_64": "bin/windows-x86_64/remotehand-example.exe",
"linux-x86_64": "bin/linux-x86_64/remotehand-example",
"linux-aarch64": "bin/linux-aarch64/remotehand-example"
}
},
"permissions": [
"network.connect",
"credentials.use",
"storage.plugin"
],
"contributes": {
"sidebar": [
{
"id": "connections",
"title": "Example",
"icon": "icon.svg",
"panel": "connections"
}
],
"panels": [
{
"id": "connections",
"title": "Example Connections",
"entry": "ui/index.html"
}
],
"commands": []
}
}
Unknown manifest fields are rejected. Runtime and asset paths must remain inside the plugin package.
Runtime entrypoint keys use `<os>-<arch>` values reported by Rust `std::env::consts`, such as `windows-x86_64`, `linux-x86_64`, and `linux-aarch64`. A plugin package may contain multiple platform executables; RemoteHand launches only the exact entrypoint matching the current host.
Permissions
Plugin Runtime v1 currently recognizes:

network.connect

clipboard.read

clipboard.write

credentials.use

storage.plugin

Contribution declarations such as panels and sidebar items are metadata, not permissions.
Permissions are intended to become host-enforced capabilities. Until stronger OS-level sandboxing exists, declarations must not be described as a complete security boundary for arbitrary native executables.
credentials.use must never mean unrestricted vault export. Credential APIs should broker approved operations and keep secret exposure as narrow as possible.
UI contributions
Initial contribution kinds are:

sidebar items

dock panels

commands

Plugins own their UI. RemoteHand will host plugin-provided web assets in an isolated environment with a controlled bridge. Plugin UI must not receive unrestricted Tauri or filesystem access.
Runtime
Plugins run out of process.
RemoteHand launches the configured executable, establishes a versioned IPC session, validates plugin identity/API compatibility, supervises process lifetime, and tears down runtime resources when a plugin stops or crashes.
The runtime transport and handshake are part of Plugin API v1 and will be documented as they stabilize.
Installation safety
The existing plugin manager keeps these protections:

newly installed plugins are disabled by default

strict manifest parsing

API-version validation

path traversal rejection

symlink rejection

bounded file count and package size

bounded manifest and state files

safe removal of disabled plugins only

Current package limits remain:

maximum 2,048 files

maximum 64 MiB package size

maximum 512 scanned plugin entries

maximum 64 KiB manifest

maximum 1 MiB plugin-state file

Reference plugin
The first production reference plugin will be maintained separately in:
webbytenchi/remotehand-plugin-vnc
VNC-specific backend and frontend code must live in that repository, not RemoteHand core.
Developer documentation
The long-term public Plugin SDK documentation will cover:

manifest schema

package layout

executable entrypoint contract

IPC framing

handshake and API negotiation

lifecycle and crash supervision

UI hosting and contribution points

Host API

permissions

plugin-scoped storage

credential brokering

packaging, signing, testing, and distribution
