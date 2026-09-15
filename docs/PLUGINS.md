RemoteHand Plugins
RemoteHand v1.0.3 introduces Plugin API v1 as the foundation for optional protocol and workspace extensions.
Goals

Keep major connection protocols out of the core when they can be delivered as add-ons.

Keep RemoteHand portable by storing plugins beside the executable in plugins/.

Keep plugin state under data/config/plugins.json.

Use a small, versioned core API instead of allowing plugins to reach into internal modules.

Apply least privilege to sensitive capabilities.

Current v1.0.3 scope
The first release is intentionally conservative.
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

RemoteHand v1.0.3 does not dynamically execute arbitrary native plugin binaries or libraries. Plugin execution and host-mediated protocol APIs are a later phase.
Directory layout
RemoteHand/
RemoteHand.exe
plugins/
remotehand.vnc/
plugin.json
...
data/
config/
plugins.json
Manifest format
Example:
JSON{
"id": "remotehand.vnc",
"name": "RemoteHand VNC",
"version": "1.0.0",
"apiVersion": 1,
"author": "RemoteHand",
"description": "VNC connection support.",
"capabilities": [
"connection-type",
"dock-panel",
"network",
"credential-use",
"clipboard-read",
"clipboard-write"
]
}
Unknown manifest fields are rejected.
Plugin IDs must use lowercase ASCII letters, digits, ., -, or _.
Capability model
API v1 recognizes these declared capabilities:

connection-type

dock-panel

settings

network

clipboard-read

clipboard-write

filesystem-read

filesystem-write

credential-use

credential-use is intentionally different from direct vault access. Future plugin APIs should ask the RemoteHand core to use a credential for an approved operation instead of exposing decrypted secret material to plugin code.
Capabilities in v1.0.3 are validated declarations. They are the contract for future host-mediated enforcement; no arbitrary plugin code is executed in this foundation release.
Installation limits
Folder installation is deliberately bounded:

maximum 2,048 files,

maximum 64 MiB total file size,

maximum 512 scanned plugin entries,

maximum 64 KiB manifest,

maximum 1 MiB plugin-state file.

Symbolic links and unsupported filesystem entry types are rejected.
Removal safety
Plugins must be disabled before removal.
Removal walks the plugin tree without following symbolic links. Plugin-owned data outside the installed plugin directory is not removed automatically.
Planned next step
The first serious protocol plugin is expected to be VNC. VNC should be implemented only after Plugin API v1 behavior and the Plugin Manager have completed runtime acceptance on Windows and Linux.
