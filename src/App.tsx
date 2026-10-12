import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import {
DockviewDefaultTab,
DockviewReact,
type DockviewApi,
type DockviewReadyEvent,
type IWatermarkPanelProps,
type IDockviewPanelHeaderProps,
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
import { remoteHandFunctionKeyDisposition } from "./functionKeys";
import {
  REMOTEHAND_FUNCTION_SHORTCUTS,
  assignFunctionShortcut,
  assignedShortcutAction,
  functionShortcutFromKeyboardEvent,
} from "./shortcutMapper";
import { shouldSuppressWebViewShortcut } from "./browserShortcuts";
import {
VAULT_PROMPT_REQUEST_EVENT,
VAULT_PROMPT_RESULT_EVENT,
requestVaultAccess,
type VaultPromptRequest,
} from "./vaultPrompt";
import { enqueueVaultPrompt, settleVaultPromptBatch } from "./vaultPromptBatch";
import {
  captureGridGroupSizes,
  extractPopoutGeometries,
  extractPopoutGridGroupSizes,
  restoreGridGroupSizes,
  type GridGroupSize,
  type PopoutGeometry,
} from "./workspaceSizing";
import {
  EMPTY_UI_CONTRIBUTION_LAYOUT,
  contributionOrderIndex,
  mergeRememberedOrder,
  moveVisibleContribution,
  resolveContributionOrder,
  type UiContributionLayout,
} from "./contributionLayout";
import appIcon from "../src-tauri/icons/icon.png";
import aboutIcon from "../src-tauri/icons/128x128.png";
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
type TopbarAlignment = "left" | "center" | "right";
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
topbarAlignment: TopbarAlignment;
globalShortcutEnabled: boolean;
globalShortcut: string;
functionKeyShortcuts: Record<string, string>;
vaultAutoLockMinutes: number;
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
topbarAlignment: "center",
globalShortcutEnabled: true,
globalShortcut: "Ctrl+Shift+Space",
functionKeyShortcuts: { "core.commandPalette": "Ctrl+F12" },
vaultAutoLockMinutes: 15,
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
fileHandlers: { extensions: string[]; panel: string }[];
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
type PluginRuntimeEvent = {
pluginId: string;
event: string;
payload: unknown;
};
type PluginOpenPanelEvent = {
pluginId: string;
panelId: string;
context?: { targetId?: string; target?: string; view?: string; alertKey?: string; path?: string };
};
type RemoteHandPopoutWindow = Window & {
__REMOTEHAND_NATIVE_WINDOW_LABEL__?: string;
};
const tabDragAssistDocuments = new Set<Document>();
const shortcutOwnershipDocuments = new Set<Document>();
let tabDragWindowAssistArmed = false;
const dragIframePointerEvents = new Map<HTMLIFrameElement, string>();

function setWorkspaceDragIframePassThrough(enabled: boolean) {
if (!enabled) {
for (const [frame, previous] of dragIframePointerEvents) {
if (previous) frame.style.pointerEvents = previous;
else frame.style.removeProperty("pointer-events");
}
dragIframePointerEvents.clear();
return;
}

for (const targetDocument of tabDragAssistDocuments) {
const targetWindow = targetDocument.defaultView;
if (!targetWindow || targetWindow.closed) continue;

targetDocument.querySelectorAll<HTMLIFrameElement>("iframe.plugin-panel-frame").forEach((frame) => {
if (!dragIframePointerEvents.has(frame)) {
dragIframePointerEvents.set(frame, frame.style.pointerEvents);
}
frame.style.pointerEvents = "none";
});
}
}

function beginWorkspaceTabDrag(sourceWindow: Window) {
if (!isTauri()) return;
tabDragWindowAssistArmed = true;
setWorkspaceDragIframePassThrough(true);
const sourceLabel =
(sourceWindow as RemoteHandPopoutWindow).__REMOTEHAND_NATIVE_WINDOW_LABEL__ ?? "main";
void invoke("prepare_drag_target_windows", { sourceLabel }).catch((error) => {
console.error("Failed to prepare RemoteHand tab drag targets", error);
});
}

function releaseWorkspaceTabDragAssist() {
const wasArmed = tabDragWindowAssistArmed;
tabDragWindowAssistArmed = false;
setWorkspaceDragIframePassThrough(false);
if (!wasArmed) return;
void invoke("release_drag_target_windows").catch((error) => {
console.error("Failed to release RemoteHand drag window stacking", error);
});
}

function installWebViewShortcutOwnership(targetDocument: Document) {
if (shortcutOwnershipDocuments.has(targetDocument) || !isTauri()) return;
shortcutOwnershipDocuments.add(targetDocument);

const onKeyDown = (event: KeyboardEvent) => {
if (shouldSuppressWebViewShortcut(event.key, event)) {
event.preventDefault();
}
};
const unload = () => {
shortcutOwnershipDocuments.delete(targetDocument);
targetDocument.removeEventListener("keydown", onKeyDown, true);
};
targetDocument.addEventListener("keydown", onKeyDown, true);
targetDocument.defaultView?.addEventListener("beforeunload", unload, { once: true });
}

function installTabDragWindowAssist(targetDocument: Document) {
if (tabDragAssistDocuments.has(targetDocument) || !isTauri()) return;
tabDragAssistDocuments.add(targetDocument);

const nativeLabel = () => {
const targetWindow = targetDocument.defaultView as RemoteHandPopoutWindow | null;
return targetWindow?.__REMOTEHAND_NATIVE_WINDOW_LABEL__ ?? "main";
};

const raiseHere = () => {
if (!tabDragWindowAssistArmed) return;
void invoke("raise_drag_target_window", { label: nativeLabel() }).catch((error) => {
console.error("Failed to raise hovered RemoteHand window during tab drag", error);
});
};

const release = () => {
releaseWorkspaceTabDragAssist();
};

const finishDrop = () => {
if (!tabDragWindowAssistArmed) return;
tabDragWindowAssistArmed = false;
setWorkspaceDragIframePassThrough(false);
void invoke("finish_drag_target_window", { label: nativeLabel() }).catch((error) => {
console.error("Failed to finish RemoteHand tab drag target focus", error);
void invoke("release_drag_target_windows").catch(() => undefined);
});
};

const unload = () => {
tabDragAssistDocuments.delete(targetDocument);
release();
};

targetDocument.addEventListener("dragenter", raiseHere, true);
targetDocument.addEventListener("dragend", release, true);
targetDocument.addEventListener("drop", finishDrop, true);
targetDocument.defaultView?.addEventListener("beforeunload", unload, { once: true });
}

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
setShowForm(false);
};
const editConnection = (connection: Connection) => {
setEditingId(connection.id);
setName(connection.name);
setHost(connection.host);
setPort(String(connection.port));
setUser(connection.user);
setPassword("");
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
await requestVaultAccess("Save the password for " + trimmedName + ".");
credentialRef = "core:sftp/" + id + "/password";
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
function RemoteHandTabView({
props,
onPopout,
onDock,
onMainGroup,
}: {
props: IDockviewPanelHeaderProps;
onPopout: (panelId: string) => void;
onDock: (panelId: string) => void;
onMainGroup: (panelId: string, groupId: string) => void;
}) {
const [isPopout, setIsPopout] = useState(() => props.api.location.type === "popout");
useEffect(() => {
const syncLocation = () => {
const nextIsPopout = props.api.location.type === "popout";
setIsPopout(nextIsPopout);
if (!nextIsPopout) {
onMainGroup(props.api.id, props.api.group.id);
}
};
syncLocation();
const disposable = props.api.onDidLocationChange(syncLocation);
return () => disposable.dispose();
}, [onMainGroup, props.api]);
const stopTabActionPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
event.preventDefault();
event.stopPropagation();
};
const runTabAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
event.preventDefault();
event.stopPropagation();
action();
};
return (
<div className="remotehand-tab-shell">
<DockviewDefaultTab {...props} hideClose />
{props.tabLocation === "header" ? (
<>
<button
type="button"
className="remotehand-tab-action"
title={isPopout ? "Dock to main window" : "Pop out panel"}
aria-label={isPopout ? "Dock to main window" : "Pop out panel"}
onPointerDown={stopTabActionPointer}
onClick={(event) => runTabAction(event, () => {
if (isPopout) onDock(props.api.id);
else onPopout(props.api.id);
})}
>
{isPopout ? (
<svg viewBox="0 0 16 16" aria-hidden="true">
<path d="M6.5 13.5h-4v-4" />
<path d="M2.75 13.25 8 8" />
<path d="M3.5 6.75V3.5h9v9H9.25" />
</svg>
) : (
<svg viewBox="0 0 16 16" aria-hidden="true">
<path d="M9.5 2.5h4v4" />
<path d="M13.25 2.75 8 8" />
<path d="M12.5 9.25v3.25h-9v-9h3.25" />
</svg>
)}
</button>
<button
type="button"
className="remotehand-tab-action"
title="Close tab"
aria-label="Close tab"
onPointerDown={stopTabActionPointer}
onClick={(event) => runTabAction(event, () => props.api.close())}
>
<svg viewBox="0 0 16 16" aria-hidden="true">
<path d="M4 4l8 8" />
<path d="M12 4 4 12" />
</svg>
</button>
</>
) : null}
</div>
);
}

