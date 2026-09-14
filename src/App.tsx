import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
DockviewReact,
type DockviewApi,
type DockviewReadyEvent,
type IDockviewPanelProps,
themeDark,
themeLight,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { LocalTerminalPanel } from "./LocalTerminalPanel";
import { SftpPanel } from "./SftpPanel";
import { AppModal } from "./AppModal";
import appIcon from "../src-tauri/icons/icon.png";
import "./App.css";
type Connection = {
id: string;
name: string;
host: string;
port: number;
user: string;
credentialRef?: string;
};
type ThemeMode = "dark" | "light";
type Settings = { theme: ThemeMode };
type WorkspaceLayout = Parameters<DockviewApi["fromJSON"]>[0];
const WORKSPACE_KEY = "remotehand.workspace";
const THEME_KEY = "remotehand.theme";
const SIDEBAR_COLLAPSED_KEY = "remotehand.sidebarCollapsed";
const initialConnections: Connection[] = [];
type ConnectionsPanelParams = {
connections?: Connection[];
};
function WelcomePanel() {
return (
<section className="panel-content welcome-panel">
<h1>RemoteHand</h1>
<p>
Your portable remote workstation manager. Work with local terminals and remote systems
from one dockable workspace, with SSH, SFTP, saved credentials, and persistent layouts.
</p>
<div className="feature-list">
<div><strong>Local terminals</strong><span>Launch the shells available on the computer running RemoteHand.</span></div>
<div><strong>Remote connections</strong><span>Connect to remote systems over SSH and keep your hosts organized.</span></div>
<div><strong>SFTP and credentials</strong><span>Browse and transfer remote files while keeping saved secrets in the local vault.</span></div>
<div><strong>Flexible workspace</strong><span>Arrange tools into tabs, splits, floating windows, or popouts and restore your layout later.</span></div>
</div>
</section>
);
}
function ConnectionsPanel({
connections,
onAdd,
onUpdate,
onRemove,
onConnect,
onSftp,
}: {
connections: Connection[];
onAdd: (connection: Connection) => void;
onUpdate: (connection: Connection) => void;
onRemove: (connection: Connection) => void;
onConnect: (connection: Connection) => void;
onSftp: (connection: Connection) => void;
}) {
const [showForm, setShowForm] = useState(false);
const [editingId, setEditingId] = useState<string | null>(null);
const [name, setName] = useState("");
const [host, setHost] = useState("");
const [port, setPort] = useState("22");
const [user, setUser] = useState("");
const [password, setPassword] = useState("");
const [vaultPassphrase, setVaultPassphrase] = useState("");
const [saving, setSaving] = useState(false);
const [pendingRemove, setPendingRemove] = useState<Connection | null>(null);
const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
const resetForm = () => {
setEditingId(null);
setName("");
setHost("");
setPort("22");
setUser("");
setPassword("");
setVaultPassphrase("");
setShowForm(false);
};
const editConnection = (connection: Connection) => {
setEditingId(connection.id);
setName(connection.name);
setHost(connection.host);
setPort(String(connection.port));
setUser(connection.user);
setPassword("");
setVaultPassphrase("");
setShowForm(true);
};
const saveConnection = async () => {
const parsedPort = Number(port);
const trimmedName = name.trim();
const trimmedHost = host.trim();
const trimmedUser = user.trim();
if (!trimmedName || !trimmedHost || !trimmedUser || saving) return;
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
if (connections.some((connection) => connection.name.toLowerCase() === trimmedName.toLowerCase() && connection.id !== editingId)) {
setNotice({
title: "Connection name already exists",
message: "Choose a different name for this saved connection.",
});
return;
}
const existing = editingId ? connections.find((connection) => connection.id === editingId) : undefined;
const id = editingId ?? "connection-" + Date.now();
let credentialRef = existing?.credentialRef;
setSaving(true);
try {
if (password) {
if (!isTauri()) {
throw new Error("Password storage is available in the RemoteHand desktop app.");
}
const status = await invoke<{ exists: boolean; unlocked: boolean }>("vault_status");
if (!status.unlocked) {
if (!vaultPassphrase) {
throw new Error(status.exists
? "Vault passphrase is required to unlock the credential vault."
: "Vault passphrase is required to create the credential vault.");
}
if (status.exists) {
await invoke("vault_unlock", { passphrase: vaultPassphrase });
} else {
await invoke("vault_initialize", { passphrase: vaultPassphrase });
}
}
credentialRef = credentialRef ?? "connection:" + id;
await invoke("vault_store_secret", { credentialRef, secret: password });
}
const next: Connection = {
id,
name: trimmedName,
host: trimmedHost,
port: parsedPort,
user: trimmedUser,
...(credentialRef ? { credentialRef } : {}),
};
if (editingId) {
onUpdate(next);
} else {
onAdd(next);
}
resetForm();
} catch (reason) {
setNotice({
title: "Could not save credential",
message: String(reason),
});
} finally {
setSaving(false);
}
};
const removeConnection = (connection: Connection) => {
setPendingRemove(connection);
};
const confirmRemoveConnection = () => {
if (!pendingRemove) return;
onRemove(pendingRemove);
if (editingId === pendingRemove.id) resetForm();
setPendingRemove(null);
};
return (
<section className="panel-content connections-panel">
<div className="panel-heading">
<div>
<h2>SSH Connections</h2>
</div>
<button
type="button"
className="primary-button"
onClick={() => {
if (showForm) {
resetForm();
} else {
setShowForm(true);
}
}}
>
{showForm ? "Cancel" : "+ New connection"}
</button>
</div>
{showForm ? (
<div className="connection-form">
<label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My server" /></label>
<label><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="server.example.com" /></label>
<label><span>Port</span><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder="22" /></label>
<label><span>User</span><input value={user} onChange={(event) => setUser(event.target.value)} placeholder="username" /></label>
<label><span>Password (optional)</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editingId ? "Leave blank to keep current password" : "Saved securely in the credential vault"} autoComplete="new-password" /></label>
{password ? <label><span>Vault passphrase</span><input type="password" value={vaultPassphrase} onChange={(event) => setVaultPassphrase(event.target.value)} placeholder="Required if the vault is locked or new" autoComplete="current-password" /></label> : null}
<button type="button" className="primary-button" onClick={() => void saveConnection()} disabled={saving}>
{saving ? "Saving…" : editingId ? "Save changes" : "Save connection"}
</button>
</div>
) : null}
<div className="connection-list">
{connections.length === 0 ? (
<div className="connection-empty">
<strong>No SSH connections yet</strong>
<span>Add a host above, then connect to open it in a terminal panel.</span>
</div>
) : null}
{connections.map((connection) => (
<article className="connection-card" key={connection.id}>
<div className="connection-icon">●</div>
<div>
<strong>{connection.name}</strong>
<span>{connection.user}@{connection.host}:{connection.port}</span>
</div>
<div className="connection-actions">
<button type="button" className="connection-connect" onClick={() => onConnect(connection)}>Connect</button>
<button type="button" className="connection-sftp" onClick={() => onSftp(connection)}>SFTP</button>
<details className="connection-menu">
<summary aria-label={`Manage ${connection.name}`}>⋯</summary>
<div className="connection-menu-popover">
<button type="button" onClick={() => editConnection(connection)}>Edit</button>
<button type="button" className="danger" onClick={() => removeConnection(connection)}>Remove</button>
</div>
</details>
</div>
</article>
))}
</div>
<AppModal
open={pendingRemove !== null}
title="Remove connection?"
confirmLabel="Remove"
cancelLabel="Cancel"
danger
onConfirm={confirmRemoveConnection}
onCancel={() => setPendingRemove(null)}
>
<p>
This will remove <strong>{pendingRemove?.name}</strong> from your saved SSH connections.
</p>
<p className="app-modal-muted">You can add it again later if needed.</p>
</AppModal>
<AppModal
open={notice !== null}
title={notice?.title ?? ""}
confirmLabel="OK"
onConfirm={() => setNotice(null)}
onCancel={() => setNotice(null)}
>
<p>{notice?.message}</p>
</AppModal>
</section>
);
}
function App() {
const [connections, setConnections] = useState(initialConnections);
const [connectionsLoaded, setConnectionsLoaded] = useState(() => !isTauri());
const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
!isTauri() && localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark",
);
const [settingsLoaded, setSettingsLoaded] = useState(() => !isTauri());
const settingsPersistenceEnabledRef = useRef(true);
const [paletteOpen, setPaletteOpen] = useState(false);
const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
const [paletteQuery, setPaletteQuery] = useState("");
const [workspaceReady, setWorkspaceReady] = useState(false);
const [localOs, setLocalOs] = useState(() => (isTauri() ? "" : "linux"));
const apiRef = useRef<DockviewApi | null>(null);
const restoredRef = useRef(false);
const layoutHistoryRef = useRef<string[]>([]);
const layoutHistoryIndexRef = useRef(-1);
const applyingHistoryRef = useRef(false);
const workspaceSaveTimerRef = useRef<number | null>(null);
const workspacePersistenceEnabledRef = useRef(true);
useEffect(() => {
if (!isTauri()) return;
void invoke<string>("local_os")
.then(setLocalOs)
.catch((error) => console.error("Failed to detect local OS", error));
}, []);
const persistWorkspaceSnapshot = useCallback((snapshot: string, immediate = false) => {
const save = () => {
if (!workspacePersistenceEnabledRef.current) return;
if (isTauri()) {
void invoke("save_workspace", { workspace: JSON.parse(snapshot) as WorkspaceLayout })
.catch((error) => console.error("Failed to save workspace", error));
} else {
localStorage.setItem(WORKSPACE_KEY, snapshot);
}
};
if (immediate) {
if (workspaceSaveTimerRef.current !== null) {
window.clearTimeout(workspaceSaveTimerRef.current);
workspaceSaveTimerRef.current = null;
}
save();
return;
}
if (workspaceSaveTimerRef.current !== null) {
window.clearTimeout(workspaceSaveTimerRef.current);
}
workspaceSaveTimerRef.current = window.setTimeout(() => {
workspaceSaveTimerRef.current = null;
save();
}, 150);
}, []);

