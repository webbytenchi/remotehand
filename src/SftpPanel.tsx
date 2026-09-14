import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
type SftpTransferProgressEvent = {
transferId: string;
direction: "upload" | "download";
path: string;
completedFiles: number;
totalFiles: number;
totalFolders: number;
transferredBytes: number;
totalBytes: number;
};
type SftpTransferResult = {
items: number;
files: number;
folders: number;
bytes: number;
};
type LiveTransfer = SftpTransferProgressEvent & {
  speedBytesPerSecond: number;
};
type TransferState =
| "idle"
| "uploading"
| "downloading"
| "moving"
| "chmodding"
| "deleting";
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
const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
const [transferState, setTransferState] = useState<TransferState>("idle");
const [transferStatus, setTransferStatus] = useState("");
const [liveTransfer, setLiveTransfer] = useState<LiveTransfer | null>(null);
const [cancelRequested, setCancelRequested] = useState(false);
const transferStartedAtRef = useRef<{ transferId: string; time: number } | null>(null);
const nativeSessionId = useRef(crypto.randomUUID()).current;
const useNativeSftp = Boolean(connection?.credentialRef);
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
const next = await invoke<SftpListing>(
useNativeSftp ? "sftp_native_list" : "sftp_list",
{
host: connection.host,
port: connection.port,
user: connection.user,
path,
credentialRef: connection.credentialRef,
...(useNativeSftp ? { sessionId: nativeSessionId } : {}),
},
);
setListing(next);
setRequestedPath(next.path);
setPathInput(next.path);
setSelectedPaths([]);
setLastSelectedPath(null);
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
[connection, nativeSessionId, useNativeSftp],
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

useEffect(() => {
if (!isTauri() || !useNativeSftp) return;
return () => {
void invoke("sftp_native_disconnect", { sessionId: nativeSessionId });
};
}, [nativeSessionId, useNativeSftp]);

