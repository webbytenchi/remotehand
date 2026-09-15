RemoteHand Plugins
RemoteHand v1.0.3 introduced Plugin API v1 as the foundation for optional protocol and workspace extensions. RemoteHand v1.0.4 adds the first serious protocol integration through that contract: the first-party remotehand.vnc plugin.
Goals

Keep major connection protocols out of the core UI unless their plugin is installed and enabled.

Keep RemoteHand portable by storing plugins beside the executable in plugins/.

Keep plugin state under data/config/plugins.json.

Use a small, versioned core API instead of allowing plugins to reach into internal modules.

Apply least privilege to sensitive capabilities.

Keep secrets inside the core credential vault.

Plugin API v1
RemoteHand can:

discover installed plugins,

strictly validate plugin.json,

install from a selected folder,

keep newly installed plugins disabled by default,

enable or disable plugins,

remove disabled plugins,

display declared capabilities in the Plugin Manager,

reject incompatible API versions,

reject unknown or duplicate capabilities,

reject symlinked plugin roots, manifests, and package entries,

reject unsafe paths,

reject oversized plugin packages,

reject packages with too many files,

prevent installs that overlap RemoteHand's own plugin directory.

RemoteHand does not dynamically load arbitrary native plugin DLLs or shared libraries. First-party protocol drivers such as VNC are host-mediated: the enabled plugin manifest activates a bounded core driver whose commands enforce the plugin's declared capabilities.
Directory layout
RemoteHand/
RemoteHand.exe
plugins/
remotehand.vnc/
plugin.json
data/
config/
plugins.json
plugins/
remotehand.vnc/
connections.json
Manifest format
Example:
JSON{
"id": "remotehand.vnc",
"name": "RemoteHand VNC",
"version": "1.0.4",
"apiVersion": 1,
"author": "RemoteHand",
"description": "First-party host-mediated VNC support for RemoteHand.",
"capabilities": [
"connection-type",
"dock-panel",
"network",
"credential-use",
"filesystem-read",
"filesystem-write"
]
}
Unknown manifest fields are rejected. Plugin IDs must use lowercase ASCII letters, digits, ., -, or _.
Capability model
API v1 recognizes:

connection-type

dock-panel

settings

network

clipboard-read

clipboard-write

filesystem-read

filesystem-write

credential-use

credential-use is intentionally different from direct vault access. The core performs credential-backed operations without exposing decrypted secret material to plugin frontend code.
The VNC driver requires connection-type, dock-panel, and network for all protocol operations. Saved VNC connection persistence additionally requires filesystem-read or filesystem-write, and stored VNC passwords require credential-use.
VNC in v1.0.4
The first-party VNC plugin contributes a VNC Connections panel and embedded VNC viewer. VNC UI is only exposed when remotehand.vnc is installed and enabled.
The host-mediated driver currently targets classic RFB 3.3, 3.7, and 3.8 servers with no-auth or classic VNC password authentication. Vendor-specific security types and modern TLS authentication schemes are not part of this first milestone.
The viewer supports framebuffer updates, pointer input, keyboard input, refresh, saved VNC connections, and credential-vault integration. Clipboard host commands exist behind explicit clipboard capabilities, but the first v1.0.4 manifest does not request clipboard access because the current VNC UI does not expose clipboard controls.
Installation limits
Folder installation is deliberately bounded:

maximum 2,048 files,

maximum 64 MiB total file size,

maximum 512 scanned plugin entries,

maximum 64 KiB manifest,

maximum 1 MiB plugin-state file.

Symbolic links and unsupported filesystem entry types are rejected.
Removal and teardown safety
Plugins must be disabled before removal. Removal walks the plugin tree without following symbolic links.
Protocol commands remain capability-gated while a plugin is enabled. Session teardown is intentionally allowed even after a plugin is disabled so an already-running host-mediated session can always be closed cleanly.
Future direction
Later plugin-runtime work can add stronger process or sandbox isolation for third-party executable plugins without changing the VNC panel or capability contract introduced here.
