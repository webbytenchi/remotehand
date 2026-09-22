import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import {
DockviewReact,
type DockviewApi,
type DockviewReadyEvent,
type IWatermarkPanelProps,
type IDockviewPanelProps,
themeDark,
themeLight,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { LocalTerminalPanel } from "./LocalTerminalPanel";
import { SftpPanel } from "./SftpPanel";
import { AppModal } from "./AppModal";
import { PluginManager } from "./PluginManager";
import { PluginPanel, sendPluginPanelContext, type PluginPanelParams } from "./PluginPanel";
import {
  EMPTY_UI_CONTRIBUTION_LAYOUT,
  contributionOrderIndex,
  mergeRememberedOrder,
  moveVisibleContribution,
  resolveContributionOrder,
  type UiContributionLayout,
} from "./contributionLayout";
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
type ThemeMode = "dark" | "light" | "system";
type ColorScheme = "blue" | "emerald" | "violet" | "amber" | "neutral";
type TerminalTheme = "comfort" | "classic" | "custom";
type Settings = {
theme: ThemeMode;
colorScheme: ColorScheme;
uiFontFamily: string;
uiFontSize: number;
terminalTheme: TerminalTheme;
terminalBackground: string;
terminalForeground: string;
terminalFontFamily: string;
terminalFontSize: number;
startWithSystem: boolean;
startMinimized: boolean;
showInSystemTray: boolean;
minimizeToTrayOnClose: boolean;
};
type WorkspaceLayout = Parameters<DockviewApi["fromJSON"]>[0];
const WORKSPACE_KEY = "remotehand.workspace";
const THEME_KEY = "remotehand.theme";
const SETTINGS_KEY = "remotehand.settings";
const SIDEBAR_COLLAPSED_KEY = "remotehand.sidebarCollapsed";
const UI_CONTRIBUTION_LAYOUT_KEY = "remotehand.uiContributionLayout";
const DEFAULT_SETTINGS: Settings = {
theme: "dark",
colorScheme: "blue",
uiFontFamily: "Inter",
uiFontSize: 13,
terminalTheme: "comfort",
terminalBackground: "#11151a",
terminalForeground: "#d8dde6",
terminalFontFamily: "JetBrains Mono",
terminalFontSize: 13,
startWithSystem: false,
startMinimized: false,
showInSystemTray: true,
minimizeToTrayOnClose: false,
};
const UI_FONT_OPTIONS = ["Inter", "IBM Plex Sans", "Segoe UI", "System Default"] as const;
const TERMINAL_FONT_OPTIONS = ["JetBrains Mono", "IBM Plex Mono", "Cascadia Mono", "Consolas", "System Monospace"] as const;
const initialConnections: Connection[] = [];
type RecentActivity = {
id: string;
kind: "powershell" | "cmd" | "terminal" | "wsl" | "ssh" | "sftp";
title: string;
detail: string;
timestamp: number;
connection?: Connection;
};
type HomePanelParams = {
activities?: RecentActivity[];
onOpen?: (activity: RecentActivity) => void;
};
type ConnectionsPanelParams = {
connections?: Connection[];
};
type PluginContribution = {
id: string;
title: string;
icon: string;
panel: string;
entry: string;
};
type PluginManifestInfo = {
id: string;
name: string;
version: string;
apiVersion: number;
author: string;
description: string;
permissions: string[];
contributes: {
sidebar: PluginContribution[];
panels: PluginContribution[];
commands: PluginContribution[];
};
};
type PluginInfo = {
manifest: PluginManifestInfo;
enabled: boolean;
directory: string;
};
const HOME_MESSAGES = [
"Welcome back. Here is your recent activity.",
"Good to see you again. Pick up where you left off.",
"Your workspace is ready. Continue a recent session.",
"Ready when you are. Open a recent activity below.",
];
function HomePanel({ activities, onOpen, messageIndex }: { activities: RecentActivity[]; onOpen: (activity: RecentActivity) => void; messageIndex: number }) {
return (
<section className="panel-content home-panel">
<div className="home-hero">
<p className="eyebrow">Home</p>
<h1>RemoteHand</h1>
<p>{HOME_MESSAGES[messageIndex]}</p>
</div>
<div className="home-section">
<div className="home-section-heading">
<h2>Recent activity</h2>
<span>{activities.length ? "Continue where you left off." : "Activities you open will appear here."}</span>
</div>
<div className="activity-list">
{activities.length === 0 ? <div className="activity-empty">Open a terminal, SSH connection, or SFTP session to start building your recent activity.</div> : null}
{activities.map((activity) => (
<button className="activity-card" type="button" key={activity.id} onClick={() => onOpen(activity)}>
<span className="activity-icon">{activity.kind === "ssh" ? "◈" : activity.kind === "sftp" ? "⇅" : "⌘"}</span>
<span className="activity-copy"><strong>{activity.title}</strong><small>{activity.detail}</small></span>
<span className="activity-action">{activity.kind === "ssh" ? "Reconnect" : activity.kind === "sftp" ? "Reopen" : "Open"}</span>
</button>
))}
</div>
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
useEffect(() => {
const closeMenus = (except?: HTMLDetailsElement) => {
document.querySelectorAll<HTMLDetailsElement>(".connection-menu[open]").forEach((menu) => {
if (menu !== except) menu.open = false;
});
};
const onPointerDown = (event: PointerEvent) => {
const target = event.target as Node | null;
if (!target) return;
const menu = target instanceof Element ? target.closest<HTMLDetailsElement>(".connection-menu") : null;
closeMenus(menu ?? undefined);
};
const onKeyDown = (event: KeyboardEvent) => {
if (event.key === "Escape") closeMenus();
};
document.addEventListener("pointerdown", onPointerDown);
document.addEventListener("keydown", onKeyDown);
return () => {
document.removeEventListener("pointerdown", onPointerDown);
document.removeEventListener("keydown", onKeyDown);
};
}, []);
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
const confirmRemoveConnection = async () => {
if (!pendingRemove) return;
const removed = pendingRemove;
const credentialRef = removed.credentialRef;
const credentialIsShared = credentialRef
? connections.some((connection) => connection.id !== removed.id && connection.credentialRef === credentialRef)
: false;
onRemove(removed);
if (editingId === removed.id) resetForm();
setPendingRemove(null);
if (credentialRef && !credentialIsShared && isTauri()) {
try {
await invoke("vault_delete_secret", { credentialRef });
} catch (reason) {
setNotice({
title: "Connection removed, credential retained",
message: "The connection was removed, but its saved credential could not be deleted from the locked or unavailable vault: " + String(reason),
});
}
}
};
return (
<section className="panel-content connections-panel">
<div className="panel-heading">
<div>
<h2>Connections</h2>
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
<details
className="connection-menu"
onToggle={(event) => {
const menu = event.currentTarget;
if (!menu.open) return;
document.querySelectorAll<HTMLDetailsElement>(".connection-menu[open]").forEach((other) => {
if (other !== menu) other.open = false;
});
}}
>
<summary aria-label={`Manage ${connection.name}`}>⋯</summary>
<div className="connection-menu-popover">
<button
type="button"
onClick={(event) => {
event.currentTarget.closest<HTMLDetailsElement>(".connection-menu")!.open = false;
editConnection(connection);
}}
>
Edit
</button>
<button
type="button"
className="danger"
onClick={(event) => {
event.currentTarget.closest<HTMLDetailsElement>(".connection-menu")!.open = false;
removeConnection(connection);
}}
>
Remove
</button>
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
function WorkspaceWatermark({ containerApi }: IWatermarkPanelProps) {
const popouts = containerApi.getPopouts();
if (popouts.length === 0) return null;
return (
<div className="workspace-empty">
<div className="workspace-empty-icon" aria-hidden="true">↙</div>
<strong>All workspace panels are popped out.</strong>
<span>Close a popped-out window to dock it back.</span>
</div>
);
}
function App() {
const [connections, setConnections] = useState(initialConnections);
const [recentActivities, setRecentActivities] = useState<RecentActivity[]>([]);
const [homeMessageIndex, setHomeMessageIndex] = useState(() => Math.floor(Math.random() * HOME_MESSAGES.length));
const [recentActivitiesLoaded, setRecentActivitiesLoaded] = useState(() => !isTauri());
const [connectionsLoaded, setConnectionsLoaded] = useState(() => !isTauri());
const [settings, setSettings] = useState<Settings>(() => {
if (isTauri()) return DEFAULT_SETTINGS;
const saved = localStorage.getItem(SETTINGS_KEY);
if (saved) {
try {
return { ...DEFAULT_SETTINGS, ...(JSON.parse(saved) as Partial<Settings>) };
} catch {
return DEFAULT_SETTINGS;
}
}
const legacyTheme = localStorage.getItem(THEME_KEY);
return { ...DEFAULT_SETTINGS, theme: legacyTheme === "light" ? "light" : "dark" };
});
const [settingsOpen, setSettingsOpen] = useState(false);
const [settingsTab, setSettingsTab] = useState<"appearance" | "startup" | "layout" | "papa">("appearance");
const [papaTabUnlocked, setPapaTabUnlocked] = useState(false);
const [papaConfettiActive, setPapaConfettiActive] = useState(false);
const papaSequenceRef = useRef<string[]>([]);
const papaAudioRef = useRef<HTMLAudioElement | null>(null);
const [pluginsOpen, setPluginsOpen] = useState(false);
const [plugins, setPlugins] = useState<PluginInfo[]>([]);
const [topbarContributionItems, setTopbarContributionItems] = useState<Array<{ id: string; label: string }>>([]);
const [uiContributionLayout, setUiContributionLayout] = useState<UiContributionLayout>(EMPTY_UI_CONTRIBUTION_LAYOUT);
const [uiContributionLayoutLoaded, setUiContributionLayoutLoaded] = useState(false);
const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("dark");
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
const poppedOutPanelRef = useRef<{ panelId: string; count: number; window?: Window } | null>(null);
const closingPopoutPanelRef = useRef<{ panelId: string; groupId: string; hidden: boolean } | null>(null);
useEffect(() => {
if (!isTauri()) return;
void invoke<string>("local_os")
.then(setLocalOs)
.catch((error) => console.error("Failed to detect local OS", error));
}, []);
const refreshPlugins = useCallback(async () => {
if (!isTauri()) {
setPlugins([]);
return;
}
try {
const nextPlugins = await invoke<PluginInfo[]>("plugin_list");
setPlugins(nextPlugins);
const activePluginIds = new Set(
nextPlugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.manifest.id),
);
const api = apiRef.current;
if (api) {
for (const panel of [...api.panels]) {
if (panel.api.component !== "plugin") continue;
const pluginId = (panel.params as PluginPanelParams | undefined)?.pluginId;
if (pluginId && !activePluginIds.has(pluginId)) {
const wasPopout = panel.api.location.type === "popout";
if (wasPopout && isTauri()) {
try {
await invoke("close_panel_popouts");
} catch (error) {
console.error("Failed to close disabled plugin popout", error);
}
}
api.removePanel(panel);
}
}
}
} catch (error) {
console.error("Failed to load plugins", error);
}
}, []);
useEffect(() => {
void refreshPlugins();
}, [refreshPlugins]);
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
const recordActivity = useCallback((activity: Omit<RecentActivity, "id" | "timestamp">) => {
setRecentActivities((current) => {
const key = activity.kind + ":" + (activity.connection?.id ?? activity.title);
const next = current.filter((item) => item.kind + ":" + (item.connection?.id ?? item.title) !== key);
return [{ ...activity, id: key, timestamp: Date.now() }, ...next].slice(0, 8);
});
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
recordActivity({
kind: "ssh",
title: connection.name,
detail: connection.user + "@" + connection.host + ":" + connection.port,
connection,
});
}, [recordActivity]);
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
recordActivity({
kind: "sftp",
title: connection.name + " Files",
detail: connection.user + "@" + connection.host + ":" + connection.port,
connection,
});
}, [recordActivity]);
const addTerminal = useCallback((position?: "right" | "below", shell: "default" | "powershell" | "cmd" | "wsl" = "default") => {
const api = apiRef.current;
if (!api) return;
const resolvedShell = shell === "default" && localOs === "windows" ? "cmd" : shell;
const id = `terminal-${Date.now()}`;
const activePanel = api.activePanel;
const title = resolvedShell === "default" ? "Terminal" : resolvedShell === "powershell" ? "PowerShell" : resolvedShell === "cmd" ? "Command Prompt" : "WSL";
api.addPanel({
id,
component: "terminal",
title,
params: { shell: resolvedShell },
...(position && activePanel
? { position: { referencePanel: activePanel.id, direction: position } }
: {}),
});
recordActivity({
kind: resolvedShell === "default" ? "terminal" : resolvedShell,
title,
detail: "Local shell",
});
}, [localOs, recordActivity]);
const addConnections = useCallback(() => {
const api = apiRef.current;
if (!api) return;
const existing = api.panels.find((panel) => panel.api.component === "connections");
if (existing) {
existing.api.updateParameters({ connections });
existing.api.setActive();
return;
}
api.addPanel({
id: `connections-${Date.now()}`,
component: "connections",
title: "Connections",
params: { connections },
});
}, [connections]);
const openRecentActivity = useCallback((activity: RecentActivity) => {
if (activity.kind === "ssh") {
if (activity.connection) connectSsh(activity.connection);
return;
}
if (activity.kind === "sftp") {
if (activity.connection) openSftp(activity.connection);
return;
}
addTerminal(undefined, activity.kind === "terminal" ? "default" : activity.kind);
}, [addTerminal, connectSsh, openSftp]);
const openPluginPanel = useCallback((plugin: PluginInfo, panelId: string, context?: { targetId?: string; target?: string }) => {
const api = apiRef.current;
if (!api) return;
const panel = plugin.manifest.contributes.panels.find((item) => item.id === panelId);
if (!panel) return;
const id = "plugin-" + plugin.manifest.id + "-" + panel.id;
const existing = api.panels.find((current) => current.id === id && current.api.component === "plugin");
const params = {
pluginId: plugin.manifest.id,
panelId: panel.id,
title: panel.title,
context,
} satisfies PluginPanelParams;
if (existing) {
existing.api.updateParameters(params);
if (api.activePanel?.id !== existing.id) existing.api.setActive();
sendPluginPanelContext(plugin.manifest.id, panel.id, context);

const ownerWindow = existing.api.getWindow();
if (existing.api.location.type === "popout") {
if (isTauri()) {
void invoke("focus_single_panel_popout")
.catch((error) => console.error("Failed to restore plugin popout window", error));
} else {
ownerWindow.focus();
}
} else if (isTauri()) {
void invoke("focus_main_window")
.catch((error) => console.error("Failed to restore main window for plugin panel", error));
} else {
ownerWindow.focus();
}
return;
}
api.addPanel({
id,
component: "plugin",
title: panel.title,
params,
});
}, []);
const openHome = useCallback(() => {
const api = apiRef.current;
if (!api) return;
setHomeMessageIndex((current) => {
const offset = 1 + Math.floor(Math.random() * (HOME_MESSAGES.length - 1));
return (current + offset) % HOME_MESSAGES.length;
});
const existing = api.panels.find((panel) => panel.api.component === "welcome");
if (existing) {
existing.api.setTitle("Home");
existing.api.setActive();
return;
}
api.addPanel({ id: "home-" + Date.now(), component: "welcome", title: "Home", params: { activities: recentActivities } });
}, [recentActivities]);
const components = useMemo(
() => ({
welcome: (props: IDockviewPanelProps<HomePanelParams>) => (
<HomePanel
activities={props.params?.activities ?? recentActivities}
onOpen={openRecentActivity}
messageIndex={homeMessageIndex}
/>
),
terminal: LocalTerminalPanel,
sftp: SftpPanel,
plugin: PluginPanel,
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
[recentActivities, homeMessageIndex, openRecentActivity, addConnection, updateConnection, removeConnection, connectSsh, openSftp],
);
const popoutActive = useCallback(async () => {
const api = apiRef.current;
const panel = api?.activePanel;
if (!api || !panel) return;
if (panel.api.location.type === "popout") return;
try {
const opened = await api.addPopoutGroup(panel);
if (opened) poppedOutPanelRef.current = { panelId: panel.id, count: api.getPopouts().length };
} catch (error) {
console.error("Failed to pop out active panel", error);
}
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
api.addPanel({ id: "welcome", component: "welcome", title: "Home", params: { activities: recentActivities } });
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
}, [connections, recentActivities]);
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
if (!isTauri()) return;
void invoke<RecentActivity[]>("load_recent_activities")
.then((saved) => {
setRecentActivities(saved.slice(0, 8));
setRecentActivitiesLoaded(true);
})
.catch((error) => console.error("Failed to load recent activity", error));
}, []);
useEffect(() => {
if (!recentActivitiesLoaded || !isTauri()) return;
void invoke("save_recent_activities", { activities: recentActivities }).catch((error) =>
console.error("Failed to save recent activity", error),
);
}, [recentActivities, recentActivitiesLoaded]);
useEffect(() => {
if (!isTauri()) {
setSettingsLoaded(true);
return;
}
void invoke<Settings>("load_settings")
.then(async (saved) => {
let startWithSystem = false;
try {
startWithSystem = await invoke<boolean>("startup_enabled");
} catch (error) {
console.error("Failed to load startup preference", error);
}
setSettings({ ...DEFAULT_SETTINGS, ...saved, startWithSystem });
setSettingsLoaded(true);
})
.catch((error) => {
settingsPersistenceEnabledRef.current = false;
console.error("Failed to load settings", error);
setSettingsLoaded(true);
});
}, []);
useEffect(() => {
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyAppearanceToDocument = (targetDocument: Document) => {
const resolvedTheme =
settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
setResolvedTheme(resolvedTheme);
const root = targetDocument.documentElement;
root.dataset.theme = resolvedTheme;
root.dataset.scheme = settings.colorScheme;
root.dataset.terminalTheme = settings.terminalTheme;
root.style.setProperty("--terminal-background", settings.terminalBackground);
root.style.setProperty("--terminal-foreground", settings.terminalForeground);
const uiFamily =
settings.uiFontFamily === "System Default"
? 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
: '"' + settings.uiFontFamily + '", ui-sans-serif, system-ui, sans-serif';
const terminalFamily =
settings.terminalFontFamily === "System Monospace"
? 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace'
: '"' + settings.terminalFontFamily + '", ui-monospace, SFMono-Regular, Consolas, monospace';
root.style.setProperty("--ui-font-family", uiFamily);
root.style.setProperty("--ui-font-size", String(settings.uiFontSize) + "px");
root.style.setProperty("--terminal-font-family", terminalFamily);
root.style.setProperty("--terminal-font-size", String(settings.terminalFontSize) + "px");
targetDocument.defaultView?.dispatchEvent(new CustomEvent("remotehand-appearance-change"));
};
const applyAppearance = () => {
applyAppearanceToDocument(document);
for (const popout of apiRef.current?.getPopouts() ?? []) {
applyAppearanceToDocument(popout.window.document);
}
};
applyAppearance();
media.addEventListener("change", applyAppearance);
return () => media.removeEventListener("change", applyAppearance);
}, [settings]);
useEffect(() => {
if (!settingsLoaded) return;
if (!isTauri()) {
localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
localStorage.setItem(THEME_KEY, settings.theme);
return;
}
if (!settingsPersistenceEnabledRef.current) return;
void invoke("save_settings", { settings }).catch((error) =>
console.error("Failed to save settings", error),
);
}, [settings, settingsLoaded]);
useEffect(() => {
localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
}, [sidebarCollapsed]);

useEffect(() => {
if (!isTauri()) {
const saved = localStorage.getItem(UI_CONTRIBUTION_LAYOUT_KEY);
if (saved) {
try {
const parsed = JSON.parse(saved) as Partial<UiContributionLayout>;
setUiContributionLayout({
sidebarOrder: Array.isArray(parsed.sidebarOrder) ? parsed.sidebarOrder.filter((value): value is string => typeof value === "string") : [],
topbarOrder: Array.isArray(parsed.topbarOrder) ? parsed.topbarOrder.filter((value): value is string => typeof value === "string") : [],
});
} catch {
localStorage.removeItem(UI_CONTRIBUTION_LAYOUT_KEY);
}
}
setUiContributionLayoutLoaded(true);
return;
}
void invoke<UiContributionLayout>("load_ui_contribution_layout")
.then((saved) => {
setUiContributionLayout({
sidebarOrder: Array.isArray(saved.sidebarOrder) ? saved.sidebarOrder : [],
topbarOrder: Array.isArray(saved.topbarOrder) ? saved.topbarOrder : [],
});
})
.catch((error) => {
console.error("Failed to load UI contribution ordering; using legacy order", error);
setUiContributionLayout(EMPTY_UI_CONTRIBUTION_LAYOUT);
})
.finally(() => setUiContributionLayoutLoaded(true));
}, []);

useEffect(() => {
if (!uiContributionLayoutLoaded) return;
if (!isTauri()) {
localStorage.setItem(UI_CONTRIBUTION_LAYOUT_KEY, JSON.stringify(uiContributionLayout));
return;
}
void invoke("save_ui_contribution_layout", { layout: uiContributionLayout }).catch((error) =>
console.error("Failed to save UI contribution ordering", error),
);
}, [uiContributionLayout, uiContributionLayoutLoaded]);
useEffect(() => {
const api = apiRef.current;
if (!api) return;
for (const panel of api.panels) {
if (panel.api.component !== "connections") continue;
panel.api.updateParameters({ connections });
}
}, [connections]);
useEffect(() => {
const api = apiRef.current;
if (!api) return;
for (const panel of api.panels) {
if (panel.api.component !== "welcome") continue;
panel.api.setTitle("Home");
panel.api.updateParameters({ activities: recentActivities });
}
}, [recentActivities]);
const stopPapaAudio = useCallback(() => {
const audio = papaAudioRef.current;
if (!audio) return;
audio.pause();
audio.currentTime = 0;
}, []);
const startPapaAudio = useCallback(() => {
let audio = papaAudioRef.current;
if (!audio) {
audio = new Audio("/papa.mp3");
audio.loop = true;
papaAudioRef.current = audio;
}
audio.currentTime = 0;
void audio.play().catch((error) => console.error("Failed to start audio", error));
}, []);
useEffect(() => {
if (!settingsOpen || settingsTab !== "papa") stopPapaAudio();
}, [settingsOpen, settingsTab, stopPapaAudio]);
useEffect(() => () => {
const audio = papaAudioRef.current;
if (!audio) return;
audio.pause();
audio.currentTime = 0;
papaAudioRef.current = null;
}, []);
useEffect(() => {
if (!settingsOpen || settingsTab !== "startup" || papaTabUnlocked) {
papaSequenceRef.current = [];
return;
}
const sequence = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
const onKeyDown = (event: KeyboardEvent) => {
if (!settingsOpen || settingsTab !== "startup") return;
const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
const expected = sequence[papaSequenceRef.current.length];
if (key === expected) {
papaSequenceRef.current.push(key);
if (papaSequenceRef.current.length === sequence.length) {
setPapaTabUnlocked(true);
setPapaConfettiActive(true);
papaSequenceRef.current = [];
}
return;
}
papaSequenceRef.current = key === sequence[0] ? [key] : [];
};
window.addEventListener("keydown", onKeyDown, true);
return () => window.removeEventListener("keydown", onKeyDown, true);
}, [settingsOpen, settingsTab, papaTabUnlocked]);
useEffect(() => {
if (!papaConfettiActive) return;
const timer = window.setTimeout(() => setPapaConfettiActive(false), 1400);
return () => window.clearTimeout(timer);
}, [papaConfettiActive]);

useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
const disposables: Array<() => void> = [];
const bind = (eventName: string, handler: () => void) => {
void listen(eventName, handler).then((dispose) => {
if (cancelled) dispose();
else disposables.push(dispose);
});
};
bind("remotehand-tray-home", () => openHome());
bind("remotehand-tray-connections", () => addConnections());
bind("remotehand-tray-terminal", () => addTerminal());
bind("remotehand-tray-settings", () => { setSettingsTab("appearance"); setSettingsOpen(true); });
return () => { cancelled = true; disposables.forEach((dispose) => dispose()); };
}, [addConnections, addTerminal, openHome]);
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
event.api.addPanel({ id: "welcome", component: "welcome", title: "Home", params: { activities: recentActivities } });
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
if (panel.api.component === "connections") panel.api.updateParameters({ connections });
if (panel.api.component === "welcome") {
panel.api.setTitle("Home");
panel.api.updateParameters({ activities: recentActivities });
}
}
captureLayout(event.api);
event.api.onWillMutateLayout((mutation) => {
if (mutation.kind !== "remove" || mutation.origin !== "user") return;
const activePanel = event.api.activePanel;
if (activePanel?.api.location.type !== "popout") return;
const groupId = activePanel.api.group.id;
const isLastPanel = event.api.panels.filter((panel) => panel.api.group.id === groupId).length === 1;
closingPopoutPanelRef.current = {
panelId: activePanel.id,
groupId,
hidden: isLastPanel,
};
if (isLastPanel && isTauri()) {
void invoke("hide_single_panel_popout").catch((error) => {
console.error("Failed to hide popout before its last tab closed", error);
});
}
});
event.api.onDidMutateLayout((mutation) => {
captureLayout(event.api);
const closing = closingPopoutPanelRef.current;
if (mutation.kind !== "remove" || !closing) return;
closingPopoutPanelRef.current = null;
window.setTimeout(() => {
if (event.api.getPanel(closing.panelId) || !isTauri()) return;
const groupStillHasPanels = event.api.panels.some(
(panel) => panel.api.group.id === closing.groupId
);
if (groupStillHasPanels) return;
void getAllWindows().then(async (windows) => {
const nativePopouts = windows.filter((candidate) =>
candidate.label.startsWith("panel-popout-")
);
if (nativePopouts.length === 1) {
await nativePopouts[0].close();
}
}).catch((error) => {
console.error("Failed to close native popout after remove transaction", error);
});
}, 0);
});
event.api.onDidLayoutChange(() => {
captureLayout(event.api);
});
event.api.onDidAddPopoutGroup((popout) => {
popout.group.activePanel?.api.setActive();
popout.window.focus();
poppedOutPanelRef.current = {
panelId: popout.group.activePanel?.id ?? poppedOutPanelRef.current?.panelId ?? "",
count: event.api.getPopouts().length,
window: popout.window,
};
const targetDocument = popout.window.document;
const root = targetDocument.documentElement;
const source = document.documentElement;
root.dataset.theme = source.dataset.theme;
root.dataset.scheme = source.dataset.scheme;
root.dataset.terminalTheme = source.dataset.terminalTheme;
for (const property of [
"--terminal-background",
"--terminal-foreground",
"--ui-font-family",
"--ui-font-size",
"--terminal-font-family",
"--terminal-font-size",
]) {
const value = source.style.getPropertyValue(property);
if (value) root.style.setProperty(property, value);
}

const revealPopout = () => {
root.style.visibility = "visible";
popout.window.dispatchEvent(new CustomEvent("remotehand-appearance-change"));
if (isTauri()) {
void invoke("show_pending_popout").catch((error) => {
console.error("Failed to reveal native popout after Dockview setup", error);
});
}
};
const activePanel = popout.group.activePanel;
if (activePanel?.api.component === "plugin") {
const onPluginReady = () => {
popout.window.removeEventListener("remotehand-plugin-popout-ready", onPluginReady);
revealPopout();
};
popout.window.addEventListener("remotehand-plugin-popout-ready", onPluginReady, { once: true });
} else {
revealPopout();
}
});
event.api.onDidRemovePopoutGroup(() => {
const panelId = poppedOutPanelRef.current?.panelId;
window.setTimeout(() => {
if (panelId) {
event.api.getPanel(panelId)?.api.setActive();
}
poppedOutPanelRef.current = null;
}, 0);
});
event.api.onDidRemoveGroup(() => {
if (!isTauri()) return;
const currentWindow = getCurrentWindow();
if (!currentWindow.label.startsWith("panel-popout-")) return;
void currentWindow.close().then(async () => {
const mainWindow = (await getAllWindows()).find((candidate) => candidate.label === "main");
if (mainWindow) {
await mainWindow.setFocus();
}
}).catch((error) => {
console.error("Failed to close empty popout window or restore main-window focus", error);
});
});
event.api.onDidRemovePanel((panel) => {
const sessionId = panel.id;
const popoutWindow =
poppedOutPanelRef.current?.panelId === sessionId
? poppedOutPanelRef.current.window
: undefined;
window.setTimeout(() => {
if (event.api.getPanel(sessionId)) return;
if (!popoutWindow) return;
if (!popoutWindow.closed) {
popoutWindow.close();
}
if (!isTauri()) return;
void getAllWindows().then(async (windows) => {
const nativePopouts = windows.filter((candidate) =>
candidate.label.startsWith("panel-popout-")
);
if (nativePopouts.length === 1) {
await nativePopouts[0].close();
}
}).catch((error) => {
console.error("Failed to close native popout after its last tab closed", error);
});
}, 0);
if (panel.api.component !== "terminal") return;
window.setTimeout(() => {
if (event.api.panels.some((current) => current.id === sessionId)) return;
if (!isTauri()) return;
void invoke("terminal_close", { sessionId }).catch(() => undefined);
}, 0);
});
setWorkspaceReady(true);
};
const commands = [
{ label: "Open Home", hint: "Panel", run: openHome },
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
{ label: "Manage plugins", hint: "Add-ons", run: () => setPluginsOpen(true) },
{ label: "Float active panel", hint: "Layout", run: popoutActive },
{ label: "Undo layout change", hint: "Ctrl/Cmd+Z", run: undoLayout },
{ label: "Redo layout change", hint: "Ctrl/Cmd+Y", run: redoLayout },
{ label: "Reset workspace layout", hint: "Reset", run: resetLayout },
];
const filteredCommands = commands.filter((command) =>
command.label.toLowerCase().includes(paletteQuery.toLowerCase()),
);

