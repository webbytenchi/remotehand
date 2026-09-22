export type UiContributionLayout = {
  sidebarOrder: string[];
  topbarOrder: string[];
};

export const EMPTY_UI_CONTRIBUTION_LAYOUT: UiContributionLayout = {
  sidebarOrder: [],
  topbarOrder: [],
};

export function resolveContributionOrder(
  savedOrder: readonly string[] | undefined,
  availableIds: readonly string[],
  fallbackIds: readonly string[] = availableIds,
): string[] {
  const available = new Set(availableIds);
  const result: string[] = [];
  const seen = new Set<string>();

  const add = (id: string) => {
    if (!available.has(id) || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  for (const id of savedOrder ?? []) add(id);
  for (const id of fallbackIds) add(id);
  for (const id of availableIds) add(id);
  return result;
}

export function mergeRememberedOrder(
  rememberedOrder: readonly string[] | undefined,
  availableIds: readonly string[],
  fallbackIds: readonly string[] = availableIds,
): string[] {
  const remembered = Array.from(new Set((rememberedOrder ?? []).filter(Boolean)));
  const merged = [...remembered];
  const seen = new Set(remembered);
  for (const id of fallbackIds) {
    if (!seen.has(id) && availableIds.includes(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  for (const id of availableIds) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

export function moveContribution(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const index = order.indexOf(id);
  if (index < 0) return [...order];
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= order.length) return [...order];
  const next = [...order];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

export function contributionOrderIndex(order: readonly string[], id: string, fallback = 10_000): number {
  const index = order.indexOf(id);
  return index >= 0 ? index : fallback;
}

export function moveVisibleContribution(
  rememberedOrder: readonly string[],
  visibleOrder: readonly string[],
  id: string,
  delta: -1 | 1,
): string[] {
  const visibleIndex = visibleOrder.indexOf(id);
  if (visibleIndex < 0) return [...rememberedOrder];
  const targetVisibleIndex = visibleIndex + delta;
  if (targetVisibleIndex < 0 || targetVisibleIndex >= visibleOrder.length) return [...rememberedOrder];
  const targetId = visibleOrder[targetVisibleIndex];
  const next = [...rememberedOrder];
  const from = next.indexOf(id);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
