import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  REMOTEHAND_FUNCTION_KEYS,
  shouldPluginFramePreventFunctionKeyDefault,
} from "./functionKeys";
import {
REMOTEHAND_BROWSER_PRIMARY_KEYS,
REMOTEHAND_BROWSER_PRIMARY_SHIFT_KEYS,
} from "./browserShortcuts";
export type PluginPanelParams = {
pluginId: string;
panelId: string;
title: string;
context?: { targetId?: string; target?: string; view?: string; alertKey?: string; path?: string };
};
type PluginContext = PluginPanelParams["context"];
type PluginContextHandler = (context: PluginContext) => void;
const pluginContextHandlers = new Map<string, PluginContextHandler>();
const pluginPanelSessionState = new Map<string, unknown>();
const pluginContextKey = (pluginId: string, panelId: string) => pluginId + ":" + panelId;
const MAX_PLUGIN_PANEL_SESSION_STATE_BYTES = 256 * 1024;
export function sendPluginPanelContext(pluginId: string, panelId: string, context: PluginContext) {
pluginContextHandlers.get(pluginContextKey(pluginId, panelId))?.(context);
}
type PluginBridgeRequest = {
type: "remotehand.plugin.request";
requestId: string;
method: string;
params?: unknown;
};
type PluginBridgeDetachedRequest =
| { type: "remotehand.plugin.detached.start"; requestId: string; method: string; params?: unknown }
| { type: "remotehand.plugin.detached.status"; requestId: string; callId: string }
| { type: "remotehand.plugin.detached.forget"; requestId: string; callId: string };
type PluginHostFunctionKeyMessage = {
type: "remotehand.host.function-key";
key: string;
ctrlKey?: boolean;
altKey?: boolean;
metaKey?: boolean;
shiftKey?: boolean;
};
type PluginSessionStateMessage = {
type: "remotehand.plugin.session-state";
state?: unknown;
};
type PluginBridgeResponse = {
type: "remotehand.plugin.response";
requestId: string;
ok: boolean;
result?: unknown;
error?: string;
};
type PluginRuntimeEvent = {
pluginId: string;
event: string;
payload: unknown;
};
type PluginBridgeEvent = {
type: "remotehand.plugin.event" | "remotehand.host.event";
event: string;
payload: unknown;
};
type NativeFileDropEvent = {
pluginId: string;
panelId: string;
paths: string[];
position: { x: number; y: number };
};
type PluginAppearance = {
theme: "dark" | "light";
colorScheme: string;
uiFontFamily: string;
uiFontSize: string;
terminalFontFamily: string;
terminalFontSize: string;
terminalBackground: string;
terminalForeground: string;
colors: {
background: string;
surface: string;
surfaceRaised: string;
border: string;
text: string;
mutedText: string;
inputBackground: string;
buttonBackground: string;
buttonHover: string;
accent: string;
accentBorder: string;
accentSurface: string;
accentSurfaceHover: string;
dangerText: string;
dangerBorder: string;
dangerSurface: string;
successText: string;
successSurface: string;
};
};
type PluginAppearanceMessage = {
type: "remotehand.appearance";
appearance: PluginAppearance;
};
const PLUGIN_SECURITY_HEAD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src data:; media-src data: blob:; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none';">`;
const PLUGIN_NATIVE_UI_STYLE = `
<style data-remotehand-native-ui>
html,
body {
  user-select: none;
  -webkit-user-select: none;
}
input,
textarea,
[contenteditable="true"],
[data-remotehand-selectable="true"] {
  user-select: text;
  -webkit-user-select: text;
}
</style>`;
const PLUGIN_SCROLLBAR_STYLE = `
<style data-remotehand-scrollbars>
:root {
  --remotehand-scrollbar-size: 8px;
  --remotehand-scrollbar-thumb: rgba(148, 163, 184, 0.38);
  --remotehand-scrollbar-thumb-hover: rgba(168, 185, 210, 0.62);
}
:root[data-remotehand-theme="light"] {
  --remotehand-scrollbar-thumb: rgba(71, 85, 105, 0.40);
  --remotehand-scrollbar-thumb-hover: rgba(51, 65, 85, 0.62);
}
* {
  scrollbar-width: thin !important;
  scrollbar-color: var(--remotehand-scrollbar-thumb) transparent !important;
}
*::-webkit-scrollbar {
  width: var(--remotehand-scrollbar-size) !important;
  height: var(--remotehand-scrollbar-size) !important;
}
*::-webkit-scrollbar-track {
  background: transparent !important;
}
*::-webkit-scrollbar-thumb {
  min-height: 28px;
  border: 2px solid transparent !important;
  border-radius: 999px !important;
  background: var(--remotehand-scrollbar-thumb) !important;
  background-clip: padding-box !important;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--remotehand-scrollbar-thumb-hover) !important;
  background-clip: padding-box !important;
}
*::-webkit-scrollbar-corner {
  background: transparent !important;
}
</style>`;
function bridgeScript(pluginId: string, panelId: string, initialSessionState: unknown) {
const pluginIdJson = JSON.stringify(pluginId);
const panelIdJson = JSON.stringify(panelId);
const initialSessionStateJson = JSON.stringify(initialSessionState ?? null);
const functionKeysJson = JSON.stringify(REMOTEHAND_FUNCTION_KEYS);
const pluginFrameFunctionKeyPolicyJson = JSON.stringify(
  REMOTEHAND_FUNCTION_KEYS.reduce<Record<string, Record<string, boolean>>>((policy, key) => {
    policy[key] = {
      plain: shouldPluginFramePreventFunctionKeyDefault(key, {
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
      ctrl: shouldPluginFramePreventFunctionKeyDefault(key, {
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
      alt: shouldPluginFramePreventFunctionKeyDefault(key, {
        ctrlKey: false,
        altKey: true,
        metaKey: false,
        shiftKey: false,
      }),
      meta: shouldPluginFramePreventFunctionKeyDefault(key, {
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        shiftKey: false,
      }),
      shift: shouldPluginFramePreventFunctionKeyDefault(key, {
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: true,
      }),
    };
    return policy;
  }, {}),
);
const browserPrimaryKeysJson = JSON.stringify(REMOTEHAND_BROWSER_PRIMARY_KEYS);
const browserPrimaryShiftKeysJson = JSON.stringify(REMOTEHAND_BROWSER_PRIMARY_SHIFT_KEYS);
return `
<script>
(() => {
const pluginId = ${pluginIdJson};
const panelId = ${panelIdJson};
window.__REMOTEHAND_PLUGIN_SESSION_STATE__ = ${initialSessionStateJson};
const remoteHandFunctionKeys = new Set(${functionKeysJson});
const pluginFrameFunctionKeyPolicy = ${pluginFrameFunctionKeyPolicyJson};
const remoteHandBrowserPrimaryKeys = new Set(${browserPrimaryKeysJson});
const remoteHandBrowserPrimaryShiftKeys = new Set(${browserPrimaryShiftKeysJson});
let lastFocusedElement = null;
let sequence = 0;
const pending = new Map();
const eventListeners = new Map();
function allowsNativeContextMenu(target) {
if (!(target instanceof Element)) return false;
return Boolean(target.closest('input, textarea, [contenteditable="true"], [data-remotehand-native-context-menu="true"]'));
}
document.addEventListener("contextmenu", (event) => {
if (allowsNativeContextMenu(event.target)) return;
event.preventDefault();
}, true);
function shouldSuppressBrowserShortcut(event) {
const key = String(event.key || "").toLowerCase();
const primary = event.ctrlKey || event.metaKey;
if (primary && !event.altKey) {
if (event.shiftKey && remoteHandBrowserPrimaryShiftKeys.has(key)) return true;
if (remoteHandBrowserPrimaryKeys.has(key)) return true;
}
return event.altKey
&& !event.ctrlKey
&& !event.metaKey
&& !event.shiftKey
&& (key === "arrowleft" || key === "arrowright" || key === "home");
}
document.addEventListener("keydown", (event) => {
if (shouldSuppressBrowserShortcut(event)) event.preventDefault();
if (!remoteHandFunctionKeys.has(event.key)) return;
const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
const policy = pluginFrameFunctionKeyPolicy[event.key];
const modifierKey = event.ctrlKey
? "ctrl"
: event.altKey
? "alt"
: event.metaKey
? "meta"
: event.shiftKey
? "shift"
: "plain";
if (policy && policy[modifierKey]) event.preventDefault();
if (event.key === "F4" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
if (event.key === "F5" && plain) return;
event.stopImmediatePropagation();
lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
parent.postMessage({
type: "remotehand.host.function-key",
key: event.key,
ctrlKey: Boolean(event.ctrlKey),
altKey: Boolean(event.altKey),
metaKey: Boolean(event.metaKey),
shiftKey: Boolean(event.shiftKey)
}, "*");
}, true);
function applyAppearance(appearance) {
if (!appearance || typeof appearance !== "object") return;
const root = document.documentElement;
root.dataset.remotehandTheme = appearance.theme || "dark";
root.dataset.remotehandScheme = appearance.colorScheme || "blue";
if (appearance.uiFontFamily) root.style.setProperty("--remotehand-ui-font-family", appearance.uiFontFamily);
if (appearance.uiFontSize) root.style.setProperty("--remotehand-ui-font-size", appearance.uiFontSize);
if (appearance.terminalFontFamily) root.style.setProperty("--remotehand-terminal-font-family", appearance.terminalFontFamily);
if (appearance.terminalFontSize) root.style.setProperty("--remotehand-terminal-font-size", appearance.terminalFontSize);
if (appearance.terminalBackground) root.style.setProperty("--remotehand-terminal-background", appearance.terminalBackground);
if (appearance.terminalForeground) root.style.setProperty("--remotehand-terminal-foreground", appearance.terminalForeground);
if (appearance.colors && typeof appearance.colors === "object") {
for (const [name, value] of Object.entries(appearance.colors)) {
if (typeof value !== "string") continue;
const cssName = name.replace(/[A-Z]/g, (match) => "-" + match.toLowerCase());
root.style.setProperty("--remotehand-" + cssName, value);
}
}
window.dispatchEvent(new CustomEvent("remotehand-appearance-change", { detail: appearance }));
}
document.addEventListener("dragover", (event) => {
const files = event.dataTransfer && event.dataTransfer.files;
const types = event.dataTransfer && Array.from(event.dataTransfer.types || []);
if ((!files || files.length === 0) && !types.includes("Files")) return;
// RemoteHand owns native file-drop delivery. Suppress Chromium/WebView2's
// default file handling while preserving propagation for plugin UI handlers.
event.preventDefault();
}, true);
document.addEventListener("drop", (event) => {
const files = event.dataTransfer && event.dataTransfer.files;
if (!files || files.length === 0) return;
event.preventDefault();
const nativeBridge = window.chrome && window.chrome.webview;
if (!nativeBridge || typeof nativeBridge.postMessageWithAdditionalObjects !== "function") {
console.error("RemoteHand WebView2 native file-drop bridge is unavailable in this frame");
return;
}
try {
nativeBridge.postMessageWithAdditionalObjects({
type: "remotehand.files.drop",
pluginId,
panelId,
position: { x: event.clientX, y: event.clientY },
}, files);
} catch (error) {
console.error("RemoteHand native file-drop handoff failed", error);
}
}, true);
window.remotehand = Object.freeze({
request(method, params = null) {
return new Promise((resolve, reject) => {
const requestId = String(++sequence);
pending.set(requestId, { resolve, reject });
parent.postMessage({ type: "remotehand.plugin.request", requestId, method, params }, "*");
});
},
startRequest(method, params = null) {
return new Promise((resolve, reject) => {
const requestId = String(++sequence);
pending.set(requestId, { resolve, reject });
parent.postMessage({ type: "remotehand.plugin.detached.start", requestId, method, params }, "*");
});
},
requestStatus(callId) {
return new Promise((resolve, reject) => {
const requestId = String(++sequence);
pending.set(requestId, { resolve, reject });
parent.postMessage({ type: "remotehand.plugin.detached.status", requestId, callId }, "*");
});
},
forgetRequest(callId) {
return new Promise((resolve, reject) => {
const requestId = String(++sequence);
pending.set(requestId, { resolve, reject });
parent.postMessage({ type: "remotehand.plugin.detached.forget", requestId, callId }, "*");
});
},
getSessionState() {
return window.__REMOTEHAND_PLUGIN_SESSION_STATE__ ?? null;
},
setSessionState(state = null) {
window.__REMOTEHAND_PLUGIN_SESSION_STATE__ = state;
parent.postMessage({ type: "remotehand.plugin.session-state", state }, "*");
},
onEvent(eventName, listener) {
if (typeof eventName !== "string" || typeof listener !== "function") throw new TypeError("onEvent requires an event name and listener");
let listeners = eventListeners.get(eventName);
if (!listeners) { listeners = new Set(); eventListeners.set(eventName, listeners); }
listeners.add(listener);
return () => { listeners.delete(listener); if (listeners.size === 0) eventListeners.delete(eventName); };
}
});
window.addEventListener("message", (event) => {
const message = event.data;
if (!message) return;
if (message.type === "remotehand.appearance") { applyAppearance(message.appearance); return; }
if (message.type === "remotehand.host.restore-focus") {
const target = lastFocusedElement;
if (target && target.isConnected) {
try { target.focus({ preventScroll: true }); } catch { target.focus(); }
}
return;
}
if (message.type === "remotehand.plugin.context") {
window.__REMOTEHAND_PLUGIN_CONTEXT__ = message.context || {};
window.dispatchEvent(new CustomEvent("remotehand-plugin-context", { detail: window.__REMOTEHAND_PLUGIN_CONTEXT__ }));
return;
}
if (message.type === "remotehand.plugin.response") {
const pendingRequest = pending.get(message.requestId);
if (!pendingRequest) return;
pending.delete(message.requestId);
if (message.ok) pendingRequest.resolve(message.result); else pendingRequest.reject(new Error(message.error || "Plugin request failed"));
return;
}
if (message.type === "remotehand.plugin.event" || message.type === "remotehand.host.event") {
const listeners = eventListeners.get(message.event);
if (!listeners) return;
for (const listener of Array.from(listeners)) { try { listener(message.payload); } catch (error) { console.error("RemoteHand plugin event listener failed", error); } }
}
});
parent.postMessage({ type: "remotehand.plugin.ready" }, "*");
})();
</script>`;
}
function readPluginAppearance(): PluginAppearance {
const root = document.documentElement;
const computed = getComputedStyle(root);
const theme = root.dataset.theme === "light" ? "light" : "dark";
const light = theme === "light";
const read = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback;
return { theme, colorScheme: root.dataset.scheme || "blue", uiFontFamily: read("--ui-font-family", 'ui-sans-serif, system-ui, sans-serif'), uiFontSize: read("--ui-font-size", "13px"), terminalFontFamily: read("--terminal-font-family", '"JetBrains Mono", "Cascadia Code", Consolas, monospace'), terminalFontSize: read("--terminal-font-size", "13px"), terminalBackground: read("--terminal-background", light ? "#ffffff" : "#11151a"), terminalForeground: read("--terminal-foreground", light ? "#20242c" : "#d8dde6"), colors: { background: light ? "#f4f5f7" : "#11151a", surface: light ? "#ffffff" : "#171d24", surfaceRaised: light ? "#f8f9fb" : "#1d252f", border: light ? "#c8d0da" : "#35404d", text: light ? "#20242c" : "#dee5ef", mutedText: light ? "#667085" : "#93a1b2", inputBackground: light ? "#ffffff" : "#0f141a", buttonBackground: light ? "#eef1f4" : "#232c37", buttonHover: light ? "#e2e7ec" : "#2a3542", accent: read("--accent", light ? "#356fa9" : "#70a7e8"), accentBorder: read("--accent-border", light ? "#8fb3d8" : "#3b5f8d"), accentSurface: read("--accent-surface", light ? "#e7f0fa" : "#16263a"), accentSurfaceHover: read("--accent-surface-hover", light ? "#d9e9f8" : "#1d3550"), dangerText: light ? "#a12a2a" : "#efaaaa", dangerBorder: light ? "#d4a1a1" : "#5a3035", dangerSurface: light ? "#fff0f0" : "#241316", successText: light ? "#27643c" : "#bce5c7", successSurface: light ? "#e8f6ed" : "#214c34" } };
}
function injectBridge(html: string, pluginId: string, panelId: string, sessionState: unknown) {
const bridge = bridgeScript(pluginId, panelId, sessionState);
const lower = html.toLowerCase();
const headStart = lower.indexOf("<head");
if (headStart >= 0) {
const headOpenEnd = lower.indexOf(">", headStart);
if (headOpenEnd >= 0) { const insertAt = headOpenEnd + 1; return html.slice(0, insertAt) + PLUGIN_SECURITY_HEAD + PLUGIN_NATIVE_UI_STYLE + PLUGIN_SCROLLBAR_STYLE + bridge + html.slice(insertAt); }
}
return PLUGIN_SECURITY_HEAD + PLUGIN_NATIVE_UI_STYLE + PLUGIN_SCROLLBAR_STYLE + bridge + html;
}
export function PluginPanel({ api, params }: IDockviewPanelProps<PluginPanelParams>) {
const iframeRef = useRef<HTMLIFrameElement>(null);
const [html, setHtml] = useState<string | null>(null);
const [error, setError] = useState<string | null>(null);
const pluginId = params?.pluginId ?? "";
const panelId = params?.panelId ?? "";
const context = params?.context;
const contextRef = useRef<PluginContext>(context);
contextRef.current = context;
useEffect(() => {
let cancelled = false;
setHtml(null);
setError(null);
if (!pluginId || !panelId) { setError("Plugin panel metadata is missing."); return; }
if (!isTauri()) { setError("Plugin panels require the RemoteHand desktop app."); return; }
const sessionKey = pluginContextKey(pluginId, panelId);
void Promise.all([
invoke<string>("plugin_read_panel_html", { id: pluginId, panelId }),
invoke<unknown>("plugin_panel_session_get", { pluginId, panelId }).catch(() => null),
]).then(async ([source, hostSessionState]) => {
if (cancelled) return;
let sessionState = pluginPanelSessionState.get(sessionKey) ?? hostSessionState ?? null;
if (hostSessionState != null) pluginPanelSessionState.set(sessionKey, hostSessionState);
if (sessionState == null) {
await new Promise((resolve) => window.setTimeout(resolve, 150));
if (cancelled) return;
const retryHostSessionState = await invoke<unknown>("plugin_panel_session_get", { pluginId, panelId }).catch(() => null);
sessionState = pluginPanelSessionState.get(sessionKey) ?? retryHostSessionState ?? null;
if (retryHostSessionState != null) pluginPanelSessionState.set(sessionKey, retryHostSessionState);
}
setHtml(injectBridge(source, pluginId, panelId, sessionState));
}).catch((cause) => { if (!cancelled) setError(String(cause)); });
return () => { cancelled = true; };
}, [panelId, pluginId]);
useEffect(() => {
const postAppearance = () => {
iframeRef.current?.contentWindow?.postMessage({ type: "remotehand.appearance", appearance: readPluginAppearance() } satisfies PluginAppearanceMessage, "*");
};
const postContext = (nextContext: PluginContext = contextRef.current) => {
iframeRef.current?.contentWindow?.postMessage({ type: "remotehand.plugin.context", context: nextContext ?? {} }, "*");
};
const onMessage = (event: MessageEvent<PluginBridgeRequest | PluginBridgeDetachedRequest | PluginHostFunctionKeyMessage | PluginSessionStateMessage | { type: "remotehand.plugin.ready" }>) => {
if (event.source !== iframeRef.current?.contentWindow) return;
const message = event.data;
if (!message) return;
if (message.type === "remotehand.plugin.ready") { postAppearance(); postContext(); return; }
if (message.type === "remotehand.plugin.session-state") {
const sessionKey = pluginContextKey(pluginId, panelId);
if (message.state == null) {
pluginPanelSessionState.delete(sessionKey);
void invoke("plugin_panel_session_set", { pluginId, panelId, value: null }).catch((error) => {
console.error("RemoteHand failed to clear plugin panel session state", error);
});
return;
}
try {
const encoded = JSON.stringify(message.state);
if (encoded.length <= MAX_PLUGIN_PANEL_SESSION_STATE_BYTES) {
pluginPanelSessionState.set(sessionKey, message.state);
void invoke("plugin_panel_session_set", { pluginId, panelId, value: message.state }).catch((error) => {
console.error("RemoteHand failed to persist plugin panel session state", error);
});
}
} catch {
console.error("RemoteHand rejected non-serializable plugin panel session state");
}
return;
}
if (message.type === "remotehand.host.function-key") {
const plain = !message.ctrlKey && !message.altKey && !message.metaKey && !message.shiftKey;
if (message.key === "F1" && plain) {
window.dispatchEvent(new CustomEvent("remotehand-open-about"));
return;
}
if (
message.ctrlKey
&& !message.altKey
&& !message.metaKey
&& !message.shiftKey
&& /^F(?:[1-9]|1[0-2])$/.test(message.key)
) {
window.dispatchEvent(new CustomEvent("remotehand-function-shortcut", { detail: "Ctrl+" + message.key }));
}
return;
}
const respond = (response: PluginBridgeResponse) => { iframeRef.current?.contentWindow?.postMessage(response, "*"); };
if (message.type === "remotehand.plugin.detached.start") {
if (typeof message.requestId !== "string" || typeof message.method !== "string") return;
void invoke("plugin_runtime_call_start", { id: pluginId, method: message.method, params: message.params ?? null })
.then((result) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: true, result }))
.catch((cause) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: false, error: String(cause) }));
return;
}
if (message.type === "remotehand.plugin.detached.status") {
if (typeof message.requestId !== "string" || typeof message.callId !== "string") return;
void invoke("plugin_runtime_call_status", { pluginId, callId: message.callId })
.then((result) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: true, result }))
.catch((cause) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: false, error: String(cause) }));
return;
}
if (message.type === "remotehand.plugin.detached.forget") {
if (typeof message.requestId !== "string" || typeof message.callId !== "string") return;
void invoke("plugin_runtime_call_forget", { pluginId, callId: message.callId })
.then((result) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: true, result }))
.catch((cause) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: false, error: String(cause) }));
return;
}
if (message.type !== "remotehand.plugin.request") return;
if (typeof message.requestId !== "string" || typeof message.method !== "string") return;
void invoke("plugin_runtime_call", { id: pluginId, method: message.method, params: message.params ?? null }).then((result) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: true, result })).catch((cause) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: false, error: String(cause) }));
};
const contextKey = pluginContextKey(pluginId, panelId);
pluginContextHandlers.set(contextKey, postContext);
let ownerWindow = api.getWindow();
const bind = (nextWindow: Window) => { ownerWindow.removeEventListener("message", onMessage); ownerWindow = nextWindow; ownerWindow.addEventListener("message", onMessage); };
ownerWindow.addEventListener("message", onMessage);
window.addEventListener("remotehand-appearance-change", postAppearance);
const locationDisposable = api.onDidLocationChange(() => {
bind(api.getWindow());
postAppearance();
postContext();
});
return () => {
locationDisposable.dispose();
ownerWindow.removeEventListener("message", onMessage);
window.removeEventListener("remotehand-appearance-change", postAppearance);
if (pluginContextHandlers.get(contextKey) === postContext) pluginContextHandlers.delete(contextKey);
};
}, [api, pluginId, panelId, html]);
useEffect(() => {
iframeRef.current?.contentWindow?.postMessage(
{ type: "remotehand.plugin.context", context: contextRef.current ?? {} },
"*",
);
}, [context]);

