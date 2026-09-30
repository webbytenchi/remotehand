import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

export const VAULT_PROMPT_REQUEST_EVENT = "remotehand-vault-prompt-request";
export const VAULT_PROMPT_RESULT_EVENT = "remotehand-vault-prompt-result";

export type VaultPromptRequest = {
requestId: string;
reason: string;
create: boolean;
};

export type VaultPromptResult = {
requestId: string;
ok: boolean;
error?: string;
};

export async function requestVaultAccess(reason: string): Promise<void> {
if (!isTauri()) throw new Error("RemoteHand Vault is available only in the desktop app.");

const status = await invoke<{ exists: boolean; unlocked: boolean }>("vault_status");
if (status.unlocked) return;

const requestId = crypto.randomUUID();
let dispose: (() => void) | undefined;
const result = new Promise<void>(async (resolve, reject) => {
dispose = await listen<VaultPromptResult>(VAULT_PROMPT_RESULT_EVENT, (event) => {
if (event.payload.requestId !== requestId) return;
dispose?.();
dispose = undefined;
if (event.payload.ok) resolve();
else reject(new Error(event.payload.error || "Vault access was cancelled."));
});
});

try {
await emit(VAULT_PROMPT_REQUEST_EVENT, {
requestId,
reason,
create: !status.exists,
} satisfies VaultPromptRequest);
return await result;
} catch (error) {
dispose?.();
throw error;
}
}
