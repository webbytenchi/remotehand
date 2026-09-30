export type RemoteHandShortcutModifiers = Pick<
  KeyboardEvent,
  "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
>;

const PRIMARY_BROWSER_KEYS = new Set([
  "f",
  "g",
  "h",
  "j",
  "l",
  "n",
  "o",
  "p",
  "r",
  "s",
  "t",
  "u",
  "w",
  "0",
  "=",
  "+",
  "-",
  "_",
  "delete",
  "pageup",
  "pagedown",
  "tab",
]);

const PRIMARY_SHIFT_BROWSER_KEYS = new Set([
  "c",
  "i",
  "j",
  "r",
  "t",
  "w",
]);

export function shouldSuppressWebViewShortcut(
  key: string,
  modifiers: RemoteHandShortcutModifiers,
): boolean {
  const normalized = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  const primary = modifiers.ctrlKey || modifiers.metaKey;

  if (primary && !modifiers.altKey) {
    if (modifiers.shiftKey && PRIMARY_SHIFT_BROWSER_KEYS.has(normalized)) return true;
    if (PRIMARY_BROWSER_KEYS.has(normalized)) return true;
  }

  if (
    modifiers.altKey
    && !modifiers.ctrlKey
    && !modifiers.metaKey
    && !modifiers.shiftKey
    && (normalized === "arrowleft" || normalized === "arrowright" || normalized === "home")
  ) {
    return true;
  }

  return false;
}
