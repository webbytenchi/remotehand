# RemoteHand Plugins

RemoteHand supports out-of-process executable plugins. A plugin is a self-contained package that RemoteHand can install, enable, launch, and communicate with over a versioned IPC channel. Plugins extend RemoteHand without modifying core — they can add panels, sidebar actions, commands, and live top-bar contributions.

This document is the developer guide for Plugin API v1. It covers what a plugin is, how it is packaged, how it communicates with the host, and what it can contribute to the UI.

## Design rule

RemoteHand core owns infrastructure. Plugins own functionality.

Core may understand plugin lifecycle, generic UI contributions, permissions, storage, IPC, and process supervision. Core must not contain protocol-specific or plugin-specific knowledge — no VNC, no RDP, no ICMP, no ping semantics, no threshold logic, no plugin-specific rendering rules.

If a plugin needs a new capability, the question is always:

1. Is this a missing generic capability that would reasonably benefit arbitrary plugins? If yes, extend the plugin API generically.
2. If no, the capability belongs in the plugin, not in core.

This rule is what makes plugins independently distributable and keeps RemoteHand core from accumulating per-plugin code over time.

## Trust model

Plugin API v1 uses a conservative trust model:

- Plugins are disabled by default after installation.
- Manifests are strictly validated. Unknown fields are rejected.
- Incompatible API versions are rejected at load time.
- Plugin packages are scanned for symlinks, path traversal, oversized files, and excessive file counts.
- Plugin removal requires the plugin to be disabled first.
- Sensitive capabilities (network, clipboard, credentials, vault unlock, plugin storage) require explicit permission declarations in the manifest.
- The host reports granted permissions back to the plugin at handshake, so plugins know what they were actually granted.

Declared permissions are not yet a complete OS-level security boundary for arbitrary native code. Plugins are native executables. Only install plugins you trust.

## Package layout

A plugin is distributed as a self-contained folder. RemoteHand installs it under its portable plugins/ directory.

~~~text
remotehand.example/
	├── plugin.json # required - manifest
	├── icon.svg # optional - referenced from manifest
	├── bin/
	│ ├── windows-x86_64/
	│ │ └── remotehand-example.exe
	│ ├── linux-x86_64/
	│ │ └── remotehand-example
	│ └── linux-aarch64/
	│ └── remotehand-example
	└── ui/
	 └── index.html # optional - panel HTML, hosted in a sandboxed iframe
~~~

The bin/<os>-<arch>/ keys match the values Rust reports for std::env::consts::OS and std::env::consts::ARCH. A package may contain entrypoints for multiple platforms. RemoteHand launches only the exact entrypoint that matches the current host - a Windows install never attempts to run the Linux binary.

Runtime and asset paths in the manifest must resolve inside the plugin package. Path traversal and symlinks are rejected at install time.

Installed layout on disk:

~~~text
RemoteHand/
	├── RemoteHand.exe
	├── plugins/
	│ └── remotehand.example/
	│ ├── plugin.json
	│ └── ...
	└── data/
	 ├── config/
	 │ └── plugins.json # enabled/disabled state
	 └── plugins/
	 └── remotehand.example/ # plugin-scoped storage (storage.plugin)
~~~

## Manifest

Every plugin has a plugin.json at the root of its package. The manifest is strict: unknown fields are rejected at load time and the plugin will not start.

Field names in the JSON file are camelCase. Plugin authors only ever write camelCase.

~~~json
{
 "id": "remotehand.example",
 "name": "Example Plugin",
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
 "storage.plugin"
 ],
 "contributes": {
 "sidebar": [],
 "panels": [
 {
 "id": "main",
 "title": "Example",
 "entry": "ui/index.html"
 }
 ],
 "commands": []
 }
}
~~~

### Field reference

#### id - string, required

Unique plugin identifier. Used as the plugin install directory name and as the namespace for plugin-scoped storage.

Convention: reverse-DNS style, lowercase, dots and hyphens only. Examples: remotehand.example, remotehand.host-monitor, com.yourname.pluginname.

