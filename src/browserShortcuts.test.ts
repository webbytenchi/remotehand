import { describe, expect, it } from "vitest";
import { shouldSuppressWebViewShortcut } from "./browserShortcuts";

const none = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

describe("RemoteHand WebView shortcut ownership", () => {
  it("suppresses browser find and reload shortcuts", () => {
    expect(shouldSuppressWebViewShortcut("f", { ...none, ctrlKey: true })).toBe(true);
    expect(shouldSuppressWebViewShortcut("r", { ...none, ctrlKey: true })).toBe(true);
    expect(shouldSuppressWebViewShortcut("R", { ...none, ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it("suppresses browser file, print, source, and location shortcuts", () => {
    for (const key of ["s", "o", "p", "u", "l"]) {
      expect(shouldSuppressWebViewShortcut(key, { ...none, ctrlKey: true })).toBe(true);
    }
  });

  it("suppresses browser zoom and navigation shortcuts", () => {
    for (const key of ["+", "=", "-", "0"]) {
      expect(shouldSuppressWebViewShortcut(key, { ...none, ctrlKey: true })).toBe(true);
    }
    expect(shouldSuppressWebViewShortcut("ArrowLeft", { ...none, altKey: true })).toBe(true);
    expect(shouldSuppressWebViewShortcut("ArrowRight", { ...none, altKey: true })).toBe(true);
    expect(shouldSuppressWebViewShortcut("Home", { ...none, altKey: true })).toBe(true);
  });

  it("suppresses developer-tool browser accelerators", () => {
    for (const key of ["c", "i", "j"]) {
      expect(
        shouldSuppressWebViewShortcut(key, { ...none, ctrlKey: true, shiftKey: true }),
      ).toBe(true);
    }
  });

  it("does not claim normal editing shortcuts", () => {
    for (const key of ["a", "c", "v", "x", "z", "y"]) {
      expect(shouldSuppressWebViewShortcut(key, { ...none, ctrlKey: true })).toBe(false);
    }
    expect(shouldSuppressWebViewShortcut("Enter", none)).toBe(false);
    expect(shouldSuppressWebViewShortcut("Escape", none)).toBe(false);
  });
});
