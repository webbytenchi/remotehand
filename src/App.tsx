import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
DockviewReact,
type DockviewApi,
type DockviewReadyEvent,
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
user: string;
};
type ThemeMode = "dark" | "light";
const WORKSPACE_KEY = "remotehand.workspace";
const THEME_KEY = "remotehand.theme";
const initialConnections: Connection[] = [
{ id: "local", name: "Local machine", host: "localhost", user: "local" },
];
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
function ConnectionsPanel({
connections,
onAdd,
}: {
connections: Connection[];
onAdd: () => void;
}) {
return (
<section className="panel-content connections-panel">
<div className="panel-heading">
<div>
<p className="eyebrow">Workspace</p>
<h2>Connections</h2>
</div>
<button type="button" className="primary-button" onClick={onAdd}>+ New connection</button>
</div>
<div className="connection-list">
{connections.map((connection) => (
<article className="connection-card" key={connection.id}>
<div className="connection-icon">●</div>
<div>
<strong>{connection.name}</strong>
<span>{connection.user}@{connection.host}</span>
</div>
<span className="connection-status">Ready</span>
</article>
))}
</div>
</section>
);
}
function App() {
const [connections, setConnections] = useState(initialConnections);
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
localStorage.setItem(WORKSPACE_KEY, snapshot);
}, []);

const applyHistorySnapshot = useCallback((snapshot: string, index: number) => {
const api = apiRef.current;
if (!api) return;
applyingHistoryRef.current = true;
try {
api.fromJSON(JSON.parse(snapshot));
layoutHistoryIndexRef.current = index;
localStorage.setItem(WORKSPACE_KEY, snapshot);
} finally {
queueMicrotask(() => {
applyingHistoryRef.current = false;
});
}
}, []);

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

const addConnection = useCallback(() => {
setConnections((current) => [
...current,
{
id: `connection-${Date.now()}`,
name: `New connection ${current.length}`,
host: "example.local",
user: "user",
},
]);
}, []);
const components = useMemo(
() => ({
welcome: WelcomePanel,
terminal: LocalTerminalPanel,
connections: () => (
<ConnectionsPanel connections={connections} onAdd={addConnection} />
),
}),
[connections, addConnection],
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
const resetLayout = useCallback(() => {
const api = apiRef.current;
if (!api) return;
localStorage.removeItem(WORKSPACE_KEY);
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
localStorage.setItem(THEME_KEY, themeMode);
document.documentElement.dataset.theme = themeMode;
}, [themeMode]);
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
const handleReady = (event: DockviewReadyEvent) => {
apiRef.current = event.api;
const saved = localStorage.getItem(WORKSPACE_KEY);
if (saved) {
try {
event.api.fromJSON(JSON.parse(saved));
restoredRef.current = true;
} catch {
localStorage.removeItem(WORKSPACE_KEY);
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
<span className="phase-badge">Milestone 2</span>
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
<button className="new-connection" type="button" onClick={addConnection}>+ New connection</button>
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
