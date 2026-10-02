import type { VaultPromptRequest } from "./vaultPrompt";

export function enqueueVaultPrompt(
  queue: VaultPromptRequest[],
  request: VaultPromptRequest,
): void {
  if (queue.some((pending) => pending.requestId === request.requestId)) return;
  queue.push(request);
}

export async function settleVaultPromptBatch(
  active: VaultPromptRequest,
  queue: VaultPromptRequest[],
  settle: (request: VaultPromptRequest) => Promise<void>,
): Promise<void> {
  let batch = [active];
  while (batch.length > 0) {
    await Promise.allSettled(batch.map((request) => settle(request)));
    batch = queue.splice(0);
  }
}
