import { describe, expect, it } from "vitest";
import { derivePortablePaths } from "./portable";

describe("derivePortablePaths", () => {
  it("keeps Linux data inside the application directory", () => {
    expect(derivePortablePaths("/opt/RemoteHand")).toEqual({
      root: "/opt/RemoteHand",
      config: "/opt/RemoteHand/config",
      data: "/opt/RemoteHand/data",
      layouts: "/opt/RemoteHand/layouts",
      themes: "/opt/RemoteHand/themes",
      logs: "/opt/RemoteHand/logs",
    });
  });

  it("keeps Windows data inside the application directory", () => {
    const b = String.fromCharCode(92);
    const root = ["C:", "Tools", "RemoteHand"].join(b);
    expect(derivePortablePaths(root)).toEqual({
      root,
      config: [root, "config"].join(b),
      data: [root, "data"].join(b),
      layouts: [root, "layouts"].join(b),
      themes: [root, "themes"].join(b),
      logs: [root, "logs"].join(b),
    });
  });
});