useEffect(() => {
if (!isTauri() || !pluginId) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<PluginRuntimeEvent>("remotehand-plugin-event", (tauriEvent) => {
if (tauriEvent.payload.pluginId !== pluginId) return;
iframeRef.current?.contentWindow?.postMessage({ type: "remotehand.plugin.event", event: tauriEvent.payload.event, payload: tauriEvent.payload.payload } satisfies PluginBridgeEvent, "*");
}).then((dispose) => { if (cancelled) dispose(); else unlisten = dispose; });
return () => { cancelled = true; unlisten?.(); };
}, [pluginId]);

useEffect(() => {
if (!isTauri() || !pluginId) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<{ exists: boolean; unlocked: boolean }>("remotehand-vault-status-changed", (tauriEvent) => {
iframeRef.current?.contentWindow?.postMessage({
type: "remotehand.host.event",
event: "vault.status",
payload: tauriEvent.payload,
} satisfies PluginBridgeEvent, "*");
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, [pluginId]);

useEffect(() => {
if (!isTauri() || !pluginId || !panelId) return;
let cancelled = false;
let unlisten: (() => void) | undefined;
void listen<NativeFileDropEvent>("remotehand-native-file-drop", (tauriEvent) => {
const payload = tauriEvent.payload;
if (payload.pluginId !== pluginId || payload.panelId !== panelId) return;
iframeRef.current?.contentWindow?.postMessage({
type: "remotehand.host.event",
event: "files.drop",
payload: { paths: payload.paths, position: payload.position },
} satisfies PluginBridgeEvent, "*");
}).then((dispose) => {
if (cancelled) dispose();
else unlisten = dispose;
});
return () => {
cancelled = true;
unlisten?.();
};
}, [pluginId, panelId]);
const repairedDocumentRef = useRef<Document | null>(null);
const repairSheetRef = useRef<CSSStyleSheet | null>(null);
const repairCssRef = useRef<string | null>(null);
const [popoutStylesReady, setPopoutStylesReady] = useState(api.location.type !== "popout");
useLayoutEffect(() => {
const markPopoutStylesReady = (doc: Document) => {
const view = doc.defaultView;
if (!view) return;
// A constructable stylesheet is installed synchronously, but WebView2 can
// still paint the moved iframe once before recalculating it. Keep the iframe
// hidden through the next rendering opportunity, then reveal it only after
// the repaired document has completed that style/layout cycle.
view.requestAnimationFrame(() => {
view.requestAnimationFrame(() => {
if (iframeRef.current?.contentDocument !== doc || api.location.type !== "popout") return;
setPopoutStylesReady(true);
view.parent.dispatchEvent(new CustomEvent("remotehand-plugin-popout-ready"));
});
});
};
const repairPopoutStyles = () => {
if (api.location.type !== "popout") {
setPopoutStylesReady(true);
return;
}
const doc = iframeRef.current?.contentDocument;
if (!doc) return;
const styles = Array.from(doc.querySelectorAll<HTMLStyleElement>("style"));
if (styles.length === 0) {
markPopoutStylesReady(doc);
return;
}
try {
if (repairedDocumentRef.current === doc) {
const sheet = repairSheetRef.current;
if (sheet && repairCssRef.current === css && doc.adoptedStyleSheets.includes(sheet)) {
markPopoutStylesReady(doc);
return;
}
}
const css = styles.map((style) => style.textContent ?? "").join("\n");
if (!css) {
markPopoutStylesReady(doc);
return;
}
const view = doc.defaultView;
const FrameCSSStyleSheet = view
? Reflect.get(view, "CSSStyleSheet") as typeof CSSStyleSheet | undefined
: undefined;
if (!FrameCSSStyleSheet) return;
const previousSheet = repairSheetRef.current;
if (previousSheet && repairedDocumentRef.current === doc) {
doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(
(candidate) => candidate !== previousSheet
);
}
const sheet = new FrameCSSStyleSheet();
sheet.replaceSync(css);
doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
repairedDocumentRef.current = doc;
repairSheetRef.current = sheet;
repairCssRef.current = css;
markPopoutStylesReady(doc);
} catch (error) {
console.error("RemoteHand plugin popout style repair failed", error);
}
};
if (api.location.type === "popout") setPopoutStylesReady(false);
else setPopoutStylesReady(true);
repairPopoutStyles();
const timer = window.setInterval(repairPopoutStyles, 500);
return () => window.clearInterval(timer);
}, [api, html]);
const content = useMemo(() => html ?? "", [html]);
if (error) return <section className="plugin-panel-host plugin-panel-error"><strong>Plugin panel unavailable</strong><span>{error}</span></section>;
if (!html) return <div className="plugin-panel-host plugin-panel-loading">Loading plugin panel…</div>;
return <iframe ref={iframeRef} className="plugin-panel-frame" style={{ visibility: popoutStylesReady ? "visible" : "hidden" }} title={params?.title || pluginId} sandbox="allow-scripts allow-same-origin" allow="autoplay" srcDoc={content} />;
}