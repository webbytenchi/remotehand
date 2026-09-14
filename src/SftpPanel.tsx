import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IDockviewPanelProps } from "dockview-react";
import { AppModal } from "./AppModal";
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
| "creating"
| "renaming"
| "moving"
| "chmodding"
| "deleting";
type SftpActionModal = "new-folder" | "rename" | "move" | "chmod" | "delete" | "properties" | null;
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
function permissionsToOctal(permissions: string) {
const mode = permissions.slice(-9);
if (mode.length !== 9) return "";
const digit = (triplet: string) =>
String((triplet[0] === "r" ? 4 : 0) + (triplet[1] === "w" ? 2 : 0) + ("xst".includes(triplet[2].toLowerCase()) ? 1 : 0));
const special =
(mode[2] === "s" || mode[2] === "S" ? 4 : 0) +
(mode[5] === "s" || mode[5] === "S" ? 2 : 0) +
(mode[8] === "t" || mode[8] === "T" ? 1 : 0);
const octal = digit(mode.slice(0, 3)) + digit(mode.slice(3, 6)) + digit(mode.slice(6, 9));
return special ? String(special) + octal : octal;
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
const [moreOpen, setMoreOpen] = useState(false);
const [actionModal, setActionModal] = useState<SftpActionModal>(null);
const [modalValue, setModalValue] = useState("");
const [modalError, setModalError] = useState("");
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
function closeActionModal() {
setActionModal(null);
setModalValue("");
setModalError("");
}
function createFolder() {
if (!listing || needsVaultUnlock || transferring || loading) return;
setModalValue("");
setModalError("");
setActionModal("new-folder");
}
function renameSelected() {
if (selectedEntries.length !== 1 || transferring || loading) return;
setModalValue(selectedEntries[0].name);
setModalError("");
setActionModal("rename");
}
function showProperties() {
setMoreOpen(false);
setModalError("");
setActionModal("properties");
}
async function copyPath() {
setMoreOpen(false);
const value = selectedEntries.length === 1 ? selectedEntries[0].path : currentPath;
try {
await navigator.clipboard.writeText(value);
setTransferStatus("Copied remote path");
setError("");
} catch (reason) {
setError("Could not copy remote path: " + String(reason));
}
}
function openTerminalHere() {
setMoreOpen(false);
const escapedPath = currentPath.replaceAll("'", "'\\''");
props.containerApi.addPanel({
id: "ssh-sftp-" + Date.now(),
component: "terminal",
title: connection.name,
params: {
ssh: {
host: connection.host,
port: connection.port,
user: connection.user,
name: connection.name,
},
initialCommand: "cd '" + escapedPath + "'",
},
});
}
function moveSelected() {
if (selectedEntries.length === 0 || transferring || loading) return;
setModalValue(currentPath);
setModalError("");
setActionModal("move");
}
function chmodSelected() {
if (selectedEntries.length === 0 || transferring || loading) return;
const octalValues = selectedEntries.map((entry) => permissionsToOctal(entry.permissions)).filter(Boolean);
const uniqueOctalValues = Array.from(new Set(octalValues));
setModalValue(uniqueOctalValues.length === 1 ? uniqueOctalValues[0] : "");
setModalError("");
setActionModal("chmod");
}
function deleteSelected() {
if (selectedEntries.length === 0 || transferring || loading) return;
setModalValue("");
setModalError("");
setActionModal("delete");
}
async function confirmActionModal() {
if (!actionModal) return;
if (actionModal === "properties") {
closeActionModal();
return;
}
const value = modalValue.trim();
if (actionModal === "new-folder" || actionModal === "rename") {
if (!value) {
setModalError(actionModal === "new-folder" ? "Enter a folder name." : "Enter a new name.");
return;
}
if (value === "." || value === ".." || value.includes("/") || value.includes(String.fromCharCode(92))) {
setModalError("Name cannot contain path separators.");
return;
}
}
if (actionModal === "rename" && selectedEntries.length === 1 && value === selectedEntries[0].name) {
setModalError("Enter a different name.");
return;
}
if (actionModal === "move" && !value) {
setModalError("Enter a destination directory.");
return;
}
if (actionModal === "chmod" && !/^[0-7]{3,4}$/.test(value)) {
setModalError("Enter a 3- or 4-digit octal mode, such as 755 or 0644.");
return;
}
const modal = actionModal;
closeActionModal();
setError("");
setTransferStatus("");
if (modal === "new-folder") {
setTransferState("creating");
setTransferStatus("Creating folder " + String.fromCharCode(34) + value + String.fromCharCode(34) + "...");
try {
const path = remoteChildPath(currentPath, value);
await invoke(useNativeSftp ? "sftp_native_mkdir" : "sftp_mkdir", {
host: connection.host,
port: connection.port,
user: connection.user,
path,
credentialRef: connection.credentialRef,
...(useNativeSftp ? { sessionId: nativeSessionId } : {}),
});
await loadPath(currentPath);
setTransferStatus('Created folder "' + value + '"');
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
return;
}
if (modal === "rename") {
if (selectedEntries.length !== 1) return;
const entry = selectedEntries[0];
setTransferState("renaming");
setTransferStatus("Renaming " + String.fromCharCode(34) + entry.name + String.fromCharCode(34) + " to " + String.fromCharCode(34) + value + String.fromCharCode(34) + "...");
try {
const destination = remoteChildPath(parentPath(entry.path), value);
await invoke(useNativeSftp ? "sftp_native_rename_entry" : "sftp_rename_entry", {
host: connection.host,
port: connection.port,
user: connection.user,
source: entry.path,
destination,
credentialRef: connection.credentialRef,
...(useNativeSftp ? { sessionId: nativeSessionId } : {}),
});
await loadPath(currentPath);
setTransferStatus('Renamed "' + entry.name + '" to "' + value + '"');
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
return;
}
if (modal === "move") {
setTransferState("moving");
setTransferStatus(selectedEntries.length === 1 ? "Moving " + String.fromCharCode(34) + selectedEntries[0].name + String.fromCharCode(34) + " to " + String.fromCharCode(34) + value + String.fromCharCode(34) + "..." : "Moving " + String(selectedEntries.length) + " items to " + String.fromCharCode(34) + value + String.fromCharCode(34) + "...");
try {
const count = await invoke<number>("sftp_move_entries", {
host: connection.host,
port: connection.port,
user: connection.user,
destination: value,
items: selectedEntries.map(({ path, name, isDir }) => ({ path, name, isDir })),
credentialRef: connection.credentialRef,
});
await loadPath(currentPath);
setTransferStatus("Moved " + String(count) + (count === 1 ? " item" : " items"));
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
return;
}
if (modal === "chmod") {
setTransferState("chmodding");
setTransferStatus(selectedEntries.length === 1 ? "Changing permissions for " + String.fromCharCode(34) + selectedEntries[0].name + String.fromCharCode(34) + " to " + value + "..." : "Changing permissions for " + String(selectedEntries.length) + " items to " + value + "...");
try {
const count = await invoke<number>("sftp_chmod_entries", {
host: connection.host,
port: connection.port,
user: connection.user,
mode: value,
items: selectedEntries.map(({ path, name, isDir }) => ({ path, name, isDir })),
credentialRef: connection.credentialRef,
});
await loadPath(currentPath);
setTransferStatus("Changed permissions on " + String(count) + (count === 1 ? " item" : " items"));
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
return;
}
if (modal === "delete") {
setTransferState("deleting");
setTransferStatus(selectedEntries.length === 1 ? "Deleting " + String.fromCharCode(34) + selectedEntries[0].name + String.fromCharCode(34) + "..." : "Deleting " + String(selectedEntries.length) + " items...");
try {
const count = await invoke<number>("sftp_delete_entries", {
host: connection.host,
port: connection.port,
user: connection.user,
items: selectedEntries.map(({ path, name, isDir }) => ({ path, name, isDir })),
credentialRef: connection.credentialRef,
});
await loadPath(currentPath);
setTransferStatus("Deleted " + String(count) + (count === 1 ? " item" : " items"));
} catch (reason) {
setError(String(reason));
} finally {
setTransferState("idle");
}
}
}
function actionModalTitle() {
switch (actionModal) {
case "new-folder": return "New folder";
case "rename": return "Rename item";
case "move": return "Move selected items";
case "chmod": return "Change permissions";
case "delete": return "Delete selected items?";
case "properties": return "Properties";
default: return "";
}
}
function actionModalConfirmLabel() {
switch (actionModal) {
case "new-folder": return "Create";
case "rename": return "Rename";
case "move": return "Move";
case "chmod": return "Apply";
case "delete": return "Delete";
case "properties": return "Close";
default: return "OK";
}
}
const propertiesEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
const selectedPermissionOctals = selectedEntries.map((entry) => permissionsToOctal(entry.permissions)).filter(Boolean);
const uniquePermissionOctals = Array.from(new Set(selectedPermissionOctals));
const selectedPermissionSymbols = Array.from(new Set(selectedEntries.map((entry) => entry.permissions)));
const chmodCurrentOctal = uniquePermissionOctals.length === 1 ? uniquePermissionOctals[0] : "Mixed";
const chmodCurrentPermissions = selectedPermissionSymbols.length === 1 ? selectedPermissionSymbols[0] : "Mixed";
const deleteDescription = selectedEntries.length === 1
? selectedEntries[0].name
: String(selectedEntries.length) + " selected items";

return (
<section className={"panel-content sftp-panel" + (needsVaultUnlock ? " sftp-panel-unlock" : "")}>
<div className="sftp-heading">
<div>
<h2>{connection.name}</h2>
<span>
{connection.user}@{connection.host}:{connection.port}
</span>
</div>
</div>
{listing && !needsVaultUnlock ? (
<div className="sftp-action-toolbar" role="toolbar" aria-label="SFTP file actions">
<button className="sftp-icon-action" type="button" title="Up" aria-label="Up" onClick={() => void loadPath(parentPath(currentPath))} disabled={!canGoUp || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-5 5m5-5 5 5"/></svg></button>
<button className="sftp-icon-action" type="button" title="Refresh" aria-label="Refresh" onClick={() => void loadPath(currentPath)} disabled={loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.2 9a7 7 0 0 1 11.5-2.3L20 11M4 13l2.3 4.3A7 7 0 0 0 17.8 15"/></svg></button>
<span className="sftp-toolbar-separator" aria-hidden="true" />
<button className="sftp-icon-action" type="button" title="Upload" aria-label="Upload" onClick={() => void chooseUploadFiles()} disabled={!listing || needsVaultUnlock || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M5 20h14"/></svg></button>
<button className="sftp-icon-action" type="button" title="Download" aria-label="Download" onClick={() => void downloadFiles()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14"/></svg></button>
<span className="sftp-toolbar-separator" aria-hidden="true" />
<button className="sftp-icon-action" type="button" title="New Folder" aria-label="New Folder" onClick={() => void createFolder()} disabled={loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3zM12 12v5m-2.5-2.5h5"/></svg></button>
<button className="sftp-icon-action" type="button" title="Rename" aria-label="Rename" onClick={() => void renameSelected()} disabled={selectedEntries.length !== 1 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1L19 8.5 15.5 5 5 15.5 4 20ZM13.5 7l3.5 3.5"/></svg></button>
<button className="sftp-icon-action" type="button" title="Move" aria-label="Move" onClick={() => void moveSelected()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-4-4 4 4-4 4M9 8 5 12l4 4"/></svg></button>
<button className="sftp-icon-action" type="button" title="CHMOD" aria-label="CHMOD" onClick={() => void chmodSelected()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9H6z"/></svg></button>
<span className="sftp-toolbar-separator" aria-hidden="true" />
<button className="sftp-icon-action sftp-danger-action" type="button" title="Delete" aria-label="Delete" onClick={() => void deleteSelected()} disabled={selectedEntries.length === 0 || loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg></button>
<div className="sftp-more">
<button className="sftp-icon-action" type="button" title="More actions" aria-label="More actions" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)} disabled={loading || transferring}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
{moreOpen ? (
<div className="sftp-more-menu" role="menu">
<button type="button" role="menuitem" onClick={showProperties}>Properties</button>
<button type="button" role="menuitem" onClick={() => void copyPath()}>Copy Path</button>
<button type="button" role="menuitem" onClick={openTerminalHere}>Open Terminal Here</button>
</div>
) : null}
</div>
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
              className="sftp-unlock-button"
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

<AppModal
open={actionModal !== null}
title={actionModalTitle()}
confirmLabel={actionModalConfirmLabel()}
cancelLabel={actionModal === "properties" ? undefined : "Cancel"}
danger={actionModal === "delete"}
focusActions={actionModal === "delete" || actionModal === "properties"}
onConfirm={() => void confirmActionModal()}
onCancel={closeActionModal}
>
{actionModal === "properties" ? (
<div className="sftp-properties">
{propertiesEntry ? (
<>
<div><span>Name</span><strong>{propertiesEntry.name}</strong></div>
<div><span>Path</span><strong>{propertiesEntry.path}</strong></div>
<div><span>Type</span><strong>{propertiesEntry.isDir ? "Folder" : "File"}</strong></div>
<div><span>Size</span><strong>{propertiesEntry.isDir ? "—" : formatSize(propertiesEntry.size)}</strong></div>
<div><span>Permissions</span><strong>{propertiesEntry.permissions}</strong></div>
<div><span>Octal</span><strong>{permissionsToOctal(propertiesEntry.permissions) || "—"}</strong></div>
</>
) : (
<>
<div><span>Path</span><strong>{currentPath}</strong></div>
<div><span>Type</span><strong>Folder</strong></div>
<div><span>Selected items</span><strong>{selectedEntries.length}</strong></div>
</>
)}
</div>
) : actionModal === "delete" ? (
<>
<p>Delete <strong>{deleteDescription}</strong>?</p>
<p className="app-modal-muted">Non-empty directories will be refused.</p>
</>
) : (
<>
{actionModal === "chmod" ? (
<div className="sftp-properties">
{selectedEntries.length === 1 ? (
<>
<div><span>Name</span><strong>{selectedEntries[0].name}</strong></div>
<div><span>Current permissions</span><strong>{selectedEntries[0].permissions}</strong></div>
<div><span>Current octal</span><strong>{permissionsToOctal(selectedEntries[0].permissions) || "—"}</strong></div>
</>
) : (
<>
<div><span>Selected items</span><strong>{selectedEntries.length}</strong></div>
<div><span>Current permissions</span><strong>{chmodCurrentPermissions}</strong></div>
<div><span>Current octal</span><strong>{chmodCurrentOctal}</strong></div>
</>
)}
</div>
) : null}
<label className="sftp-modal-field">
<span>
{actionModal === "new-folder"
? "Folder name"
: actionModal === "rename"
? "New name"
: actionModal === "move"
? "Destination directory"
: "Octal mode"}
</span>
<input
type="text"
value={modalValue}
onChange={(event) => {
setModalValue(event.target.value);
setModalError("");
}}
onKeyDown={(event) => {
if (event.key === "Enter") void confirmActionModal();
}}
autoFocus
/>
{actionModal === "chmod" ? (
<small>Use a 3- or 4-digit octal mode, for example 755 or 0644.</small>
) : null}
{modalError ? <small className="sftp-modal-error">{modalError}</small> : null}
</label>
</>
)}
</AppModal>

</section>
);
}