The id must be stable across versions. Changing it makes RemoteHand treat the plugin as a different plugin.

#### name - string, required

Human-readable display name shown in the Plugin Manager. Example: Host Monitor.

#### version - string, required

The plugin own version, independent of the API version. Free-form but conventionally semver: 1.0.0, 0.4.1.

#### apiVersion - number, required

The Plugin API version this plugin targets. Currently 1.

The host rejects plugins whose apiVersion it does not support. Bumping this field is a breaking change; a plugin written for apiVersion 1 keeps working with apiVersion 1 for the lifetime of that version.

#### author - string, required

Author or organization name. Shown in the Plugin Manager.

#### description - string, optional

Short description shown in the Plugin Manager. Defaults to empty string.

#### runtime - object, required

Describes how to launch the plugin.

- runtime.kind - string, required. Currently only executable is supported.
- runtime.entrypoints - object, required. Maps os-arch keys to relative paths within the plugin package.

The keys match the values Rust std::env::consts::OS and std::env::consts::ARCH produce, joined with a hyphen:

| Key | Meaning |
|---|---|
| windows-x86_64 | Windows, 64-bit x86 |
| linux-x86_64 | Linux, 64-bit x86 |
| linux-aarch64 | Linux, 64-bit ARM |

At launch, the host picks the entrypoint matching the current host. If no entrypoint matches, the plugin cannot start on that platform - the host reports the mismatch rather than silently failing.

Paths are relative to the plugin package root. Absolute paths, traversal, and symlinks are rejected at install time.

#### permissions - array of string, optional

Declared capabilities. Each string must be one of the recognized permissions (see the Permissions section). Unknown permission strings are rejected - the manifest will not load.

Defaults to an empty array, meaning the plugin requests no sensitive capabilities.

#### contributes - object, optional

Declares static contributions: things the plugin adds to the RemoteHand UI at install or load time. Defaults to an empty object.

Three sub-fields:

- contributes.sidebar - array of contribution objects. Each adds a button to the workspace sidebar.
- contributes.panels - array of contribution objects. Each declares a dockable panel the plugin provides.
- contributes.commands - array of contribution objects. Each declares a named command.

Each contribution object has these fields:

| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string | yes | Unique within the plugin. |
| title | string | yes | Display text (button label, panel title, command label). |
| icon | string | no | Relative path to an SVG icon inside the package. |
| panel | string | no | For sidebar entries, the id of the panel this button opens. |
| entry | string | no | For panel entries, relative path to the panel HTML file. |

A sidebar contribution normally needs id, title, icon, and panel. A panel contribution needs id, title, and entry.

Note on top-bar contributions: these are not declared in contributes. Top-bar items are published at runtime by the running plugin, because they carry live data. See the Top-bar contributions section.

## Permissions

Permissions are the capabilities a plugin declares in its manifest. The host reports granted permissions back to the plugin during the handshake. A plugin should not assume a permission is active without checking grantedPermissions.

Recognized permissions:

| Permission | Grants |
|---|---|
| network.connect | Outbound network access. Declared for transparency - the host does not yet enforce this at the OS level. |
| clipboard.read | Read from the system clipboard. |
| clipboard.write | Write to the system clipboard. |
| credentials.use | Request a specific credential from the vault by opaque reference. |
| credentials.store | Store a secret in the vault under the plugin namespace. |
| vault.unlock | Request that the host unlock the vault with a passphrase. Sensitive. |
| storage.plugin | Read and write plugin-scoped persistent storage. |

Contribution declarations (panels, sidebar, commands) are not permissions. They are metadata. A plugin that only contributes UI does not need a permission for that.

These declarations are not yet a complete security boundary. Plugins are native executables with the OS permissions of the RemoteHand process. A plugin that declares no permissions can still open a network socket, read files, etc., through its own code. Permissions exist to make intent explicit and to gate host-mediated capabilities like vault access and plugin storage. They are not a sandbox.

Only install plugins you trust.

## Runtime and IPC

### Process model

Plugins run out of process. When a plugin is enabled, RemoteHand:

