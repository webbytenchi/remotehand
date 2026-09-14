import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";
type SftpConnection = {
host: string;
port: number;
user: string;
name: string;
credentialRef?: string;
};
type SftpEntry = {
name: string;
path: string;
isDir: boolean;
size: number;
permissions: string;
};
type SftpListing = {
path: string;
entries: SftpEntry[];
};
type SftpPanelParams = {
connection?: SftpConnection;
};
type TransferItem = {
localPath: string;
remotePath: string;
};
type TransferState = "idle" | "uploading" | "downloading";
function stripTrailingSlashes(path: string) {
let result = path;
while (result.length > 1 && result.endsWith("/")) {
result = result.slice(0, -1);
}
return result;
}
function parentPath(path: string) {
if (!path || path === "/" || path === ".") return path;
const normalized = stripTrailingSlashes(path);
const index = normalized.lastIndexOf("/");
if (index <= 0) return "/";
return normalized.slice(0, index);
}
function formatSize(size: number) {
if (size < 1024) return String(size) + " B";
if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + " MB";
return (size / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}
function fileNameFromLocalPath(path: string) {
const normalized = path.split(String.fromCharCode(92)).join("/");
return normalized.split("/").pop() || normalized;
}
function joinLocalPath(folder: string, fileName: string) {
const backslash = String.fromCharCode(92);
const separator = folder.includes(backslash) ? backslash : "/";
let base = folder;
while (base.endsWith("/") || base.endsWith(backslash)) {
base = base.slice(0, -1);
}
return base + separator + fileName;
}
function remoteChildPath(folder: string, fileName: string) {
if (folder === "/") return "/" + fileName;
return stripTrailingSlashes(folder) + "/" + fileName;
}
export function SftpPanel(props: IDockviewPanelProps<SftpPanelParams>) {
const connection = props.params?.connection;
const [listing, setListing] = useState<SftpListing | null>(null);
const [requestedPath, setRequestedPath] = useState(".");
const [loading, setLoading] = useState(false);
const [pathInput, setPathInput] = useState(".");
const [error, setError] = useState("");
const [needsVaultUnlock, setNeedsVaultUnlock] = useState(false);
const [vaultPassphrase, setVaultPassphrase] = useState("");
const [unlocking, setUnlocking] = useState(false);
const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
const [uploadPaths, setUploadPaths] = useState<string[]>([]);
const [transferState, setTransferState] = useState<TransferState>("idle");
const [transferStatus, setTransferStatus] = useState("");
const transferring = transferState !== "idle";
const loadPath = useCallback(
async (path: string) => {
if (!connection) {
setError("SFTP connection details are unavailable.");
return;
}
if (!isTauri()) {
setError("SFTP browsing is available in the RemoteHand desktop app.");
return;
}
setLoading(true);
setError("");
try {
const next = await invoke<SftpListing>("sftp_list", {
host: connection.host,
port: connection.port,
user: connection.user,
path,
credentialRef: connection.credentialRef,
});
setListing(next);
setRequestedPath(next.path);
setPathInput(next.path);
setSelectedPaths([]);
setNeedsVaultUnlock(false);
} catch (reason) {
const message = String(reason);
if (connection.credentialRef && message.includes("credential vault is locked")) {
setNeedsVaultUnlock(true);
setError("Credential vault is locked. Enter the vault passphrase to continue.");
} else {
setError(message);
}
} finally {
setLoading(false);
}
},
[connection],
);
const unlockVault = useCallback(async () => {
if (!vaultPassphrase || unlocking) return;
setUnlocking(true);
setError("");
try {
await invoke("vault_unlock", { passphrase: vaultPassphrase });
setVaultPassphrase("");
setNeedsVaultUnlock(false);
await loadPath(requestedPath);
} catch (reason) {
setError(String(reason));
} finally {
setUnlocking(false);
}
}, [loadPath, requestedPath, unlocking, vaultPassphrase]);
useEffect(() => {
void loadPath(".");
}, [loadPath]);
const selectedFiles = useMemo(
() =>
listing?.entries.filter((entry) => !entry.isDir && selectedPaths.includes(entry.path)) ?? [],
[listing, selectedPaths],
);
if (!connection) {
return <section className="panel-content sftp-panel">Missing SFTP connection.</section>;
}
const currentPath = listing?.path ?? requestedPath;
const canGoUp = Boolean(currentPath && currentPath !== "/" && currentPath !== ".");
function toggleFile(entry: SftpEntry) {
if (entry.isDir || transferring) return;
setTransferStatus("");
setError("");
setSelectedPaths((current) =>
current.includes(entry.path)
? current.filter((path) => path !== entry.path)
: [...current, entry.path],
);
}
async function chooseUploadFiles() {
if (transferring || loading) return;
setError("");
try {
const paths = await invoke<string[]>("sftp_pick_upload_files");
if (paths.length > 0) setUploadPaths(paths);
} catch (reason) {
setError(String(reason));
}
}
async function uploadFiles() {
if (uploadPaths.length === 0 || transferring || loading) return;
const seen = new Set<string>();
const items: TransferItem[] = [];

for (const localPath of uploadPaths) {
const fileName = fileNameFromLocalPath(localPath);
if (!fileName) continue;

if (seen.has(fileName)) {
setError('Multiple selected local files are named "' + fileName + '".');
return;
}
seen.add(fileName);

if (listing?.entries.some((entry) => entry.name === fileName)) {
setError('A remote entry named "' + fileName + '" already exists.');
return;
}

items.push({
localPath,
remotePath: remoteChildPath(currentPath, fileName),
});
}

if (items.length === 0) return;

setTransferState("uploading");
setError("");
setTransferStatus("");
try {
const count = await invoke<number>("sftp_upload_many", {
host: connection.host,
port: connection.port,
user: connection.user,
items,
credentialRef: connection.credentialRef,
});
setTransferStatus("Uploaded " + String(count) + (count === 1 ? " file" : " files"));
setUploadPaths([]);
await loadPath(currentPath);
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
}
async function downloadFiles() {
if (selectedFiles.length === 0 || transferring || loading) return;
setError("");
let folder: string | null;
try {
folder = await invoke<string | null>("sftp_pick_download_folder");
} catch (reason) {
setError(String(reason));
return;
}
if (!folder) return;

const items: TransferItem[] = selectedFiles.map((entry) => ({
localPath: joinLocalPath(folder, entry.name),
remotePath: entry.path,
}));

setTransferState("downloading");
setTransferStatus("");
try {
const count = await invoke<number>("sftp_download_many", {
host: connection.host,
port: connection.port,
user: connection.user,
items,
credentialRef: connection.credentialRef,
});
setTransferStatus("Downloaded " + String(count) + (count === 1 ? " file" : " files"));
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
}
return (
<section className={"panel-content sftp-panel" + (needsVaultUnlock ? " sftp-panel-unlock" : "")}>
<div className="sftp-heading">
<div>
<p className="eyebrow">Milestone 5</p>
<h2>{connection.name}</h2>
<span>
{connection.user}@{connection.host}:{connection.port}
</span>
</div>
<div className="sftp-toolbar">
<button
type="button"
disabled={!canGoUp || loading || transferring}
onClick={() => void loadPath(parentPath(currentPath))}
>
Up
</button>
<button
type="button"
disabled={loading || transferring}
onClick={() => void loadPath(currentPath)}
>
Refresh
</button>
</div>
</div>
<div className="sftp-transfer-bar">
<div className="sftp-transfer-group">
<span>Upload local files</span>
<button
type="button"
className="sftp-picker-button"
onClick={() => void chooseUploadFiles()}
disabled={loading || transferring}
>
Choose files…
</button>
<div className="sftp-transfer-summary" title={uploadPaths.join("\n")}>
{uploadPaths.length === 0
? "No files selected"
: uploadPaths.length === 1
? uploadPaths[0]
: String(uploadPaths.length) + " files selected"}
</div>
<button
type="button"
onClick={() => void uploadFiles()}
disabled={uploadPaths.length === 0 || loading || transferring}
>
{transferState === "uploading" ? "Working…" : "Upload"}
</button>
</div>

<div className="sftp-transfer-group sftp-download-group">
<span>Download selected files</span>
<div className="sftp-transfer-summary">
{selectedFiles.length === 0
? "No remote files selected"
: String(selectedFiles.length) +
(selectedFiles.length === 1 ? " file selected" : " files selected")}
</div>
<button
type="button"
onClick={() => void downloadFiles()}
disabled={selectedFiles.length === 0 || loading || transferring}
>
{transferState === "downloading" ? "Working…" : "Download"}
</button>
</div>
</div>

<input
className="sftp-path"
type="text"
value={pathInput}
onChange={(event) => setPathInput(event.target.value)}
onKeyDown={(event) => {
if (event.key === "Enter" && !loading && !transferring) {
void loadPath(pathInput.trim() || ".");
}
}}
disabled={loading || transferring}
aria-label="Remote path"
title="Type a remote path and press Enter"
/>

{needsVaultUnlock ? (
<div className="sftp-unlock">
<label>
<span>Vault passphrase</span>
<input
type="password"
value={vaultPassphrase}
onChange={(event) => setVaultPassphrase(event.target.value)}
onKeyDown={(event) => {
if (event.key === "Enter") void unlockVault();
}}
autoComplete="current-password"
autoFocus
/>
</label>
<button
type="button"
onClick={() => void unlockVault()}
disabled={!vaultPassphrase || unlocking}
>
{unlocking ? "Unlocking…" : "Unlock"}
</button>
</div>
) : null}

{error ? (
<div className="sftp-error sftp-message">
<span>{error}</span>
<button type="button" onClick={() => setError("")} aria-label="Dismiss error">
×
</button>
</div>
) : null}

{transferStatus ? (
<div className="sftp-transfer-status sftp-message">
<span>{transferStatus}</span>
<button
type="button"
onClick={() => setTransferStatus("")}
aria-label="Dismiss transfer status"
>
×
</button>
</div>
) : null}

{loading ? <div className="sftp-state">Loading remote directory…</div> : null}

{!loading && !error && !needsVaultUnlock && !unlocking ? (
<div className="sftp-list" role="table" aria-label="Remote files">
<div className="sftp-row sftp-row-header" role="row">
<span>Name</span>
<span>Size</span>
<span>Permissions</span>
</div>

{listing?.entries.length === 0 ? (
<div className="sftp-state">This directory is empty.</div>
) : null}

{listing?.entries.map((entry) => (
<button
type="button"
className="sftp-row sftp-entry"
key={entry.path + "-" + entry.name}
disabled={transferring}
onDoubleClick={() => entry.isDir && !transferring && void loadPath(entry.path)}
onClick={() => (entry.isDir ? void loadPath(entry.path) : toggleFile(entry))}
aria-pressed={!entry.isDir && selectedPaths.includes(entry.path)}
title={entry.isDir ? "Open " + entry.name : entry.name}
>
<span className="sftp-name">
<span aria-hidden="true">{entry.isDir ? "▸" : "·"}</span>
{entry.name}
</span>
<span>{entry.isDir ? "—" : formatSize(entry.size)}</span>
<span>{entry.permissions}</span>
</button>
))}
</div>
) : null}
</section>
);
}
