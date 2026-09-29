import { useEffect, useRef, type ReactNode } from "react";
type AppModalProps = {
open: boolean;
title: string;
children: ReactNode;
tabs?: ReactNode;
className?: string;
confirmLabel?: string;
cancelLabel?: string;
danger?: boolean;
focusActions?: boolean;
focusDialog?: boolean;
restoreFocus?: boolean;
confirmOnEnter?: boolean;
elevated?: boolean;
onConfirm: () => void;
onCancel: () => void;
};
export function AppModal({
open,
title,
children,
tabs,
className,
confirmLabel = "OK",
cancelLabel,
danger = false,
focusActions = true,
focusDialog = false,
restoreFocus = false,
confirmOnEnter = false,
elevated = false,
onConfirm,
onCancel,
}: AppModalProps) {
const dialogRef = useRef<HTMLDivElement>(null);
const previousFocusRef = useRef<HTMLElement | null>(null);
useEffect(() => {
if (!open || !restoreFocus) return;
const active = document.activeElement;
previousFocusRef.current = active instanceof HTMLElement ? active : null;
return () => {
const previous = previousFocusRef.current;
previousFocusRef.current = null;
if (!previous || !previous.isConnected) return;
window.requestAnimationFrame(() => {
if (previous instanceof HTMLIFrameElement) {
previous.contentWindow?.focus();
previous.contentWindow?.postMessage({ type: "remotehand.host.restore-focus" }, "*");
return;
}
previous.focus({ preventScroll: true });
});
};
}, [open, restoreFocus]);
useEffect(() => {
if (!open || !focusDialog) return;
const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
return () => window.cancelAnimationFrame(frame);
}, [open, focusDialog]);
useEffect(() => {
if (!open) return;
const handleKeyDown = (event: KeyboardEvent) => {
if (event.key === "Escape") {
event.preventDefault();
onCancel();
return;
}
if (confirmOnEnter && event.key === "Enter" && !event.isComposing) {
event.preventDefault();
onConfirm();
}
};
window.addEventListener("keydown", handleKeyDown);
return () => window.removeEventListener("keydown", handleKeyDown);
}, [open, onCancel, onConfirm, confirmOnEnter]);
if (!open) return null;
return (
<div className={`app-modal-backdrop${elevated ? " app-modal-backdrop-elevated" : ""}`} onMouseDown={onCancel}>
<div
ref={dialogRef}
tabIndex={focusDialog ? -1 : undefined}
className={`app-modal${className ? ` ${className}` : ""}`}
role="dialog"
aria-modal="true"
aria-labelledby="app-modal-title"
onMouseDown={(event) => event.stopPropagation()}
>
<div className="app-modal-header">
<p className="eyebrow">RemoteHand</p>
<h3 id="app-modal-title">{title}</h3>
</div>
{tabs}
<div className="app-modal-body">{children}</div>
<div className="app-modal-actions">
{cancelLabel ? (
<button type="button" className="modal-button" onClick={onCancel} autoFocus={focusActions}>
{cancelLabel}
</button>
) : null}
<button
type="button"
className={danger ? "modal-button danger" : "modal-button primary"}
onClick={onConfirm}
autoFocus={focusActions && !cancelLabel}
>
{confirmLabel}
</button>
</div>
</div>
</div>
);
}
