import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { AppModal } from "./AppModal";
import type { VncConnection } from "./VncPanel";
type VncConnectionsPanelProps = {
onConnect: (connection: VncConnection) => void;
};
export function VncConnectionsPanel({ onConnect }: VncConnectionsPanelProps) {
const [connections, setConnections] = useState<VncConnection[]>([]);
const [loading, setLoading] = useState(true);
const [showForm, setShowForm] = useState(false);
const [editingId, setEditingId] = useState<string | null>(null);
const [name, setName] = useState("");
const [host, setHost] = useState("");
const [port, setPort] = useState("5900");
const [password, setPassword] = useState("");
const [vaultPassphrase, setVaultPassphrase] = useState("");
const [saving, setSaving] = useState(false);
const [pendingRemove, setPendingRemove] = useState<VncConnection | null>(null);
const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
const load = useCallback(async () => {
if (!isTauri()) {
setConnections([]);
setLoading(false);
return;
}
setLoading(true);
try {
setConnections(await invoke<VncConnection[]>("vnc_load_connections"));
} catch (error) {
setNotice({ title: "Could not load VNC connections", message: String(error) });
} finally {
setLoading(false);
}
}, []);
useEffect(() => {
void load();
}, [load]);
const persist = async (next: VncConnection[]) => {
await invoke("vnc_save_connections", { connections: next });
setConnections(next);
};
const resetForm = () => {
setEditingId(null);
setName("");
setHost("");
setPort("5900");
setPassword("");
setVaultPassphrase("");
setShowForm(false);
};
const edit = (connection: VncConnection) => {
setEditingId(connection.id);
setName(connection.name);
setHost(connection.host);
setPort(String(connection.port));
setPassword("");
setVaultPassphrase("");
setShowForm(true);
};
const save = async () => {
if (saving || !isTauri()) return;
const parsedPort = Number(port);
const trimmedName = name.trim();
const trimmedHost = host.trim();
if (!trimmedName || !trimmedHost) return;
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
if (connections.some((item) => item.name.toLowerCase() === trimmedName.toLowerCase() && item.id !== editingId)) {
setNotice({ title: "Connection name already exists", message: "Choose a different name for this VNC connection." });
return;
}
const existing = editingId ? connections.find((item) => item.id === editingId) : undefined;
const id = editingId ?? "vnc-" + Date.now();
let credentialRef = existing?.credentialRef;
setSaving(true);
try {
if (password) {
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
credentialRef = credentialRef ?? "vnc:" + id;
await invoke("vnc_store_credential", { credentialRef, secret: password });
}
const nextConnection: VncConnection = {
id,
name: trimmedName,
host: trimmedHost,
port: parsedPort,
...(credentialRef ? { credentialRef } : {}),
};
const next = editingId
? connections.map((item) => item.id === editingId ? nextConnection : item)
: [...connections, nextConnection];
await persist(next);
resetForm();
} catch (error) {
setNotice({ title: "Could not save VNC connection", message: String(error) });
} finally {
setSaving(false);
}
};
const confirmRemove = async () => {
if (!pendingRemove || !isTauri()) return;
const removed = pendingRemove;
setPendingRemove(null);
try {
const next = connections.filter((item) => item.id !== removed.id);
await persist(next);
if (removed.credentialRef && !next.some((item) => item.credentialRef === removed.credentialRef)) {
try {
await invoke("vnc_delete_credential", { credentialRef: removed.credentialRef });
} catch (error) {
setNotice({
title: "Connection removed, credential retained",
message: "The VNC connection was removed, but its saved credential could not be deleted: " + String(error),
});
}
}
if (editingId === removed.id) resetForm();
} catch (error) {
setNotice({ title: "Could not remove VNC connection", message: String(error) });
}
};
return (
<section className="panel-content connections-panel">
<div className="panel-heading">
<div>
<h2>VNC Connections</h2>
</div>
<button
type="button"
className="primary-button"
onClick={() => showForm ? resetForm() : setShowForm(true)}
>
{showForm ? "Cancel" : "+ New VNC connection"}
</button>
</div>
{showForm ? (
<div className="connection-form">
<label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Office desktop" /></label>
<label><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.50" /></label>
<label><span>Port</span><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder="5900" /></label>
<label><span>Password (optional)</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editingId ? "Leave blank to keep current password" : "Saved securely in the credential vault"} autoComplete="new-password" /></label>
{password ? <label><span>Vault passphrase</span><input type="password" value={vaultPassphrase} onChange={(event) => setVaultPassphrase(event.target.value)} placeholder="Required if the vault is locked or new" autoComplete="current-password" /></label> : null}
<button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>
{saving ? "Saving…" : editingId ? "Save changes" : "Save VNC connection"}
</button>
</div>
) : null}
<div className="connection-list">
{loading ? <div className="connection-empty"><span>Loading VNC connections…</span></div> : null}
{!loading && connections.length === 0 ? (
<div className="connection-empty">
<strong>No VNC connections yet</strong>
<span>Add a VNC host above, then connect to open its remote desktop in a dock panel.</span>
</div>
) : null}
{connections.map((connection) => (
<article className="connection-card" key={connection.id}>
<div className="connection-icon">▣</div>
<div>
<strong>{connection.name}</strong>
<span>{connection.host}:{connection.port}</span>
</div>
<div className="connection-actions">
<button type="button" className="connection-connect" onClick={() => onConnect(connection)}>Connect</button>
<details className="connection-menu">
<summary aria-label={"Actions for " + connection.name}>⋯</summary>
<div className="connection-menu-popover">
<button type="button" onClick={() => edit(connection)}>Edit</button>
<button type="button" className="danger" onClick={() => setPendingRemove(connection)}>Remove</button>
</div>
</details>
</div>
</article>
))}
</div>
<AppModal
open={pendingRemove !== null}
title="Remove VNC connection?"
confirmLabel="Remove"
cancelLabel="Cancel"
danger
onConfirm={() => void confirmRemove()}
onCancel={() => setPendingRemove(null)}
>

<p>Remove <strong>{pendingRemove?.name}</strong>?</p>
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
