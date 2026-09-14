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
function getTheme() {
const terminalTheme = document.documentElement.dataset.terminalTheme;
const baseTheme = terminalTheme === "classic" ? CLASSIC_THEME : COMFORT_THEME;
const styles = getComputedStyle(document.documentElement);
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
fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-family").trim() || ["JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Consolas", "Liberation Mono", "monospace"].join(", "),
fontSize: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--terminal-font-size"), 10) || 13,
scrollback: 10000,
theme: getTheme(),
});

terminal.loadAddon(fitAddon);
terminalRef.current = terminal;
terminal.open(host);
fitAddon.fit();
terminal.focus();

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
void navigator.clipboard.writeText(selection).catch(() => undefined);
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
if (!terminal) return;
const styles = getComputedStyle(document.documentElement);
const fontFamily = styles.getPropertyValue("--terminal-font-family").trim();
const fontSize = Number.parseInt(styles.getPropertyValue("--terminal-font-size"), 10);
terminal.options.theme = getTheme();
if (fontFamily) terminal.options.fontFamily = fontFamily;
if (Number.isFinite(fontSize)) terminal.options.fontSize = fontSize;
fitAddonRef.current?.fit();
if (isTauri()) {
void invoke("terminal_resize", {
sessionId,
rows: terminal.rows,
cols: terminal.cols,
}).catch(() => undefined);
}
};
const observer = new MutationObserver(applyAppearance);
observer.observe(document.documentElement, {
attributes: true,
attributeFilter: ["data-theme", "data-terminal-theme"],
});
window.addEventListener("remotehand-appearance-change", applyAppearance);
return () => {
observer.disconnect();
window.removeEventListener("remotehand-appearance-change", applyAppearance);
};
}, [sessionId]);
useEffect(() => {
const host = hostRef.current;
if (!host) return;
const onContextMenu = (event: MouseEvent) => {
const pasteAction = rightClickPaste ? !event.shiftKey : event.shiftKey;
if (!pasteAction) return;

event.preventDefault();
if (!isTauri()) return;

void navigator.clipboard
.readText()
.then(async (text) => {
if (!text) return;

const multiline = text.includes("\n") || text.includes("\r");
if (multiline && confirmMultiline) {
setPendingPaste(text);
return;
}

await writeTerminal(sessionId, text);
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
window.addEventListener("keydown", onKeyDown);

return () => {
host.removeEventListener("contextmenu", onContextMenu);
window.removeEventListener("keydown", onKeyDown);
};
}, [confirmMultiline, rightClickPaste, searchOpen, sessionId]);
const pasteClipboard = async () => {
if (!isTauri()) return;
const text = await navigator.clipboard.readText();
if (!text) return;

const multiline = text.includes("\n") || text.includes("\r");
if (multiline && confirmMultiline) {
setPendingPaste(text);
return;
}

await writeTerminal(sessionId, text);
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
title="Paste clipboard"
>
Paste
</button>

</div>

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
onConfirm={() => {
const text = pendingPaste;
setPendingPaste(null);
if (!text) return;
void writeTerminal(sessionId, text).finally(() => terminalRef.current?.focus());
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
