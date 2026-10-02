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