1. Locates the entrypoint matching the current host in the plugin package.
2. Launches it as a child process.
3. Establishes a versioned IPC session over the child stdin and stdout.
4. Validates the plugin identity and API compatibility against the manifest.
5. Supervises the process and tears down runtime resources when it exits or crashes.

The IPC channel is stdio. There is no network socket and no separate file. Stdin and stdout carry framed JSON messages. Stderr is inherited by the host process and passes through to the host stderr.

### Framing

Every message is a length-prefixed JSON frame:

- 4 bytes: payload length as a little-endian unsigned 32-bit integer.
- N bytes: the JSON payload (UTF-8), where N is the length above.

Limits:

- Minimum frame: 1 byte.
- Maximum frame: 16 MiB. Frames larger than this are rejected and the session is terminated.

### Handshake

Immediately after launch, the plugin sends a hello message:

~~~json
{
 "type": "plugin.hello",
 "pluginId": "remotehand.example",
 "apiVersion": 1,
 "pluginVersion": "1.0.0"
}
~~~

The host validates:

- pluginId matches the manifest that launched it.
- apiVersion is supported by the host.

On success the host replies with host.ready:

~~~json
{
 "type": "host.ready",
 "pluginId": "remotehand.example",
 "apiVersion": 1,
 "grantedPermissions": ["network.connect", "storage.plugin"]
}
~~~

grantedPermissions is authoritative. A plugin that declared a permission but did not receive it here must treat that capability as unavailable.

On failure, the host terminates the child. There is no soft reject - a plugin that cannot handshake does not run.

### Message types

After the handshake, four message types carry all runtime traffic. Each is a JSON object with a type field that names it.

host.request - host to plugin. The host asks the plugin to do something (open a panel, handle a command, receive a context update).

~~~json
{
 "type": "host.request",
 "requestId": 1,
 "method": "some.method",
 "params": {}
}
~~~

plugin.response - plugin to host. The plugin replies to a host.request.

~~~json
{
 "type": "plugin.response",
 "requestId": 1,
 "ok": true,
 "result": {},
 "error": ""
}
~~~

requestId echoes the id from the request. ok is false on failure and error carries a message.

plugin.request - plugin to host. The plugin calls a host service (credentials, storage, etc.).

~~~json
{
 "type": "plugin.request",
 "requestId": 1,
 "method": "storage.get",
 "params": { "key": "targets" }
}
~~~

host.response - host to plugin. The host replies to a plugin.request.

~~~json
{
 "type": "host.response",
 "requestId": 1,
 "ok": true,
 "result": {},
 "error": ""
}
~~~

plugin.event - plugin to host. A one-way notification with no reply. This is how a plugin pushes live data, like top-bar updates.

~~~json
{
 "type": "plugin.event",
 "event": "topbar.update",
 "payload": { "items": [] }
}
~~~

Events are fire-and-forget. The host does not reply.

### Request and response rules

- Request ids are per-session and must be unique while a request is in flight.
- The host and plugin can each have multiple requests outstanding at once.
- A response must carry the same requestId as its request.
- An ok:false response carries a human-readable error string. result is ignored in that case.
- requestId is a JSON number. The panel bridge converts to and from strings internally, but plugins see numbers.

## Host services

Plugins call host services using plugin.request. The host replies with host.response. Each service is gated by a permission - the host rejects calls whose permission was not granted.

### storage.get and storage.set

Requires: storage.plugin.

Plugin-scoped persistent storage. Each plugin gets its own namespace, isolated from other plugins and from RemoteHand core data. Storage is JSON - one file per key, in a directory named after the plugin id.

storage.get:

~~~json
{
 "type": "plugin.request",
 "requestId": 1,
 "method": "storage.get",
 "params": { "key": "targets" }
}
~~~

Reply:

~~~json
{
 "type": "host.response",
 "requestId": 1,
 "ok": true,
 "result": { "value": null },
 "error": ""
}
~~~

result.value is the parsed JSON stored under that key, or null if no value exists.

storage.set:

~~~json
{
 "type": "plugin.request",
 "requestId": 2,
 "method": "storage.set",
 "params": { "key": "targets", "value": [] }
}
~~~

