import { describe, expect, it, vi } from "vitest";
import {
  captureGridGroupSizes,
  extractPopoutGeometries,
  extractPopoutGridGroupSizes,
  restoreGridGroupSizes,
} from "./workspaceSizing";

function group(
  id: string,
  type: string,
  width: number,
  height: number,
) {
  return {
    id,
    api: {
      location: { type },
      width,
      height,
      setSize: vi.fn(),
    },
  };
}

describe("workspaceSizing", () => {
  it("captures only visible main-grid group dimensions", () => {
    const mainA = group("main-a", "grid", 420, 700);
    const popout = group("popout", "popout", 600, 500);
    const mainB = group("main-b", "grid", 860, 700);

    expect(captureGridGroupSizes([mainA, popout, mainB])).toEqual([
      { id: "main-a", width: 420, height: 700 },
      { id: "main-b", width: 860, height: 700 },
    ]);
  });

  it("restores only groups that were present in the captured main grid", () => {
    const mainA = group("main-a", "grid", 500, 700);
    const returned = group("returned", "grid", 300, 700);
    const mainB = group("main-b", "grid", 480, 700);

    restoreGridGroupSizes(
      [mainA, returned, mainB],
      [
        { id: "main-a", width: 420, height: 700 },
        { id: "main-b", width: 860, height: 700 },
      ],
    );

    expect(mainA.api.setSize).toHaveBeenCalledWith({ width: 420, height: 700 });
    expect(mainB.api.setSize).toHaveBeenCalledWith({ width: 860, height: 700 });
    expect(returned.api.setSize).not.toHaveBeenCalled();
  });

  it("extracts saved popout desktop geometry in restore order", () => {
    expect(
      extractPopoutGeometries({
        popoutGroups: [
          { position: { left: 120, top: 80, width: 900, height: 600 } },
          { position: null },
          { position: { left: 1400, top: 200, width: 700, height: 500 } },
        ],
      }),
    ).toEqual([
      { left: 120, top: 80, width: 900, height: 600 },
      null,
      { left: 1400, top: 200, width: 700, height: 500 },
    ]);
  });

  it("extracts nested popout group dimensions from a saved workspace", () => {
    const sizes = extractPopoutGridGroupSizes({
      popoutGroups: [
        {
          grid: {
            width: 900,
            height: 600,
            orientation: "HORIZONTAL",
            root: {
              type: "branch",
              data: [
                {
                  type: "leaf",
                  size: 300,
                  data: { id: "left" },
                },
                {
                  type: "branch",
                  size: 600,
                  data: [
                    {
                      type: "leaf",
                      size: 200,
                      data: { id: "top-right" },
                    },
                    {
                      type: "leaf",
                      size: 400,
                      data: { id: "bottom-right" },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });

    expect(sizes).toEqual([
      { id: "left", width: 300, height: 600 },
      { id: "top-right", width: 600, height: 200 },
      { id: "bottom-right", width: 600, height: 400 },
    ]);
  });
});