function LegacyPluginSidebarIcon({ icon }: { icon: string }) {
if (icon === "monitor-pulse") {
return (
<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
<rect x="2.5" y="3.5" width="15" height="11" rx="2" />
<path d="M5 9h2l1.5-3 2.2 6 1.8-4 1 1H15" />
<path d="M7.5 17h5" />
<path d="M10 14.5V17" />
</svg>
);
}
return <>◇</>;
}

function PluginSidebarIcon({ pluginId, icon }: { pluginId: string; icon: string }) {
const [asset, setAsset] = useState<{ src: string; mimeType: string } | null>(null);
useEffect(() => {
if (!icon || icon === "monitor-pulse" || !isTauri()) {
setAsset(null);
return;
}
let disposed = false;
let objectUrl: string | null = null;
void invoke<{ mimeType: string; bytes: number[] }>("plugin_read_sidebar_icon", { id: pluginId, icon })
.then((result) => {
if (disposed) return;
const blob = new Blob([new Uint8Array(result.bytes)], { type: result.mimeType });
objectUrl = URL.createObjectURL(blob);
setAsset({ src: objectUrl, mimeType: result.mimeType });
})
.catch(() => {
if (!disposed) setAsset(null);
});
return () => {
disposed = true;
if (objectUrl) URL.revokeObjectURL(objectUrl);
};
}, [pluginId, icon]);
if (asset?.mimeType === "image/svg+xml") {
return (
<span
className="plugin-sidebar-icon-mask"
style={{ WebkitMaskImage: `url("${asset.src}")`, maskImage: `url("${asset.src}")` }}
/>
);
}
if (asset) {
return <img className="plugin-sidebar-icon-image" src={asset.src} alt="" draggable={false} />;
}
return <LegacyPluginSidebarIcon icon={icon} />;
}