Reply:

~~~json
{
 "type": "host.response",
 "requestId": 2,
 "ok": true,
 "result": null,
 "error": ""
}
~~~

Key rules:

- Keys must be 1 to 128 characters.
- Allowed characters: A-Z, a-z, 0-9, dot, dash, underscore.
- One JSON file per key, capped at 1 MiB.

### credentials.use

Requires: credentials.use.

Retrieve a specific credential by opaque reference. The plugin does not enumerate the vault - it must already know the reference (usually because it stored it itself, or because the user supplied it through the plugin own UI).

~~~json
{
 "type": "plugin.request",
 "requestId": 3,
 "method": "credentials.use",
 "params": { "credentialRef": "plugin:remotehand.example:profile-1:abc123" }
}
~~~

Reply:

~~~json
{
 "type": "host.response",
 "requestId": 3,
 "ok": true,
 "result": { "secret": "..." },
 "error": ""
}
~~~

On failure, ok is false and error explains why (vault locked, reference unknown, permission denied, and so on).

### credentials.store

Requires: credentials.store.

Store a secret in the vault under the plugin namespace.

~~~json
{
 "type": "plugin.request",
 "requestId": 4,
 "method": "credentials.store",
 "params": { "credentialRef": "plugin:remotehand.example:profile-1:abc123", "secret": "..." }
}
~~~

Reply:

~~~json
{
 "type": "host.response",
 "requestId": 4,
 "ok": true,
 "result": "plugin:remotehand.example:profile-1:abc123",
 "error": ""
}
~~~

Rules:

- The reference must begin with plugin: followed by your plugin id followed by a colon. This prevents a plugin from overwriting another plugin namespace or core RemoteHand credentials.
- The plugin should store only the opaque reference in its own state. It should not persist the secret itself.

### vault.unlock

Requires: vault.unlock.

Request that the host unlock the credential vault with a passphrase.

~~~json
{
 "type": "plugin.request",
 "requestId": 5,
 "method": "vault.unlock",
 "params": { "passphrase": "..." }
}
~~~

The passphrase is used transiently by the host to unlock the vault and is not persisted by this API.

This is a sensitive permission. The plugin process and UI can observe the passphrase before it reaches the host. Only grant vault.unlock to plugins you trust with your vault passphrase.

## UI contributions

A plugin can add three kinds of UI to RemoteHand:

- Panels - dockable workspace panels, hosted in a sandboxed iframe.
- Sidebar buttons - buttons in the workspace sidebar that open a panel.
- Commands - named actions invokable from RemoteHand UI.

Panels and sidebar buttons are declared in the manifest (contributes.panels, contributes.sidebar). Commands are declared in contributes.commands. All three are static - they must be known before the plugin runs.

Top-bar contributions are different: they are published at runtime by the running plugin and are covered in the next section.

### Panel hosting

A panel contribution points at an HTML file inside the plugin package:

~~~json
{
 "id": "main",
 "title": "Example",
 "entry": "ui/index.html"
}
~~~

RemoteHand loads that HTML into a sandboxed iframe with a strict security posture:

- The iframe has sandbox=allow-scripts - no same-origin access, no forms, no popups, no top-level navigation.
- A plugin-panel Content-Security-Policy meta tag is injected into the panel head before it loads.
- The desktop release build also preserves the inline-script policy needed by the current srcdoc hosting path. This is a host-side compatibility detail; it does not grant the panel same-origin access or direct network access.

The plugin-panel Content-Security-Policy is:

default-src none; script-src unsafe-inline; style-src unsafe-inline; img-src data: blob:; connect-src none; font-src data:; media-src data: blob:; object-src none; frame-src none; child-src none; form-action none; base-uri none;

In the actual document this is written as a single-line meta tag with quotes. connect-src none means the plugin UI cannot make network requests directly. All communication goes through the bridge described below.

### The panel bridge

RemoteHand injects a bridge script into every plugin panel. The bridge exposes a small API to the plugin UI:

