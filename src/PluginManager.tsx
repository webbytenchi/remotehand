import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppModal } from "./AppModal";

type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  author: string;
  description: string;
  permissions: string[];
};

type PluginInfo = {
  manifest: PluginManifest;
  enabled: boolean;
  directory: string;
};

type TopbarItem = {
  id: string;
  title: string;
  target?: string;
  targetId?: string;
  currentLatencyMs?: number | null;
  history?: Array<{ latencyMs?: number | null; state?: string }>;
  state?: string;
  panel?: string;
};

type PluginRuntimeEvent = {
  pluginId: string;
  event: string;
  payload: unknown;
};

type TopbarPayload = {
  items?: unknown;
};

type AlertPayload = {
  alertType?: string;
  targetId?: string;
  target?: string;
  targetName?: string;
  fallbackBeep?: boolean;
  sound?: { dataUrl?: string; durationMs?: number } | null;
};

function parseTopbarItems(payload: unknown): TopbarItem[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as TopbarPayload).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.title !== "string") return [];
    const history = Array.isArray(value.history)
      ? value.history.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          if (record.latencyMs != null && typeof record.latencyMs !== "number") return [];
          if (record.state != null && typeof record.state !== "string") return [];
          return [{
            latencyMs: record.latencyMs as number | null | undefined,
            state: record.state as string | undefined,
          }];
        })
      : [];
    return [{
      id: value.id,
      title: value.title,
      target: typeof value.target === "string" ? value.target : undefined,
      targetId: typeof value.targetId === "string" ? value.targetId : undefined,
      currentLatencyMs: typeof value.currentLatencyMs === "number" ? value.currentLatencyMs : null,
      history,
      state: typeof value.state === "string" ? value.state : undefined,
      panel: typeof value.panel === "string" ? value.panel : undefined,
    } satisfies TopbarItem];
  });
}

function topbarSeverity(state?: string) {
  if (state === "OFFLINE") return "offline";
  if (state === "HIGH LATENCY") return "high-latency";
  if (state === "NORMAL") return "normal";
  return "ready";
}

