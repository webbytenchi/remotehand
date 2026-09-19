import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { AppModal } from "./AppModal";
import "@xterm/xterm/css/xterm.css";
type LocalShell = "default" | "powershell" | "cmd" | "wsl";
type TerminalParams = {
shell?: LocalShell;
initialCommand?: string;
ssh?: {
host: string;
port: number;
user: string;
name: string;
};
};
type TerminalOutputEvent = {
sessionId: string;
data: string;
};
type TerminalExitEvent = {
sessionId: string;
};
const COMFORT_THEME = {
background: "#11151a",
foreground: "#d8dde6",
cursor: "#d7dde6",
cursorAccent: "#11151a",
selectionBackground: "#3a4658",
black: "#252a31",
red: "#e66b72",
green: "#55c79a",
yellow: "#d7c84d",
blue: "#4eb4d8",
magenta: "#d76bd7",
cyan: "#70c8d8",
white: "#c7ccd4",
brightBlack: "#666d78",
brightRed: "#f07b82",
brightGreen: "#69d7aa",
brightYellow: "#e3d85a",
brightBlue: "#62c3e6",
brightMagenta: "#e784df",
brightCyan: "#86d6e3",
brightWhite: "#eef1f5",
};
const CLASSIC_THEME = {
background: "#05070a",
foreground: "#d5dbe5",
cursor: "#d5dbe5",
selectionBackground: "#32445f",
black: "#000000",
red: "#ff0000",
green: "#00ff00",
yellow: "#ffff00",
blue: "#5c5cff",
magenta: "#ff00ff",
cyan: "#00ffff",
white: "#d5dbe5",
brightBlack: "#666666",
brightRed: "#ff5555",
brightGreen: "#55ff55",
brightYellow: "#ffff55",
brightBlue: "#7f7fff",
brightMagenta: "#ff55ff",
brightCyan: "#55ffff",
brightWhite: "#ffffff",
};
function getTheme(ownerDocument: Document = document) {
const terminalTheme = ownerDocument.documentElement.dataset.terminalTheme;
const baseTheme = terminalTheme === "classic" ? CLASSIC_THEME : COMFORT_THEME;
const styles = ownerDocument.defaultView?.getComputedStyle(ownerDocument.documentElement) ?? getComputedStyle(ownerDocument.documentElement);
const background = styles.getPropertyValue("--terminal-background").trim();
const foreground = styles.getPropertyValue("--terminal-foreground").trim();
return {
...baseTheme,
background: background || baseTheme.background,
foreground: foreground || baseTheme.foreground,
cursorAccent: background || baseTheme.background,
};
}
async function writeTerminal(sessionId: string, data: string) {
await invoke("terminal_write", { sessionId, data });
}

function normalizePaste(text: string): string {
 return text.replace(/\r\n|\r|\n/g, "\r");
}

