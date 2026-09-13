import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
type LocalShell = "default" | "powershell" | "cmd" | "wsl";
type TerminalParams = {
shell?: LocalShell;
};
type TerminalOutputEvent = {
sessionId: string;
data: string;
};
type TerminalExitEvent = {
sessionId: string;
};
const DARK_THEME = {
background: "#05070a",
foreground: "#d5dbe5",
cursor: "#d5dbe5",
selectionBackground: "#32445f",
};
const LIGHT_THEME = {
background: "#f4f5f7",
foreground: "#20242c",
cursor: "#20242c",
selectionBackground: "#b8c9df",
};
function getTheme() {
return document.documentElement.dataset.theme === "light"
? LIGHT_THEME
: DARK_THEME;
}
function terminalSize(element: HTMLElement) {
return {
cols: Math.max(2, Math.floor(element.clientWidth / 8.2)),
rows: Math.max(1, Math.floor(element.clientHeight / 17)),
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
const outputRef = useRef("");
const [searchOpen, setSearchOpen] = useState(false);
const [searchQuery, setSearchQuery] = useState("");
const [status, setStatus] = useState("Starting local shell...");
const [rightClickPaste, setRightClickPaste] = useState(true);
const [confirmMultiline, setConfirmMultiline] = useState(true);
const sessionId = api.id;
const shell = params?.shell ?? "default";
useEffect(() => {
const host = hostRef.current;
if (!host) return;
const terminal = new Terminal({
cursorBlink: true,
convertEol: false,
fontFamily:
'"Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
fontSize: 13,
scrollback: 10000,
theme: getTheme(),
});

terminalRef.current = terminal;
terminal.open(host);
terminal.focus();

if (!isTauri()) {
terminal.writeln("RemoteHand Local Terminal");
terminal.writeln("");
terminal.writeln(
"A Tauri desktop runtime is required for local PTY sessions.",
);
terminal.writeln("Run: npm run tauri dev");
setStatus("Desktop runtime required");

return () => {
terminal.dispose();
terminalRef.current = null;
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

unlistenExit = await listen<TerminalExitEvent>(
"terminal-exit",
(event) => {
if (event.payload.sessionId !== sessionId) return;
terminal.writeln("\r\n[RemoteHand] shell exited.");
setStatus("Exited");
},
);

const size = terminalSize(host);
terminal.resize(size.cols, size.rows);

await invoke("terminal_start", {
sessionId,
shell,
rows: size.rows,
cols: size.cols,
});

if (cancelled) {
await invoke("terminal_close", { sessionId }).catch(() => undefined);
return;
}

setStatus(shell === "default" ? "Local shell" : shell);

resizeObserver = new ResizeObserver(() => {
const next = terminalSize(host);
if (next.cols === terminal.cols && next.rows === terminal.rows) return;

terminal.resize(next.cols, next.rows);
void invoke("terminal_resize", {
sessionId,
rows: next.rows,
cols: next.cols,
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
void invoke("terminal_close", { sessionId }).catch(() => undefined);
terminal.dispose();
terminalRef.current = null;
};
}, [sessionId, shell]);
useEffect(() => {
const observer = new MutationObserver(() => {
if (terminalRef.current) {
terminalRef.current.options.theme = getTheme();
}
});
observer.observe(document.documentElement, {
attributes: true,
attributeFilter: ["data-theme"],
});

return () => observer.disconnect();
}, []);
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
if (
multiline &&
confirmMultiline &&
!window.confirm(
"Paste multiple lines into the terminal? This may execute commands immediately.",
)
) {
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
if (
multiline &&
confirmMultiline &&
!window.confirm(
"Paste multiple lines into the terminal? This may execute commands immediately.",
)
) {
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
<span className="terminal-shell">{shell}</span>
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

<button
type="button"
onClick={() => setSearchOpen((open) => !open)}
title="Search terminal output (Ctrl/Cmd+F)"
>
Search
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
</section>
);
}
