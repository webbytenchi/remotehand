import { useEffect, type ReactNode } from "react";
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
onConfirm,
onCancel,
}: AppModalProps) {
useEffect(() => {
if (!open) return;
const handleKeyDown = (event: KeyboardEvent) => {
if (event.key === "Escape") onCancel();
};
window.addEventListener("keydown", handleKeyDown);
return () => window.removeEventListener("keydown", handleKeyDown);
}, [open, onCancel]);
if (!open) return null;
return (
<div className="app-modal-backdrop" onMouseDown={onCancel}>
<div
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
