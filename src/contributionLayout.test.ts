import { describe, expect, it } from "vitest";
import {
  contributionOrderIndex,
  mergeRememberedOrder,
  moveContribution,
  moveVisibleContribution,
  resolveContributionOrder,
} from "./contributionLayout";

describe("contribution layout ordering", () => {
  it("uses remembered order and appends new contributions deterministically", () => {
    expect(
      resolveContributionOrder(
        ["plugin:b", "core:home", "missing:item"],
        ["core:home", "plugin:a", "plugin:b"],
        ["core:home", "plugin:a", "plugin:b"],
      ),
    ).toEqual(["plugin:b", "core:home", "plugin:a"]);
  });

  it("keeps temporarily missing remembered ids while learning new ones", () => {
    expect(
      mergeRememberedOrder(
        ["plugin:old", "core:home"],
        ["core:home", "plugin:new"],
        ["core:home", "plugin:new"],
      ),
    ).toEqual(["plugin:old", "core:home", "plugin:new"]);
  });

  it("moves one contribution without disturbing the rest", () => {
    expect(moveContribution(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveContribution(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("moves across visible neighbors while retaining hidden remembered slots", () => {
    expect(
      moveVisibleContribution(
        ["a", "hidden", "b", "c"],
        ["a", "b", "c"],
        "b",
        -1,
      ),
    ).toEqual(["b", "hidden", "a", "c"]);
  });

  it("provides a harmless fallback index for unknown ids", () => {
    expect(contributionOrderIndex(["a", "b"], "b")).toBe(1);
    expect(contributionOrderIndex(["a", "b"], "x")).toBe(10_000);
  });
});
