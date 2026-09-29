import { describe, expect, it } from "vitest";
import { remoteHandFunctionKeyDisposition } from "./functionKeys";

const noModifiers = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

describe("RemoteHand function-key ownership", () => {
  it("blocks unassigned function keys", () => {
    expect(remoteHandFunctionKeyDisposition("F1", noModifiers)).toBe("blocked");
    expect(remoteHandFunctionKeyDisposition("F11", noModifiers)).toBe("blocked");
  });

  it("reserves F12 for RemoteHand settings", () => {
    expect(remoteHandFunctionKeyDisposition("F12", noModifiers)).toBe("settings");
    expect(remoteHandFunctionKeyDisposition("F12", { ...noModifiers, ctrlKey: true })).toBe("settings");
  });

  it("allows only plain F5 to reach plugin-specific handlers", () => {
    expect(remoteHandFunctionKeyDisposition("F5", noModifiers)).toBe("plugin");
    expect(remoteHandFunctionKeyDisposition("F5", { ...noModifiers, ctrlKey: true })).toBe("blocked");
    expect(remoteHandFunctionKeyDisposition("F5", { ...noModifiers, shiftKey: true })).toBe("blocked");
  });

  it("ignores non-function keys", () => {
    expect(remoteHandFunctionKeyDisposition("Escape", noModifiers)).toBe("none");
    expect(remoteHandFunctionKeyDisposition("k", { ...noModifiers, ctrlKey: true })).toBe("none");
  });
});
