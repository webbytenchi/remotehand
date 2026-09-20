import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useRef, useState } from "react";
export type PluginPanelParams = {
pluginId: string;
panelId: string;
title: string;
context?: { targetId?: string; target?: string };
};
type PluginBridgeRequest = {
type: "remotehand.plugin.request";
requestId: string;
method: string;
params?: unknown;
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
type: "remotehand.plugin.event";
event: string;
payload: unknown;
};
type PluginAppearance = {
theme: "dark" | "light";
colorScheme: string;
uiFontFamily: string;
uiFontSize: string;
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
const BRIDGE_SCRIPT = `
<script>
(() => {
let sequence = 0;
const pending = new Map();
const eventListeners = new Map();
function applyAppearance(appearance) {
if (!appearance || typeof appearance !== "object") return;
const root = document.documentElement;
root.dataset.remotehandTheme = appearance.theme || "dark";
root.dataset.remotehandScheme = appearance.colorScheme || "blue";
if (appearance.uiFontFamily) root.style.setProperty("--remotehand-ui-font-family", appearance.uiFontFamily);
if (appearance.uiFontSize) root.style.setProperty("--remotehand-ui-font-size", appearance.uiFontSize);
if (appearance.colors && typeof appearance.colors === "object") {
for (const [name, value] of Object.entries(appearance.colors)) {
if (typeof value !== "string") continue;
const cssName = name.replace(/[A-Z]/g, (match) => "-" + match.toLowerCase());
root.style.setProperty("--remotehand-" + cssName, value);
}
}
window.dispatchEvent(new CustomEvent("remotehand-appearance-change", { detail: appearance }));
}
window.remotehand = Object.freeze({
request(method, params = null) {
return new Promise((resolve, reject) => {
const requestId = String(++sequence);
pending.set(requestId, { resolve, reject });
parent.postMessage({ type: "remotehand.plugin.request", requestId, method, params }, "*");
});
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
if (message.type === "remotehand.plugin.response") {
const pendingRequest = pending.get(message.requestId);
if (!pendingRequest) return;
pending.delete(message.requestId);
if (message.ok) pendingRequest.resolve(message.result); else pendingRequest.reject(new Error(message.error || "Plugin request failed"));
return;
}
if (message.type === "remotehand.plugin.event") {
const listeners = eventListeners.get(message.event);
if (!listeners) return;
for (const listener of Array.from(listeners)) { try { listener(message.payload); } catch (error) { console.error("RemoteHand plugin event listener failed", error); } }
}
});
parent.postMessage({ type: "remotehand.plugin.ready" }, "*");
})();
</script>`;
function readPluginAppearance(): PluginAppearance {
const root = document.documentElement;
const computed = getComputedStyle(root);
const theme = root.dataset.theme === "light" ? "light" : "dark";
const light = theme === "light";
const read = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback;
return { theme, colorScheme: root.dataset.scheme || "blue", uiFontFamily: read("--ui-font-family", 'ui-sans-serif, system-ui, sans-serif'), uiFontSize: read("--ui-font-size", "13px"), colors: { background: light ? "#f4f5f7" : "#11151a", surface: light ? "#ffffff" : "#171d24", surfaceRaised: light ? "#f8f9fb" : "#1d252f", border: light ? "#c8d0da" : "#35404d", text: light ? "#20242c" : "#dee5ef", mutedText: light ? "#667085" : "#93a1b2", inputBackground: light ? "#ffffff" : "#0f141a", buttonBackground: light ? "#eef1f4" : "#232c37", buttonHover: light ? "#e2e7ec" : "#2a3542", accent: read("--accent", light ? "#356fa9" : "#70a7e8"), accentBorder: read("--accent-border", light ? "#8fb3d8" : "#3b5f8d"), accentSurface: read("--accent-surface", light ? "#e7f0fa" : "#16263a"), accentSurfaceHover: read("--accent-surface-hover", light ? "#d9e9f8" : "#1d3550"), dangerText: light ? "#a12a2a" : "#efaaaa", dangerBorder: light ? "#d4a1a1" : "#5a3035", dangerSurface: light ? "#fff0f0" : "#241316", successText: light ? "#27643c" : "#bce5c7", successSurface: light ? "#e8f6ed" : "#214c34" } };
}
function injectBridge(html: string) {
const lower = html.toLowerCase();
const headStart = lower.indexOf("<head");
if (headStart >= 0) {
const headOpenEnd = lower.indexOf(">", headStart);
if (headOpenEnd >= 0) { const insertAt = headOpenEnd + 1; return html.slice(0, insertAt) + PLUGIN_SECURITY_HEAD + BRIDGE_SCRIPT + html.slice(insertAt); }
}
return PLUGIN_SECURITY_HEAD + BRIDGE_SCRIPT + html;
}
export function PluginPanel({ api, params }: IDockviewPanelProps<PluginPanelParams>) {
const iframeRef = useRef<HTMLIFrameElement>(null);
const [html, setHtml] = useState<string | null>(null);
const [error, setError] = useState<string | null>(null);
const pluginId = params?.pluginId ?? "";
const panelId = params?.panelId ?? "";
const context = params?.context;
useEffect(() => {
let cancelled = false;
setHtml(null);
setError(null);
if (!pluginId || !panelId) { setError("Plugin panel metadata is missing."); return; }
if (!isTauri()) { setError("Plugin panels require the RemoteHand desktop app."); return; }
void invoke<string>("plugin_read_panel_html", { id: pluginId, panelId }).then((source) => { if (!cancelled) setHtml(injectBridge(source)); }).catch((cause) => { if (!cancelled) setError(String(cause)); });
return () => { cancelled = true; };
}, [panelId, pluginId]);
useEffect(() => {
const postAppearance = () => {
iframeRef.current?.contentWindow?.postMessage({ type: "remotehand.appearance", appearance: readPluginAppearance() } satisfies PluginAppearanceMessage, "*");
};
const postContext = () => {
iframeRef.current?.contentWindow?.postMessage({ type: "remotehand.plugin.context", context: context ?? {} }, "*");
};
const onMessage = (event: MessageEvent<PluginBridgeRequest | { type: "remotehand.plugin.ready" }>) => {
if (event.source !== iframeRef.current?.contentWindow) return;
const message = event.data;
if (!message) return;
if (message.type === "remotehand.plugin.ready") { postAppearance(); postContext(); return; }
if (message.type !== "remotehand.plugin.request") return;
if (typeof message.requestId !== "string" || typeof message.method !== "string") return;
const respond = (response: PluginBridgeResponse) => { iframeRef.current?.contentWindow?.postMessage(response, "*"); };
void invoke("plugin_runtime_call", { id: pluginId, method: message.method, params: message.params ?? null }).then((result) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: true, result })).catch((cause) => respond({ type: "remotehand.plugin.response", requestId: message.requestId, ok: false, error: String(cause) }));
};
let ownerWindow = api.getWindow();
const bind = (nextWindow: Window) => { ownerWindow.removeEventListener("message", onMessage); ownerWindow = nextWindow; ownerWindow.addEventListener("message", onMessage); };
ownerWindow.addEventListener("message", onMessage);
window.addEventListener("remotehand-appearance-change", postAppearance);
const reloadPluginFrame = () => {
const frame = iframeRef.current;
if (!frame || !html) return;
frame.srcdoc = "";
window.setTimeout(() => {
if (iframeRef.current === frame) {
frame.srcdoc = html;
}
}, 0);
};
const locationDisposable = api.onDidLocationChange(() => {
bind(api.getWindow());
window.setTimeout(reloadPluginFrame, 0);
});
return () => { locationDisposable.dispose(); ownerWindow.removeEventListener("message", onMessage); window.removeEventListener("remotehand-appearance-change", postAppearance); };
}, [api, pluginId, html, context?.targetId, context?.target]);
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
const [popoutDiagnostic, setPopoutDiagnostic] = useState<string | null>(null);
useEffect(() => {
const locationDisposable = api.onDidLocationChange(() => {
window.setTimeout(() => {
const frame = iframeRef.current;
const doc = frame?.contentDocument;
if (!frame || !doc || api.location.type !== "popout") {
setPopoutDiagnostic(null);
return;
}
const styles = Array.from(doc.querySelectorAll<HTMLStyleElement>("style"));
const details = styles.map((style, index) => {
let sheetState = "sheet=null";
try {
sheetState = style.sheet ? "sheet=active rules=" + style.sheet.cssRules.length : "sheet=null";
} catch (error) {
sheetState = "sheet=error " + String(error);
}
return index + ":" + style.textContent?.length + " chars " + sheetState;
}).join(" | ");
const bodyStyle = doc.defaultView?.getComputedStyle(doc.body);
setPopoutDiagnostic(
"PLUGIN POPOUT DEBUG\n" +
"readyState=" + doc.readyState +
" styles=" + styles.length +
" adopted=" + doc.adoptedStyleSheets.length +
" body.bg=" + (bodyStyle?.backgroundColor ?? "?") +
" body.font=" + (bodyStyle?.fontFamily ?? "?") +
"\n" + details
);
}, 500);
});
return () => locationDisposable.dispose();
}, [api, html]);
const content = useMemo(() => html ?? "", [html]);
if (error) return <section className="plugin-panel-host plugin-panel-error"><strong>Plugin panel unavailable</strong><span>{error}</span></section>;
if (!html) return <div className="plugin-panel-host plugin-panel-loading">Loading plugin panel…</div>;
return <>
<iframe ref={iframeRef} className="plugin-panel-frame" title={params?.title || pluginId} sandbox="allow-scripts" allow="autoplay" srcDoc={content} />
{popoutDiagnostic ? <pre style={{ position: "absolute", right: 8, bottom: 8, zIndex: 9999, maxWidth: "calc(100% - 16px)", margin: 0, padding: 8, whiteSpace: "pre-wrap", background: "#111", color: "#7cff7c", border: "1px solid #7cff7c", fontSize: 11 }}>{popoutDiagnostic}</pre> : null}
</>;
}