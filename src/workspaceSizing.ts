export type GridGroupSize = {
  id: string;
  width: number;
  height: number;
};

type GridGroupLike = {
  id: string;
  api: {
    location: { type: string };
    width: number;
    height: number;
    setSize: (size: { width?: number; height?: number }) => void;
  };
};

export function captureGridGroupSizes(groups: readonly GridGroupLike[]): GridGroupSize[] {
  return groups
    .filter((group) => group.api.location.type === "grid")
    .map((group) => ({
      id: group.id,
      width: group.api.width,
      height: group.api.height,
    }))
    .filter((size) => size.width > 0 && size.height > 0);
}

export function restoreGridGroupSizes(
  groups: readonly GridGroupLike[],
  sizes: readonly GridGroupSize[],
): void {
  if (sizes.length === 0) return;
  const saved = new Map(sizes.map((size) => [size.id, size]));
  for (const group of groups) {
    if (group.api.location.type !== "grid") continue;
    const size = saved.get(group.id);
    if (!size) continue;
    group.api.setSize({ width: size.width, height: size.height });
  }
}


type SerializedPopoutGridNode = {
  type?: string;
  data?: unknown;
  size?: number;
};

type SerializedPopoutGrid = {
  width?: number;
  height?: number;
  orientation?: string;
  root?: SerializedPopoutGridNode;
};

function collectPopoutLeafSizes(
  node: SerializedPopoutGridNode,
  orientation: string,
  width: number,
  height: number,
  output: GridGroupSize[],
): void {
  if (node.type === "leaf") {
    const data = node.data;
    if (!data || typeof data !== "object") return;
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "string" || width <= 0 || height <= 0) return;
    output.push({ id, width, height });
    return;
  }
  if (node.type !== "branch" || !Array.isArray(node.data)) return;

  const childOrientation = orientation === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
  for (const childValue of node.data) {
    if (!childValue || typeof childValue !== "object") continue;
    const child = childValue as SerializedPopoutGridNode;
    const childSize = typeof child.size === "number" && child.size > 0 ? child.size : undefined;
    collectPopoutLeafSizes(
      child,
      childOrientation,
      childOrientation === "VERTICAL" && childSize ? childSize : width,
      childOrientation === "HORIZONTAL" && childSize ? childSize : height,
      output,
    );
  }
}

export function extractPopoutGridGroupSizes(layout: unknown): GridGroupSize[] {
  if (!layout || typeof layout !== "object") return [];
  const popouts = (layout as { popoutGroups?: unknown }).popoutGroups;
  if (!Array.isArray(popouts)) return [];

  const output: GridGroupSize[] = [];
  for (const popoutValue of popouts) {
    if (!popoutValue || typeof popoutValue !== "object") continue;
    const grid = (popoutValue as { grid?: SerializedPopoutGrid }).grid;
    if (!grid?.root) continue;
    if (
      typeof grid.width !== "number" ||
      typeof grid.height !== "number" ||
      typeof grid.orientation !== "string"
    ) {
      continue;
    }
    collectPopoutLeafSizes(
      grid.root,
      grid.orientation,
      grid.width,
      grid.height,
      output,
    );
  }
  return output;
}
