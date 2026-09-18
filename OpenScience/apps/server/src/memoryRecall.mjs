/**
 * One recall over both memory stores.
 *
 * Hidden knowledge: the platform keeps two kinds of long-term memory and, until
 * 2026-09-16, exposed only one of them to anything that could ask. The
 * structured records — profile, preferences, behaviours, corrections, notes —
 * live in `evimed_memory` behind `memorySubstrate`, and reached the model only
 * as the block the control plane renders into the root prompt at dispatch. The
 * capsule facts live in `evimed_product` behind `capsuleService`, and were what
 * `evimed_capsule_recall` and `/api/agent-memory/v1/recall` searched. A
 * delegated child, or an external agent, asking "what does this researcher
 * prefer?" therefore got the capsule's answer and never the record the
 * extractor had written the day before. Both callers' schemas already promised
 * `scope: all`; this is what makes the promise true.
 *
 * Scopes: `capsule` searches the facts of the active capsules; `conversation`
 * searches the research-memory records and notes; `all` searches both. Memory
 * items come first — they are the account's own long-term picture and are
 * already budgeted by `memoryRecallPolicy` — then capsule facts, and `limit`
 * bounds the union. `agenda` is a name both schemas reserve and nothing serves;
 * it is refused by code here exactly as the capsule service refused it before.
 *
 * Every item carries `source`, so a caller can tell a fact the user imported in
 * a capsule from a record the platform inferred, and `contextOnly`, because
 * neither is permission.
 *
 * @module
 */

import { HttpError } from "./security.mjs";

export const MEMORY_RECALL_SCOPES = Object.freeze(["all", "capsule", "conversation"]);

/** The most items one recall returns, whatever the caller asked for. */
export const MEMORY_RECALL_MAX_LIMIT = 50;

/**
 * @param {{ capsules?: { recall: Function } | null, memorySubstrate?: { recall: Function, recallEnabled?: boolean } | null }} services
 * @param {{ id: string, accountCreatedAt?: string }} user
 * @param {{ query: string, projectId?: string | null, sessionId?: string | null, limit?: number, factKinds?: readonly string[], since?: string | null, scope?: string }} input
 * @returns {Promise<{ items: Record<string, any>[], mode: string, contextOnly: true, sources: { memory: number, capsule: number } }>}
 */
export async function recallAcrossMemory({ capsules = null, memorySubstrate = null }, user, input) {
  const scope = input.scope ?? "all";
  if (!MEMORY_RECALL_SCOPES.includes(scope)) throw new HttpError(400, "capsule_scope_unavailable", "This memory scope is unavailable.");
  // The deployment's recall switch covers both stores. An answer, not an
  // error: the caller asked a well-formed question of a deployment that has
  // recall turned off, and `mode: "disabled"` says so — the same shape a
  // researcher's own recall pause produces, so a run moves on rather than
  // retrying a tool that is working as configured, and nothing in the answer
  // can be read as "this researcher has no memories".
  if (memorySubstrate && memorySubstrate.recallEnabled === false) {
    return { items: [], mode: "disabled", contextOnly: true, sources: { memory: 0, capsule: 0 } };
  }
  const limit = Math.max(1, Math.min(MEMORY_RECALL_MAX_LIMIT, Number(input.limit ?? 10) || 10));
  const factKinds = Array.isArray(input.factKinds) ? input.factKinds : [];
  const since = input.since ?? null;
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const projectId = input.projectId ?? null;

  const [capsule, memory] = await Promise.all([
    scope !== "conversation" && capsules
      ? capsules.recall(user.id, { query: input.query, projectId, limit, factKinds, since, scope: "capsule", accountCreatedAt: user.accountCreatedAt })
      : { items: [], mode: "none" },
    scope !== "capsule" && memorySubstrate
      ? memorySubstrate.recall(user.id, input.query, { projectId, sessionId: input.sessionId ?? null })
      : [],
  ]);

  const memoryItems = (Array.isArray(memory) ? memory : [])
    .filter((memo) => !Number.isFinite(sinceMs) || !memo.updatedAt || Date.parse(memo.updatedAt) >= sinceMs)
    // The capsule vocabulary and the record vocabulary share only
    // `preference`; a caller narrowing by kind gets the records of that kind
    // too, and nothing else of theirs.
    .filter((memo) => !factKinds.length || factKinds.includes(memo.kind))
    .map((memo) => ({
      id: memo.id,
      source: "memory",
      kind: memo.kind ?? "note",
      scope: memo.scope ?? "user",
      memoryType: memo.memoryType ?? "manual",
      content: memo.content,
      updatedAt: memo.updatedAt ?? null,
      confidence: memo.confidence ?? null,
      importance: memo.importance ?? null,
      contextOnly: true,
    }));
  const capsuleItems = (Array.isArray(capsule?.items) ? capsule.items : []).map((item) => ({ ...item, source: "capsule", contextOnly: true }));
  return {
    items: [...memoryItems, ...capsuleItems].slice(0, limit),
    mode: typeof capsule?.mode === "string" ? capsule.mode : "none",
    contextOnly: true,
    sources: { memory: memoryItems.length, capsule: capsuleItems.length },
  };
}
