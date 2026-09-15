import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { AppModal } from "./AppModal";
type PluginManifest = {
id: string;
name: string;
version: string;
apiVersion: number;
author: string;
description: string;
capabilities: string[];
};
type PluginInfo = {
manifest: PluginManifest;
enabled: boolean;
directory: string;
};
export function PluginManager({
open,
onClose,
}: {
open: boolean;
onClose: () => void;
}) {
const [plugins, setPlugins] = useState<PluginInfo[]>([]);
const [loading, setLoading] = useState(false);
const [busyId, setBusyId] = useState<string | null>(null);
const [error, setError] = useState<string | null>(null);
const [removeTarget, setRemoveTarget] = useState<PluginInfo | null>(null);
const refresh = useCallback(async () => {
if (!isTauri()) {
setPlugins([]);
return;
}
setLoading(true);
setError(null);
try {
setPlugins(await invoke<PluginInfo[]>("plugin_list"));
} catch (cause) {
setError(String(cause));
} finally {
setLoading(false);
}
}, []);
useEffect(() => {
if (open) void refresh();
}, [open, refresh]);
const install = async () => {
setLoading(true);
setError(null);
try {
const installed = await invoke<PluginInfo | null>("plugin_install_from_folder");
if (installed) await refresh();
} catch (cause) {
setError(String(cause));
} finally {
setLoading(false);
}
};
const setEnabled = async (plugin: PluginInfo, enabled: boolean) => {
setBusyId(plugin.manifest.id);
setError(null);
try {
await invoke("plugin_set_enabled", {
id: plugin.manifest.id,
enabled,
});
await refresh();
} catch (cause) {
setError(String(cause));
} finally {
setBusyId(null);
}
};
const requestRemove = (plugin: PluginInfo) => {
if (plugin.enabled) {
setError("Disable the plugin before removing it.");
return;
}
setRemoveTarget(plugin);
};
const confirmRemove = async () => {
const plugin = removeTarget;
if (!plugin) return;
setRemoveTarget(null);
setBusyId(plugin.manifest.id);
setError(null);
try {
await invoke("plugin_remove", { id: plugin.manifest.id });
await refresh();
} catch (cause) {
setError(String(cause));
} finally {
setBusyId(null);
}
};
return (
<>
<AppModal
open={open}
title="Plugins"
confirmLabel="Done"
onConfirm={onClose}
onCancel={onClose}
focusActions={false}
>
<div className="plugin-manager">
<div className="plugin-manager-heading">
<div>
<strong>Installed add-ons</strong>
<span>
Plugins are disabled by default and only receive capabilities declared in their manifest.
</span>
</div>
<div className="plugin-manager-toolbar">
<button type="button" onClick={() => void install()} disabled={loading}>
Install from folder
</button>
<button type="button" onClick={() => void refresh()} disabled={loading}>
{loading ? "Refreshing…" : "Refresh"}
</button>
</div>
</div>
<div className="plugin-security-note">
<strong>Plugin API v1 security model</strong>
<span>
RemoteHand validates manifests and manages plugin lifecycle. Supported first-party drivers are host-mediated; RemoteHand does not load arbitrary
native plugin code.
</span>
</div>

{error ? <div className="plugin-error">{error}</div> : null}

{!loading && plugins.length === 0 ? (
<div className="plugin-empty">
<strong>No plugins installed</strong>
<span>
Choose Install from folder to validate and copy an add-on into RemoteHand&apos;s portable
plugins directory.
</span>
</div>
) : null}

<div className="plugin-list">
{plugins.map((plugin) => (
<article className="plugin-card" key={plugin.manifest.id}>
<div className="plugin-card-main">
<div className="plugin-title-row">
<strong>{plugin.manifest.name}</strong>
<span className={plugin.enabled ? "plugin-status enabled" : "plugin-status"}>
{plugin.enabled ? "Enabled" : "Disabled"}
</span>
</div>
<span className="plugin-meta">
v{plugin.manifest.version} · {plugin.manifest.author} · API {plugin.manifest.apiVersion}
</span>
{plugin.manifest.description ? <p>{plugin.manifest.description}</p> : null}
<div className="plugin-capabilities">
{plugin.manifest.capabilities.length ? (
plugin.manifest.capabilities.map((capability) => (
<span key={capability}>{capability}</span>
))
) : (
<span>no sensitive capabilities</span>
)}
</div>
</div>

<div className="plugin-actions">
<button
type="button"
disabled={busyId === plugin.manifest.id}
onClick={() => void setEnabled(plugin, !plugin.enabled)}
>
{plugin.enabled ? "Disable" : "Enable"}
</button>
<button
type="button"
className="danger"
disabled={plugin.enabled || busyId === plugin.manifest.id}
onClick={() => requestRemove(plugin)}
title={plugin.enabled ? "Disable this plugin before removing it" : "Remove plugin"}
>
Remove
</button>
</div>
</article>
))}
</div>
</div>
</AppModal>

<AppModal
open={removeTarget !== null}
title="Remove plugin?"
confirmLabel="Remove"
cancelLabel="Cancel"
danger
onConfirm={() => void confirmRemove()}
onCancel={() => setRemoveTarget(null)}
>
<p>
Remove <strong>{removeTarget?.manifest.name}</strong>? This deletes its plugin directory.
Plugin-owned data is not removed automatically.
</p>
</AppModal>
</>
);
}
