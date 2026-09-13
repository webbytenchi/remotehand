import { useEffect, useMemo, useRef, useState } from "react";
import { DockviewReact, type DockviewReadyEvent, themeDark } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./App.css";
type PanelId = "welcome" | "terminal" | "connections";
type Connection = {
id: string;
name: string;
host: string;
user: string;
};
const initialConnections: Connection[] = [
{
id: "local",
name: "Local machine",
host: "localhost",
user: "local",
},
];
function WelcomePanel() {
return (
<section className="panel-content welcome-panel">
<p className="eyebrow">Milestone 1</p>
<h1>Workspace Shell</h1>
<p>
RemoteHand now has a real dockable workspace. Panels can be opened,
closed, resized, split, tabbed, and rearranged.
</p>
<div className="feature-list">
<div>
<strong>Dockable panels</strong>
<span>Arrange tools into tabs and split groups.</span>
</div>
<div>
<strong>Persistent layout</strong>
<span>Your workspace arrangement is restored locally.</span>
</div>
<div>
<strong>Tool palette</strong>
<span>Open the terminal and connection manager on demand.</span>
</div>
</div>
</section>
);
}
function TerminalPanel() {
const [lines, setLines] = useState<string[]>([
"RemoteHand local terminal",
"Milestone 1 shell is ready.",
"Terminal execution arrives in Milestone 2.",
]);
const [command, setCommand] = useState("");
const inputRef = useRef<HTMLInputElement>(null);
const run = () => {
const value = command.trim();
if (!value) return;
setLines((current) => [...current, $ ${value}, "Local terminal backend pending (Milestone 2)."]);
setCommand("");
inputRef.current?.focus();
};
return (
<section className="terminal-panel">
<div className="terminal-output">
{lines.map((line, index) => (
<div key={${line}-${index}}>{line}</div>
))}
</div>
<div className="terminal-input">
<span>$</span>
<input
ref={inputRef}
aria-label="Terminal command"
value={command}
onChange={(event) => setCommand(event.target.value)}
onKeyDown={(event) => {
if (event.key === "Enter") run();
}}
placeholder="Command..."
/>
<button type="button" onClick={run}>
Run
</button>
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
<button type="button" className="primary-button" onClick={onAdd}>
+ New connection
</button>
</div>
<div className="connection-list">
{connections.map((connection) => (
<article className="connection-card" key={connection.id}>
<div className="connection-icon">●</div>
<div>
<strong>{connection.name}</strong>
<span>
{connection.user}@{connection.host}
</span>
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
const [ready, setReady] = useState(false);
const dockviewRef = useRef<HTMLDivElement>(null);
const components = useMemo(
() => ({
welcome: WelcomePanel,
terminal: TerminalPanel,
connections: () => (
<ConnectionsPanel
connections={connections}
onAdd={() =>
setConnections((current) => [
...current,
{
id: connection-${current.length + 1},
name: New connection ${current.length},
host: "example.local",
user: "user",
},
])
}
/>
),
}),
[connections],
);
useEffect(() => {
if (!ready) return;
const saved = localStorage.getItem("remotehand.workspace");
if (!saved) return;
try {
const layout = JSON.parse(saved);
const element = dockviewRef.current;
if (element) {
const api = (
element as HTMLDivElement & {
__remotehandApi?: { fromJSON: (value: unknown) => void };
}
).__remotehandApi;
api?.fromJSON(layout);
}
} catch {
localStorage.removeItem("remotehand.workspace");
}
}, [ready]);
const handleReady = (event: DockviewReadyEvent) => {
setReady(true);
event.api.addPanel({
id: "welcome",
component: "welcome",
title: "Welcome",
});

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

const element = dockviewRef.current;
if (element) {
(
element as HTMLDivElement & {
__remotehandApi?: typeof event.api;
}
).__remotehandApi = event.api;

event.api.onDidMutateLayout(() => {
localStorage.setItem(
"remotehand.workspace",
JSON.stringify(event.api.toJSON()),
);
});
}
};
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
<span className="phase-badge">Milestone 1</span>
</div>
</header>
<section className="workspace">
<aside className="sidebar">
<div className="sidebar-heading">Workspace</div>
<button
className="sidebar-action"
type="button"
onClick={() => {
const element = dockviewRef.current;
const api = (
element as HTMLDivElement & {
__remotehandApi?: {
addPanel: (options: {
id: string;
component: string;
title: string;
}) => void;
};
} | null
)?.__remotehandApi;
api?.addPanel({
id: `terminal-${Date.now()}`,
component: "terminal",
title: "Terminal",
});
}}
>
<span>⌘</span>
Terminal
</button>
<button
className="sidebar-action"
type="button"
onClick={() => {
const element = dockviewRef.current;
const api = (
element as HTMLDivElement & {
__remotehandApi?: {
addPanel: (options: {
id: string;
component: string;
title: string;
}) => void;
};
} | null
)?.__remotehandApi;
api?.addPanel({
id: `connections-${Date.now()}`,
component: "connections",
title: "Connections",
});
}}
>
<span>◈</span>
Connections
</button>
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
<button
className="new-connection"
type="button"
onClick={() =>
setConnections((current) => [
...current,
{
id: `connection-${current.length + 1}`,
name: `New connection ${current.length}`,
host: "example.local",
user: "user",
},
])
}
>
+ New connection
</button>
</aside>

<section className="canvas">
<div className="dockview-host" ref={dockviewRef}>
<DockviewReact
className="remotehand-dockview"
theme={themeDark}
components={components}
onReady={handleReady}
/>
</div>
</section>
</section>
</main>
);
}
export default App;
