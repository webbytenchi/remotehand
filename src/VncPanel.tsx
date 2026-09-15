import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IDockviewPanelProps } from "dockview-react";
export type VncConnection = {
id: string;
name: string;
host: string;
port: number;
credentialRef?: string;
};
type VncPanelParams = {
sessionId?: string;
connection?: VncConnection;
};
type FrameEvent = {
sessionId: string;
width: number;
height: number;
generation: number;
};
type StatusEvent = {
sessionId: string;
status: string;
message: string;
};
const SPECIAL_KEYS: Record<string, number> = {
Backspace: 0xff08,
Tab: 0xff09,
Enter: 0xff0d,
Escape: 0xff1b,
Home: 0xff50,
ArrowLeft: 0xff51,
ArrowUp: 0xff52,
ArrowRight: 0xff53,
ArrowDown: 0xff54,
PageUp: 0xff55,
PageDown: 0xff56,
End: 0xff57,
Insert: 0xff63,
Delete: 0xffff,
Shift: 0xffe1,
Control: 0xffe3,
Alt: 0xffe9,
Meta: 0xffeb,
F1: 0xffbe,
F2: 0xffbf,
F3: 0xffc0,
F4: 0xffc1,
F5: 0xffc2,
F6: 0xffc3,
F7: 0xffc4,
F8: 0xffc5,
F9: 0xffc6,
F10: 0xffc7,
F11: 0xffc8,
F12: 0xffc9,
};
function keysym(event: ReactKeyboardEvent<HTMLCanvasElement>) {
if (event.key === "Shift" && event.code === "ShiftRight") return 0xffe2;
if (event.key === "Control" && event.code === "ControlRight") return 0xffe4;
if (event.key === "Alt" && event.code === "AltRight") return 0xffea;
if (event.key === "Meta" && event.code === "MetaRight") return 0xffec;
if (SPECIAL_KEYS[event.key] !== undefined) return SPECIAL_KEYS[event.key];
if (event.key.length !== 1) return null;
const point = event.key.codePointAt(0);
if (point === undefined) return null;
return point <= 0xff ? point : 0x01000000 | point;
}
function buttonMask(buttons: number) {
let mask = 0;
if (buttons & 1) mask |= 1;
if (buttons & 4) mask |= 2;
if (buttons & 2) mask |= 4;
return mask;
}
export function VncPanel(props: IDockviewPanelProps<VncPanelParams>) {
const connection = props.params?.connection;
const sessionId = props.params?.sessionId ?? "vnc-session";
const canvasRef = useRef<HTMLCanvasElement | null>(null);
const [status, setStatus] = useState("Connecting…");
const [resolution, setResolution] = useState("");
useEffect(() => {
if (!connection || !isTauri()) {
setStatus(connection ? "VNC requires the RemoteHand desktop app." : "Missing VNC connection details.");
return;
}
let disposed = false;
let unlistenFrame: (() => void) | undefined;
let unlistenStatus: (() => void) | undefined;
const start = async () => {
unlistenFrame = await listen<FrameEvent>("vnc-frame", async ({ payload }) => {
if (disposed || payload.sessionId !== sessionId || payload.width === 0 || payload.height === 0) return;
try {
const data = await invoke<ArrayBuffer | Uint8Array | number[]>("vnc_frame", { sessionId });
if (disposed) return;
const bytes =
data instanceof ArrayBuffer
? new Uint8ClampedArray(data)
: data instanceof Uint8Array
? new Uint8ClampedArray(data)
: new Uint8ClampedArray(data);
const expected = payload.width * payload.height * 4;
if (bytes.length !== expected) return;
const canvas = canvasRef.current;
if (!canvas) return;
canvas.width = payload.width;
canvas.height = payload.height;
const context = canvas.getContext("2d");
if (!context) return;
context.putImageData(new ImageData(bytes, payload.width, payload.height), 0, 0);
setResolution(String(payload.width) + " × " + String(payload.height));
} catch (error) {
if (!disposed) setStatus(String(error));
}
});
unlistenStatus = await listen<StatusEvent>("vnc-status", ({ payload }) => {
if (payload.sessionId !== sessionId) return;
setStatus(payload.status === "connected" ? "Connected" : payload.message);
});
await invoke("vnc_start", {
sessionId,
host: connection.host,
port: connection.port,
credentialRef: connection.credentialRef ?? null,
});
};
void start().catch((error) => setStatus(String(error)));
return () => {
disposed = true;
unlistenFrame?.();
unlistenStatus?.();
void invoke("vnc_close", { sessionId }).catch(() => undefined);
};
}, [connection, sessionId]);
const sendPointer = (event: { clientX: number; clientY: number; buttons: number }, extraMask = 0) => {
const canvas = canvasRef.current;
if (!canvas || !canvas.width || !canvas.height || !isTauri()) return;
const rect = canvas.getBoundingClientRect();
const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width)));
const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height)));
void invoke("vnc_pointer", { sessionId, x, y, buttons: buttonMask(event.buttons) | extraMask }).catch(() => undefined);
};
return (
<section className="vnc-panel">
<div className="vnc-toolbar">
<span>{status}</span>
<span>{resolution}</span>
<button type="button" onClick={() => void invoke("vnc_refresh", { sessionId }).catch(() => undefined)}>
Refresh
</button>
</div>
<div className="vnc-stage">
<canvas
ref={canvasRef}
className="vnc-canvas"
tabIndex={0}
onContextMenu={(event) => event.preventDefault()}
onPointerDown={(event) => {
event.currentTarget.focus();
event.currentTarget.setPointerCapture(event.pointerId);
sendPointer(event);
}}
onPointerMove={(event) => sendPointer(event)}
onPointerUp={(event) => sendPointer(event)}
onWheel={(event) => {
event.preventDefault();
const wheelMask = event.deltaY < 0 ? 8 : 16;
sendPointer(event, wheelMask);
const release = { clientX: event.clientX, clientY: event.clientY, buttons: event.buttons };
window.setTimeout(() => sendPointer(release), 15);
}}
onKeyDown={(event) => {
const code = keysym(event);
if (code === null) return;
event.preventDefault();
void invoke("vnc_key", { sessionId, keycode: code, down: true }).catch(() => undefined);
}}
onKeyUp={(event) => {
const code = keysym(event);
if (code === null) return;
event.preventDefault();
void invoke("vnc_key", { sessionId, keycode: code, down: false }).catch(() => undefined);
}}
/>
</div>
</section>
);
}
