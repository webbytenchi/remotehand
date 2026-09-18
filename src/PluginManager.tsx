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

type TopbarTone = "accent" | "success" | "warning" | "danger" | "muted";
type TopbarSeriesPoint = { value?: number | null; tone?: TopbarTone };
type TopbarContent = {
  type: "text" | "metric" | "metric-sparkline" | "status" | "progress";
  label?: string;
  value?: string | number | null;
  tone?: TopbarTone;
  series?: TopbarSeriesPoint[];
};
type TopbarAction = {
  type: "open-panel";
  panel?: string;
  context?: { targetId?: string; target?: string };
};
type TopbarItem = {
  id: string;
  title: string;
  tooltip?: string;
  size?: { width?: number; height?: number };
  content?: TopbarContent;
  action?: TopbarAction;
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

function parseTone(value: unknown): TopbarTone | undefined {
  return value === "accent" || value === "success" || value === "warning" || value === "danger" || value === "muted"
    ? value
    : undefined;
}

function parseTopbarItems(payload: unknown): TopbarItem[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as TopbarPayload).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.title !== "string") return [];
    const sizeValue = value.size && typeof value.size === "object" ? value.size as Record<string, unknown> : undefined;
    const contentValue = value.content && typeof value.content === "object" ? value.content as Record<string, unknown> : undefined;
    const actionValue = value.action && typeof value.action === "object" ? value.action as Record<string, unknown> : undefined;
    let content: TopbarContent | undefined;
    if (contentValue && (contentValue.type === "text" || contentValue.type === "metric" || contentValue.type === "metric-sparkline" || contentValue.type === "status" || contentValue.type === "progress")) {
      const rawSeries = Array.isArray(contentValue.series) ? contentValue.series : [];
      const series = rawSeries.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        if (record.value != null && typeof record.value !== "number") return [];
        return [{ value: record.value as number | null | undefined, tone: parseTone(record.tone) }];
      });
      content = {
        type: contentValue.type,
        label: typeof contentValue.label === "string" ? contentValue.label : undefined,
        value: typeof contentValue.value === "string" || typeof contentValue.value === "number" ? contentValue.value : null,
        tone: parseTone(contentValue.tone),
        series,
      };
    }
    const contextValue = actionValue?.context && typeof actionValue.context === "object" ? actionValue.context as Record<string, unknown> : undefined;
    const action = actionValue?.type === "open-panel"
      ? {
          type: "open-panel" as const,
          panel: typeof actionValue.panel === "string" ? actionValue.panel : undefined,
          context: contextValue
            ? {
                targetId: typeof contextValue.targetId === "string" ? contextValue.targetId : undefined,
                target: typeof contextValue.target === "string" ? contextValue.target : undefined,
              }
            : undefined,
        }
      : undefined;
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
      : undefined;
    return [{
      id: value.id,
      title: value.title,
      tooltip: typeof value.tooltip === "string" ? value.tooltip : undefined,
      size: sizeValue
        ? {
            width: typeof sizeValue.width === "number" ? sizeValue.width : undefined,
            height: typeof sizeValue.height === "number" ? sizeValue.height : undefined,
          }
        : undefined,
      content,
      action,
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

function toneVars(tone: TopbarTone | undefined) {
  switch (tone) {
    case "success": return { text: "var(--success-text, #bce5c7)", surface: "var(--success-surface, #15211a)", border: "var(--success-border, #355f47)" };
    case "warning": return { text: "var(--warning-text, #f1cf87)", surface: "var(--warning-surface, #272116)", border: "var(--warning-border, #6f5a2c)" };
    case "danger": return { text: "var(--danger-text, #efaaaa)", surface: "var(--danger-surface, #241316)", border: "var(--danger-border, #5a3035)" };
    case "muted": return { text: "var(--muted-text, #a8b4c2)", surface: "var(--surface-raised, #1d252f)", border: "var(--border, #39465a)" };
    default: return { text: "var(--accent, #70a7e8)", surface: "var(--accent-surface, #16263a)", border: "var(--accent-border, #3b5f8d)" };
  }
}

function clampTopbarSize(size?: { width?: number; height?: number }) {
  return {
    width: Math.min(180, Math.max(72, Number.isFinite(size?.width) ? Number(size?.width) : 112)),
    height: Math.min(64, Math.max(36, Number.isFinite(size?.height) ? Number(size?.height) : 44)),
  };
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
      const win = window as Window & { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
      const ctor = win.AudioContext ?? win.webkitAudioContext;
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
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.99);
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
    if (item.action?.type === "open-panel") {
      onOpenPluginPanel(pluginId, item.action.panel || "", item.action.context);
      return;
    }
    onOpenPluginPanel(pluginId, item.panel || "", {
      targetId: item.targetId,
      target: item.target,
    });
  };

  const renderedTopbar = Object.entries(topbarItems).flatMap(([pluginId, items]) =>
    items.map((item) => {
      const hasGenericContent = !!item.content;
      const legacyVisible = item.history?.slice(-30) ?? [];
      const legacyValues = legacyVisible.map((entry) => Number(entry.latencyMs) || 0);
      const legacyMax = Math.max(1, ...legacyValues);
      const legacySeverity = topbarSeverity(item.state);
      const genericTone = toneVars(item.content?.tone);
      const size = clampTopbarSize(item.size);
      const series = item.content?.series?.slice(-60) ?? [];
      const seriesValues = series.map((entry) => Number(entry.value) || 0);
      const seriesMax = Math.max(1, ...seriesValues);
      return (
        <button
          key={`${pluginId}:${item.id}`}
          type="button"
          title={item.tooltip || (item.target ? `${item.title} · ${item.target}` : item.title)}
          aria-label={item.tooltip || (item.target ? `${item.title} ${item.target}` : item.title)}
          onClick={() => openTopbarItem(pluginId, item)}
          style={{
            order: -1,
            position: "relative",
            zIndex: 10,
            pointerEvents: "auto",
            flexShrink: 0,
            width: size.width,
            height: size.height,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "center",
            gap: 1,
            padding: "3px 7px",
            marginLeft: 6,
            border: `1px solid ${hasGenericContent ? genericTone.border : (legacySeverity === "offline" ? "var(--danger-border, #7d3b3b)" : legacySeverity === "high-latency" ? "var(--warning-border, #80622e)" : legacySeverity === "normal" ? "var(--success-text, #355f47)" : "var(--border, #39465a)")}`,
            borderRadius: 7,
            background: hasGenericContent ? genericTone.surface : (legacySeverity === "offline" ? "var(--danger-surface, #29171a)" : legacySeverity === "high-latency" ? "var(--warning-surface, #2a2417)" : legacySeverity === "normal" ? "var(--success-surface, #111a17)" : "var(--surface-raised, #1d252f)"),
            color: hasGenericContent ? "var(--text, #dce4ee)" : "#dce4ee",
            cursor: "pointer",
            textAlign: "center",
          }}
        >
          {hasGenericContent ? (
            <>
              {item.content?.type === "text" ? <span style={{ position: "relative", zIndex: 2, fontSize: 13, fontWeight: 700, lineHeight: 1.1 }}>{item.content.label ?? item.title}</span> : null}
              {item.content?.type === "status" ? <span style={{ position: "relative", zIndex: 2, fontSize: 12, fontWeight: 700, lineHeight: 1.1, color: genericTone.text }}>{item.content.label || item.content.value || item.title}</span> : null}
              {item.content?.type === "metric" ? <span style={{ position: "relative", zIndex: 2, fontSize: 14, fontWeight: 700, lineHeight: 1.05 }}>{item.content.value == null ? "—" : String(item.content.value)}</span> : null}
              {item.content?.type === "metric-sparkline" ? (
                <>
                  <span
                    style={{
                      position: "absolute",
                      zIndex: 3,
                      top: 2,
                      left: 5,
                      right: 5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 9,
                      fontWeight: 600,
                      lineHeight: 1.1,
                      color: "var(--muted-text, #a8b4c2)",
                    }}
                  >
                    {item.content.label || item.title}
                  </span>
                  <span style={{ position: "relative", zIndex: 2, marginTop: 7, fontSize: 14, fontWeight: 700, lineHeight: 1.05 }}>
                    {item.content.value == null ? "—" : String(item.content.value)}
                  </span>
                </>
              ) : null}
              {item.content?.type === "progress" ? <div style={{ position: "relative", zIndex: 2, display: "grid", gap: 3 }}><span style={{ fontSize: 12, fontWeight: 700 }}>{item.content.label || item.title}</span><span style={{ display: "block", height: 7, borderRadius: 999, background: "var(--border, #39465a)", overflow: "hidden" }}><span style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, Number(item.content.value) || 0))}%`, background: genericTone.text }} /></span></div> : null}
              {item.content?.type === "metric-sparkline" && series.length ? <span aria-hidden="true" style={{ position: "absolute", left: 4, right: 4, bottom: 4, height: Math.max(16, Math.min(30, size.height - 22)), display: "flex", alignItems: "flex-end", gap: 1, opacity: 0.78 }}>
                {series.map((entry, index) => {
                  const pointTone = toneVars(entry.tone || item.content?.tone);
                  const height = entry.value == null ? 5 : Math.max(3, Math.round(((Number(entry.value) || 0) / seriesMax) * Math.max(10, size.height - 18)));
                  return <span key={`${item.id}:${index}`} style={{ flex: 1, minWidth: 1, height, borderRadius: 1, background: pointTone.text }} />;
                })}
              </span> : null}
            </>
          ) : (
            <>
              <span style={{ position: "relative", zIndex: 2, fontSize: 14, fontWeight: 700, lineHeight: 1.05 }}>
                {typeof item.currentLatencyMs === "number" ? `${item.currentLatencyMs.toFixed(item.currentLatencyMs < 10 ? 1 : 0)} ms` : "—"}
              </span>
              <span aria-hidden="true" style={{ position: "absolute", left: 4, right: 4, bottom: 4, height: 22, display: "flex", alignItems: "flex-end", gap: 1, opacity: 0.72 }}>
                {legacyVisible.map((entry, index) => {
                  const height = entry.latencyMs == null ? 8 : Math.max(4, Math.round(((Number(entry.latencyMs) || 0) / legacyMax) * 20));
                  return <span key={`${item.id}:${index}`} style={{ flex: 1, minWidth: 1, height, borderRadius: 1, background: entry.state === "OFFLINE" ? "var(--danger-text, #efaaaa)" : entry.state === "HIGH LATENCY" ? "var(--warning-text, #f1cf87)" : "var(--accent, #70a7e8)" }} />;
                })}
              </span>
            </>
          )}
        </button>
      );
    }),
  );

  const managerButtonStyle = {
    border: "1px solid var(--accent-border, #39465a)",
    background: "var(--accent-surface, #16263a)",
    color: "var(--accent, #70a7e8)",
    borderRadius: 7,
    padding: "8px 12px",
    cursor: "pointer",
    font: "inherit",
  };

  const managerRemoveStyle = {
    ...managerButtonStyle,
    borderColor: "var(--danger-border, #5a3035)",
    background: "var(--danger-surface, #241316)",
    color: "var(--danger-text, #efaaaa)",
  };

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
            {plugins.map((plugin) => {
              const busy = busyId === plugin.manifest.id;
              return (
                <article className="plugin-card" key={plugin.manifest.id}>
                  <div className="plugin-card-main">
                    <div className="plugin-title-row">
                      <strong>{plugin.manifest.name}</strong>
                      <span className={plugin.enabled ? "plugin-status enabled" : "plugin-status"}>{plugin.enabled ? "Enabled" : "Disabled"}</span>
                    </div>
                    <span className="plugin-meta">v{plugin.manifest.version} · {plugin.manifest.author} · API {plugin.manifest.apiVersion}</span>
                    <p>{plugin.manifest.description}</p>
                    <div className="plugin-permissions"><strong>Permissions</strong>{plugin.manifest.permissions.length ? plugin.manifest.permissions.map((permission) => <span key={permission}>{permission}</span>) : <span>None</span>}</div>
                  </div>
                  <div className="plugin-card-actions">
                    <button type="button" onClick={() => void setEnabled(plugin, !plugin.enabled)} disabled={busy} style={{ ...managerButtonStyle, opacity: busy ? 0.45 : 1, cursor: busy ? "default" : "pointer" }}>{plugin.enabled ? "Disable" : "Enable"}</button>
                    <button type="button" onClick={() => requestRemove(plugin)} disabled={busy || plugin.enabled} style={{ ...managerRemoveStyle, opacity: busy || plugin.enabled ? 0.45 : 1, cursor: busy || plugin.enabled ? "default" : "pointer" }}>Remove</button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </AppModal>
      <AppModal open={removeTarget !== null} title="Remove plugin?" confirmLabel="Remove" onConfirm={() => void confirmRemove()} onCancel={() => setRemoveTarget(null)}>
        <p>This removes the selected plugin from RemoteHand&apos;s portable plugin directory.</p>
      </AppModal>
    </>
  );
}