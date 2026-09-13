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
import "./App.css";
type Connection = {
id: string;
name: string;
host: string;
port: number;
user: string;
};
type ThemeMode = "dark" | "light";
type WorkspaceLayout = Parameters<DockviewApi["fromJSON"]>[0];
const WORKSPACE_KEY = "remotehand.workspace";
const THEME_KEY = "remotehand.theme";
const initialConnections: Connection[] = [];
type ConnectionsPanelParams = {
connections?: Connection[];
};
function WelcomePanel() {
return (
<section className="panel-content welcome-panel">
<p className="eyebrow">Milestone 1</p>
<h1>Workspace Shell</h1>
<p>
RemoteHand now has a dockable workspace with tabs, splits, popouts,
keyboard navigation, layout history, and local persistence.
</p>
<div className="feature-list">
<div><strong>Dockable panels</strong><span>Arrange tools into tabs, splits, floating windows, or popouts.</span></div>
<div><strong>Persistent layout</strong><span>Your workspace arrangement and theme restore locally.</span></div>
<div><strong>Keyboard friendly</strong><span>Use Dockview navigation plus Ctrl/Cmd+K for the command palette.</span></div>
</div>
</section>
);
}
type AppModalProps = {
open: boolean;
title: string;
children: React.ReactNode;
confirmLabel?: string;
cancelLabel?: string;
danger?: boolean;
onConfirm: () => void;
onCancel: () => void;
};
function AppModal({
open,
title,
children,
confirmLabel = "OK",
cancelLabel,
danger = false,
onConfirm,
onCancel,
}: AppModalProps) {
useEffect(() => {
if (!open) return;
const handleKeyDown = (event: KeyboardEvent) => {
if (event.key === "Escape") onCancel();
};
window.addEventListener("keydown", handleKeyDown);
return () => window.removeEventListener("keydown", handleKeyDown);
}, [open, onCancel]);
if (!open) return null;
return (
<div className="app-modal-backdrop" onMouseDown={onCancel}>
<div
className="app-modal"
role="dialog"
aria-modal="true"
aria-labelledby="app-modal-title"
onMouseDown={(event) => event.stopPropagation()}
>
<div className="app-modal-header">
<p className="eyebrow">RemoteHand</p>
<h3 id="app-modal-title">{title}</h3>
</div>
<div className="app-modal-body">{children}</div>
<div className="app-modal-actions">
{cancelLabel ? (
<button type="button" className="modal-button" onClick={onCancel} autoFocus>
{cancelLabel}
</button>
) : null}
<button
type="button"
className={danger ? "modal-button danger" : "modal-button primary"}
onClick={onConfirm}
autoFocus={!cancelLabel}
>
{confirmLabel}
</button>
</div>
</div>
</div>
);
}
function ConnectionsPanel({
connections,
onAdd,
onUpdate,
onRemove,
onConnect,
}: {
connections: Connection[];
onAdd: (connection: Omit<Connection, "id">) => void;
onUpdate: (connection: Connection) => void;
onRemove: (connection: Connection) => void;
onConnect: (connection: Connection) => void;
}) {
const [showForm, setShowForm] = useState(false);
const [editingId, setEditingId] = useState<string | null>(null);
const [name, setName] = useState("");
const [host, setHost] = useState("");
const [port, setPort] = useState("22");
const [user, setUser] = useState("");
const [pendingRemove, setPendingRemove] = useState<Connection | null>(null);
const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
const resetForm = () => {
setEditingId(null);
setName("");
setHost("");
setPort("22");
setUser("");
setShowForm(false);
};
const editConnection = (connection: Connection) => {
setEditingId(connection.id);
setName(connection.name);
setHost(connection.host);
setPort(String(connection.port));
setUser(connection.user);
setShowForm(true);
};
const saveConnection = () => {
const parsedPort = Number(port);
const trimmedName = name.trim();
const trimmedHost = host.trim();
const trimmedUser = user.trim();
if (!trimmedName || !trimmedHost || !trimmedUser) return;
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
if (connections.some((connection) => connection.name.toLowerCase() === trimmedName.toLowerCase() && connection.id !== editingId)) {
setNotice({
title: "Connection name already exists",
message: "Choose a different name for this saved connection.",
});
return;
}
const next = {
name: trimmedName,
host: trimmedHost,
port: parsedPort,
user: trimmedUser,
};
if (editingId) {
onUpdate({ ...next, id: editingId });
} else {
onAdd(next);
}
resetForm();
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
<p className="eyebrow">Milestone 4</p>
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
<button type="button" className="primary-button" onClick={saveConnection}>
{editingId ? "Save changes" : "Save connection"}
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
localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark",
);
const [paletteOpen, setPaletteOpen] = useState(false);
const [paletteQuery, setPaletteQuery] = useState("");
const [workspaceReady, setWorkspaceReady] = useState(false);
const apiRef = useRef<DockviewApi | null>(null);
const restoredRef = useRef(false);
const layoutHistoryRef = useRef<string[]>([]);
const layoutHistoryIndexRef = useRef(-1);
const applyingHistoryRef = useRef(false);
const workspaceSaveTimerRef = useRef<number | null>(null);
const workspacePersistenceEnabledRef = useRef(true);
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

const addConnection = useCallback((connection: Omit<Connection, "id">) => {
setConnections((current) => [
...current,
{ ...connection, id: "connection-" + Date.now() },
]);
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
const components = useMemo(
() => ({
welcome: WelcomePanel,
terminal: LocalTerminalPanel,
connections: (props: IDockviewPanelProps<ConnectionsPanelParams>) => (
<ConnectionsPanel
connections={props.params?.connections ?? []}
onAdd={addConnection}
onUpdate={updateConnection}
onRemove={removeConnection}
onConnect={connectSsh}
/>
),
}),
[addConnection, updateConnection, removeConnection, connectSsh],
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
});
}, []);
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
position: { referencePanel: "welcome", direction: "right" },
});
}, []);
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
localStorage.setItem(THEME_KEY, themeMode);
document.documentElement.dataset.theme = themeMode;
}, [themeMode]);
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
{ label: "New terminal", hint: "Open tab", run: () => addTerminal() },
{ label: "New PowerShell", hint: "Local", run: () => addTerminal(undefined, "powershell") },
{ label: "New Command Prompt", hint: "Local", run: () => addTerminal(undefined, "cmd") },
{ label: "New WSL terminal", hint: "Local", run: () => addTerminal(undefined, "wsl") },
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
<span className="brand-mark">RH</span>
<div>
<strong>RemoteHand</strong>
<span>Portable workstation manager</span>
</div>
</div>
<div className="topbar-actions">
<button
className="topbar-button"
type="button"
onClick={() => setPaletteOpen(true)}
title="Command palette (Ctrl/Cmd+K)"
>
Command Palette
</button>
<button
className="topbar-button icon-button"
type="button"
onClick={() => setThemeMode((value) => (value === "dark" ? "light" : "dark"))}
title="Toggle theme"
>
{themeMode === "dark" ? "☀" : "☾"}
</button>
<span className="phase-badge">Milestone 3</span>
</div>
</header>
<section className="workspace">
<aside className="sidebar">
<div className="sidebar-heading">Workspace</div>
<button className="sidebar-action" type="button" onClick={() => addTerminal()}>
<span>⌘</span>Terminal
</button>
<button className="sidebar-action" type="button" onClick={addConnections}>
<span>◈</span>Connections
</button>
<button className="sidebar-action" type="button" onClick={() => addTerminal("right")}>
<span>⇥</span>Split right
</button>
<button className="sidebar-action" type="button" onClick={() => addTerminal("below")}>
<span>⇣</span>Split below
</button>
<button className="sidebar-action" type="button" onClick={popoutActive}>
<span>↗</span>Pop out active
</button>

<div className="sidebar-divider" />
<div className="sidebar-heading">Layout</div>
<div className="sidebar-row">
<button className="mini-action" type="button" onClick={undoLayout}>Undo</button>
<button className="mini-action" type="button" onClick={redoLayout}>Redo</button>
</div>
<button className="new-connection" type="button" onClick={resetLayout}>Reset layout</button>

<div className="sidebar-divider" />
<div className="sidebar-heading">Connections</div>
{connections.map((connection) => (
<div className="sidebar-connection" key={connection.id}>
<span className="status-dot" />
<div>
<strong>{connection.name}</strong>
<small>{connection.host}</small>
</div>
</div>
))}
<button className="new-connection" type="button" onClick={addConnections}>+ New SSH connection</button>
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
