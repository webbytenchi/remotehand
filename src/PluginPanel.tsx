import { invoke, isTauri } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useRef, useState } from "react";
export type PluginPanelParams = {
pluginId: string;
panelId: string;
title: string;
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
const PLUGIN_SECURITY_HEAD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src data:; media-src data: blob:; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none';">`;

const BRIDGE_SCRIPT = `
<script>
(() => {
let sequence = 0;
const pending = new Map();

window.remotehand = Object.freeze({
request(method, params = null) {
return new Promise((resolve, reject) => {
const requestId = String(++sequence);
pending.set(requestId, { resolve, reject });
parent.postMessage({
type: "remotehand.plugin.request",
requestId,
method,
params
}, "*");
});
}
});

window.addEventListener("message", (event) => {
const message = event.data;
if (!message || message.type !== "remotehand.plugin.response") return;
const pendingRequest = pending.get(message.requestId);
if (!pendingRequest) return;
pending.delete(message.requestId);
if (message.ok) pendingRequest.resolve(message.result);
else pendingRequest.reject(new Error(message.error || "Plugin request failed"));
});

parent.postMessage({ type: "remotehand.plugin.ready" }, "*");
})();
</script>`;
function injectBridge(html: string) {
const lower = html.toLowerCase();
const headStart = lower.indexOf("<head");
if (headStart >= 0) {
const headOpenEnd = lower.indexOf(">", headStart);
if (headOpenEnd >= 0) {
const insertAt = headOpenEnd + 1;
return html.slice(0, insertAt) + PLUGIN_SECURITY_HEAD + BRIDGE_SCRIPT + html.slice(insertAt);
}
}
return PLUGIN_SECURITY_HEAD + BRIDGE_SCRIPT + html;
}
export function PluginPanel({
api,
params,
}: IDockviewPanelProps<PluginPanelParams>) {
const iframeRef = useRef<HTMLIFrameElement>(null);
const [html, setHtml] = useState<string | null>(null);
const [error, setError] = useState<string | null>(null);
const pluginId = params?.pluginId ?? "";
const panelId = params?.panelId ?? "";
useEffect(() => {
let cancelled = false;
setHtml(null);
setError(null);
if (!pluginId || !panelId) {
setError("Plugin panel metadata is missing.");
return;
}
if (!isTauri()) {
setError("Plugin panels require the RemoteHand desktop app.");
return;
}

void invoke<string>("plugin_read_panel_html", { id: pluginId, panelId })
.then((source) => {
if (!cancelled) setHtml(injectBridge(source));
})
.catch((cause) => {
if (!cancelled) setError(String(cause));
});

return () => {
cancelled = true;
};
}, [panelId, pluginId]);
useEffect(() => {
const onMessage = (event: MessageEvent<PluginBridgeRequest>) => {
if (event.source !== iframeRef.current?.contentWindow) return;
const message = event.data;
if (!message || message.type !== "remotehand.plugin.request") return;
if (typeof message.requestId !== "string" || typeof message.method !== "string") return;
const respond = (response: PluginBridgeResponse) => {
iframeRef.current?.contentWindow?.postMessage(response, "*");
};

void invoke("plugin_runtime_call", {
id: pluginId,
method: message.method,
params: message.params ?? null,
})
.then((result) =>
respond({
type: "remotehand.plugin.response",
requestId: message.requestId,
ok: true,
result,
}),
)
.catch((cause) =>
respond({
type: "remotehand.plugin.response",
requestId: message.requestId,
ok: false,
error: String(cause),
}),
);
};

let ownerWindow = api.getWindow();
const bind = (nextWindow: Window) => {
ownerWindow.removeEventListener("message", onMessage);
ownerWindow = nextWindow;
ownerWindow.addEventListener("message", onMessage);
};
ownerWindow.addEventListener("message", onMessage);
const locationDisposable = api.onDidLocationChange(() => bind(api.getWindow()));
return () => {
locationDisposable.dispose();
ownerWindow.removeEventListener("message", onMessage);
};
}, [api, pluginId]);
const content = useMemo(() => html ?? "", [html]);
if (error) {
return (
<section className="plugin-panel-host plugin-panel-error">
<strong>Plugin panel unavailable</strong>
<span>{error}</span>
</section>
);
}
if (!html) {
return <div className="plugin-panel-host plugin-panel-loading">Loading plugin panel…</div>;
}
return (
<iframe
ref={iframeRef}
className="plugin-panel-frame"
title={params?.title || pluginId}
sandbox="allow-scripts"
srcDoc={content}
/>
);
}
