export type RemoteHandShortcutModifiers = Pick<
  KeyboardEvent,
  "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
>;

export const REMOTEHAND_BROWSER_PRIMARY_KEYS = [
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
] as const;

export const REMOTEHAND_BROWSER_PRIMARY_SHIFT_KEYS = [
  "c",
  "i",
  "j",
  "r",
  "t",
  "w",
] as const;

const PRIMARY_BROWSER_KEYS = new Set<string>(REMOTEHAND_BROWSER_PRIMARY_KEYS);
const PRIMARY_SHIFT_BROWSER_KEYS = new Set<string>(REMOTEHAND_BROWSER_PRIMARY_SHIFT_KEYS);

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
