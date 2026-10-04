import { describe, expect, it } from "vitest";
import {
  remoteHandFunctionKeyDisposition,
  shouldPluginFramePreventFunctionKeyDefault,
} from "./functionKeys";

const noModifiers = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

describe("RemoteHand function-key ownership", () => {
  it("blocks unassigned function keys", () => {
    expect(remoteHandFunctionKeyDisposition("F2", noModifiers)).toBe("blocked");
    expect(remoteHandFunctionKeyDisposition("F11", noModifiers)).toBe("blocked");
    expect(remoteHandFunctionKeyDisposition("F12", noModifiers)).toBe("blocked");
  });

  it("maps only plain F1 to About", () => {
    expect(remoteHandFunctionKeyDisposition("F1", noModifiers)).toBe("about");
    expect(remoteHandFunctionKeyDisposition("F1", { ...noModifiers, shiftKey: true })).toBe("blocked");
  });

  it("allows native Alt-F4 close handling", () => {
    expect(remoteHandFunctionKeyDisposition("F4", { ...noModifiers, altKey: true })).toBe("none");
    expect(remoteHandFunctionKeyDisposition("F4", noModifiers)).toBe("blocked");
  });

  it("allows only plain F5 to reach plugin-specific handlers", () => {
    expect(remoteHandFunctionKeyDisposition("F5", noModifiers)).toBe("plugin");
    expect(remoteHandFunctionKeyDisposition("F5", { ...noModifiers, ctrlKey: true })).toBe("blocked");
    expect(remoteHandFunctionKeyDisposition("F5", { ...noModifiers, shiftKey: true })).toBe("blocked");
  });

  it("does not pre-cancel plain plugin-owned F5 in plugin frames", () => {
    expect(shouldPluginFramePreventFunctionKeyDefault("F5", noModifiers)).toBe(false);
  });

  it("still suppresses host-owned or blocked function keys in plugin frames", () => {
    expect(shouldPluginFramePreventFunctionKeyDefault("F1", noModifiers)).toBe(true);
    expect(shouldPluginFramePreventFunctionKeyDefault("F2", noModifiers)).toBe(true);
    expect(
      shouldPluginFramePreventFunctionKeyDefault("F5", { ...noModifiers, ctrlKey: true }),
    ).toBe(true);
  });

  it("leaves native Alt-F4 alone in plugin frames", () => {
    expect(
      shouldPluginFramePreventFunctionKeyDefault("F4", { ...noModifiers, altKey: true }),
    ).toBe(false);
  });

  it("ignores non-function keys", () => {
    expect(remoteHandFunctionKeyDisposition("Escape", noModifiers)).toBe("none");
    expect(remoteHandFunctionKeyDisposition("k", { ...noModifiers, ctrlKey: true })).toBe("none");
  });
});
