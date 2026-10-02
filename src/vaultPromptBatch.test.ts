import { describe, expect, it } from "vitest";
import type { VaultPromptRequest } from "./vaultPrompt";
import { enqueueVaultPrompt, settleVaultPromptBatch } from "./vaultPromptBatch";

function request(requestId: string, source: "frontend" | "plugin"): VaultPromptRequest {
  return {
    requestId,
    reason: requestId,
    create: false,
    source,
    ...(source === "plugin" ? { pluginId: requestId } : {}),
  };
}

describe("Vault prompt batching", () => {
  it("queues concurrent requests once instead of rejecting them", () => {
    const queue: VaultPromptRequest[] = [];
    const second = request("plugin-b", "plugin");

    enqueueVaultPrompt(queue, second);
    enqueueVaultPrompt(queue, second);

    expect(queue.map((pending) => pending.requestId)).toEqual(["plugin-b"]);
  });

  it("settles requests that arrive while the active unlock is completing", async () => {
    const active = request("plugin-a", "plugin");
    const queued = request("plugin-b", "plugin");
    const late = request("frontend-c", "frontend");
    const queue: VaultPromptRequest[] = [queued];
    const settled: string[] = [];

    await settleVaultPromptBatch(active, queue, async (pending) => {
      settled.push(pending.requestId);
      if (pending.requestId === "plugin-a") {
        enqueueVaultPrompt(queue, late);
      }
    });

    expect(settled).toEqual(["plugin-a", "plugin-b", "frontend-c"]);
    expect(queue).toEqual([]);
  });
});