function App() {
useEffect(() => {
installWebViewShortcutOwnership(document);
installTabDragWindowAssist(document);
}, []);
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
const [globalShortcutDraft, setGlobalShortcutDraft] = useState(() => settings.globalShortcut);
const [globalShortcutCapturing, setGlobalShortcutCapturing] = useState(false);
const [globalShortcutError, setGlobalShortcutError] = useState("");
const [globalShortcutApplying, setGlobalShortcutApplying] = useState(false);
const [settingsOpen, setSettingsOpen] = useState(false);
const [vaultPrompt, setVaultPrompt] = useState<VaultPromptRequest | null>(null);
const vaultPromptRef = useRef<VaultPromptRequest | null>(null);
const vaultPromptQueueRef = useRef<VaultPromptRequest[]>([]);
const vaultPassphraseInputRef = useRef<HTMLInputElement | null>(null);
const [vaultPromptPassphrase, setVaultPromptPassphrase] = useState("");
const [vaultPromptPassphraseConfirm, setVaultPromptPassphraseConfirm] = useState("");
const [vaultPromptError, setVaultPromptError] = useState("");
const [vaultPromptBusy, setVaultPromptBusy] = useState(false);
const [settingsTab, setSettingsTab] = useState<"appearance" | "layout" | "startup" | "vault" | "plugins" | "shortcuts" | "about" | "papa">("appearance");
const [vaultStatus, setVaultStatus] = useState<{ exists: boolean; unlocked: boolean } | null>(null);
const [vaultStatusError, setVaultStatusError] = useState("");
const [vaultActionBusy, setVaultActionBusy] = useState(false);
const closeSettings = useCallback(() => {
setGlobalShortcutDraft(settings.globalShortcut);
setGlobalShortcutCapturing(false);
setGlobalShortcutError("");
setSettingsOpen(false);
}, [settings.globalShortcut]);
const [papaTabUnlocked, setPapaTabUnlocked] = useState(false);
const [papaConfettiActive, setPapaConfettiActive] = useState(false);
const [papaConfettiPosition, setPapaConfettiPosition] = useState<{ top: number; left: number } | null>(null);
const papaTabButtonRef = useRef<HTMLButtonElement | null>(null);
const papaSequenceRef = useRef<string[]>([]);
const papaAudioRef = useRef<HTMLAudioElement | null>(null);
const [pluginSettingsHost, setPluginSettingsHost] = useState<HTMLDivElement | null>(null);
const [plugins, setPlugins] = useState<PluginInfo[]>([]);
const [topbarContributionItems, setTopbarContributionItems] = useState<Array<{ id: string; label: string }>>([]);
const topbarViewportRef = useRef<HTMLDivElement | null>(null);
const [topbarOverflowing, setTopbarOverflowing] = useState(false);
const [topbarAtStart, setTopbarAtStart] = useState(true);
const [topbarAtEnd, setTopbarAtEnd] = useState(true);
const syncTopbarOverflow = useCallback(() => {
const viewport = topbarViewportRef.current;
if (!viewport) return;
const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
setTopbarOverflowing(maxScrollLeft > 1);
setTopbarAtStart(viewport.scrollLeft <= 1);
setTopbarAtEnd(viewport.scrollLeft >= maxScrollLeft - 1);
}, []);
const scrollTopbar = useCallback((direction: -1 | 1) => {
const viewport = topbarViewportRef.current;
if (!viewport) return;
const distance = Math.max(120, Math.round(viewport.clientWidth * 0.72));
viewport.scrollBy({ left: direction * distance, behavior: "smooth" });
}, []);
useEffect(() => {
const viewport = topbarViewportRef.current;
if (!viewport) return;
const content = viewport.querySelector<HTMLElement>(".topbar-contributions");
const observer = new ResizeObserver(() => syncTopbarOverflow());
observer.observe(viewport);
if (content) observer.observe(content);
const frame = window.requestAnimationFrame(syncTopbarOverflow);
return () => {
window.cancelAnimationFrame(frame);
observer.disconnect();
};
}, [syncTopbarOverflow, topbarContributionItems]);
const [pluginSidebarVisibility, setPluginSidebarVisibility] = useState<Record<string, boolean>>({});
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
const [appVersion, setAppVersion] = useState(() => isTauri() ? "—" : "Development");
const apiRef = useRef<DockviewApi | null>(null);
const startupFileHandled = useRef(false);
const restoredRef = useRef(false);
const layoutHistoryRef = useRef<string[]>([]);
const layoutHistoryIndexRef = useRef(-1);
const applyingHistoryRef = useRef(false);
const workspaceSaveTimerRef = useRef<number | null>(null);
const workspacePersistenceEnabledRef = useRef(true);
const poppedOutPanelRef = useRef<{ panelId: string; count: number; window?: Window } | null>(null);
const popoutWindowsRef = useRef<Map<string, RemoteHandPopoutWindow>>(new Map());
const popoutReturnSizesRef = useRef<Map<string, GridGroupSize[]>>(new Map());
const restoredPopoutSizesRef = useRef<GridGroupSize[]>([]);
const restoredPopoutGeometriesRef = useRef<Array<PopoutGeometry | null>>([]);
const mainReturnGroupRef = useRef<Map<string, string>>(new Map());
const lastFocusedElementRef = useRef<HTMLElement | null>(null);
useEffect(() => {
const rememberFocusedElement = (event: FocusEvent) => {
const target = event.target;
if (!(target instanceof HTMLElement)) return;
if (target === document.body || target === document.documentElement) return;
lastFocusedElementRef.current = target;
};
document.addEventListener("focusin", rememberFocusedElement, true);
return () => document.removeEventListener("focusin", rememberFocusedElement, true);
}, []);
useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen("remotehand-global-shortcut-restored", () => {
const target = lastFocusedElementRef.current;
if (!target?.isConnected) return;
window.requestAnimationFrame(() => {
window.requestAnimationFrame(() => {
if (cancelled || !target.isConnected) return;
target.focus({ preventScroll: true });
});
});
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, []);
useEffect(() => {
if (!isTauri()) return;
void invoke<string>("local_os")
.then(setLocalOs)
.catch((error) => console.error("Failed to detect local OS", error));
}, []);
useEffect(() => {
if (!isTauri()) return;
void getVersion()
.then(setAppVersion)
.catch((error) => console.error("Failed to read app version", error));
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
useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<PluginRuntimeEvent>("remotehand-plugin-event", (event) => {
if (event.payload.event !== "sidebar.update") return;
const payload = event.payload.payload;
if (!payload || typeof payload !== "object") return;
const items = (payload as { items?: unknown }).items;
if (!Array.isArray(items)) return;
setPluginSidebarVisibility((current) => {
const next = { ...current };
for (const entry of items) {
if (!entry || typeof entry !== "object") continue;
const value = entry as { id?: unknown; visible?: unknown };
if (typeof value.id !== "string" || !/^[a-z0-9._-]{1,128}$/.test(value.id) || typeof value.visible !== "boolean") continue;
next[`${event.payload.pluginId}:${value.id}`] = value.visible;
}
return next;
});
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
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

const applyHistorySnapshot = useCallback(async (snapshot: string, index: number) => {
const api = apiRef.current;
if (!api) return;
applyingHistoryRef.current = true;
try {
if (isTauri() && api.getPopouts().length > 0) {
try {
await invoke("close_panel_popouts");
} catch (error) {
console.error("Failed to close native popouts before applying workspace history", error);
}
}
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
void applyHistorySnapshot(layoutHistoryRef.current[nextIndex], nextIndex);
}, [applyHistorySnapshot]);

const redoLayout = useCallback(() => {
const index = layoutHistoryIndexRef.current;
const history = layoutHistoryRef.current;
if (index < 0 || index >= history.length - 1) return;
const nextIndex = index + 1;
void applyHistorySnapshot(history[nextIndex], nextIndex);
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
const openPluginPanel = useCallback((plugin: PluginInfo, panelId: string, context?: { targetId?: string; target?: string; view?: string; alertKey?: string; path?: string }) => {
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
useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
const openFileInHandler = (path: string) => {
const leaf = path.split(/[\\/]/).pop() || path;
const dot = leaf.lastIndexOf(".");
if (dot < 0) return;
const extension = leaf.slice(dot + 1).toLowerCase();
const plugin = plugins.find((item) => item.enabled &&
item.manifest.fileHandlers.some((handler) => handler.extensions.some((value) => (value.startsWith(".") ? value.slice(1) : value).toLowerCase() === extension)));
if (!plugin) return;
const handler = plugin.manifest.fileHandlers.find((item) => item.extensions.some((value) => (value.startsWith(".") ? value.slice(1) : value).toLowerCase() === extension));
if (handler) openPluginPanel(plugin, handler.panel, { path });
};
void listen<string>("remotehand-open-file", (event) => openFileInHandler(event.payload)).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => { cancelled = true; unlisten?.(); };
}, [openPluginPanel, plugins]);
useEffect(() => {
if (!isTauri() || startupFileHandled.current || plugins.length === 0) return;
startupFileHandled.current = true;
void invoke<string | null>("startup_open_file_path").then((path) => {
if (!path) return;
const leaf = path.split(/[\\/]/).pop() || path;
const dot = leaf.lastIndexOf(".");
if (dot < 0) return;
const extension = leaf.slice(dot + 1).toLowerCase();
const plugin = plugins.find((item) => item.enabled &&
item.manifest.fileHandlers.some((handler) => handler.extensions.some((value) => (value.startsWith(".") ? value.slice(1) : value).toLowerCase() === extension)));
if (!plugin) return;
const handler = plugin.manifest.fileHandlers.find((item) => item.extensions.some((value) => (value.startsWith(".") ? value.slice(1) : value).toLowerCase() === extension));
if (handler) openPluginPanel(plugin, handler.panel, { path });
}).catch((error) => console.error("Could not route startup file to a plugin", error));
}, [openPluginPanel, plugins]);
useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<PluginOpenPanelEvent>("remotehand-open-plugin-panel", (event) => {
const request = event.payload;
const plugin = plugins.find(
(item) => item.enabled && item.manifest.id === request.pluginId,
);
if (!plugin) return;
openPluginPanel(plugin, request.panelId, request.context);
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, [openPluginPanel, plugins]);
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
const runFunctionShortcut = useCallback((shortcut: string) => {
const actionId = assignedShortcutAction(settings.functionKeyShortcuts, shortcut);
if (!actionId) return false;
if (actionId === "core.commandPalette") {
setPaletteOpen((open) => !open);
return true;
}
if (actionId === "core.home") {
openHome();
return true;
}
if (actionId === "core.connections") {
addConnections();
return true;
}
if (actionId === "core.terminal.default") {
addTerminal();
return true;
}
if (actionId === "core.terminal.powershell") {
addTerminal(undefined, "powershell");
return true;
}
if (actionId === "core.terminal.cmd") {
addTerminal(undefined, "cmd");
return true;
}
if (actionId === "core.terminal.wsl") {
addTerminal(undefined, "wsl");
return true;
}
if (actionId.startsWith("plugin:")) {
const [, pluginId, panelId] = actionId.split(":");
const plugin = plugins.find((item) => item.enabled && item.manifest.id === pluginId);
if (!plugin || !panelId) return false;
openPluginPanel(plugin, panelId);
return true;
}
return false;
}, [addConnections, addTerminal, openHome, openPluginPanel, plugins, settings.functionKeyShortcuts]);
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
const popoutPanel = useCallback(async (panelId?: string) => {
const api = apiRef.current;
const panel = panelId ? api?.getPanel(panelId) : api?.activePanel;
if (!api || !panel) return;
if (panel.api.location.type === "popout") return;
const sourceGroupId = panel.api.group.id;
try {
const opened = await api.addPopoutGroup(panel);
if (opened) {
mainReturnGroupRef.current.set(panel.id, sourceGroupId);
poppedOutPanelRef.current = { panelId: panel.id, count: api.getPopouts().length };
}
} catch (error) {
console.error("Failed to pop out panel", error);
}
}, []);
const popoutActive = useCallback(async () => {
await popoutPanel();
}, [popoutPanel]);
const dockPanel = useCallback((panelId: string) => {
const api = apiRef.current;
const panel = api?.getPanel(panelId);
if (!api || !panel || panel.api.location.type !== "popout") return;
const preservedMainSizes = captureGridGroupSizes(api.groups);
try {
const popoutWindow = panel.api.getWindow() as RemoteHandPopoutWindow;
const nativeLabel = popoutWindow.__REMOTEHAND_NATIVE_WINDOW_LABEL__;
const rememberedGroupId = mainReturnGroupRef.current.get(panelId);
const rememberedGroup = rememberedGroupId
? api.groups.find((group) => group.id === rememberedGroupId && group.api.location.type === "grid")
: undefined;
const fallbackGroup = api.groups.find((group) => group.api.location.type === "grid") ?? api.addGroup();
panel.api.moveTo({
group: rememberedGroup ?? fallbackGroup,
position: rememberedGroup ? "center" : "right",
});
mainReturnGroupRef.current.set(panelId, (rememberedGroup ?? fallbackGroup).id);
panel.api.setActive();

const restoreMainSizes = () => restoreGridGroupSizes(api.groups, preservedMainSizes);
window.requestAnimationFrame(() => {
restoreMainSizes();
window.requestAnimationFrame(restoreMainSizes);
});

if (isTauri() && nativeLabel) {
queueMicrotask(() => {
const stillHasPanels = api.panels.some(
(current) =>
current.api.location.type === "popout" &&
current.api.getWindow() === popoutWindow,
);
if (!stillHasPanels) {
void invoke("close_panel_popout", { label: nativeLabel }).catch((error) =>
console.error("Failed to close emptied native popout", error),
);
}
});
}

if (isTauri()) {
void invoke("focus_main_window").catch((error) =>
console.error("Failed to restore main window after docking panel", error),
);
}
} catch (error) {
console.error("Failed to dock panel back into RemoteHand", error);
}
}, []);
const RemoteHandTab = useCallback((props: IDockviewPanelHeaderProps) => (
<RemoteHandTabView
props={props}
onPopout={(panelId) => { void popoutPanel(panelId); }}
onDock={dockPanel}
onMainGroup={(panelId, groupId) => {
mainReturnGroupRef.current.set(panelId, groupId);
}}
/>
), [dockPanel, popoutPanel]);
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
const nextSettings = { ...DEFAULT_SETTINGS, ...saved, startWithSystem };
setSettings(nextSettings);
setGlobalShortcutDraft(nextSettings.globalShortcut);
if (isTauri()) {
try {
await invoke("vault_set_auto_lock", { minutes: nextSettings.vaultAutoLockMinutes });
} catch (error) {
console.error("Failed to configure Vault auto-lock", error);
}
}
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
const shortcutFromKeyboardEvent = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
if (event.key === "Escape") {
event.preventDefault();
setGlobalShortcutCapturing(false);
setGlobalShortcutDraft(settings.globalShortcut);
setGlobalShortcutError("");
return;
}
if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
event.preventDefault();
return;
}
event.preventDefault();
const parts: string[] = [];
if (event.ctrlKey) parts.push("Ctrl");
if (event.shiftKey) parts.push("Shift");
if (event.altKey) parts.push("Alt");
if (event.metaKey) parts.push("Meta");

let key = event.key;
if (key === " ") key = "Space";
else if (key.length === 1) key = key.toUpperCase();
else if (key === "ArrowUp") key = "Up";
else if (key === "ArrowDown") key = "Down";
else if (key === "ArrowLeft") key = "Left";
else if (key === "ArrowRight") key = "Right";

if (parts.length === 0) {
setGlobalShortcutError("Use at least one modifier key, such as Ctrl or Shift.");
return;
}

parts.push(key);
setGlobalShortcutDraft(parts.join("+"));
setGlobalShortcutCapturing(false);
setGlobalShortcutError("");
}, [settings.globalShortcut]);

const refreshVaultStatus = useCallback(async () => {
if (!isTauri()) {
setVaultStatus({ exists: false, unlocked: false });
setVaultStatusError("");
return;
}
try {
const status = await invoke<{ exists: boolean; unlocked: boolean }>("vault_status");
setVaultStatus(status);
setVaultStatusError("");
} catch (error) {
setVaultStatusError(String(error));
}
}, []);

const unlockVaultFromSettings = useCallback(async () => {
if (vaultActionBusy) return;
setVaultActionBusy(true);
setVaultStatusError("");
try {
await requestVaultAccess("Unlock the RemoteHand Vault from Settings.");
await refreshVaultStatus();
} catch (error) {
setVaultStatusError(String(error));
} finally {
setVaultActionBusy(false);
}
}, [refreshVaultStatus, vaultActionBusy]);

const lockVaultFromSettings = useCallback(async () => {
if (!isTauri() || vaultActionBusy) return;
setVaultActionBusy(true);
setVaultStatusError("");
try {
await invoke("vault_lock");
await refreshVaultStatus();
} catch (error) {
setVaultStatusError(String(error));
} finally {
setVaultActionBusy(false);
}
}, [refreshVaultStatus, vaultActionBusy]);

useEffect(() => {
if (!settingsOpen || settingsTab !== "vault") return;
void refreshVaultStatus();
}, [refreshVaultStatus, settingsOpen, settingsTab]);

useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<{ exists: boolean; unlocked: boolean }>("remotehand-vault-status-changed", (event) => {
setVaultStatus(event.payload);
setVaultStatusError("");
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, []);

const applyGlobalShortcut = useCallback(async (enabled: boolean, shortcut: string) => {
const trimmedShortcut = shortcut.trim();
if (enabled && !trimmedShortcut) {
setGlobalShortcutError("Enter a shortcut before enabling the global shortcut.");
return;
}
setGlobalShortcutApplying(true);
setGlobalShortcutError("");
try {
if (isTauri()) {
await invoke("set_global_shortcut", { enabled, shortcut: trimmedShortcut });
}
setSettings((current) => ({
...current,
globalShortcutEnabled: enabled,
globalShortcut: trimmedShortcut || current.globalShortcut,
}));
if (trimmedShortcut) setGlobalShortcutDraft(trimmedShortcut);
} catch (error) {
setGlobalShortcutError(String(error));
} finally {
setGlobalShortcutApplying(false);
}
}, []);

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
if (!settingsOpen || settingsTab !== "about" || papaTabUnlocked) {
papaSequenceRef.current = [];
return;
}
const sequence = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
const onKeyDown = (event: KeyboardEvent) => {
if (!settingsOpen || settingsTab !== "about") return;
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
}, [settingsOpen, settingsTab, papaTabUnlocked, startPapaAudio]);
useEffect(() => {
if (!papaConfettiActive) {
setPapaConfettiPosition(null);
return;
}
const button = papaTabButtonRef.current;
if (!button) return;
const frame = window.requestAnimationFrame(() => {
const rect = button.getBoundingClientRect();
setPapaConfettiPosition({ top: rect.top + 2, left: rect.left + rect.width / 2 });
});
return () => window.cancelAnimationFrame(frame);
}, [papaConfettiActive, papaTabUnlocked]);
useEffect(() => {
if (!papaConfettiActive) return;
const timer = window.setTimeout(() => setPapaConfettiActive(false), 1400);
return () => window.clearTimeout(timer);
}, [papaConfettiActive]);

useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<VaultPromptRequest>(VAULT_PROMPT_REQUEST_EVENT, (event) => {
const request = event.payload;
if (vaultPromptRef.current) {
enqueueVaultPrompt(vaultPromptQueueRef.current, request);
return;
}
vaultPromptRef.current = request;
setVaultPrompt(request);
setVaultPromptPassphrase("");
setVaultPromptPassphraseConfirm("");
setVaultPromptError("");
setVaultPromptBusy(false);
void invoke("focus_main_window").catch((error) =>
console.error("Failed to focus RemoteHand for Vault unlock", error),
);
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, []);

useEffect(() => {
if (!isTauri()) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<VaultPromptRequest>("remotehand-vault-plugin-access-request", (event) => {
const incoming = event.payload;
const request: VaultPromptRequest = {
...incoming,
source: "plugin",
reason: `Plugin ${incoming.pluginId ?? "unknown"} requests Vault access. ${incoming.reason}`,
};
if (vaultPromptRef.current) {
enqueueVaultPrompt(vaultPromptQueueRef.current, request);
return;
}
vaultPromptRef.current = request;
setVaultPrompt(request);
setVaultPromptPassphrase("");
setVaultPromptPassphraseConfirm("");
setVaultPromptError("");
setVaultPromptBusy(false);
void invoke("focus_main_window").catch((error) =>
console.error("Failed to focus RemoteHand for plugin Vault access", error),
);
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, []);

const finishVaultPrompt = useCallback(async (ok: boolean, error?: string) => {
const request = vaultPromptRef.current;
if (!request) return;

const settle = async (pending: VaultPromptRequest) => {
if (pending.source === "plugin") {
await invoke("vault_resolve_plugin_access_request", {
requestId: pending.requestId,
ok,
error: error ?? null,
});
return;
}
await emit(VAULT_PROMPT_RESULT_EVENT, {
requestId: pending.requestId,
ok,
...(error ? { error } : {}),
});
};

// Keep the active marker in place while settling so any Vault requests that
// arrive during the same unlock are queued and released by this one prompt.
await settleVaultPromptBatch(request, vaultPromptQueueRef.current, settle);

vaultPromptRef.current = null;
setVaultPrompt(null);
setVaultPromptPassphrase("");
setVaultPromptPassphraseConfirm("");
setVaultPromptError("");
setVaultPromptBusy(false);
}, []);

useEffect(() => {
if (!vaultPrompt) return;
let cancelled = false;
const focusPassphrase = () => {
if (cancelled) return;
const input = vaultPassphraseInputRef.current;
if (!input || input.disabled) return;
const active = document.activeElement;
const modal = input.closest(".vault-prompt-modal");
if (modal?.contains(active)) return;
input.focus({ preventScroll: true });
};
const keepVaultPromptFocused = () => {
window.requestAnimationFrame(focusPassphrase);
};
const watchdog = () => {
focusPassphrase();
if (!cancelled) window.requestAnimationFrame(watchdog);
};
const keepVaultPromptKeystrokes = (event: KeyboardEvent) => {
const input = vaultPassphraseInputRef.current;
if (!input || input.disabled) return;
const modal = input.closest(".vault-prompt-modal");
const target = event.target;
if (target instanceof Node && modal?.contains(target)) return;
if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) {
event.preventDefault();
event.stopImmediatePropagation();
focusPassphrase();
return;
}
event.preventDefault();
event.stopImmediatePropagation();
focusPassphrase();
setVaultPromptPassphrase((current) => current + event.key);
};
document.addEventListener("focusin", keepVaultPromptFocused, true);
window.addEventListener("keydown", keepVaultPromptKeystrokes, true);
const frame = window.requestAnimationFrame(watchdog);
return () => {
cancelled = true;
window.cancelAnimationFrame(frame);
document.removeEventListener("focusin", keepVaultPromptFocused, true);
window.removeEventListener("keydown", keepVaultPromptKeystrokes, true);
};
}, [vaultPrompt]);

const confirmVaultPrompt = useCallback(async () => {
const request = vaultPromptRef.current;
if (!request || vaultPromptBusy) return;
if (!vaultPromptPassphrase) {
setVaultPromptError("Enter the Vault passphrase.");
return;
}
if (request.create && vaultPromptPassphrase !== vaultPromptPassphraseConfirm) {
setVaultPromptError("Vault passphrases do not match.");
return;
}
setVaultPromptBusy(true);
setVaultPromptError("");
try {
if (request.create) {
await invoke("vault_initialize", { passphrase: vaultPromptPassphrase });
} else {
await invoke("vault_unlock", { passphrase: vaultPromptPassphrase });
}
await finishVaultPrompt(true);
} catch (error) {
setVaultPromptError(String(error));
setVaultPromptBusy(false);
}
}, [finishVaultPrompt, vaultPromptBusy, vaultPromptPassphrase, vaultPromptPassphraseConfirm]);

const cancelVaultPrompt = useCallback(() => {
if (vaultPromptBusy) return;
void finishVaultPrompt(false, "Vault access was cancelled.");
}, [finishVaultPrompt, vaultPromptBusy]);

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
const openSettingsFromFunctionKey = (tab: "appearance" | "about") => {
setSettingsTab(tab);
setSettingsOpen(true);
};
const onKeyDown = (event: KeyboardEvent) => {
const mappedShortcut = functionShortcutFromKeyboardEvent(event.key, event);
if (mappedShortcut) {
event.preventDefault();
event.stopImmediatePropagation();
runFunctionShortcut(mappedShortcut);
return;
}
const functionKeyDisposition = remoteHandFunctionKeyDisposition(event.key, event);
if (functionKeyDisposition !== "none") {
event.preventDefault();
if (functionKeyDisposition === "about") {
event.stopImmediatePropagation();
openSettingsFromFunctionKey("about");
return;
}
if (functionKeyDisposition === "blocked") {
event.stopImmediatePropagation();
return;
}
// Plain F5 is allowed to continue to an intentional plugin-specific handler,
// but the WebView/browser default refresh action remains suppressed.
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
const onOpenAbout = () => openSettingsFromFunctionKey("about");
const onMappedFunctionShortcut = (event: Event) => {
const shortcut = (event as CustomEvent<string>).detail;
if (typeof shortcut === "string") runFunctionShortcut(shortcut);
};
window.addEventListener("keydown", onKeyDown, true);
window.addEventListener("remotehand-open-about", onOpenAbout);
window.addEventListener("remotehand-function-shortcut", onMappedFunctionShortcut);
return () => {
window.removeEventListener("keydown", onKeyDown, true);
window.removeEventListener("remotehand-open-about", onOpenAbout);
window.removeEventListener("remotehand-function-shortcut", onMappedFunctionShortcut);
};
}, [redoLayout, runFunctionShortcut, undoLayout]);
const handleReady = async (event: DockviewReadyEvent) => {
apiRef.current = event.api;
event.api.onWillDragPanel((dragEvent) => {
beginWorkspaceTabDrag(dragEvent.panel.api.getWindow());
});
if (isTauri()) {
try {
const saved = await invoke<WorkspaceLayout | null>("load_workspace");
if (saved) {
restoredPopoutSizesRef.current = extractPopoutGridGroupSizes(saved);
restoredPopoutGeometriesRef.current = extractPopoutGeometries(saved);
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
const parsed = JSON.parse(saved) as WorkspaceLayout;
restoredPopoutSizesRef.current = extractPopoutGridGroupSizes(parsed);
restoredPopoutGeometriesRef.current = extractPopoutGeometries(parsed);
event.api.fromJSON(parsed);
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
event.api.onDidLayoutChange(() => {
captureLayout(event.api);
releaseWorkspaceTabDragAssist();
});
event.api.onDidPopoutGroupSizeChange(() => {
captureLayout(event.api);
});
event.api.onDidPopoutGroupPositionChange(() => {
captureLayout(event.api);
});
event.api.onDidAddPopoutGroup((popout) => {
const restoreSavedPopoutSizes = () => {
const matchingGroups = event.api.groups.filter(
(group) =>
group.api.location.type === "popout" &&
group.api.getWindow() === popout.window,
);
restoreGridGroupSizes(matchingGroups, restoredPopoutSizesRef.current);
};
window.requestAnimationFrame(() => {
restoreSavedPopoutSizes();
window.requestAnimationFrame(restoreSavedPopoutSizes);
});
const nativePopout = popout.window as RemoteHandPopoutWindow;
const nativeLabel = nativePopout.__REMOTEHAND_NATIVE_WINDOW_LABEL__;
const savedGeometry = restoredPopoutGeometriesRef.current.shift();
if (isTauri() && nativeLabel && savedGeometry) {
void invoke("set_panel_popout_geometry", {
label: nativeLabel,
x: savedGeometry.left,
y: savedGeometry.top,
width: savedGeometry.width,
height: savedGeometry.height,
}).catch((error) => {
console.error("Failed to restore panel popout geometry", error);
});
}
if (!vaultPromptRef.current) {
popout.group.activePanel?.api.setActive();
popout.window.focus();
}
popoutWindowsRef.current.set(popout.id, nativePopout);
const rememberMainSizesBeforeReturn = () => {
popoutReturnSizesRef.current.set(popout.id, captureGridGroupSizes(event.api.groups));
};
popout.window.addEventListener("beforeunload", rememberMainSizesBeforeReturn, { once: true, capture: true });
poppedOutPanelRef.current = {
panelId: popout.group.activePanel?.id ?? poppedOutPanelRef.current?.panelId ?? "",
count: event.api.getPopouts().length,
window: popout.window,
};
const targetDocument = popout.window.document;
installWebViewShortcutOwnership(targetDocument);
installTabDragWindowAssist(targetDocument);
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
const vaultPromptActive = vaultPromptRef.current !== null;
void invoke("show_pending_popout", { focus: !vaultPromptActive })
.then(() => {
if (vaultPromptActive) {
return invoke("focus_main_window");
}
})
.catch((error) => {
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
event.api.onDidRemovePopoutGroup((removedPopout) => {
const popoutWindow = popoutWindowsRef.current.get(removedPopout.id);
popoutWindowsRef.current.delete(removedPopout.id);
const preservedMainSizes = popoutReturnSizesRef.current.get(removedPopout.id) ?? [];
popoutReturnSizesRef.current.delete(removedPopout.id);
const nativeLabel = popoutWindow?.__REMOTEHAND_NATIVE_WINDOW_LABEL__;
const restoreMainSizes = () => restoreGridGroupSizes(event.api.groups, preservedMainSizes);
window.requestAnimationFrame(() => {
restoreMainSizes();
window.requestAnimationFrame(restoreMainSizes);
});
window.setTimeout(() => {
if (popoutWindow && !popoutWindow.closed) {
popoutWindow.close();
}
if (isTauri() && nativeLabel) {
void invoke("close_panel_popout", { label: nativeLabel }).catch(() => undefined);
}
const panelId = poppedOutPanelRef.current?.panelId;
if (panelId) {
event.api.getPanel(panelId)?.api.setActive();
}
poppedOutPanelRef.current = null;
}, 0);
});
event.api.onDidRemovePanel((panel) => {
const sessionId = panel.id;
const panelWindow =
panel.api.location.type === "popout"
? (panel.api.getWindow() as RemoteHandPopoutWindow)
: undefined;
const nativeLabel = panelWindow?.__REMOTEHAND_NATIVE_WINDOW_LABEL__;
window.setTimeout(() => {
if (event.api.getPanel(sessionId)) return;
if (!panelWindow) return;
const popoutStillHasPanels = event.api.panels.some(
(current) =>
current.api.location.type === "popout" &&
current.api.getWindow() === panelWindow,
);
if (popoutStillHasPanels) return;
if (!panelWindow.closed) {
panelWindow.close();
}
if (!isTauri() || !nativeLabel) return;
void invoke("close_panel_popout", { label: nativeLabel }).catch((error) => {
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
{ label: "Manage plugins", hint: "Add-ons", run: () => { setSettingsTab("plugins"); setSettingsOpen(true); } },
{ label: "Float active panel", hint: "Layout", run: popoutActive },
{ label: "Undo layout change", hint: "Ctrl/Cmd+Z", run: undoLayout },
{ label: "Redo layout change", hint: "Ctrl/Cmd+Y", run: redoLayout },
{ label: "Reset workspace layout", hint: "Reset", run: resetLayout },
];
const filteredCommands = commands.filter((command) =>
command.label.toLowerCase().includes(paletteQuery.toLowerCase()),
);

const functionShortcutActions = [
{ id: "core.commandPalette", label: "Command Palette", detail: "Open or close the RemoteHand command palette." },
{ id: "core.home", label: "Home", detail: "Open or focus the Home panel." },
{ id: "core.connections", label: "Connections", detail: "Open or focus the Connections panel." },
...(localOs === "windows"
? [
{ id: "core.terminal.powershell", label: "New PowerShell", detail: "Open a new local PowerShell terminal." },
{ id: "core.terminal.cmd", label: "New Command Prompt", detail: "Open a new local Command Prompt terminal." },
{ id: "core.terminal.wsl", label: "New WSL Terminal", detail: "Open a new local WSL terminal." },
]
: [
{ id: "core.terminal.default", label: "New Terminal", detail: "Open a new local terminal." },
]),
...plugins.flatMap((plugin) =>
plugin.enabled
? plugin.manifest.contributes.panels.map((panel) => ({
id: `plugin:${plugin.manifest.id}:${panel.id}`,
label: panel.title,
detail: `${plugin.manifest.name} plugin`,
}))
: [],
),
];
const setFunctionShortcut = (actionId: string, shortcut: string) => {
setSettings((current) => ({
...current,
functionKeyShortcuts: assignFunctionShortcut(current.functionKeyShortcuts, actionId, shortcut),
}));
};

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
? plugin.manifest.contributes.sidebar
.filter((sidebar) => pluginSidebarVisibility[`${plugin.manifest.id}:${sidebar.id}`] !== false)
.map((sidebar) => ({
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

const topbarCatalog = [...topbarContributionItems];
const topbarAvailableIds = topbarCatalog.map((item) => item.id);
const topbarFallbackIds = topbarContributionItems.map((item) => item.id);
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
{topbarOverflowing ? (
<button
className="topbar-scroll-button"
type="button"
onClick={() => scrollTopbar(-1)}
disabled={topbarAtStart}
title="Show previous top-bar items"
aria-label="Show previous top-bar items"
>
‹
</button>
) : null}
<div
className="topbar-contribution-viewport"
ref={topbarViewportRef}
onScroll={syncTopbarOverflow}
>
<div className={`topbar-contributions align-${settings.topbarAlignment}${topbarOverflowing ? " overflowing" : ""}`} />
</div>
{topbarOverflowing ? (
<button
className="topbar-scroll-button"
type="button"
onClick={() => scrollTopbar(1)}
disabled={topbarAtEnd}
title="Show next top-bar items"
aria-label="Show next top-bar items"
>
›
</button>
) : null}
<button
className="topbar-button icon-button settings-button"
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
? plugin.manifest.contributes.sidebar
.filter((sidebar) => pluginSidebarVisibility[plugin.manifest.id + ":" + sidebar.id] !== false)
.map((sidebar) => (
<button
className="sidebar-action"
style={{ order: 100 + contributionOrderIndex(resolvedSidebarOrder, plugin.manifest.id + ":" + sidebar.id) }}
type="button"
key={plugin.manifest.id + ":" + sidebar.id}
onClick={() => openPluginPanel(plugin, sidebar.panel)}
title={sidebar.title}
>
<span className="sidebar-icon" aria-hidden="true"><PluginSidebarIcon pluginId={plugin.manifest.id} icon={sidebar.icon} /></span>
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
defaultTabComponent={RemoteHandTab}
components={components}
watermarkComponent={WorkspaceWatermark}
onReady={handleReady}
keyboardNavigation
dndStrategy="auto"
popoutUrl="popout.html"
/>
</div>
{!workspaceReady && <div className="workspace-loading">Preparing workspace…</div>}
</section>
</section>
<PluginManager
open={settingsOpen && settingsTab === "plugins"}
onClose={closeSettings}
embedded
embeddedHost={pluginSettingsHost}
onChanged={() => void refreshPlugins()}
topbarOrder={resolvedTopbarOrder}
onTopbarItemsChanged={setTopbarContributionItems}
onOpenPluginPanel={(pluginId, panelId, context) => {
const plugin = plugins.find((item) => item.manifest.id === pluginId);
if (plugin) openPluginPanel(plugin, panelId, context);
}}
/>
<AppModal
open={vaultPrompt !== null}
title={vaultPrompt?.create ? "Create RemoteHand Vault" : "Unlock RemoteHand Vault"}
className="vault-prompt-modal"
confirmLabel={vaultPromptBusy ? (vaultPrompt?.create ? "Creating…" : "Unlocking…") : (vaultPrompt?.create ? "Create Vault" : "Unlock")}
cancelLabel="Cancel"
onConfirm={() => { void confirmVaultPrompt(); }}
onCancel={cancelVaultPrompt}
focusActions={false}
restoreFocus
elevated
>
<div className="vault-prompt">
<p>{vaultPrompt?.reason}</p>
{vaultPrompt?.create ? (
<p className="vault-prompt-note">Choose a passphrase for this RemoteHand Vault. RemoteHand does not store the passphrase and cannot recover it for you.</p>
) : (
<p className="vault-prompt-note">Enter your RemoteHand Vault passphrase to continue.</p>
)}
<label>
<span>Vault passphrase</span>
<input
ref={vaultPassphraseInputRef}
type="password"
value={vaultPromptPassphrase}
onChange={(event) => setVaultPromptPassphrase(event.target.value)}
onKeyDown={(event) => {
if (event.key === "Enter") void confirmVaultPrompt();
}}
autoComplete={vaultPrompt?.create ? "new-password" : "current-password"}
autoFocus
disabled={vaultPromptBusy}
/>
</label>
{vaultPrompt?.create ? (
<label>
<span>Confirm Vault passphrase</span>
<input
type="password"
value={vaultPromptPassphraseConfirm}
onChange={(event) => setVaultPromptPassphraseConfirm(event.target.value)}
onKeyDown={(event) => {
if (event.key === "Enter") void confirmVaultPrompt();
}}
autoComplete="new-password"
disabled={vaultPromptBusy}
/>
</label>
) : null}
{vaultPromptError ? <div className="vault-prompt-error">{vaultPromptError}</div> : null}
</div>
</AppModal>
<AppModal
open={settingsOpen}
title="Settings"
className="settings-modal"
confirmLabel={settingsTab === "papa" ? "Always" : "Done"}
onConfirm={closeSettings}
onCancel={closeSettings}
focusActions={false}
focusDialog
restoreFocus
tabs={<div className="settings-tabs" role="tablist" aria-label="Settings sections">
<button type="button" role="tab" aria-selected={settingsTab === "appearance"} className={settingsTab === "appearance" ? "active" : ""} onClick={() => setSettingsTab("appearance")}>Appearance</button>
<button type="button" role="tab" aria-selected={settingsTab === "layout"} className={settingsTab === "layout" ? "active" : ""} onClick={() => setSettingsTab("layout")}>Interface</button>
<button type="button" role="tab" aria-selected={settingsTab === "startup"} className={settingsTab === "startup" ? "active" : ""} onClick={() => setSettingsTab("startup")}>Startup &amp; Tray</button>
<button type="button" role="tab" aria-selected={settingsTab === "vault"} className={settingsTab === "vault" ? "active" : ""} onClick={() => setSettingsTab("vault")}>Vault</button>
<button type="button" role="tab" aria-selected={settingsTab === "plugins"} className={settingsTab === "plugins" ? "active" : ""} onClick={() => setSettingsTab("plugins")}>Plugins</button>
<button type="button" role="tab" aria-selected={settingsTab === "shortcuts"} className={settingsTab === "shortcuts" ? "active" : ""} onClick={() => setSettingsTab("shortcuts")}>Keyboard Shortcuts</button>
<button type="button" role="tab" aria-selected={settingsTab === "about"} className={settingsTab === "about" ? "active" : ""} onClick={() => setSettingsTab("about")}>About</button>
{papaTabUnlocked ? <span className="papa-tab-reveal"><button ref={papaTabButtonRef} type="button" role="tab" aria-selected={settingsTab === "papa"} className={settingsTab === "papa" ? "active" : ""} onClick={() => { setSettingsTab("papa"); startPapaAudio(); }}>Papa</button></span> : null}
{papaConfettiActive && papaConfettiPosition ? createPortal(<span className="papa-heart-confetti" aria-hidden="true" style={{ top: papaConfettiPosition.top, left: papaConfettiPosition.left }}>{Array.from({ length: 10 }, (_, index) => <span key={index}>♥</span>)}</span>, document.body) : null}
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
<div className="settings-section-heading" style={{ marginTop: 8 }}>
<strong>Global shortcut</strong>
<span>Show, focus, or tuck away the existing RemoteHand window from anywhere.</span>
</div>
<label className="settings-toggle">
<input
type="checkbox"
checked={settings.globalShortcutEnabled}
disabled={globalShortcutApplying}
onChange={(event) => void applyGlobalShortcut(event.target.checked, globalShortcutDraft)}
/>
<span><strong>Enable Global RemoteHand Shortcut</strong><small>Press the shortcut anywhere to show and focus RemoteHand. Press it again while RemoteHand is focused to hide it to the system tray, or minimize it to the taskbar when the tray icon is disabled.</small></span>
</label>
<div className="settings-field">
<label htmlFor="global-shortcut">Shortcut</label>
<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
<input
id="global-shortcut"
type="text"
readOnly
value={globalShortcutCapturing ? "" : globalShortcutDraft}
disabled={globalShortcutApplying}
onFocus={() => {
setGlobalShortcutCapturing(true);
setGlobalShortcutError("");
}}
onBlur={() => setGlobalShortcutCapturing(false)}
onKeyDown={shortcutFromKeyboardEvent}
placeholder={globalShortcutCapturing ? "Press shortcut…" : "Ctrl+Shift+Space"}
aria-label="Global shortcut"
/>
<button
type="button"
className="settings-reset"
disabled={globalShortcutApplying || (settings.globalShortcutEnabled && !globalShortcutDraft.trim())}
onClick={() => void applyGlobalShortcut(settings.globalShortcutEnabled, globalShortcutDraft)}
>
{globalShortcutApplying ? "Applying…" : "Apply"}
</button>
</div>
<small style={{ color: "#718094", lineHeight: 1.4 }}>Click the field, then press the shortcut you want. Press Esc to cancel. Default: Ctrl + Shift + Space.</small>
{globalShortcutError ? <small style={{ color: "var(--danger, #e25b5b)", lineHeight: 1.4 }}>{globalShortcutError}</small> : null}
</div>
</div>
) : settingsTab === "vault" ? (
<div className="settings-tab-content">
<div className="settings-section-heading">
<strong>RemoteHand Vault</strong>
<span>Manage the core-owned encrypted Vault used by RemoteHand and authorized plugins.</span>
</div>
<div style={{ display: "grid", gap: 12, marginTop: 14 }}>
<div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "12px 13px", border: "1px solid var(--border)", borderRadius: 8 }}>
<div style={{ display: "grid", gap: 4 }}>
<strong>Status</strong>
<span className="app-modal-muted">
{vaultStatus === null ? "Checking Vault status…" : !vaultStatus.exists ? "Not initialized" : vaultStatus.unlocked ? "Unlocked" : "Locked"}
</span>
</div>
{vaultStatus?.exists ? (
vaultStatus.unlocked ? (
<button type="button" className="settings-reset" disabled={vaultActionBusy} onClick={() => void lockVaultFromSettings()}>
{vaultActionBusy ? "Locking…" : "Lock Vault"}
</button>
) : (
<button type="button" className="settings-reset" disabled={vaultActionBusy} onClick={() => void unlockVaultFromSettings()}>
{vaultActionBusy ? "Unlocking…" : "Unlock Vault"}
</button>
)
) : null}
</div>
<div className="plugin-security-note">
<strong>Security</strong>
<span>The Vault passphrase is entered only in RemoteHand's host-owned prompt. Plugins never receive the passphrase or the Vault master key.</span>
</div>
<div className="settings-field">
<label htmlFor="vault-auto-lock">Auto-lock after Vault inactivity</label>
<select
id="vault-auto-lock"
value={settings.vaultAutoLockMinutes}
disabled={vaultActionBusy}
onChange={(event) => {
const minutes = Number(event.target.value);
setSettings((current) => ({ ...current, vaultAutoLockMinutes: minutes }));
if (isTauri()) {
void invoke("vault_set_auto_lock", { minutes }).catch((error) => setVaultStatusError(String(error)));
}
}}
>
<option value={5}>5 minutes</option>
<option value={15}>15 minutes</option>
<option value={30}>30 minutes</option>
<option value={60}>60 minutes</option>
<option value={0}>Never</option>
</select>
<small style={{ color: "#718094", lineHeight: 1.4 }}>Default: 15 minutes. The timer resets whenever protected Vault data is read or changed.</small>
</div>
{!vaultStatus?.exists ? (
<div className="plugin-security-note">
<strong>Initialization</strong>
<span>The Vault is created automatically the first time RemoteHand needs to save protected data.</span>
</div>
) : null}
{vaultStatusError ? <div className="plugin-error">{vaultStatusError}</div> : null}
</div>
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
<div className="settings-field" style={{ marginBottom: 10 }}>
<span>Alignment</span>
<div className="settings-segmented">
{(["left", "center", "right"] as TopbarAlignment[]).map((alignment) => (
<button
key={alignment}
type="button"
className={settings.topbarAlignment === alignment ? "active" : ""}
onClick={() => setSettings((current) => ({ ...current, topbarAlignment: alignment }))}
>
{alignment[0].toUpperCase() + alignment.slice(1)}
</button>
))}
</div>
<small style={{ color: "#718094", lineHeight: 1.4 }}>Applies when all top-bar items fit. Overflowing items use the paging strip.</small>
</div>
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
<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
<button type="button" className="settings-reset" onClick={resetContributionOrdering}>Reset interface order</button>
<button type="button" className="settings-reset" onClick={resetLayout}>Reset workspace layout</button>
</div>
</div>
) : settingsTab === "plugins" ? (
<div className="settings-tab-content">
<div className="settings-section-heading">
<span>Install, enable, disable, and remove RemoteHand plugins.</span>
</div>
<div ref={setPluginSettingsHost} />
</div>
) : settingsTab === "shortcuts" ? (
<div className="settings-tab-content">
<div className="settings-section-heading">
<strong>Function key mapper</strong>
<span>Assign Ctrl+F1 through Ctrl+F12 to RemoteHand actions or enabled plugin panels. Assigning a shortcut automatically clears it from any previous action.</span>
</div>
<div style={{ display: "grid", gap: 8, marginTop: 14 }}>
{functionShortcutActions.map((action) => (
<div
key={action.id}
style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 150px", gap: 12, alignItems: "center", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8 }}
>
<div style={{ minWidth: 0, display: "grid", gap: 3 }}>
<strong>{action.label}</strong>
<span className="app-modal-muted" style={{ fontSize: 11, lineHeight: 1.4 }}>{action.detail}</span>
</div>
<select
aria-label={`Shortcut for ${action.label}`}
value={settings.functionKeyShortcuts[action.id] ?? ""}
onChange={(event) => setFunctionShortcut(action.id, event.target.value)}
style={{ width: "100%", border: "1px solid #2b3747", borderRadius: 7, background: "#0d141d", color: "#d2dae5", padding: "8px 10px", outline: "none" }}
>
<option value="">Unassigned</option>
{REMOTEHAND_FUNCTION_SHORTCUTS.map((shortcut) => (
<option key={shortcut} value={shortcut}>{shortcut}</option>
))}
</select>
</div>
))}
</div>
<div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
<button
type="button"
className="settings-reset"
onClick={() => setSettings((current) => ({ ...current, functionKeyShortcuts: { ...DEFAULT_SETTINGS.functionKeyShortcuts } }))}
>
Reset shortcuts
</button>
</div>
<div className="plugin-security-note" style={{ marginTop: 14 }}>
<strong>Shortcut ownership</strong>
<span>RemoteHand owns mapped Ctrl+function-key combinations even while focus is inside a plugin panel. Plain F5 remains available for intentional plugin-specific behavior. Ctrl+K is no longer used by the Command Palette.</span>
</div>
</div>
) : settingsTab === "about" ? (
<div className="settings-tab-content">
<div style={{ display: "grid", gap: 22 }}>
<section style={{ display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: 18, alignItems: "center", paddingBottom: 4 }}>
<img src={aboutIcon} alt="" aria-hidden="true" width="80" height="80" style={{ width: 80, height: 80, borderRadius: 18 }} />
<div style={{ minWidth: 0 }}>
<strong style={{ display: "block", fontSize: 22, lineHeight: 1.15 }}>RemoteHand</strong>
<span className="app-modal-muted" style={{ display: "block", marginTop: 5 }}>Version {appVersion}</span>
<span className="app-modal-muted" style={{ display: "block", marginTop: 8, lineHeight: 1.5 }}>Portable remote workstation manager for Windows and Linux.</span>
</div>
</section>
<section style={{ display: "grid", gap: 12, paddingTop: 4 }}>
<strong>Application</strong>
<div style={{ display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", gap: "9px 18px" }}>
<span className="app-modal-muted">Version</span><strong>{appVersion}</strong>
<span className="app-modal-muted">Operating system</span><strong>{localOs === "windows" ? "Windows" : (localOs || "Unknown")}</strong>
<span className="app-modal-muted">Data model</span><strong>Portable</strong>
<span className="app-modal-muted">Plugin API</span><strong>v1</strong>
<span className="app-modal-muted">License</span><strong>MIT</strong>
</div>
</section>
<section style={{ display: "grid", gap: 9, paddingTop: 2 }}>
<strong>What RemoteHand includes</strong>
<span className="app-modal-muted" style={{ lineHeight: 1.55 }}>Local terminals, SSH sessions, SFTP file management, saved connections, encrypted portable credentials, dockable workspaces, popout windows, system-tray integration, and out-of-process plugins.</span>
</section>
<section style={{ display: "grid", gap: 9, paddingTop: 2 }}>
<strong>Architecture</strong>
<span className="app-modal-muted" style={{ lineHeight: 1.55 }}>Tauri 2 desktop shell with a React + TypeScript frontend and Rust backend. RemoteHand core owns generic infrastructure while plugins own feature-specific behavior.</span>
</section>
<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
<button type="button" className="settings-reset" onClick={() => void invoke("open_external_url", { url: "https://github.com/webbytenchi/remotehand" }).catch((error) => console.error("Failed to open repository", error))}>Repository</button>
<button type="button" className="settings-reset" onClick={() => void invoke("open_external_url", { url: "https://github.com/webbytenchi/remotehand/releases" }).catch((error) => console.error("Failed to open releases", error))}>Releases</button>
<button type="button" className="settings-reset" onClick={() => void invoke("open_external_url", { url: "https://github.com/webbytenchi/remotehand/tree/main/docs" }).catch((error) => console.error("Failed to open documentation", error))}>Documentation</button>
<button type="button" className="settings-reset" onClick={() => void invoke("open_external_url", { url: "https://github.com/webbytenchi/remotehand/blob/main/LICENSE" }).catch((error) => console.error("Failed to open license", error))}>MIT License</button>
</div>
</div>
</div>
) : (
<div className="settings-tab-content papa-settings">
<div className="papa-message">
<strong>I Love You Andami...</strong>
<span>Papa</span>
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