const coreSidebarItems = [
{ id: "core:home", label: "Home" },
...(localOs === "windows"
? [
{ id: "core:powershell", label: "PowerShell" },
{ id: "core:cmd", label: "Command Prompt" },
]
: [{ id: "core:terminal", label: "Terminal" }]),
{ id: "core:connections", label: "Connections" },
];
const pluginSidebarItems = plugins.flatMap((plugin) =>
plugin.enabled
? plugin.manifest.contributes.sidebar.map((sidebar) => ({
id: `${plugin.manifest.id}:${sidebar.id}`,
label: sidebar.title,
}))
: [],
);
const sidebarCatalog = [...coreSidebarItems, ...pluginSidebarItems];
const sidebarAvailableIds = sidebarCatalog.map((item) => item.id);
const resolvedSidebarOrder = resolveContributionOrder(
uiContributionLayout.sidebarOrder,
sidebarAvailableIds,
sidebarAvailableIds,
);

const coreTopbarItems = [
{ id: "core:plugins", label: "Plugins" },
{ id: "core:settings", label: "Settings" },
];
const topbarCatalog = [...topbarContributionItems, ...coreTopbarItems];
const topbarAvailableIds = topbarCatalog.map((item) => item.id);
const topbarFallbackIds = [...topbarContributionItems.map((item) => item.id), ...coreTopbarItems.map((item) => item.id)];
const resolvedTopbarOrder = resolveContributionOrder(
uiContributionLayout.topbarOrder,
topbarAvailableIds,
topbarFallbackIds,
);

