export const REMOTEHAND_FUNCTION_SHORTCUTS = [
  "Ctrl+F1",
  "Ctrl+F2",
  "Ctrl+F3",
  "Ctrl+F4",
  "Ctrl+F5",
  "Ctrl+F6",
  "Ctrl+F7",
  "Ctrl+F8",
  "Ctrl+F9",
  "Ctrl+F10",
  "Ctrl+F11",
  "Ctrl+F12",
] as const;

export type RemoteHandFunctionShortcut = (typeof REMOTEHAND_FUNCTION_SHORTCUTS)[number];

type ShortcutModifiers = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

export function functionShortcutFromKeyboardEvent(
  key: string,
  modifiers: ShortcutModifiers,
): RemoteHandFunctionShortcut | null {
  if (
    !modifiers.ctrlKey
    || modifiers.altKey
    || modifiers.metaKey
    || modifiers.shiftKey
    || !/^F(?:[1-9]|1[0-2])$/.test(key)
  ) {
    return null;
  }
  return `Ctrl+${key}` as RemoteHandFunctionShortcut;
}

export function assignedShortcutAction(
  shortcuts: Record<string, string>,
  shortcut: string,
): string | null {
  for (const [actionId, assigned] of Object.entries(shortcuts)) {
    if (assigned === shortcut) return actionId;
  }
  return null;
}

export function assignFunctionShortcut(
  shortcuts: Record<string, string>,
  actionId: string,
  shortcut: string,
): Record<string, string> {
  const next = { ...shortcuts };
  for (const [otherActionId, assigned] of Object.entries(next)) {
    if (otherActionId !== actionId && assigned === shortcut && shortcut) {
      next[otherActionId] = "";
    }
  }
  next[actionId] = shortcut;
  return next;
}