export function LocalTerminalPanel({
api,
params,
}: IDockviewPanelProps<TerminalParams>) {
const hostRef = useRef<HTMLDivElement>(null);
const terminalRef = useRef<Terminal | null>(null);
const fitAddonRef = useRef<FitAddon | null>(null);
const outputRef = useRef("");
const [searchOpen, setSearchOpen] = useState(false);
const [searchQuery, setSearchQuery] = useState("");
const [status, setStatus] = useState(params?.ssh ? "Connecting SSH..." : "Starting local shell...");
const [rightClickPaste, setRightClickPaste] = useState(true);
const [confirmMultiline, setConfirmMultiline] = useState(true);
const [pendingPaste, setPendingPaste] = useState<string | null>(null);
const [diagnostic, setDiagnostic] = useState("");
const sessionId = api.id;
const shell = params?.shell ?? "default";
const ssh = params?.ssh;
const initialCommand = params?.initialCommand;
useEffect(() => {
const host = hostRef.current;
if (!host) return;
const fitAddon = new FitAddon();
fitAddonRef.current = fitAddon;
const terminal = new Terminal({
cursorBlink: true,
convertEol: false,
documentOverride: host.ownerDocument,
fontFamily: getComputedStyle(host.ownerDocument.documentElement).getPropertyValue("--terminal-font-family").trim() || ["JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Consolas", "Liberation Mono", "monospace"].join(", "),
fontSize: Number.parseInt(getComputedStyle(host.ownerDocument.documentElement).getPropertyValue("--terminal-font-size"), 10) || 13,
scrollback: 10000,
theme: getTheme(host.ownerDocument),
});

const applyTerminalDomTypography = () => {
const rows = terminal.element?.querySelector<HTMLElement>(".xterm-rows");
if (!rows) return;
const ownerDocument = host.ownerDocument;
const styles = ownerDocument.defaultView?.getComputedStyle(ownerDocument.documentElement) ?? getComputedStyle(ownerDocument.documentElement);
const fontFamily = styles.getPropertyValue("--terminal-font-family").trim();
const fontSize = styles.getPropertyValue("--terminal-font-size").trim();
if (fontFamily) rows.style.setProperty("font-family", fontFamily);
if (fontSize) rows.style.setProperty("font-size", fontSize);
};

terminal.loadAddon(fitAddon);
terminalRef.current = terminal;
terminal.open(host);
applyTerminalDomTypography();
fitAddon.fit();
terminal.focus();

const updateDiagnostic = () => {
const element = host.querySelector(".xterm-rows");
const computed = element ? host.ownerDocument.defaultView?.getComputedStyle(element) : null;
const firstCell = element?.querySelector<HTMLElement>("span");
const cellComputed = firstCell ? host.ownerDocument.defaultView?.getComputedStyle(firstCell) : null;
const xtermElement = terminal.element;
const ownerClass = xtermElement ? Array.from(xtermElement.classList).find((name) => name.startsWith("xterm-dom-renderer-owner-")) ?? "n/a" : "n/a";
const matchingStyles = ownerClass === "n/a" ? [] : Array.from(host.ownerDocument.querySelectorAll("style")).filter((style) => style.textContent?.includes(ownerClass));
const mainMatchingStyles = ownerClass === "n/a" ? [] : Array.from(document.querySelectorAll("style")).filter((style) => style.textContent?.includes(ownerClass));
const cellClass = firstCell?.className || "n/a";
const cellStyle = firstCell?.getAttribute("style") || "n/a";
const glyphSpans = element ? Array.from(element.querySelectorAll<HTMLElement>("span")).filter((span) => (span.textContent ?? "").trim().length > 0) : [];
const glyphSample = glyphSpans.slice(0, 4).map((span) => {
const color = host.ownerDocument.defaultView?.getComputedStyle(span).color ?? "n/a";
const text = (span.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 18);
return `${JSON.stringify(text)}:${span.className || "-"}:${color}`;
}).join(";") || "n/a";
const ownerRules = ownerClass === "n/a" ? [] : Array.from(host.ownerDocument.styleSheets).flatMap((sheet) => {
try {
return Array.from(sheet.cssRules).map((rule) => rule.cssText).filter((rule) => rule.includes(ownerClass) && (rule.includes("xterm-rows") || rule.includes("color:")));
} catch {
return [];
}
});
const defaultRule = ownerRules.find((rule) => /xterm-rows[^,{]*\\{[^}]*color:/i.test(rule)) ?? ownerRules.find((rule) => rule.includes("color:")) ?? "n/a";
const ownerRuleSample = ownerRules.slice(0, 6).map((rule) => rule.replace(/\\s+/g, " ").slice(0, 180)).join(" || ") || "n/a";
setDiagnostic(
`doc=${host.ownerDocument.URL} | location=${String(api.location.type)} | font=${terminal.options.fontFamily} | size=${terminal.options.fontSize}px | rows=${terminal.rows} cols=${terminal.cols} | cssFont=${computed?.fontFamily ?? "n/a"} | cssSize=${computed?.fontSize ?? "n/a"} | terminalTheme=${host.ownerDocument.documentElement.dataset.terminalTheme ?? "n/a"} | cssBg=${host.ownerDocument.defaultView?.getComputedStyle(host.ownerDocument.documentElement).getPropertyValue("--terminal-background").trim() || "n/a"} | cssFg=${host.ownerDocument.defaultView?.getComputedStyle(host.ownerDocument.documentElement).getPropertyValue("--terminal-foreground").trim() || "n/a"} | xtermBg=${terminal.options.theme?.background ?? "n/a"} | xtermFg=${terminal.options.theme?.foreground ?? "n/a"} | blue=${terminal.options.theme?.blue ?? "n/a"} | brightBlue=${terminal.options.theme?.brightBlue ?? "n/a"} | white=${terminal.options.theme?.white ?? "n/a"} | brightWhite=${terminal.options.theme?.brightWhite ?? "n/a"} | owner=${ownerClass} | ownerStyles=${matchingStyles.length} | mainOwnerStyles=${mainMatchingStyles.length} | cellClass=${cellClass} | cellStyle=${cellStyle} | cellColor=${cellComputed?.color ?? "n/a"} | glyphs=${glyphSample} | defaultRule=${defaultRule.replace(/\\s+/g, " ").slice(0, 240)} | ownerRules=${ownerRuleSample}`,
);
};

if (!isTauri()) {
terminal.writeln("RemoteHand Terminal");
terminal.writeln("");
terminal.writeln(
"A Tauri desktop runtime is required for terminal sessions.",
);
terminal.writeln("Run: npm run tauri dev");
setStatus("Desktop runtime required");

return () => {
terminal.dispose();
terminalRef.current = null;
fitAddonRef.current = null;
};
}

let cancelled = false;
let unlistenOutput: UnlistenFn | undefined;
let unlistenExit: UnlistenFn | undefined;
let resizeObserver: ResizeObserver | undefined;

const inputDisposable = terminal.onData((data) => {
void writeTerminal(sessionId, data).catch((error) => {
terminal.writeln(
"\r\n[RemoteHand] terminal input failed: " + String(error),
);
});
});

const selectionDisposable = terminal.onSelectionChange(() => {
const selection = terminal.getSelection();
if (!selection) return;
const clipboard = host.ownerDocument.defaultView?.navigator.clipboard;
if (!clipboard) return;
void clipboard.writeText(selection).catch(() => undefined);
});

const start = async () => {
unlistenOutput = await listen<TerminalOutputEvent>(
"terminal-output",
(event) => {
if (event.payload.sessionId !== sessionId) return;
outputRef.current += event.payload.data;
if (outputRef.current.length > 2_000_000) {
outputRef.current = outputRef.current.slice(-1_000_000);
}
terminal.write(event.payload.data);
},
);

if (cancelled) {
unlistenOutput?.();
return;
}

unlistenExit = await listen<TerminalExitEvent>(
"terminal-exit",
(event) => {
if (event.payload.sessionId !== sessionId) return;
terminal.writeln("\r\n[RemoteHand] shell exited.");
setStatus("Exited");
},
);

if (cancelled) {
unlistenOutput?.();
unlistenExit?.();
return;
}

fitAddon.fit();

if (ssh) {
await invoke("ssh_start", {
sessionId,
host: ssh.host,
port: ssh.port,
user: ssh.user,
rows: terminal.rows,
cols: terminal.cols,
initialCommand,
});
} else {
await invoke("terminal_start", {
sessionId,
shell,
rows: terminal.rows,
cols: terminal.cols,
});
}

if (cancelled) {
unlistenOutput?.();
unlistenExit?.();
return;
}

setStatus(
ssh
? "SSH " + ssh.user + "@" + ssh.host + ":" + ssh.port
: shell === "default"
? "Local shell"
: shell,
);

resizeObserver = new ResizeObserver(() => {
const previousCols = terminal.cols;
const previousRows = terminal.rows;
fitAddon.fit();
if (terminal.cols === previousCols && terminal.rows === previousRows) return;

void invoke("terminal_resize", {
sessionId,
rows: terminal.rows,
cols: terminal.cols,
}).catch(() => undefined);
});

resizeObserver.observe(host);
updateDiagnostic();
};



void start().catch((error) => {
terminal.writeln(
"\r\n[RemoteHand] failed to start local terminal: " + String(error),
);
setStatus("Start failed");
});

return () => {
cancelled = true;
resizeObserver?.disconnect();
inputDisposable.dispose();
selectionDisposable.dispose();
unlistenOutput?.();
unlistenExit?.();
terminal.dispose();
terminalRef.current = null;
fitAddonRef.current = null;
};
}, [initialCommand, sessionId, shell, ssh]);
useEffect(() => {
const applyAppearance = () => {
const terminal = terminalRef.current;
const host = hostRef.current;
if (!terminal || !host) return;
const ownerDocument = host.ownerDocument;
const ownerWindow = ownerDocument.defaultView;
const styles = ownerWindow?.getComputedStyle(ownerDocument.documentElement) ?? getComputedStyle(ownerDocument.documentElement);
const fontFamily = styles.getPropertyValue("--terminal-font-family").trim();
const fontSize = Number.parseInt(styles.getPropertyValue("--terminal-font-size"), 10);
terminal.options.theme = getTheme(ownerDocument);
if (fontFamily) terminal.options.fontFamily = fontFamily;
if (Number.isFinite(fontSize)) terminal.options.fontSize = fontSize;
const rows = terminal.element?.querySelector<HTMLElement>(".xterm-rows");
if (rows) {
if (fontFamily) rows.style.setProperty("font-family", fontFamily);
if (Number.isFinite(fontSize)) rows.style.setProperty("font-size", String(fontSize) + "px");
}
fitAddonRef.current?.fit();
if (api.location.type === "popout") {
const computed = rows ? ownerWindow?.getComputedStyle(rows) : null;
setDiagnostic(
`doc=${ownerDocument.URL} | location=${String(api.location.type)} | font=${terminal.options.fontFamily} | size=${terminal.options.fontSize}px | rows=${terminal.rows} cols=${terminal.cols} | cssFont=${computed?.fontFamily ?? "n/a"} | cssSize=${computed?.fontSize ?? "n/a"} | terminalTheme=${ownerDocument.documentElement.dataset.terminalTheme ?? "n/a"} | cssBg=${styles.getPropertyValue("--terminal-background").trim() || "n/a"} | cssFg=${styles.getPropertyValue("--terminal-foreground").trim() || "n/a"} | xtermBg=${terminal.options.theme?.background ?? "n/a"} | xtermFg=${terminal.options.theme?.foreground ?? "n/a"} | blue=${terminal.options.theme?.blue ?? "n/a"} | brightBlue=${terminal.options.theme?.brightBlue ?? "n/a"} | white=${terminal.options.theme?.white ?? "n/a"} | brightWhite=${terminal.options.theme?.brightWhite ?? "n/a"} | owner=${terminal.element ? Array.from(terminal.element.classList).find((name) => name.startsWith("xterm-dom-renderer-owner-")) ?? "n/a" : "n/a"} | ownerStyles=${terminal.element ? Array.from(ownerDocument.querySelectorAll("style")).filter((style) => style.textContent?.includes(Array.from(terminal.element!.classList).find((name) => name.startsWith("xterm-dom-renderer-owner-")) ?? "__missing__")).length : 0} | mainOwnerStyles=${terminal.element ? Array.from(document.querySelectorAll("style")).filter((style) => style.textContent?.includes(Array.from(terminal.element!.classList).find((name) => name.startsWith("xterm-dom-renderer-owner-")) ?? "__missing__")).length : 0} | cellClass=${rows?.querySelector<HTMLElement>("span")?.className || "n/a"} | cellStyle=${rows?.querySelector<HTMLElement>("span")?.getAttribute("style") || "n/a"} | cellColor=${rows?.querySelector<HTMLElement>("span") ? ownerWindow?.getComputedStyle(rows.querySelector<HTMLElement>("span")!).color ?? "n/a" : "n/a"} | glyphs=${rows ? Array.from(rows.querySelectorAll<HTMLElement>("span")).filter((span) => (span.textContent ?? "").trim().length > 0).slice(0, 4).map((span) => `${JSON.stringify((span.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 18))}:${span.className || "-"}:${ownerWindow?.getComputedStyle(span).color ?? "n/a"}`).join(";") || "n/a" : "n/a"} | defaultRule=${terminal.element ? Array.from(ownerDocument.styleSheets).flatMap((sheet) => { try { return Array.from(sheet.cssRules).map((rule) => rule.cssText).filter((rule) => rule.includes(Array.from(terminal.element!.classList).find((name) => name.startsWith("xterm-dom-renderer-owner-")) ?? "__missing__") && (rule.includes("xterm-rows") || rule.includes("color:"))); } catch { return []; } }).find((rule) => /xterm-rows[^,{]*\\{[^}]*color:/i.test(rule))?.replace(/\\s+/g, " ").slice(0, 240) ?? "n/a" : "n/a"} | ownerRules=${terminal.element ? Array.from(ownerDocument.styleSheets).flatMap((sheet) => { try { return Array.from(sheet.cssRules).map((rule) => rule.cssText).filter((rule) => rule.includes(Array.from(terminal.element!.classList).find((name) => name.startsWith("xterm-dom-renderer-owner-")) ?? "__missing__") && (rule.includes("xterm-rows") || rule.includes("color:"))); } catch { return []; } }).slice(0, 6).map((rule) => rule.replace(/\\s+/g, " ").slice(0, 180)).join(" || ") || "n/a" : "n/a"}`,
);
}
if (isTauri()) {
void invoke("terminal_resize", {
sessionId,
rows: terminal.rows,
cols: terminal.cols,
}).catch(() => undefined);
}
};
const ownerDocument = hostRef.current?.ownerDocument ?? document;
const ownerWindow = ownerDocument.defaultView ?? window;
const observer = new MutationObserver(applyAppearance);
observer.observe(ownerDocument.documentElement, {
attributes: true,
attributeFilter: ["data-theme", "data-terminal-theme"],
});
ownerWindow.addEventListener("remotehand-appearance-change", applyAppearance);
const locationDisposable = api.onDidLocationChange(() => {
const terminal = terminalRef.current;
const host = hostRef.current;
if (!terminal || !host) return;
const nextWindow = host.ownerDocument.defaultView;
const refreshAppearance = () => {
terminal.open(host);
const rows = terminal.element?.querySelector<HTMLElement>(".xterm-rows");
if (rows) {
const styles = host.ownerDocument.defaultView?.getComputedStyle(host.ownerDocument.documentElement);
const fontFamily = styles?.getPropertyValue("--terminal-font-family").trim();
const fontSize = styles?.getPropertyValue("--terminal-font-size").trim();
if (fontFamily) rows.style.setProperty("font-family", fontFamily);
if (fontSize) rows.style.setProperty("font-size", fontSize);
}
applyAppearance();
terminal.refresh(0, terminal.rows - 1);
terminal.focus();
};
if (nextWindow) {
nextWindow.requestAnimationFrame(refreshAppearance);
} else {
refreshAppearance();
}
});
return () => {
observer.disconnect();
ownerWindow.removeEventListener("remotehand-appearance-change", applyAppearance);
locationDisposable.dispose();
};
}, [api, sessionId]);
useEffect(() => {
const host = hostRef.current;
if (!host) return;
const onContextMenu = (event: MouseEvent) => {
const pasteAction = rightClickPaste ? !event.shiftKey : event.shiftKey;
if (!pasteAction) return;

event.preventDefault();
if (!isTauri()) return;

const clipboard = host.ownerDocument.defaultView?.navigator.clipboard;
if (!clipboard) return;

void clipboard
.readText()
.then(async (text) => {
if (!text) return;

const multiline = text.includes("\n") || text.includes("\r");
if (multiline && confirmMultiline) {
setPendingPaste(text);
return;
}

await writeTerminal(sessionId, normalizePaste(text));
terminalRef.current?.focus();
})
.catch(() => undefined);
};

const onKeyDown = (event: KeyboardEvent) => {
if (
(event.ctrlKey || event.metaKey) &&
event.key.toLowerCase() === "f"
) {
event.preventDefault();
setSearchOpen(true);
}

if (event.key === "Escape" && searchOpen) {
event.preventDefault();
setSearchOpen(false);
terminalRef.current?.focus();
}
};

host.addEventListener("contextmenu", onContextMenu);
const ownerWindow = host.ownerDocument.defaultView;
ownerWindow?.addEventListener("keydown", onKeyDown);

return () => {
host.removeEventListener("contextmenu", onContextMenu);
ownerWindow?.removeEventListener("keydown", onKeyDown);
};
}, [confirmMultiline, rightClickPaste, searchOpen, sessionId]);
const pasteClipboard = async () => {
if (!isTauri()) return;
const clipboard = hostRef.current?.ownerDocument.defaultView?.navigator.clipboard;
if (!clipboard) return;
const text = await clipboard.readText();
if (!text) return;

const multiline = text.includes("\n") || text.includes("\r");
if (multiline && confirmMultiline) {
setPendingPaste(text);
return;
}

await writeTerminal(sessionId, normalizePaste(text));
terminalRef.current?.focus();
};
const search = () => {
const query = searchQuery.trim();
const terminal = terminalRef.current;
if (!query || !terminal) return;
const haystack = outputRef.current.toLocaleLowerCase();
const index = haystack.lastIndexOf(query.toLocaleLowerCase());

if (index < 0) {
setStatus("No match for " + query);
return;
}

const row = Math.max(
0,
outputRef.current.slice(0, index).split("\n").length - 1,
);
terminal.scrollToLine(row);
setStatus("Found " + query);
};
return (
<section className="local-terminal-panel">
<div className="terminal-toolbar">
<span className="terminal-status">{status}</span>
<span className="terminal-shell">{ssh ? "ssh" : shell}</span>
<label className="terminal-option" title="Toggle right-click paste behavior">
<input
type="checkbox"
checked={rightClickPaste}
onChange={(event) => setRightClickPaste(event.target.checked)}
/>
Right-click paste
</label>

<label className="terminal-option" title="Confirm before pasting multiple lines">
<input
type="checkbox"
checked={confirmMultiline}
onChange={(event) => setConfirmMultiline(event.target.checked)}
/>
Confirm multi-line
</label>

<button
type="button"
onClick={() => void pasteClipboard()}
              className="terminal-primary-action"
title="Paste clipboard"
>
Paste
</button>
</div>

{api.location.type === "popout" ? (
<pre className="terminal-debug-panel">
POPUP DEBUG
{diagnostic || "Collecting popout diagnostics…"}
</pre>
) : null}

{searchOpen ? (
<form
className="terminal-search"
onSubmit={(event) => {
event.preventDefault();
search();
}}
>
<input
autoFocus
aria-label="Search terminal output"
value={searchQuery}
onChange={(event) => setSearchQuery(event.target.value)}
placeholder="Find in terminal..."
/>
<button type="submit">Find</button>
<button
type="button"
onClick={() => {
setSearchOpen(false);
terminalRef.current?.focus();
}}
>
Close
</button>
</form>
) : null}

<div
ref={hostRef}
className="terminal-host"
onMouseDown={() => terminalRef.current?.focus()}
/>
<AppModal
open={pendingPaste !== null}
title="Paste multiple lines?"
confirmLabel="Paste"
cancelLabel="Cancel"
confirmOnEnter
onConfirm={() => {
const text = pendingPaste;
setPendingPaste(null);
if (!text) return;
void writeTerminal(sessionId, normalizePaste(text)).finally(() => terminalRef.current?.focus());
}}
onCancel={() => {
setPendingPaste(null);
terminalRef.current?.focus();
}}
>
<p>This may execute commands immediately. Review the text before pasting:</p>
<pre className="terminal-paste-preview">{pendingPaste}</pre>
</AppModal>
</section>
);
}