export function PluginManager({
  open,
  onClose,
  onChanged,
  onOpenPluginPanel,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
  onOpenPluginPanel?: (pluginId: string, panelId: string, context?: { targetId?: string; target?: string }) => void;
}) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PluginInfo | null>(null);
  const [topbarItems, setTopbarItems] = useState<Record<string, TopbarItem[]>>({});
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

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

  const stopAlertSound = useCallback(() => {
    const active = activeAudioRef.current;
    if (active) {
      active.pause();
      active.currentTime = 0;
      activeAudioRef.current = null;
    }
  }, []);

  const primeAudio = useCallback(() => {
    try {
      type AudioContextCtor = new () => AudioContext;
      const ctor = (window as Window & { webkitAudioContext?: AudioContextCtor }).AudioContext ?? (window as Window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
      if (!audioContextRef.current && ctor) audioContextRef.current = new ctor();
      if (audioContextRef.current?.state === "suspended") void audioContextRef.current.resume();
    } catch {
      // Audio is best-effort; monitoring must continue even when audio is unavailable.
    }
  }, []);

  const playBeep = useCallback(async () => {
    primeAudio();
    const context = audioContextRef.current;
    if (!context) return;
    try {
      if (context.state === "suspended") await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.95);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 1.0);
    } catch {
      // Audio failures are intentionally non-fatal.
    }
  }, [primeAudio]);

  const playAlertSound = useCallback(async (payload: AlertPayload) => {
    stopAlertSound();
    const durationMs = Math.min(Math.max(Number(payload.sound?.durationMs) || 1000, 250), 10_000);
    const dataUrl = typeof payload.sound?.dataUrl === "string" ? payload.sound.dataUrl : "";
    if (!dataUrl) {
      await playBeep();
      return;
    }
    try {
      const audio = new Audio(dataUrl);
      audio.preload = "auto";
      activeAudioRef.current = audio;
      audio.onended = () => {
        if (activeAudioRef.current === audio) activeAudioRef.current = null;
      };
      await audio.play();
      window.setTimeout(() => {
        if (activeAudioRef.current !== audio) return;
        audio.pause();
        audio.currentTime = 0;
        activeAudioRef.current = null;
      }, durationMs);
    } catch {
      stopAlertSound();
      await playBeep();
    }
  }, [playBeep, stopAlertSound]);

  useEffect(() => {
    const onPointerDown = () => primeAudio();
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [primeAudio]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<PluginRuntimeEvent>("remotehand-plugin-event", (event) => {
      if (event.payload.event === "topbar.update") {
        const items = parseTopbarItems(event.payload.payload);
        setTopbarItems((current) => ({ ...current, [event.payload.pluginId]: items }));
      } else if (event.payload.event === "monitor.alert") {
        void playAlertSound(event.payload.payload as AlertPayload);
      }
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [playAlertSound]);

  useEffect(() => {
    const activePluginIds = new Set(plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.manifest.id));
    setTopbarItems((current) => {
      const next: Record<string, TopbarItem[]> = {};
      for (const [pluginId, items] of Object.entries(current)) {
        if (activePluginIds.has(pluginId)) next[pluginId] = items;
      }
      return next;
    });
  }, [plugins]);

  const install = async () => {
    setLoading(true);
    setError(null);
    try {
      const installed = await invoke<PluginInfo | null>("plugin_install_from_folder");
      if (installed) {
        await refresh();
        onChanged?.();
      }
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
      await invoke("plugin_set_enabled", { id: plugin.manifest.id, enabled });
      if (!enabled) {
        stopAlertSound();
        setTopbarItems((current) => {
          const next = { ...current };
          delete next[plugin.manifest.id];
          return next;
        });
      }
      await refresh();
      onChanged?.();
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
      setTopbarItems((current) => {
        const next = { ...current };
        delete next[plugin.manifest.id];
        return next;
      });
      await refresh();
      onChanged?.();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const openTopbarItem = (pluginId: string, item: TopbarItem) => {
    if (!onOpenPluginPanel) return;
    onOpenPluginPanel(pluginId, item.panel || "host-monitor", {
      targetId: item.targetId,
      target: item.target,
    });
  };

  const renderedTopbar = Object.entries(topbarItems).flatMap(([pluginId, items]) =>
    items.map((item) => {
      const visible = item.history?.slice(-30) ?? [];
      const values = visible.map((entry) => Number(entry.latencyMs) || 0);
      const max = Math.max(1, ...values);
      const severity = topbarSeverity(item.state);
      const border = severity === "offline" ? "#7d3b3b" : severity === "high-latency" ? "#80622e" : severity === "normal" ? "#355f47" : "#39465a";
      const background = severity === "offline" ? "#29171a" : severity === "high-latency" ? "#2a2417" : "#111a17";
      return (
        <button
          key={`${pluginId}:${item.id}`}
          type="button"
          title={item.target ? `${item.title} · ${item.target}` : item.title}
          aria-label={item.target ? `${item.title} ${item.target}` : item.title}
          onClick={() => openTopbarItem(pluginId, item)}
          style={{
            order: -1,
            position: "relative",
            zIndex: 10,
            pointerEvents: "auto",
            flexShrink: 0,
            width: 112,
            height: 44,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "center",
            gap: 1,
            padding: "3px 7px",
            marginLeft: 6,
            border: `1px solid ${border}`,
            borderRadius: 7,
            background,
            color: "#dce4ee",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          <span style={{ position: "relative", zIndex: 2, fontSize: 14, fontWeight: 700, lineHeight: 1.05 }}>
            {typeof item.currentLatencyMs === "number" ? `${item.currentLatencyMs.toFixed(item.currentLatencyMs < 10 ? 1 : 0)} ms` : "—"}
          </span>
          <span aria-hidden="true" style={{ position: "absolute", left: 4, right: 4, bottom: 4, height: 22, display: "flex", alignItems: "flex-end", gap: 1, opacity: 0.72 }}>
            {visible.map((entry, index) => {
              const height = entry.latencyMs == null ? 8 : Math.max(4, Math.round(((Number(entry.latencyMs) || 0) / max) * 20));
              return <span key={`${item.id}:${index}`} style={{ flex: 1, minWidth: 1, height, borderRadius: 1, background: "currentColor" }} />;
            })}
          </span>
        </button>
      );
    }),
  );

  return (
    <>
      {typeof document !== "undefined" && document.querySelector(".topbar-actions") && renderedTopbar.length
        ? createPortal(renderedTopbar, document.querySelector(".topbar-actions")!)
        : null}
      <AppModal open={open} title="Plugins" confirmLabel="Done" onConfirm={onClose} onCancel={onClose} focusActions={false}>
        <div className="plugin-manager">
          <div className="plugin-manager-heading">
            <div>
              <strong>Installed add-ons</strong>
              <span>Plugins are disabled by default and only receive permissions declared in their manifest.</span>
            </div>
            <div className="plugin-manager-toolbar">
              <button type="button" onClick={() => void install()} disabled={loading}>Install from folder</button>
              <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
            </div>
          </div>
          <div className="plugin-security-note">
            <strong>Plugin API v1 security model</strong>
            <span>RemoteHand validates manifests, permissions, and contributions. Executable plugins run out of process through the Plugin Runtime v1 host.</span>
          </div>
          {error ? <div className="plugin-error">{error}</div> : null}
          {!loading && plugins.length === 0 ? (
            <div className="plugin-empty"><strong>No plugins installed</strong><span>Choose Install from folder to validate and copy an add-on into RemoteHand&apos;s portable plugins directory.</span></div>
          ) : null}
          <div className="plugin-list">
            {plugins.map((plugin) => (
              <article className="plugin-card" key={plugin.manifest.id}>
                <div className="plugin-card-main">
                  <div className="plugin-title-row">
                    <strong>{plugin.manifest.name}</strong>
                    <span className={plugin.enabled ? "plugin-status enabled" : "plugin-status"}>{plugin.enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <span className="plugin-meta">v{plugin.manifest.version} · {plugin.manifest.author} · API {plugin.manifest.apiVersion}</span>
                  {plugin.manifest.description ? <p>{plugin.manifest.description}</p> : null}
                  <div className="plugin-capabilities">
                    {plugin.manifest.permissions.length ? plugin.manifest.permissions.map((permission) => <span key={permission}>{permission}</span>) : <span>no sensitive permissions</span>}
                  </div>
                </div>
                <div className="plugin-actions">
                  <button type="button" disabled={busyId === plugin.manifest.id} onClick={() => void setEnabled(plugin, !plugin.enabled)}>{plugin.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" className="danger" disabled={plugin.enabled || busyId === plugin.manifest.id} onClick={() => requestRemove(plugin)} title={plugin.enabled ? "Disable this plugin before removing it" : "Remove plugin"}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </AppModal>

      <AppModal open={removeTarget !== null} title="Remove plugin?" confirmLabel="Remove" cancelLabel="Cancel" danger onConfirm={() => void confirmRemove()} onCancel={() => setRemoveTarget(null)}>
        <p>Remove <strong>{removeTarget?.manifest.name}</strong>? This deletes its plugin directory. Plugin-owned data is not removed automatically.</p>
      </AppModal>
    </>
  );
}