useEffect(() => {
if (!isTauri()) return;
let unlisten: UnlistenFn | undefined;
void listen<SftpTransferProgressEvent>("sftp-transfer-progress", (event) => {
setLiveTransfer((current) => {
if (!current || current.transferId !== event.payload.transferId) return current;
const started = transferStartedAtRef.current;
let speedBytesPerSecond = current.speedBytesPerSecond;
if (started && started.transferId === event.payload.transferId) {
const elapsedSeconds = (performance.now() - started.time) / 1000;
if (elapsedSeconds > 0 && event.payload.transferredBytes > 0) {
speedBytesPerSecond = event.payload.transferredBytes / elapsedSeconds;
}
}
return { ...event.payload, speedBytesPerSecond };
});
}).then((stop) => {
unlisten = stop;
});
return () => {
unlisten?.();
};
}, []);
const selectedEntries = useMemo(
() => listing?.entries.filter((entry) => selectedPaths.includes(entry.path)) ?? [],
[listing, selectedPaths],
);
const selectedFileCount = selectedEntries.filter((entry) => !entry.isDir).length;
const selectedFolderCount = selectedEntries.filter((entry) => entry.isDir).length;
if (!connection) {
return <section className="panel-content sftp-panel">Missing SFTP connection.</section>;
}
const currentPath = listing?.path ?? requestedPath;
const canGoUp = Boolean(currentPath && currentPath !== "/" && currentPath !== ".");
function toggleEntry(entry: SftpEntry) {
if (transferring) return;
setTransferStatus("");
setError("");
setLastSelectedPath(entry.path);
setSelectedPaths((current) =>
current.includes(entry.path)
? current.filter((path) => path !== entry.path)
: [...current, entry.path],
);
}
function selectEntry(entry: SftpEntry, event: MouseEvent) {
if (transferring) return;
setTransferStatus("");
setError("");
const entries = listing?.entries ?? [];
if (event.shiftKey && lastSelectedPath) {
const anchor = entries.findIndex((item) => item.path === lastSelectedPath);
const target = entries.findIndex((item) => item.path === entry.path);
if (anchor >= 0 && target >= 0) {
const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
const range = entries.slice(from, to + 1).map((item) => item.path);
setSelectedPaths((current) =>
event.ctrlKey || event.metaKey ? Array.from(new Set([...current, ...range])) : range,
);
return;
}
}
if (event.ctrlKey || event.metaKey) {
toggleEntry(entry);
return;
}
setSelectedPaths([entry.path]);
setLastSelectedPath(entry.path);
}
function toggleAllEntries() {
if (transferring || !listing) return;
const allPaths = listing.entries.map((entry) => entry.path);
setSelectedPaths(selectedPaths.length === allPaths.length ? [] : allPaths);
setLastSelectedPath(null);
setTransferStatus("");
setError("");
}
async function chooseUploadFiles() {
if (!listing || needsVaultUnlock || transferring || loading) return;
setError("");
try {
const uploadPaths = await invoke<string[]>("sftp_pick_upload_files");
if (uploadPaths.length === 0) return;
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
if (listing.entries.some((entry) => entry.name === fileName)) {
setError('A remote entry named "' + fileName + '" already exists.');
return;
}
items.push({
localPath,
remotePath: remoteChildPath(currentPath, fileName),
});
}
if (items.length === 0) return;
const transferId = crypto.randomUUID();
setTransferState("uploading");
setTransferStatus("");
setCancelRequested(false);
setLiveTransfer({
transferId,
direction: "upload",
path: "",
completedFiles: 0,
totalFiles: items.length,
totalFolders: 0,
transferredBytes: 0,
totalBytes: 0,
speedBytesPerSecond: 0,
});
transferStartedAtRef.current = { transferId, time: performance.now() };
try {
const result = await invoke<SftpTransferResult>(
useNativeSftp ? "sftp_native_upload_many" : "sftp_upload_many",
{
host: connection.host,
port: connection.port,
user: connection.user,
items,
credentialRef: connection.credentialRef,
transferId,
...(useNativeSftp ? { sessionId: nativeSessionId } : {}),
},
);
setTransferStatus(
"Upload complete · " +
String(result.files) +
(result.files === 1 ? " file" : " files") +
" · " +
formatSize(result.bytes),
);
await loadPath(currentPath);
} finally {
setTransferState("idle");
setLiveTransfer(null);
setCancelRequested(false);
}
} catch (reason) {
const message = String(reason);
if (message.includes("SFTP transfer cancelled")) {
setTransferStatus("Upload cancelled");
} else {
setError(message);
}
}
}
async function downloadFiles() {
if (selectedEntries.length === 0 || transferring || loading) return;
setError("");
let folder: string | null;
try {
folder = await invoke<string | null>("sftp_pick_download_folder");
} catch (reason) {
setError(String(reason));
return;
}
if (!folder) return;

const items = selectedEntries.map((entry) => ({
path: entry.path,
name: entry.name,
isDir: entry.isDir,
size: entry.size,
}));
const transferId = crypto.randomUUID();
setTransferState("downloading");
setTransferStatus("");
setCancelRequested(false);
setLiveTransfer({
transferId,
direction: "download",
path: "",
completedFiles: 0,
totalFiles: 0,
totalFolders: 0,
transferredBytes: 0,
totalBytes: 0,
speedBytesPerSecond: 0,
});
transferStartedAtRef.current = { transferId, time: performance.now() };
try {
const result = await invoke<SftpTransferResult>(
useNativeSftp ? "sftp_native_download_entries" : "sftp_download_entries",
{
host: connection.host,
port: connection.port,
user: connection.user,
folder,
items,
credentialRef: connection.credentialRef,
transferId,
...(useNativeSftp ? { sessionId: nativeSessionId } : {}),
},
);
setTransferStatus(
"Download complete · " +
String(result.files) +
(result.files === 1 ? " file" : " files") +
" · " +
String(result.folders) +
(result.folders === 1 ? " folder" : " folders") +
" · " +
formatSize(result.bytes),
);
} catch (reason) {
const message = String(reason);
if (message.includes("SFTP transfer cancelled")) {
setTransferStatus("Download cancelled");
} else {
setError(message);
}
} finally {
setTransferState("idle");
setLiveTransfer(null);
setCancelRequested(false);
}
}
async function cancelTransfer() {
if (!liveTransfer || !useNativeSftp || cancelRequested) return;
setCancelRequested(true);
try {
await invoke("sftp_native_cancel_transfer", { transferId: liveTransfer.transferId });
} catch (reason) {
setCancelRequested(false);
setError(String(reason));
}
}
async function moveSelected() {
if (selectedEntries.length === 0 || transferring || loading) return;
const destination = window.prompt("Move selected items to remote directory:", currentPath);
if (!destination?.trim()) return;
setTransferState("moving");
setError("");
setTransferStatus("");
try {
const count = await invoke<number>("sftp_move_entries", {
host: connection.host,
port: connection.port,
user: connection.user,
destination: destination.trim(),
items: selectedEntries.map(({ path, name, isDir }) => ({ path, name, isDir })),
credentialRef: connection.credentialRef,
});
setTransferStatus("Moved " + String(count) + (count === 1 ? " item" : " items"));
await loadPath(currentPath);
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
}
async function chmodSelected() {
if (selectedEntries.length === 0 || transferring || loading) return;
const mode = window.prompt("CHMOD selected items (octal mode):", "755");
if (!mode?.trim()) return;
setTransferState("chmodding");
setError("");
setTransferStatus("");
try {
const count = await invoke<number>("sftp_chmod_entries", {
host: connection.host,
port: connection.port,
user: connection.user,
mode: mode.trim(),
items: selectedEntries.map(({ path, name, isDir }) => ({ path, name, isDir })),
credentialRef: connection.credentialRef,
});
setTransferStatus("Changed permissions on " + String(count) + (count === 1 ? " item" : " items"));
await loadPath(currentPath);
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
}
async function deleteSelected() {
if (selectedEntries.length === 0 || transferring || loading) return;
const description = selectedEntries.length === 1
? selectedEntries[0].name
: String(selectedEntries.length) + " selected items";
if (!window.confirm("Delete " + description + "? Non-empty directories will be refused.")) return;
setTransferState("deleting");
setError("");
setTransferStatus("");
try {
const count = await invoke<number>("sftp_delete_entries", {
host: connection.host,
port: connection.port,
user: connection.user,
items: selectedEntries.map(({ path, name, isDir }) => ({ path, name, isDir })),
credentialRef: connection.credentialRef,
});
setTransferStatus("Deleted " + String(count) + (count === 1 ? " item" : " items"));
await loadPath(currentPath);
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
{listing && !needsVaultUnlock ? (
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
) : null}
</div>
{listing && !needsVaultUnlock ? (
<div className="sftp-action-toolbar" role="toolbar" aria-label="SFTP file actions">
<button type="button" title="Choose files to upload" aria-label="Choose files to upload" onClick={() => void chooseUploadFiles()} disabled={!listing || needsVaultUnlock || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M5 20h14"/></svg><span>{transferState === "uploading" ? "Working…" : "Upload"}</span></button>
<button type="button" title="Download selected files and folders" aria-label="Download selected files and folders" onClick={() => void downloadFiles()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14"/></svg><span>{transferState === "downloading" ? "Working…" : "Download"}</span></button>
<button type="button" title="Move selected items" aria-label="Move selected items" onClick={() => void moveSelected()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-4-4 4 4-4 4M9 8 5 12l4 4"/></svg><span>{transferState === "moving" ? "Working…" : "Move"}</span></button>
<button type="button" title="Change permissions" aria-label="Change permissions" onClick={() => void chmodSelected()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9H6z"/></svg><span>{transferState === "chmodding" ? "Working…" : "CHMOD"}</span></button>
<button type="button" className="sftp-danger-action" title="Delete selected items" aria-label="Delete selected items" onClick={() => void deleteSelected()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg><span>{transferState === "deleting" ? "Working…" : "Delete"}</span></button>
</div>
) : null}
{liveTransfer ? (() => {
const progressPercent = liveTransfer.totalBytes > 0
? Math.min(100, (liveTransfer.transferredBytes / liveTransfer.totalBytes) * 100)
: liveTransfer.totalFiles > 0
? Math.min(100, (liveTransfer.completedFiles / liveTransfer.totalFiles) * 100)
: 0;
return (
<div className="sftp-transfer-progress" role="status" aria-live="polite">
<div className="sftp-transfer-progress-header">
<strong>{liveTransfer.direction === "upload" ? "Uploading…" : "Downloading…"}</strong>
<div className="sftp-transfer-progress-actions">
<span>
{liveTransfer.totalFiles > 0
? String(liveTransfer.completedFiles) + " / " + String(liveTransfer.totalFiles) + " files"
: "Preparing transfer…"}
</span>
{useNativeSftp ? (
<button
type="button"
className="sftp-transfer-cancel"
onClick={() => void cancelTransfer()}
disabled={cancelRequested}
>
{cancelRequested ? "Cancelling…" : "Cancel"}
</button>
) : null}
</div>
</div>
<div className="sftp-transfer-current-path" title={liveTransfer.path}>
{liveTransfer.path || "Preparing transfer…"}
</div>
<div className="sftp-transfer-progress-detail">
<span>
{liveTransfer.totalBytes > 0
? formatSize(liveTransfer.transferredBytes) +
" / " +
formatSize(liveTransfer.totalBytes) +
(liveTransfer.speedBytesPerSecond > 0
? " · " + formatSize(liveTransfer.speedBytesPerSecond) + "/s"
: "")
: liveTransfer.totalFolders > 0
? String(liveTransfer.totalFolders) + (liveTransfer.totalFolders === 1 ? " folder" : " folders")
: "Calculating transfer size…"}
</span>
<strong>{progressPercent.toFixed(0) + "%"}</strong>
</div>
<div
className="sftp-transfer-progress-track"
role="progressbar"
aria-valuemin={0}
aria-valuemax={100}
aria-valuenow={Math.round(progressPercent)}
>
<div className="sftp-transfer-progress-bar" style={{ width: progressPercent + "%" }} />
</div>
</div>
);
})() : null}

{listing && !needsVaultUnlock ? (
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
) : null}

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
<label className="sftp-checkbox-cell" title="Select all items"><input type="checkbox" checked={Boolean(listing?.entries.length) && selectedPaths.length === listing?.entries.length} onChange={toggleAllEntries} disabled={transferring || !listing?.entries.length} aria-label="Select all remote items"/></label>
<span>Name</span><span>Size</span><span>Permissions</span>
</div>

{listing?.entries.length === 0 ? (
<div className="sftp-state">This directory is empty.</div>
) : null}

{listing?.entries.map((entry) => (
<div className="sftp-row sftp-entry" key={entry.path + "-" + entry.name} role="row" tabIndex={transferring ? -1 : 0} aria-selected={selectedPaths.includes(entry.path)} onClick={(event) => selectEntry(entry, event)} onDoubleClick={() => entry.isDir && !transferring && void loadPath(entry.path)} onKeyDown={(event) => { if (event.key === "Enter" && entry.isDir && !transferring) void loadPath(entry.path); }} title={entry.isDir ? "Double-click to open " + entry.name : entry.name}>
<label className="sftp-checkbox-cell" onClick={(event) => event.stopPropagation()} title={"Select " + entry.name}><input type="checkbox" checked={selectedPaths.includes(entry.path)} onChange={() => toggleEntry(entry)} disabled={transferring} aria-label={"Select " + entry.name}/></label>
<span className="sftp-name"><span aria-hidden="true">{entry.isDir ? "▸" : "·"}</span>{entry.name}</span>
<span>{entry.isDir ? "—" : formatSize(entry.size)}</span><span>{entry.permissions}</span>
</div>
))}
</div>
) : null}

{selectedEntries.length > 0 && listing && !needsVaultUnlock ? (
<div className="sftp-selected-summary">
<span>Selected remote items</span>
<strong>
{String(selectedEntries.length) +
(selectedEntries.length === 1 ? " item" : " items") +
" · " +
String(selectedFileCount) +
(selectedFileCount === 1 ? " file" : " files") +
" · " +
String(selectedFolderCount) +
(selectedFolderCount === 1 ? " folder" : " folders")}
</strong>
</div>
) : null}
</section>
);
}
