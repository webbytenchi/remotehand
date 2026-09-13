import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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

type TransferStatus =
  | "conflict"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

type TransferItem = {
  id: string;
  kind: "upload" | "download";
  name: string;
  localPath?: string;
  remotePath: string;
  alternateRemotePath?: string;
  totalBytes: number;
  transferredBytes: number;
  status: TransferStatus;
  startedAt?: number;
  finishedAt?: number;
  resultPath?: string;
  error?: string;
};

type TransferProgress = {
  transferId: string;
  status: string;
  transferredBytes: number;
  totalBytes: number;
};

type TransferResult = {
  transferId: string;
  localPath?: string;
  remotePath: string;
  bytes: number;
};

function parentPath(path: string) {
  if (!path || path === "/" || path === ".") return path;
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function joinRemotePath(base: string, name: string) {
  return base === "/" ? "/" + name : base.replace(/\/+$/, "") + "/" + name;
}

function localBaseName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "upload";
}

function keepBothName(name: string, existing: Set<string>) {
  const index = name.lastIndexOf(".");
  const hasExtension = index > 0;
  const stem = hasExtension ? name.slice(0, index) : name;
  const extension = hasExtension ? name.slice(index) : "";
  for (let copy = 2; copy < 10_000; copy += 1) {
    const candidate = stem + " (" + copy + ")" + extension;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return "copy-" + Date.now() + "-" + name;
}

function formatSize(size: number) {
  if (size < 1024) return String(size) + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + " MB";
  return (size / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function transferMetrics(item: TransferItem) {
  const percent = item.totalBytes > 0
    ? Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100))
    : item.status === "completed"
      ? 100
      : 0;
  const elapsedSeconds = item.startedAt
    ? Math.max(0.001, ((item.finishedAt ?? Date.now()) - item.startedAt) / 1000)
    : 0;
  const speed = elapsedSeconds > 0 ? item.transferredBytes / elapsedSeconds : 0;
  const remaining = Math.max(0, item.totalBytes - item.transferredBytes);
  const eta = speed > 0 && remaining > 0 ? Math.ceil(remaining / speed) : 0;
  return { percent, speed, eta };
}

export function SftpPanel(props: IDockviewPanelProps<SftpPanelParams>) {
  const connection = props.params?.connection;
  const sessionId = props.api.id;
  const [listing, setListing] = useState<SftpListing | null>(null);
  const [requestedPath, setRequestedPath] = useState(".");
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState(".");
  const [error, setError] = useState("");
  const [needsVaultUnlock, setNeedsVaultUnlock] = useState(false);
  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [manualUploadPath, setManualUploadPath] = useState("");
  const [permissionMode, setPermissionMode] = useState("644");
  const [transfers, setTransfers] = useState<TransferItem[]>([]);

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
          sessionId,
          host: connection.host,
          port: connection.port,
          user: connection.user,
          path,
          credentialRef: connection.credentialRef,
        });
        setListing(next);
        setRequestedPath(next.path);
        setPathInput(next.path);
        setSelectedPath(null);
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
    [connection, sessionId],
  );

  const currentPath = listing?.path ?? requestedPath;
  const selectedEntry = useMemo(
    () => listing?.entries.find((entry) => entry.path === selectedPath) ?? null,
    [listing, selectedPath],
  );

  const queueUploadPath = useCallback(
    (localPath: string) => {
      const trimmed = localPath.trim();
      if (!trimmed) return;
      const name = localBaseName(trimmed);
      const existingNames = new Set(
        (listing?.entries ?? []).map((entry) => entry.name.toLocaleLowerCase()),
      );
      const conflict = existingNames.has(name.toLocaleLowerCase());
      const alternateName = conflict ? keepBothName(name, existingNames) : name;
      setTransfers((current) => [
        ...current,
        {
          id: "transfer-" + Date.now() + "-" + Math.random().toString(16).slice(2),
          kind: "upload",
          name,
          localPath: trimmed,
          remotePath: joinRemotePath(currentPath, name),
          alternateRemotePath: joinRemotePath(currentPath, alternateName),
          totalBytes: 0,
          transferredBytes: 0,
          status: conflict ? "conflict" : "queued",
        },
      ]);
      setManualUploadPath("");
    },
    [currentPath, listing],
  );

  const queueDownload = useCallback(() => {
    if (!selectedEntry || selectedEntry.isDir) return;
    setTransfers((current) => [
      ...current,
      {
        id: "transfer-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        kind: "download",
        name: selectedEntry.name,
        remotePath: selectedEntry.path,
        totalBytes: selectedEntry.size,
        transferredBytes: 0,
        status: "queued",
      },
    ]);
  }, [selectedEntry]);

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

  const applyPermissions = useCallback(async () => {
    if (!selectedEntry || !permissionMode.trim()) return;
    setError("");
    try {
      await invoke("sftp_chmod", {
        sessionId,
        path: selectedEntry.path,
        mode: permissionMode.trim(),
      });
      await loadPath(currentPath);
    } catch (reason) {
      setError(String(reason));
    }
  }, [currentPath, loadPath, permissionMode, selectedEntry, sessionId]);

  useEffect(() => {
    void loadPath(".");
    return () => {
      if (connection && isTauri()) {
        void invoke("sftp_close", { sessionId }).catch(() => undefined);
      }
    };
  }, [connection, loadPath, sessionId]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void listen<TransferProgress>("sftp-transfer-progress", (event) => {
      if (!active) return;
      setTransfers((current) =>
        current.map((item) =>
          item.id === event.payload.transferId
            ? {
                ...item,
                transferredBytes: event.payload.transferredBytes,
                totalBytes: event.payload.totalBytes || item.totalBytes,
                status: event.payload.status === "completed" ? "completed" : item.status,
              }
            : item,
        ),
      );
    }).then((stop) => {
      if (!active) stop();
      else unlisten = stop;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (!active || event.payload.type !== "drop") return;
      for (const path of event.payload.paths) queueUploadPath(path);
    }).then((stop) => {
      if (!active) stop();
      else unlisten = stop;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [queueUploadPath]);

  useEffect(() => {
    if (!connection || !isTauri()) return;
    if (transfers.some((item) => item.status === "running")) return;
    const next = transfers.find((item) => item.status === "queued");
    if (!next) return;

    const startedAt = Date.now();
    setTransfers((current) =>
      current.map((item) =>
        item.id === next.id ? { ...item, status: "running", startedAt } : item,
      ),
    );

    const run = async () => {
      try {
        let result: TransferResult;
        if (next.kind === "upload") {
          result = await invoke<TransferResult>("sftp_upload", {
            transferId: next.id,
            host: connection.host,
            port: connection.port,
            user: connection.user,
            localPath: next.localPath,
            remotePath: next.remotePath,
            credentialRef: connection.credentialRef,
          });
        } else {
          result = await invoke<TransferResult>("sftp_download", {
            transferId: next.id,
            host: connection.host,
            port: connection.port,
            user: connection.user,
            remotePath: next.remotePath,
            remoteSize: next.totalBytes,
            conflictPolicy: "rename",
            credentialRef: connection.credentialRef,
          });
        }
        setTransfers((current) =>
          current.map((item) =>
            item.id === next.id
              ? {
                  ...item,
                  status: "completed",
                  transferredBytes: result.bytes,
                  totalBytes: result.bytes || item.totalBytes,
                  resultPath: result.localPath,
                  finishedAt: Date.now(),
                }
              : item,
          ),
        );
        if (next.kind === "upload") await loadPath(currentPath);
      } catch (reason) {
        setTransfers((current) =>
          current.map((item) =>
            item.id === next.id
              ? {
                  ...item,
                  status: "failed",
                  error: String(reason),
                  finishedAt: Date.now(),
                }
              : item,
          ),
        );
      }
    };

    void run();
  }, [connection, currentPath, loadPath, transfers]);

  if (!connection) {
    return <section className="panel-content sftp-panel">Missing SFTP connection.</section>;
  }

  const canGoUp = Boolean(currentPath && currentPath !== "/" && currentPath !== ".");

  return (
    <section className={"panel-content sftp-panel" + (needsVaultUnlock ? " sftp-panel-unlock" : "")}>
      <div className="sftp-heading">
        <div>
          <p className="eyebrow">Milestone 5</p>
          <h2>{connection.name}</h2>
          <span>{connection.user}@{connection.host}:{connection.port}</span>
        </div>
        <div className="sftp-toolbar">
          <button type="button" disabled={!canGoUp || loading} onClick={() => void loadPath(parentPath(currentPath))}>
            Up
          </button>
          <button type="button" disabled={loading} onClick={() => void loadPath(currentPath)}>
            Refresh
          </button>
          <button type="button" disabled={!selectedEntry || selectedEntry.isDir} onClick={queueDownload}>
            Download
          </button>
        </div>
      </div>

      <div className="sftp-address-row">
        <input
          className="sftp-path"
          type="text"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !loading) void loadPath(pathInput.trim() || ".");
          }}
          disabled={loading}
          aria-label="Remote path"
          title="Type a remote path and press Enter"
        />
        <input
          className="sftp-upload-path"
          type="text"
          value={manualUploadPath}
          onChange={(event) => setManualUploadPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") queueUploadPath(manualUploadPath);
          }}
          placeholder="Local file path to upload"
          aria-label="Local upload path"
        />
        <button type="button" onClick={() => queueUploadPath(manualUploadPath)} disabled={!manualUploadPath.trim()}>
          Queue upload
        </button>
      </div>

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
          <button type="button" onClick={() => void unlockVault()} disabled={!vaultPassphrase || unlocking}>
            {unlocking ? "Unlocking..." : "Unlock"}
          </button>
        </div>
      ) : null}

      {error ? <div className="sftp-error">{error}</div> : null}
      {loading ? <div className="sftp-state">Loading remote directory...</div> : null}

      {!loading && !needsVaultUnlock && !unlocking ? (
        <div className="sftp-main">
          <div className="sftp-browser">
            <div className="sftp-drop-hint">Drop local files anywhere in this window to queue an upload.</div>
            <div className="sftp-list" role="table" aria-label="Remote files">
              <div className="sftp-row sftp-row-header" role="row">
                <span>Name</span>
                <span>Size</span>
                <span>Permissions</span>
              </div>
              {listing?.entries.length === 0 ? <div className="sftp-state">This directory is empty.</div> : null}
              {listing?.entries.map((entry) => (
                <button
                  type="button"
                  className={"sftp-row sftp-entry" + (selectedPath === entry.path ? " selected" : "")}
                  key={entry.path + "-" + entry.name}
                  onDoubleClick={() => entry.isDir && void loadPath(entry.path)}
                  onClick={() => {
                    setSelectedPath(entry.path);
                    setPermissionMode(entry.isDir ? "755" : "644");
                  }}
                  title={entry.isDir ? "Select; double-click to open " + entry.name : "Select " + entry.name}
                >
                  <span className="sftp-name"><span aria-hidden="true">{entry.isDir ? ">" : "-"}</span>{entry.name}</span>
                  <span>{entry.isDir ? "-" : formatSize(entry.size)}</span>
                  <span>{entry.permissions}</span>
                </button>
              ))}
            </div>
          </div>

          <aside className="sftp-side">
            <section className="sftp-permissions">
              <strong>Permissions</strong>
              <span>{selectedEntry ? selectedEntry.name : "Select a remote entry"}</span>
              <div>
                <input
                  value={permissionMode}
                  onChange={(event) => setPermissionMode(event.target.value)}
                  inputMode="numeric"
                  maxLength={4}
                  aria-label="Octal permissions"
                />
                <button type="button" disabled={!selectedEntry} onClick={() => void applyPermissions()}>
                  Apply
                </button>
              </div>
            </section>

            <section className="sftp-transfers">
              <div className="sftp-transfer-heading">
                <strong>Transfer queue</strong>
                <button
                  type="button"
                  onClick={() => setTransfers((current) => current.filter((item) => item.status === "queued" || item.status === "running" || item.status === "conflict"))}
                >
                  Clear finished
                </button>
              </div>
              {transfers.length === 0 ? <div className="sftp-state">No transfers queued.</div> : null}
              {transfers.map((item) => {
                const metrics = transferMetrics(item);
                return (
                  <article className="sftp-transfer" key={item.id}>
                    <div className="sftp-transfer-title">
                      <strong>{item.kind === "upload" ? "Upload" : "Download"}: {item.name}</strong>
                      <span>{item.status}</span>
                    </div>
                    {item.status === "conflict" ? (
                      <div className="sftp-conflict">
                        <span>A remote file with this name already exists.</span>
                        <div>
                          <button type="button" onClick={() => setTransfers((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, status: "queued" } : currentItem))}>
                            Overwrite
                          </button>
                          <button type="button" onClick={() => setTransfers((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, remotePath: currentItem.alternateRemotePath ?? currentItem.remotePath, status: "queued" } : currentItem))}>
                            Keep both
                          </button>
                          <button type="button" onClick={() => setTransfers((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, status: "skipped" } : currentItem))}>
                            Skip
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="sftp-progress"><span style={{ width: metrics.percent + "%" }} /></div>
                        <div className="sftp-transfer-meta">
                          <span>{metrics.percent}%</span>
                          <span>{metrics.speed > 0 ? formatSize(metrics.speed) + "/s" : "-"}</span>
                          <span>{metrics.eta > 0 ? "ETA " + metrics.eta + "s" : "ETA -"}</span>
                        </div>
                      </>
                    )}
                    {item.resultPath ? <small>Saved to {item.resultPath}</small> : null}
                    {item.error ? <small className="sftp-transfer-error">{item.error}</small> : null}
                  </article>
                );
              })}
            </section>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
