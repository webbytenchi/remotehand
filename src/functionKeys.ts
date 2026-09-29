export const REMOTEHAND_FUNCTION_KEYS = [
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;

export type RemoteHandFunctionKeyDisposition = "none" | "blocked" | "plugin" | "about";

const FUNCTION_KEY_SET = new Set<string>(REMOTEHAND_FUNCTION_KEYS);

type FunctionKeyModifiers = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">;

export function remoteHandFunctionKeyDisposition(
  key: string,
  modifiers: FunctionKeyModifiers,
): RemoteHandFunctionKeyDisposition {
  if (!FUNCTION_KEY_SET.has(key)) return "none";
  const plain =
    !modifiers.ctrlKey
    && !modifiers.altKey
    && !modifiers.metaKey
    && !modifiers.shiftKey;
  if (key === "F1" && plain) return "about";
  if (key === "F5" && plain) return "plugin";
  if (
    key === "F4"
    && modifiers.altKey
    && !modifiers.ctrlKey
    && !modifiers.metaKey
    && !modifiers.shiftKey
  ) {
    return "none";
  }
  return "blocked";
}
