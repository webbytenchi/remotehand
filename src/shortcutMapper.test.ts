import { describe, expect, it } from "vitest";
import {
  assignFunctionShortcut,
  assignedShortcutAction,
  functionShortcutFromKeyboardEvent,
  REMOTEHAND_FUNCTION_SHORTCUTS,
} from "./shortcutMapper";

const none = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

describe("RemoteHand function shortcut mapper", () => {
  it("recognizes only Ctrl+F1 through Ctrl+F12", () => {
    expect(functionShortcutFromKeyboardEvent("F2", { ...none, ctrlKey: true })).toBe("Ctrl+F2");
    expect(functionShortcutFromKeyboardEvent("F12", { ...none, ctrlKey: true })).toBe("Ctrl+F12");
    expect(functionShortcutFromKeyboardEvent("F12", none)).toBeNull();
    expect(functionShortcutFromKeyboardEvent("F12", { ...none, ctrlKey: true, shiftKey: true })).toBeNull();
    expect(functionShortcutFromKeyboardEvent("k", { ...none, ctrlKey: true })).toBeNull();
  });

  it("exposes the full Ctrl+F1 through Ctrl+F12 bank", () => {
    expect(REMOTEHAND_FUNCTION_SHORTCUTS).toHaveLength(12);
    expect(REMOTEHAND_FUNCTION_SHORTCUTS[0]).toBe("Ctrl+F1");
    expect(REMOTEHAND_FUNCTION_SHORTCUTS[11]).toBe("Ctrl+F12");
  });

  it("finds the action assigned to a shortcut", () => {
    expect(
      assignedShortcutAction(
        { "core.commandPalette": "Ctrl+F12", "plugin:a:main": "Ctrl+F2" },
        "Ctrl+F2",
      ),
    ).toBe("plugin:a:main");
    expect(assignedShortcutAction({ "core.commandPalette": "Ctrl+F12" }, "Ctrl+F3")).toBeNull();
  });

  it("moves a shortcut instead of allowing duplicate assignments", () => {
    expect(
      assignFunctionShortcut(
        { "core.commandPalette": "Ctrl+F12", "plugin:a:main": "Ctrl+F2" },
        "plugin:b:main",
        "Ctrl+F2",
      ),
    ).toEqual({
      "core.commandPalette": "Ctrl+F12",
      "plugin:a:main": "",
      "plugin:b:main": "Ctrl+F2",
    });
  });
});
