/**
 * One recall over an account's memory and its capsules.
 *
 * Hidden knowledge: the platform keeps two kinds of long-term memory. The account's own memory is OpenViking's (the native engine's
 * files, read through `nativeRecallSource` in `agentMemoryRecall.mjs`: what the memory page's search finds). The capsule facts
 * live in `evimed_product` behind `capsuleService`: what a person put into a capsule, what a received pack brings, what a
 * document's understanding published. Both callers' schemas promise `scope: all`; this is what makes the promise true. The legacy
 * engine that kept a third store of structured records in PostgreSQL, and recalled it with validity intervals and an `asOf`, was
 * deleted on 2026-10-25.
 *
 * Scopes: `capsule` searches the facts of the active capsules; `conversation` searches the account's memories; `all` searches both.
 * Memories come first — they are the account's own long-term picture — then capsule facts, and `limit` bounds the union. `agenda`
 * is a name both schemas reserve and nothing serves; it is refused by code here exactly as the capsule service refused it before.
 *
 * Every item carries `source`, so a caller can tell a fact the user imported in a capsule from a memory of the account's own,
 * and `contextOnly`, because neither is permission.
 *
 * @module
 */

import { HttpError } from "./security.mjs";

export const MEMORY_RECALL_SCOPES = Object.freeze(["all", "capsule", "conversation"]);

/** The most items one recall returns, whatever the caller asked for. */
export const MEMORY_RECALL_MAX_LIMIT = 50;

/** The most the capsule half is asked for: `CapsuleService.recall` refuses more
 *  than thirty, and a limit of forty on the union used to be a 400 from the
 *  half that was asked for too many rather than an answer. */
const CAPSULE_RECALL_MAX_LIMIT = 30;

/**
 * @param {{ capsules?: { recall: Function } | null, memory?: { recall: Function, recallEnabled?: boolean } | null }} services
 *   `memory` is the account's own memory as a recall source (`nativeRecallSource`); absent, the answer is the capsules' alone.
 * @param {{ id: string, accountCreatedAt?: string }} user
 * @param {{ query: string, projectId?: string | null, sessionId?: string | null, limit?: number, factKinds?: readonly string[], since?: string | null, scope?: string,
 *   standing?: boolean }} input
 *   `standing: false`: the recall tool's reading — what the question reaches and nothing else, so that a lookup that finds
 *   nothing can say so (review M6). The agent API reads as it always did.
 * @returns {Promise<{ items: Record<string, any>[], mode: string, contextOnly: true, sources: { memory: number, capsule: number } }>}
 */
export async function recallAcrossMemory({ capsules = null, memory = null }, user, input) {
  const scope = input.scope ?? "all";
  if (!MEMORY_RECALL_SCOPES.includes(scope)) throw new HttpError(400, "capsule_scope_unavailable", "This memory scope is unavailable.");
  // The deployment's recall switch covers both stores. An answer, not an
  // error: the caller asked a well-formed question of a deployment that has
  // recall turned off, and `mode: "disabled"` says so — the same shape a
  // researcher's own recall pause produces at the capsule gateway (`mode:
  // "paused"`, `capsuleGateway.mjs`: the pause is asked there, once, for both
  // halves), so a run moves on rather than retrying a tool that is working as
  // configured, and nothing in the answer can be read as "this researcher
  // has no memories".
  if (memory && memory.recallEnabled === false) {
    return { items: [], mode: "disabled", contextOnly: true, sources: { memory: 0, capsule: 0 } };
  }
  const limit = Math.max(1, Math.min(MEMORY_RECALL_MAX_LIMIT, Math.trunc(Number(input.limit ?? 10)) || 10));
  const factKinds = Array.isArray(input.factKinds) ? input.factKinds : [];
  const since = input.since ?? null;
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const projectId = input.projectId ?? null;

  const [capsule, found] = await Promise.all([
    scope !== "conversation" && capsules
      ? capsules.recall(user.id, { query: input.query, projectId, limit: Math.min(CAPSULE_RECALL_MAX_LIMIT, limit), factKinds, since, scope: "capsule", accountCreatedAt: user.accountCreatedAt })
      : { items: [], mode: "none" },
    scope !== "capsule" && memory
      ? memory.recall(user.id, input.query, { projectId, sessionId: input.sessionId ?? null })
      : [],
  ]);

  const memoryItems = (Array.isArray(found) ? found : [])
    .filter((memo) => !Number.isFinite(sinceMs) || !memo.updatedAt || Date.parse(memo.updatedAt) >= sinceMs)
    // The capsule vocabulary and the memory page's share only `preference`; a caller narrowing by kind gets the memories of
    // that kind too, and nothing else of theirs.
    .filter((memo) => !factKinds.length || factKinds.includes(memo.kind))
    .map((memo) => ({
      id: memo.id,
      source: "memory",
      kind: memo.kind ?? "note",
      scope: memo.scope ?? "user",
      memoryType: memo.memoryType ?? "native",
      content: memo.content,
      updatedAt: memo.updatedAt ?? null,
      confidence: memo.confidence ?? null,
      importance: memo.importance ?? null,
      // Whose statement a memory is — the person's (`explicit`, `manual`) or an inference (`inferred`) — when the store said.
      ...(memo.origin ? { origin: memo.origin } : {}),
      contextOnly: true,
    }));
  const capsuleItems = (Array.isArray(capsule?.items) ? capsule.items : [])
    .map((item) => ({ ...item, source: "capsule", contextOnly: true }));
  return {
    items: [...memoryItems, ...capsuleItems].slice(0, limit),
    mode: typeof capsule?.mode === "string" ? capsule.mode : "none",
    contextOnly: true,
    sources: { memory: memoryItems.length, capsule: capsuleItems.length },
  };
}
