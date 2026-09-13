import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { IDockviewPanelProps } from "dockview-react";

type SftpConnection = {
  host: string;
  port: number;
  user: string;
  name: string;
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
  const [error, setError] = useState("");

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
        });
        setListing(next);
        setRequestedPath(next.path);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setLoading(false);
      }
    },
    [connection],
  );

  useEffect(() => {
    void loadPath(".");
  }, [loadPath]);

  if (!connection) {
    return <section className="panel-content sftp-panel">Missing SFTP connection.</section>;
  }

  const currentPath = listing?.path ?? requestedPath;
  const canGoUp = Boolean(currentPath && currentPath !== "/" && currentPath !== ".");

  return (
    <section className="panel-content sftp-panel">
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

      <div className="sftp-path" title={currentPath}>{currentPath}</div>

      {error ? <div className="sftp-error">{error}</div> : null}
      {loading ? <div className="sftp-state">Loading remote directory…</div> : null}

      {!loading && !error ? (
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