~~~js
window.remotehand.request(method, params) // Promise - call a host service
window.remotehand.onEvent(name, listener) // subscribe to events from the plugin runtime
~~~

window.remotehand.request sends a plugin.request to the host via postMessage, waits for the reply, and resolves or rejects the promise.

window.remotehand.onEvent subscribes to events emitted by the plugin own runtime process. The bridge delivers these over remotehand.plugin.event messages.

### Panel lifecycle

1. RemoteHand loads the panel HTML and injects the bridge.
2. The bridge sends remotehand.plugin.ready to the host.
3. The host responds with the current appearance (theme, colors, fonts) and the panel context.
4. The panel can now call window.remotehand.request and receive events.

### Appearance

Plugin panels automatically receive RemoteHand appearance - theme, color scheme, UI font, and colors - without needing a permission. The bridge applies them to the panel document root as CSS custom properties and a data-remotehand-theme attribute, then fires a remotehand-appearance-change event.

Plugin CSS should consume the CSS custom properties with fallbacks, so the panel remains usable outside RemoteHand (for example, during development):

~~~css
body {
 background: var(--remotehand-background, #11151a);
 color: var(--remotehand-text, #dee5ef);
 font-family: var(--remotehand-ui-font-family, system-ui, sans-serif);
}
~~~

Available properties:

| Property | Meaning |
|---|---|
| --remotehand-background | Panel background |
| --remotehand-surface | Surface color |
| --remotehand-surface-raised | Raised surface color |
| --remotehand-border | Border color |
| --remotehand-text | Body text |
| --remotehand-muted-text | Secondary text |
| --remotehand-input-background | Input field background |
| --remotehand-button-background | Button background |
| --remotehand-button-hover | Button hover background |
| --remotehand-accent | Accent color |
| --remotehand-accent-border | Accent border |
| --remotehand-accent-surface | Accent surface |
| --remotehand-accent-surface-hover | Accent surface hover |
| --remotehand-danger-text | Danger text |
| --remotehand-danger-border | Danger border |
| --remotehand-danger-surface | Danger surface |
| --remotehand-success-text | Success text |
| --remotehand-success-surface | Success surface |

Plus:

- --remotehand-ui-font-family
- --remotehand-ui-font-size
- data-remotehand-theme - dark or light
- data-remotehand-scheme - the selected color scheme name

## Top-bar contributions

The RemoteHand app bar shows live per-plugin widgets - small buttons rendered from generic content that a running plugin publishes.

A top-bar contribution is not declared in the manifest. It is published at runtime via a plugin.event with event name topbar.update:

~~~json
{
 "type": "plugin.event",
 "event": "topbar.update",
 "payload": {
 "items": []
 }
}
~~~

Each call to topbar.update replaces that plugin entire set of top-bar items. To add or remove a button, publish the new full set.

### Item shape

Each item in the items array describes one button:

~~~json
{
 "id": "host-monitor:server-1",
 "title": "Server 1",
 "tooltip": "Server 1, 10.0.0.5",
 "size": { "width": 112, "height": 44 },
 "content": {},
 "action": {
 "type": "open-panel",
 "panel": "main",
 "context": { "targetId": "server-1", "target": "10.0.0.5" }
 }
}
~~~

| Field | Type | Required | Meaning |
|---|---|---|---|
| id | string | yes | Unique within the plugin. |
| title | string | yes | Used as the accessible label. |
| tooltip | string | no | Hover text. |
| size | object | no | Requested button size, clamped to bounds (see below). |
| content | object | no | Content tree - see Content primitives. |
| action | object | no | What happens when the user clicks. |

### Size clamping

Requested sizes are clamped by RemoteHand core:

- Width: 72 to 180 px. Default 112.
- Height: 36 to 64 px. Default 44.

Larger buttons get taller sparklines.

### Actions

Currently one action type is supported:

~~~json
{
 "type": "open-panel",
 "panel": "main",
 "context": { "targetId": "...", "target": "..." }
}
~~~

panel is the panel id to open. context is passed to the panel when it opens, so the panel knows which button the user clicked. This is how Host Monitor opens its panel focused on a specific target.

### Content primitives

content is a tree of generic primitives. RemoteHand renders them without knowing anything plugin-specific.

Every content node has:

- type - one of the primitives below.
- tone - optional semantic tone: success, warning, danger, muted, or omitted (defaults to accent).
- fontSize - optional, clamped to 8 to 18 px.

stack

A vertical container. children are rendered top-to-bottom, distributed across the button height.

- children - array of content nodes, max 6.

text

A single line of text with ellipsis truncation.

- label - string, up to 80 characters.
- value - fallback if label is absent.
- Default font size 11 px.

metric

A prominent value, typically the main reading.

- value - string or number, rendered as an em dash if null.
- Default font size 14 px.

status

A short state label.

- label - string.
- value - fallback.
- Default font size 12 px.

progress

A labelled progress bar.

- label - string.
- value - number 0 to 100 (clamped).
- Default font size 12 px.

sparkline

A bar-style mini chart.

- series - array of points, capped at the last 60.
- Each point: value (number or null) and an optional tone.
- Individual points can carry their own tone, overriding the node tone.

metric-sparkline

A composite primitive: a prominent value with an inline sparkline below it. Unlike stack, it is not a container - it renders directly from its own value and series fields. Functionally equivalent to a stack of metric and sparkline, but as a single node.

- value - string or number.
- series - array of points, capped at the last 60.

### Safety limits

The host enforces these when parsing a topbar.update:

| Limit | Value |
|---|---|
| Max nesting depth | 2 |
| Max children per stack | 6 |
| Max series points | 60 |
| Max label length | 80 characters |
| Font size range | 8 to 18 px |
| Requested width | 72 to 180 px |
| Requested height | 36 to 64 px |

Items that fail validation are silently dropped. A malformed content tree does not crash the app or break other plugins.

### Events

Beyond topbar.update, the plugin can emit any event name. RemoteHand dispatches events it recognizes and ignores the rest.

Currently recognized plugin events:

| Event | Handled by |
|---|---|
| topbar.update | Plugin Manager - updates the top-bar items for this plugin |
| monitor.alert | Host Monitor - plays an alert sound |

Event names are matched exactly. A plugin that emits an unrecognized event name is not an error - the event is silently ignored.

Events flow from the plugin runtime to the frontend over a single Tauri channel named remotehand-plugin-event. The panel bridge exposes those runtime events through window.remotehand.onEvent(name, listener). Core may forward event names that it does not interpret itself; UI behavior outside the documented core-handled events is the plugin's responsibility.

## Installation safety

Plugin installation enforces a set of protections before a plugin is allowed onto disk:

- Newly installed plugins are disabled by default. The user must enable them explicitly.
- Manifests are strictly parsed. Unknown fields, unknown permission strings, and incompatible apiVersion values are rejected.
- Path traversal is rejected. Runtime and asset paths must resolve inside the plugin package.
- Symlinks are rejected at install time.
- Overlapping source and destination trees are rejected (installing a plugin from inside its own destination is refused).
- Removal requires the plugin to be disabled first, and never follows symbolic links.

Package limits:

| Limit | Value |
|---|---|
| Maximum file count | 2,048 |
| Maximum package size | 64 MiB |
| Maximum scanned plugin entries | 512 |
| Maximum manifest size | 64 KiB |
| Maximum plugin-state file size | 1 MiB |

These protections are conservative. They exist to prevent accidental damage from malformed packages and to bound resource usage, not to be a full sandbox.

## Development workflow

### 1. Choose an id and structure

Pick a reverse-DNS-style id. It becomes the plugin install directory name and storage namespace. Create the package skeleton:

~~~text
remotehand.example/
 plugin.json
 bin/
 windows-x86_64/
 ui/
 index.html
~~~

### 2. Write the manifest

Start with the smallest valid plugin.json:

~~~json
{
 "id": "remotehand.example",
 "name": "Example",
 "version": "0.1.0",
 "apiVersion": 1,
 "author": "Your Name",
 "runtime": {
 "kind": "executable",
 "entrypoints": {
 "windows-x86_64": "bin/windows-x86_64/remotehand-example.exe"
 }
 }
}
~~~

permissions and contributes can be omitted entirely. Add them as you need them.

### 3. Write the runtime

The plugin runtime is a normal executable that speaks the protocol on stdin and stdout. In Rust, the shape is:

1. Read frames from stdin.
2. Parse each frame as JSON.
3. Send plugin.hello immediately.
4. Wait for host.ready.
5. Loop: read frames, dispatch on type, write responses.

The host is not patient. The handshake has a hard 5-second timeout. A plugin that does not complete the handshake within 5 seconds of launch is terminated.

For a first plugin, the runtime can do almost nothing - greet the host, then handle host.request and emit occasional events.

### 4. Write the panel UI (optional)

If the plugin contributes a panel, ui/index.html is the entry. It runs in a sandboxed iframe with the injected bridge. A minimal panel:

~~~html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Example</title></head>
<body>
 <h1>Example</h1>
 <p id="status">ready</p>
 <script>
 window.remotehand.onEvent("topbar.update", (payload) => {
 document.getElementById("status").textContent =
 "items: " + (payload.items || []).length;
 });
 </script>
</body>
</html>
~~~

The bridge is injected automatically. There is nothing to import.

### 5. Build the executable

For Rust:

~~~text
cargo build --release
~~~

Then copy the built binary into the entrypoint path declared in plugin.json.

### 6. Package and install

Assemble the package folder in the shape RemoteHand expects, then use RemoteHand Plugin Manager to install it. The install reads the folder, validates the manifest, copies it under plugins/, and marks the plugin disabled.

Enable the plugin. If everything is correct, the runtime launches and the handshake completes.

### 7. Iterate

During development, the fastest loop is:

1. Rebuild the executable.
2. Copy it into the plugin installed directory under plugins/.
3. Disable and re-enable the plugin in the Plugin Manager.

Reloading the panel HTML is enough to pick up UI changes; the runtime does not need to restart for that.

The plugin stderr is inherited by RemoteHand, so eprintln from the plugin appears in the host console. In dev mode (npm run tauri dev), that means your terminal.

## Reference plugin

The first complete reference plugin is RemoteHand Host Monitor, maintained separately at webbytenchi/remotehand-plugin-host-monitor.

It demonstrates nearly every part of the API v1 surface:

- A Rust runtime that speaks the full IPC protocol.
- plugin.hello and host.ready handshake.
- storage.plugin for persisting configured targets.
- network.connect for ICMP monitoring.
- A contributes.panels panel with sandboxed HTML and the bridge.
- Runtime topbar.update events publishing one button per monitored target.
- open-panel actions with context so clicking a button opens the panel on that target.
- monitor.alert events for state-change sounds.
- Bounded configuration and package sizing.

Reading that plugin source is the fastest way to see a full implementation.

## Roadmap and known limitations

Plugin API v1 is stable but growing. Current limitations to be aware of:

- Permissions are declared, not enforced at the OS level. A plugin is a native executable with the host privileges. The permission list is a declaration of intent, not a sandbox.
- The recognized event list used by core UI behavior is fixed. topbar.update updates top-bar contributions and monitor.alert drives the built-in alert-sound path. Other plugin events may still be delivered to an installed plugin panel through the panel bridge, but core does not attach generic UI behavior to them.
- Only open-panel actions are supported for top-bar contributions.
- Panel communication is limited to request and onEvent. There is no direct panel-to-runtime channel that bypasses the host.
- No signing or verification. Plugins are not signed. Only install plugins from sources you trust.
- Linux unprivileged ICMP availability depends on the host ICMP socket policy. Not a RemoteHand limitation, but relevant to plugins that use raw sockets.

Planned directions (subject to change):

- Additional UI contribution surfaces.
- Richer host services (port forwarding, session events).
- Plugin signing and verification.
- A formal plugin SDK with language bindings.

## License

RemoteHand is licensed under the MIT License. Plugins are independent works and may use any license compatible with their own distribution.

Third-party components retain their own licenses.