const moveSidebarItem = (id: string, delta: -1 | 1) => {
setUiContributionLayout((current) => {
const remembered = mergeRememberedOrder(current.sidebarOrder, sidebarAvailableIds, sidebarAvailableIds);
const visible = resolveContributionOrder(remembered, sidebarAvailableIds, sidebarAvailableIds);
return { ...current, sidebarOrder: moveVisibleContribution(remembered, visible, id, delta) };
});
};
const moveTopbarItem = (id: string, delta: -1 | 1) => {
setUiContributionLayout((current) => {
const remembered = mergeRememberedOrder(current.topbarOrder, topbarAvailableIds, topbarFallbackIds);
const visible = resolveContributionOrder(remembered, topbarAvailableIds, topbarFallbackIds);
return { ...current, topbarOrder: moveVisibleContribution(remembered, visible, id, delta) };
});
};
const resetContributionOrdering = () => {
setUiContributionLayout(EMPTY_UI_CONTRIBUTION_LAYOUT);
};

if (!settingsLoaded) {
return <main className="app-shell" aria-hidden="true" />;
}
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
<button className="topbar-button icon-button" style={{ order: contributionOrderIndex(resolvedTopbarOrder, "core:plugins") }} type="button" onClick={() => setPluginsOpen(true)} title="Plugins" aria-label="Plugins">🧩</button>
<button
className="topbar-button icon-button settings-button"
style={{ order: contributionOrderIndex(resolvedTopbarOrder, "core:settings") }}
type="button"
onClick={() => { setSettingsTab("appearance"); setSettingsOpen(true); }}
title="Settings"
aria-label="Settings"
>
&#9881;
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
<button className="sidebar-action" style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, "core:home") }} type="button" onClick={openHome} title="Home">
<span className="sidebar-icon" aria-hidden="true">
<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
<path d="M3 9.2L10 3l7 6.2" />
<path d="M5 8.2V17h10V8.2" />
<path d="M8 17v-5h4v5" />
</svg>
</span><span className="sidebar-label">Home</span>
</button>
{localOs === "windows" ? (
<>
<button className="sidebar-action" style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, "core:powershell") }} type="button" onClick={() => addTerminal(undefined, "powershell")} title="PowerShell">
<span className="sidebar-icon" aria-hidden="true">
<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
<rect x="2.5" y="3.5" width="15" height="13" rx="2" />
<path d="M6 7l3 3-3 3" />
<path d="M11 13h3" />
</svg>
</span><span className="sidebar-label">PowerShell</span>
</button>
<button className="sidebar-action" style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, "core:cmd") }} type="button" onClick={() => addTerminal(undefined, "cmd")} title="Command Prompt">
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
<button className="sidebar-action" style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, "core:terminal") }} type="button" onClick={() => addTerminal()} title="Terminal">
<span className="sidebar-icon">⌘</span><span className="sidebar-label">Terminal</span>
</button>
)}
<button className="sidebar-action" style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, "core:connections") }} type="button" onClick={addConnections} title="Connections">
<span className="sidebar-icon">◈</span><span className="sidebar-label">Connections</span>
</button>
{plugins.flatMap((plugin) =>
plugin.enabled
? plugin.manifest.contributes.sidebar.map((sidebar) => (
<button
className="sidebar-action"
style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, plugin.manifest.id + ":" + sidebar.id) }}
type="button"
key={plugin.manifest.id + ":" + sidebar.id}
onClick={() => openPluginPanel(plugin, sidebar.panel)}
title={sidebar.title}
>
<span className="sidebar-icon" aria-hidden="true">◇</span>
<span className="sidebar-label">{sidebar.title}</span>
</button>
))
: [],
)}
</aside>
<section className="canvas">
<div className="dockview-host">
<DockviewReact
className="remotehand-dockview"
theme={resolvedTheme === "light" ? themeLight : themeDark}
components={components}
watermarkComponent={WorkspaceWatermark}
onReady={handleReady}
keyboardNavigation
dndStrategy="pointer"
popoutUrl="popout.html"
/>
</div>
{!workspaceReady && <div className="workspace-loading">Preparing workspace…</div>}
</section>
</section>
<PluginManager
open={pluginsOpen}
onClose={() => setPluginsOpen(false)}
onChanged={() => void refreshPlugins()}
topbarOrder={resolvedTopbarOrder}
onTopbarItemsChanged={setTopbarContributionItems}
onOpenPluginPanel={(pluginId, panelId, context) => {
const plugin = plugins.find((item) => item.manifest.id === pluginId);
if (plugin) openPluginPanel(plugin, panelId, context);
}}
/>
<AppModal
open={settingsOpen}
title="Settings"
className="settings-modal"
confirmLabel={settingsTab === "papa" ? "Always" : "Done"}
onConfirm={() => setSettingsOpen(false)}
onCancel={() => setSettingsOpen(false)}
focusActions={false}
tabs={<div className="settings-tabs" role="tablist" aria-label="Settings sections">
<button type="button" role="tab" aria-selected={settingsTab === "appearance"} className={settingsTab === "appearance" ? "active" : ""} onClick={() => setSettingsTab("appearance")}>Appearance</button>
<button type="button" role="tab" aria-selected={settingsTab === "startup"} className={settingsTab === "startup" ? "active" : ""} onClick={() => setSettingsTab("startup")}>Startup &amp; Tray</button>
<button type="button" role="tab" aria-selected={settingsTab === "layout"} className={settingsTab === "layout" ? "active" : ""} onClick={() => setSettingsTab("layout")}>Interface</button>
{papaTabUnlocked ? <span className="papa-tab-reveal"><button type="button" role="tab" aria-selected={settingsTab === "papa"} className={settingsTab === "papa" ? "active" : ""} onClick={() => { setSettingsTab("papa"); startPapaAudio(); }}>Papa</button>{papaConfettiActive ? <span className="papa-heart-confetti" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <span key={index}>♥</span>)}</span> : null}</span> : null}
</div>}>
{settingsTab === "appearance" ? (
<div className="appearance-settings settings-tab-content">
<div className="settings-section-heading">
<span>Customize RemoteHand and terminal typography.</span>
</div>
<div className="settings-field">
<span>Theme</span>
<div className="settings-segmented">
{(["dark", "light", "system"] as ThemeMode[]).map((mode) => (
<button key={mode} type="button" className={settings.theme === mode ? "active" : ""} onClick={() => setSettings((current) => ({ ...current, theme: mode }))}>
{mode[0].toUpperCase() + mode.slice(1)}
</button>
))}
</div>
</div>
<div className="settings-field">
<label htmlFor="color-scheme">Color scheme</label>
<select id="color-scheme" value={settings.colorScheme} onChange={(event) => setSettings((current) => ({ ...current, colorScheme: event.target.value as ColorScheme }))}>
<option value="blue">RemoteHand Blue</option>
<option value="emerald">Emerald</option>
<option value="violet">Violet</option>
<option value="amber">Amber</option>
<option value="neutral">Neutral</option>
</select>
</div>
<div className="settings-field settings-font-row">
<label htmlFor="ui-font">Interface font</label>
<select id="ui-font" value={settings.uiFontFamily} onChange={(event) => setSettings((current) => ({ ...current, uiFontFamily: event.target.value }))}>
{UI_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
</select>
<div className="settings-stepper" aria-label="Interface font size">
<button type="button" onClick={() => setSettings((current) => ({ ...current, uiFontSize: Math.max(11, current.uiFontSize - 1) }))}>−</button>
<span>{settings.uiFontSize} px</span>
<button type="button" onClick={() => setSettings((current) => ({ ...current, uiFontSize: Math.min(18, current.uiFontSize + 1) }))}>+</button>
</div>
</div>
<div className="settings-field">
<label htmlFor="terminal-theme">Terminal theme</label>
<select id="terminal-theme" value={settings.terminalTheme} onChange={(event) => {
const terminalTheme = event.target.value as TerminalTheme;
setSettings((current) => {
if (terminalTheme === "comfort") return { ...current, terminalTheme, terminalBackground: "#11151a", terminalForeground: "#d8dde6" };
if (terminalTheme === "classic") return { ...current, terminalTheme, terminalBackground: "#05070a", terminalForeground: "#d5dbe5" };
return { ...current, terminalTheme };
});
}}>
<option value="comfort">RemoteHand Comfort</option>
<option value="classic">RemoteHand Classic</option>
<option value="custom">Custom</option>
</select>
</div>
<div className="settings-color-row">
<label><span>Background</span><div className="settings-color-control"><input type="color" value={settings.terminalBackground} onChange={(event) => setSettings((current) => ({ ...current, terminalTheme: "custom", terminalBackground: event.target.value }))} /><input type="text" value={settings.terminalBackground} maxLength={7} onChange={(event) => setSettings((current) => ({ ...current, terminalTheme: "custom", terminalBackground: event.target.value }))} /></div></label>
<label><span>Foreground</span><div className="settings-color-control"><input type="color" value={settings.terminalForeground} onChange={(event) => setSettings((current) => ({ ...current, terminalTheme: "custom", terminalForeground: event.target.value }))} /><input type="text" value={settings.terminalForeground} maxLength={7} onChange={(event) => setSettings((current) => ({ ...current, terminalTheme: "custom", terminalForeground: event.target.value }))} /></div></label>
</div>
<div className="settings-field settings-font-row">
<label htmlFor="terminal-font">Terminal font</label>
<select id="terminal-font" value={settings.terminalFontFamily} onChange={(event) => setSettings((current) => ({ ...current, terminalFontFamily: event.target.value }))}>
{TERMINAL_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
</select>
<div className="settings-stepper" aria-label="Terminal font size">
<button type="button" onClick={() => setSettings((current) => ({ ...current, terminalFontSize: Math.max(10, current.terminalFontSize - 1) }))}>−</button>
<span>{settings.terminalFontSize} px</span>
<button type="button" onClick={() => setSettings((current) => ({ ...current, terminalFontSize: Math.min(24, current.terminalFontSize + 1) }))}>+</button>
</div>
</div>
<button type="button" className="settings-reset" onClick={() => setSettings(DEFAULT_SETTINGS)}>Reset appearance</button>
</div>
) : settingsTab === "startup" ? (
<div className="appearance-settings startup-settings settings-tab-content">
<div className="settings-section-heading">
<span>Control how RemoteHand behaves when Windows or Linux starts it.</span>
</div>
<label className="settings-toggle">
<input type="checkbox" checked={settings.startWithSystem} onChange={(event) => {
const enabled = event.target.checked;
setSettings((current) => ({ ...current, startWithSystem: enabled }));
if (isTauri()) void invoke("set_startup_enabled", { enabled }).catch((error) => console.error("Failed to update startup preference", error));
}} />
<span><strong>Start RemoteHand with system</strong><small>Launch RemoteHand automatically at user login.</small></span>
</label>
<label className="settings-toggle">
<input type="checkbox" checked={settings.startMinimized} onChange={(event) => setSettings((current) => ({ ...current, startMinimized: event.target.checked }))} />
<span><strong>Start minimized</strong><small>Applies when RemoteHand is launched automatically.</small></span>
</label>
<label className="settings-toggle">
<input type="checkbox" checked={settings.showInSystemTray} onChange={(event) => {
const visible = event.target.checked;
setSettings((current) => ({ ...current, showInSystemTray: visible }));
if (isTauri()) void invoke("set_tray_visible", { visible }).catch((error) => console.error("Failed to update tray visibility", error));
}} />
<span><strong>Show RemoteHand in system tray</strong><small>Keep a tray icon available while RemoteHand is running.</small></span>
</label>
<label className={"settings-toggle" + (!settings.showInSystemTray ? " disabled" : "")}>
<input type="checkbox" checked={settings.minimizeToTrayOnClose} disabled={!settings.showInSystemTray} onChange={(event) => {
const value = event.target.checked;
setSettings((current) => ({ ...current, minimizeToTrayOnClose: value }));
if (isTauri()) void invoke("set_close_to_tray", { value }).catch((error) => console.error("Failed to update close-to-tray preference", error));
}} />
<span><strong>Minimize to tray when closing</strong><small>Keep RemoteHand running when the main window is closed.</small></span>
</label>
</div>
) : settingsTab === "layout" ? (
<div className="settings-tab-content">
<div className="settings-section-heading">
<span>RemoteHand owns the order of built-in and plugin interface contributions. Plugins only provide content.</span>
</div>
<div style={{ display: "grid", gap: 16 }}>
<section>
<strong style={{ display: "block", marginBottom: 8 }}>Sidebar</strong>
<div style={{ display: "grid", gap: 6 }}>
{resolvedSidebarOrder.map((id, index) => {
const entry = sidebarCatalog.find((item) => item.id === id);
if (!entry) return null;
return <div key={id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 6, alignItems: "center", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 7 }}>
<span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
<button type="button" className="settings-reset" style={{ margin: 0, padding: "4px 8px" }} disabled={index === 0} onClick={() => moveSidebarItem(id, -1)} aria-label={`Move ${entry.label} up`}>↑</button>
<button type="button" className="settings-reset" style={{ margin: 0, padding: "4px 8px" }} disabled={index === resolvedSidebarOrder.length - 1} onClick={() => moveSidebarItem(id, 1)} aria-label={`Move ${entry.label} down`}>↓</button>
</div>;
})}
</div>
</section>
<section>
<strong style={{ display: "block", marginBottom: 8 }}>Top bar</strong>
<div style={{ display: "grid", gap: 6 }}>
{resolvedTopbarOrder.map((id, index) => {
const entry = topbarCatalog.find((item) => item.id === id);
if (!entry) return null;
return <div key={id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: 6, alignItems: "center", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 7 }}>
<span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
<button type="button" className="settings-reset" style={{ margin: 0, padding: "4px 8px" }} disabled={index === 0} onClick={() => moveTopbarItem(id, -1)} aria-label={`Move ${entry.label} left`}>←</button>
<button type="button" className="settings-reset" style={{ margin: 0, padding: "4px 8px" }} disabled={index === resolvedTopbarOrder.length - 1} onClick={() => moveTopbarItem(id, 1)} aria-label={`Move ${entry.label} right`}>→</button>
</div>;
})}
</div>
</section>
</div>
<button type="button" className="settings-reset" onClick={resetContributionOrdering}>Reset interface order</button>
</div>
) : (
<div className="settings-tab-content papa-settings">
<div className="papa-message">
<strong>I Love You Andami!</strong>
<span>- Papa</span>
</div>
</div>
)}
</AppModal>
{paletteOpen && (
<div className="palette-backdrop" role="presentation" onMouseDown={() => setPaletteOpen(false)}>
<div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
<input autoFocus value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder="Type a command…" aria-label="Filter commands" />
<div className="command-list">
{filteredCommands.length ? filteredCommands.map((command) => (
<button key={command.label} type="button" onClick={() => { command.run(); setPaletteOpen(false); setPaletteQuery(""); }}>
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
