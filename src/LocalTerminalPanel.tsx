import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
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
async function writeTerminal(sessionId: string, data: string) {
await invoke("terminal_write", { sessionId, data });
}

export function LocalTerminalPanel({
api,
params,
}: IDockviewPanelProps<TerminalParams>) {
const hostRef = useRef<HTMLDivElement>(null);
const terminalRef = useRef<Terminal | null>(null);
const [rightClickPaste, setRightClickPaste] = useState(true);
const [confirmMultiline, setConfirmMultiline] = useState(true);
const sessionId = api.id;
const shell = params?.shell ?? "default";
const ssh = params?.ssh;
const initialCommand = params?.initialCommand;
useEffect(() => {
const host = hostRef.current;
if (!host) return;
const fitAddon = new FitAddon();
const terminal = new Terminal({
cursorBlink: true,
convertEol: false,
fontFamily:
'"Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
fontSize: 13,
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
};
}, [initialCommand, sessionId, shell, ssh]);
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


host.addEventListener("contextmenu", onContextMenu);

return () => {
host.removeEventListener("contextmenu", onContextMenu);
};
}, [confirmMultiline, rightClickPaste, sessionId]);
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
return (
<section className="local-terminal-panel">
<div className="terminal-toolbar">
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


<div
ref={hostRef}
className="terminal-host"
onMouseDown={() => terminalRef.current?.focus()}
/>
</section>
);
}