const captureLayout = useCallback((api: DockviewApi) => {
const snapshot = JSON.stringify(api.toJSON());
if (applyingHistoryRef.current) return;
const history = layoutHistoryRef.current;
const index = layoutHistoryIndexRef.current;
if (index >= 0 && history[index] === snapshot) return;
const next = history.slice(0, index + 1);
next.push(snapshot);
if (next.length > 50) next.shift();
layoutHistoryRef.current = next;
layoutHistoryIndexRef.current = next.length - 1;
persistWorkspaceSnapshot(snapshot);
}, [persistWorkspaceSnapshot]);

const applyHistorySnapshot = useCallback((snapshot: string, index: number) => {
const api = apiRef.current;
if (!api) return;
applyingHistoryRef.current = true;
try {
api.fromJSON(JSON.parse(snapshot) as WorkspaceLayout);
layoutHistoryIndexRef.current = index;
persistWorkspaceSnapshot(snapshot, true);
} finally {
queueMicrotask(() => {
applyingHistoryRef.current = false;
});
}
}, [persistWorkspaceSnapshot]);

const undoLayout = useCallback(() => {
const index = layoutHistoryIndexRef.current;
if (index <= 0) return;
const nextIndex = index - 1;
applyHistorySnapshot(layoutHistoryRef.current[nextIndex], nextIndex);
}, [applyHistorySnapshot]);

