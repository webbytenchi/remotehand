import { useCallback, useEffect, useState } from "react";
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

function parentPath(path: string) {
  if (!path || path === "/" || path === ".") return path;
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function formatSize(size: number) {
  if (size < 1024) return `${size} ` + "B";
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

  if (!connection) {
    return <section className="panel-content sftp-panel">Missing SFTP connection.</section>;
  }

  const currentPath = listing?.path ?? requestedPath;
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
          <button
            type="button"
            disabled={!canGoUp || loading}
            onClick={() => void loadPath(parentPath(currentPath))}
          >
            Up
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadPath(currentPath)}
          >
            Refresh
          </button>
        </div>
      </div>

      <input
        className="sftp-path"
        type="text"
        value={pathInput}
        onChange={(event) => setPathInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !loading) {
            void loadPath(pathInput.trim() || ".");
          }
        }}
        disabled={loading}
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

      {error ? <div className="sftp-error">{error}</div> : null}
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
              key={`${entry.path}-${entry.name}`}
              disabled={!entry.isDir}
              onDoubleClick={() => entry.isDir && void loadPath(entry.path)}
              onClick={() => entry.isDir && void loadPath(entry.path)}
              title={entry.isDir ? `Open ${entry.name}` : entry.name}
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