const redoLayout = useCallback(() => {
const index = layoutHistoryIndexRef.current;
const history = layoutHistoryRef.current;
if (index < 0 || index >= history.length - 1) return;
const nextIndex = index + 1;
applyHistorySnapshot(history[nextIndex], nextIndex);
}, [applyHistorySnapshot]);

const addConnection = useCallback((connection: Connection) => {
setConnections((current) => [...current, connection]);
}, []);
const updateConnection = useCallback((connection: Connection) => {
setConnections((current) => current.map((item) => item.id === connection.id ? connection : item));
}, []);
const removeConnection = useCallback((connection: Connection) => {
setConnections((current) => current.filter((item) => item.id !== connection.id));
}, []);
const connectSsh = useCallback((connection: Connection) => {
const api = apiRef.current;
if (!api) return;
api.addPanel({
id: "ssh-" + connection.id + "-" + Date.now(),
component: "terminal",
title: connection.name,
params: {
ssh: {
host: connection.host,
port: connection.port,
user: connection.user,
name: connection.name,
},
},
});
}, []);
const openSftp = useCallback((connection: Connection) => {
const api = apiRef.current;
if (!api) return;
api.addPanel({
id: "sftp-" + connection.id + "-" + Date.now(),
component: "sftp",
title: connection.name + " Files",
params: {
connection: {
host: connection.host,
port: connection.port,
user: connection.user,
name: connection.name,
credentialRef: connection.credentialRef,
},
},
});
}, []);
const components = useMemo(
() => ({
welcome: WelcomePanel,
terminal: LocalTerminalPanel,
sftp: SftpPanel,
connections: (props: IDockviewPanelProps<ConnectionsPanelParams>) => (
<ConnectionsPanel
connections={props.params?.connections ?? []}
onAdd={addConnection}
onUpdate={updateConnection}
onRemove={removeConnection}
onConnect={connectSsh}
onSftp={openSftp}
/>
),
}),
[addConnection, updateConnection, removeConnection, connectSsh, openSftp],
);
const addTerminal = useCallback((position?: "right" | "below", shell: "default" | "powershell" | "cmd" | "wsl" = "default") => {
const api = apiRef.current;
if (!api) return;
const id = `terminal-${Date.now()}`;
const activePanel = api.activePanel;
api.addPanel({
id,
component: "terminal",
title: shell === "default" ? "Terminal" : shell === "powershell" ? "PowerShell" : shell === "cmd" ? "Command Prompt" : "WSL",
params: { shell },
...(position && activePanel
? { position: { referencePanel: activePanel.id, direction: position } }
: {}),
});
}, []);
const addConnections = useCallback(() => {
apiRef.current?.addPanel({
id: `connections-${Date.now()}`,
component: "connections",
title: "Connections",
params: { connections },
});
}, [connections]);
const popoutActive = useCallback(async () => {
const api = apiRef.current;
const panel = api?.activePanel;
if (!api || !panel) return;
await api.addPopoutGroup(panel, { popoutUrl: "popout.html" });
}, []);
const resetLayout = useCallback(async () => {
const api = apiRef.current;
if (!api) return;
if (isTauri()) {
try {
await invoke("clear_workspace");
workspacePersistenceEnabledRef.current = true;
} catch (error) {
console.error("Failed to clear workspace", error);
return;
}
} else {
localStorage.removeItem(WORKSPACE_KEY);
}
api.clear();
api.addPanel({ id: "welcome", component: "welcome", title: "Welcome" });
api.addPanel({
id: "terminal",
component: "terminal",
title: "Terminal",
position: { referencePanel: "welcome", direction: "below" },
});
api.addPanel({
id: "connections",
component: "connections",
title: "Connections",
params: { connections },
position: { referencePanel: "welcome", direction: "right" },
});
}, [connections]);
useEffect(() => {
if (!isTauri()) return;
void invoke<Connection[]>("load_connections")
.then((saved) => setConnections(saved))
.then(() => setConnectionsLoaded(true))
.catch((error) => console.error("Failed to load connections", error))
}, []);
useEffect(() => {
if (!connectionsLoaded || !isTauri()) return;
void invoke("save_connections", { connections }).catch((error) =>
console.error("Failed to save connections", error),
);
}, [connections, connectionsLoaded]);
useEffect(() => {
if (!isTauri()) {
localStorage.setItem(THEME_KEY, themeMode);
setSettingsLoaded(true);
return;
}
void invoke<Settings>("load_settings")
.then((settings) => {
if (settings.theme === "dark" || settings.theme === "light") {
setThemeMode(settings.theme);
}
setSettingsLoaded(true);
})
.catch((error) => {
settingsPersistenceEnabledRef.current = false;
console.error("Failed to load settings", error);
});
}, []);
useEffect(() => {
document.documentElement.dataset.theme = themeMode;
if (!settingsLoaded || !isTauri() || !settingsPersistenceEnabledRef.current) return;
void invoke("save_settings", { settings: { theme: themeMode } satisfies Settings }).catch((error) =>
console.error("Failed to save settings", error),
);
}, [themeMode, settingsLoaded]);
useEffect(() => {
localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
}, [sidebarCollapsed]);
useEffect(() => {
const api = apiRef.current;
if (!api) return;
for (const panel of api.panels) {
if (panel.api.component !== "connections") continue;
panel.api.updateParameters({ connections });
}
}, [connections]);
useEffect(() => {
const onKeyDown = (event: KeyboardEvent) => {
if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
event.preventDefault();
setPaletteOpen((open) => !open);
}
if (event.key === "Escape") setPaletteOpen(false);
if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
event.preventDefault();
if (event.shiftKey) redoLayout();
else undoLayout();
}
if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
event.preventDefault();
redoLayout();
}
};
window.addEventListener("keydown", onKeyDown);
return () => window.removeEventListener("keydown", onKeyDown);
}, [redoLayout, undoLayout]);
const handleReady = async (event: DockviewReadyEvent) => {
apiRef.current = event.api;
if (isTauri()) {
try {
const saved = await invoke<WorkspaceLayout | null>("load_workspace");
if (saved) {
event.api.fromJSON(saved);
restoredRef.current = true;
}
} catch (error) {
workspacePersistenceEnabledRef.current = false;
console.error("Failed to load workspace", error);
}
} else {
const saved = localStorage.getItem(WORKSPACE_KEY);
if (saved) {
try {
event.api.fromJSON(JSON.parse(saved) as WorkspaceLayout);
restoredRef.current = true;
} catch {
localStorage.removeItem(WORKSPACE_KEY);
}
}
}
if (!restoredRef.current) {
event.api.addPanel({ id: "welcome", component: "welcome", title: "Welcome" });
event.api.addPanel({
id: "terminal",
component: "terminal",
title: "Terminal",
position: { referencePanel: "welcome", direction: "below" },
});
event.api.addPanel({
id: "connections",
component: "connections",
title: "Connections",
position: { referencePanel: "welcome", direction: "right" },
});
}
for (const panel of event.api.panels) {
if (panel.api.component !== "connections") continue;
panel.api.updateParameters({ connections });
}
captureLayout(event.api);
event.api.onDidMutateLayout(() => {
captureLayout(event.api);
});
event.api.onDidLayoutChange(() => {
captureLayout(event.api);
});
event.api.onDidRemovePanel((panel) => {
if (panel.api.component !== "terminal") return;
const sessionId = panel.id;
window.setTimeout(() => {
if (event.api.panels.some((current) => current.id === sessionId)) return;
if (!isTauri()) return;
void invoke("terminal_close", { sessionId }).catch(() => undefined);
}, 0);
});
setWorkspaceReady(true);
};
const commands = [
...(localOs === "windows"
? [
{ label: "New PowerShell", hint: "Local", run: () => addTerminal(undefined, "powershell") },
{ label: "New Command Prompt", hint: "Local", run: () => addTerminal(undefined, "cmd") },
{ label: "New WSL terminal", hint: "Local", run: () => addTerminal(undefined, "wsl") },
]
: [
{ label: "New terminal", hint: "Local", run: () => addTerminal() },
]),
{ label: "Split terminal right", hint: "Split", run: () => addTerminal("right") },
{ label: "Split terminal below", hint: "Split", run: () => addTerminal("below") },
{ label: "Open connections", hint: "Panel", run: addConnections },
{ label: "Pop out active panel", hint: "Window", run: popoutActive },
{ label: "Undo layout change", hint: "Ctrl/Cmd+Z", run: undoLayout },
{ label: "Redo layout change", hint: "Ctrl/Cmd+Y", run: redoLayout },
{
label: themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme",
hint: "Theme",
run: () => setThemeMode((value) => (value === "dark" ? "light" : "dark")),
},
{ label: "Reset workspace layout", hint: "Reset", run: resetLayout },
];
const filteredCommands = commands.filter((command) =>
command.label.toLowerCase().includes(paletteQuery.toLowerCase()),
);
return (
<main className="app-shell">
<header className="topbar">
<div className="brand">
<img className="brand-mark" src={appIcon} alt="RemoteHand" />
<div>
<strong>RemoteHand</strong>
<span>v{APP_VERSION} · {BUILD_REVISION}</span>
</div>
</div>
<div className="topbar-actions">
<button
className="topbar-button icon-button"
type="button"
onClick={() => setThemeMode((value) => (value === "dark" ? "light" : "dark"))}
title="Toggle theme"
>
{themeMode === "dark" ? "☀" : "☾"}
</button>
</div>
</header>
<section className={"workspace" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
<aside className="sidebar" aria-label="Workspace tools">
<div className="sidebar-title-row">
<div className="sidebar-heading">Workspace</div>
<button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
<span className="sidebar-toggle-icon" aria-hidden="true">
<svg viewBox="0 0 20 20" focusable="false">
<rect x="2.5" y="3" width="15" height="14" rx="2" />
<path d="M7 3v14" />
<path d={sidebarCollapsed ? "M11 7l3 3-3 3" : "M14 7l-3 3 3 3"} />
</svg>
</span>
</button>
</div>
{localOs === "windows" ? (
<>
<button className="sidebar-action" type="button" onClick={() => addTerminal(undefined, "powershell")} title="PowerShell">
<span className="sidebar-icon" aria-hidden="true">
<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
<path d="M6 7l3 3-3 3" />
<path d="M11 13h3" />
</svg>
</span><span className="sidebar-label">PowerShell</span>
</button>
<button className="sidebar-action" type="button" onClick={() => addTerminal(undefined, "cmd")} title="Command Prompt">
<span className="sidebar-icon" aria-hidden="true">
<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
<path d="M6 8l2.5 2L6 12" />
<path d="M10.5 12h3.5" />
</svg>
</span><span className="sidebar-label">Command Prompt</span>
</button>
</>
) : (
<button className="sidebar-action" type="button" onClick={() => addTerminal()} title="Terminal">
<span className="sidebar-icon">⌘</span><span className="sidebar-label">Terminal</span>
</button>
)}
<button className="sidebar-action" type="button" onClick={addConnections} title="Connections">
<span className="sidebar-icon">◈</span><span className="sidebar-label">Connections</span>
</button>
<button className="sidebar-action" type="button" onClick={() => addTerminal("right")} title="Split right">
<span className="sidebar-icon">⇥</span><span className="sidebar-label">Split right</span>
</button>
<button className="sidebar-action" type="button" onClick={() => addTerminal("below")} title="Split below">
<span className="sidebar-icon">⇣</span><span className="sidebar-label">Split below</span>
</button>
<button className="sidebar-action" type="button" onClick={popoutActive} title="Pop out active">
<span className="sidebar-icon">↗</span><span className="sidebar-label">Pop out active</span>
</button>

<div className="sidebar-divider" />
<div className="sidebar-heading">Layout</div>
<button className="sidebar-action" type="button" onClick={undoLayout} title="Undo layout change">
<span className="sidebar-icon">↶</span><span className="sidebar-label">Undo</span>
</button>
<button className="sidebar-action" type="button" onClick={redoLayout} title="Redo layout change">
<span className="sidebar-icon">↷</span><span className="sidebar-label">Redo</span>
</button>
<button className="sidebar-action" type="button" onClick={resetLayout} title="Reset layout">
<span className="sidebar-icon">⟳</span><span className="sidebar-label">Reset layout</span>
</button>
</aside>

<section className="canvas">
<div className="dockview-host">
<DockviewReact
className="remotehand-dockview"
theme={themeMode === "dark" ? themeDark : themeLight}
components={components}
onReady={handleReady}
keyboardNavigation
dndStrategy="pointer"
popoutUrl="popout.html"
/>
</div>
{!workspaceReady && <div className="workspace-loading">Preparing workspace…</div>}
</section>
</section>

{paletteOpen && (
<div className="palette-backdrop" role="presentation" onMouseDown={() => setPaletteOpen(false)}>
<div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
<input
autoFocus
value={paletteQuery}
onChange={(event) => setPaletteQuery(event.target.value)}
placeholder="Type a command…"
aria-label="Filter commands"
/>
<div className="command-list">
{filteredCommands.length ? filteredCommands.map((command) => (
<button
key={command.label}
type="button"
onClick={() => {
command.run();
setPaletteOpen(false);
setPaletteQuery("");
}}
>
<span>{command.label}</span><small>{command.hint}</small>
</button>
)) : <div className="empty-command">No matching command</div>}
</div>
</div>
</div>
)}
</main>
);
}
export default App;
