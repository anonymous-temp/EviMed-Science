/**
 * `recall` as an integrator asks it: memory, the facts of the capsules in
 * force or of the ones named, and the methods (做法) that apply.
 *
 * Hidden knowledge: until this existed a method reached a consumer only as a
 * skill file mounted into our own runtime (`capsuleMethods.mjs`). An agent that
 * is not ours — the TCM CDSS, which has no runtime of ours at all — could
 * recall what a doctor said but never how they work, which is the half of a
 * memory capsule the 甲方 plan is about (「从改方中学习用药习惯」). So recall
 * returns the methods too, chosen by the same two selectors the mount uses —
 * `selectLearnedMethods` for the account's own library and
 * `selectCapsuleMethods` for a capsule's work-style entries — so what an
 * integrator is handed and what one of our runs would mount cannot come from
 * two different rules.
 *
 * Two things differ from the mount, on purpose:
 *
 *  - **The person's own methods come first.** The build spec's order is 「你本次
 *    明说的 > 你自己的 > 对方的 > 平台默认」; the account's learned methods take
 *    the budget first and a capsule's fill what is left. (The runtime mount
 *    still spends it capsules-first; audit M §1.4 has that as a defect of its
 *    own.)
 *  - **`capsuleIds` names the capsules.** 同病异治对照 asks one school at a
 *    time; a recall that could only read the capsules in force could never put
 *    two schools side by side. At most eight, as in force. A subject may name
 *    its institution's capsules as well as its own: the institution's shelf is
 *    what its doctors choose from, and the key that asks already reads the
 *    institution's memory by leaving the header off.
 *
 * Reading a method here counts nothing. A counter write per recall is a
 * revision per recall on the method's document — the churn the memory audit
 * found (77 revisions, 2 bodies) — and a count the CDSS cannot see cannot be
 * the argument for keeping a method anyway.
 *
 * @module agentMemoryRecall
 */

import { createHash } from "node:crypto";

import { cleanMethodDisplay } from "@evimed/domain";

import { MAX_MOUNTED_CAPSULE_METHODS, MAX_MOUNTED_CAPSULE_METHOD_BYTES, selectCapsuleMethods } from "./capsuleMethods.mjs";
import { MAX_MOUNTED_LEARNED_METHODS, selectLearnedMethods } from "./learnedMethodMount.mjs";
import { recallAcrossMemory } from "./memoryRecall.mjs";
import { HttpError } from "./security.mjs";

/** How many capsules one recall may name: the bound on capsules in force. */
export const AGENT_RECALL_MAX_CAPSULES = 8;

/** Which methods a recall returns: both halves, the account's own, the
 *  capsules', or none. */
export const AGENT_RECALL_METHOD_MODES = Object.freeze(["all", "own", "capsules", "none"]);

/** The capsule half's own ceiling (`CapsuleService.recall`). */
const CAPSULE_RECALL_MAX_LIMIT = 30;

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The named capsules, each resolved to the account that holds it, or a refusal
 * naming none of them: a capsule id the caller cannot read and one that does
 * not exist are the same answer.
 * @param {any} capsules @param {{ id: string } | null} user null: a subject with no memory yet
 * @param {{ id: string } | null} institution @param {readonly string[]} ids
 * @returns {Promise<{ id: string, title: string, ownerId: string, owner: "self" | "institution" }[]>}
 */
async function namedCapsules(capsules, user, institution, ids) {
  if (!capsules) throw new HttpError(503, "product_state_unavailable", "Research memory is unavailable.");
  const found = [];
  for (const id of ids) {
    const own = user ? await capsules.get(user.id, id).catch(() => null) : null;
    const shelf = own || !institution || institution.id === user?.id ? null : await capsules.get(institution.id, id).catch(() => null);
    const capsule = own ?? shelf;
    if (!capsule) throw new HttpError(404, "capsule_not_found", "A named capsule is unavailable.");
    found.push({ id, title: String(capsule.payload?.title ?? ""), ownerId: own ? /** @type {any} */ (user).id : /** @type {any} */ (institution).id, owner: own ? "self" : "institution" });
  }
  return /** @type {any} */ (found);
}

/**
 * The account's own learned methods, as an integrator reads one: the line a
 * person reads, when to use it, and the body — the same selection a run of
 * ours would mount, within the same budget.
 * @param {any} learning @param {string} userId @param {string | null} projectId
 * @param {{ maxCount: number, maxBytes: number }} budget
 */
async function ownMethods(learning, userId, projectId, budget) {
  if (!learning) return [];
  /** @type {Map<string, any>} */
  const documents = new Map();
  const reading = {
    getMethod: (/** @type {string} */ owner, /** @type {string} */ id) => learning.getMethod(owner, id),
    approvedMethods: async (/** @type {string} */ owner) => {
      const found = await learning.approvedMethods(owner);
      for (const document of found ?? []) documents.set(String(document.id), document);
      return found;
    },
  };
  const selected = await selectLearnedMethods(reading, { userId, projectId: projectId ?? "", ...budget });
  return selected.map((method) => {
    const payload = documents.get(method.id)?.payload ?? {};
    const display = cleanMethodDisplay(payload.display);
    return {
      source: "learned",
      id: method.id,
      title: display?.title ?? method.name,
      summary: display?.summary ?? String(payload.frontmatter?.description ?? ""),
      whenToUse: String(payload.frontmatter?.whenToUse ?? ""),
      content: String(payload.body ?? ""),
      digest: method.digest,
      bytes: method.bytes,
      // 「新」: effective for fourteen days or less (build spec §8.4).
      since: payload.statusChangedAt ?? null,
      contextOnly: true,
    };
  });
}

/**
 * The work-style methods of the given capsules, or of the ones in force.
 * @param {any} capsules @param {string} userId @param {string | null} projectId
 * @param {{ capsuleId: string, mode: string }[] | null} selection null: the capsules in force
 * @param {Map<string, string>} titles
 */
async function capsuleMethods(capsules, userId, projectId, selection, titles) {
  const reading = selection
    ? { active: async () => ({ items: selection }), entries: (/** @type {any[]} */ ...args) => capsules.entries(...args) }
    : capsules;
  const selected = await selectCapsuleMethods(reading, { userId, projectId: /** @type {any} */ (projectId) });
  return selected.map((method) => ({
    source: "capsule",
    id: method.id,
    capsuleId: method.capsuleId,
    title: titles.get(method.capsuleId) ?? null,
    summary: null,
    whenToUse: null,
    content: method.content,
    digest: `sha256:${sha256(method.content)}`,
    bytes: method.bytes,
    since: null,
    contextOnly: true,
  }));
}

/**
 * One recall for an agent that is not ours.
 *
 * @param {{ capsules: any, memorySubstrate?: any, learning?: any }} services
 * @param {{ user: any, institution?: any }} accounts `user` is null for a subject that has no memory yet;
 *   `institution` is the key's own account, when the request names a subject
 * @param {{ query: string, projectId?: string | null, limit?: number, factKinds?: string[], since?: string | null, scope?: string,
 *   capsuleIds?: readonly string[], methods?: string }} input
 */
export async function recallForAgent({ capsules, memorySubstrate = null, learning = null }, { user, institution = null }, input) {
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(input.limit ?? 10)) || 10));
  const methodMode = input.methods ?? "all";
  if (!AGENT_RECALL_METHOD_MODES.includes(methodMode)) throw new HttpError(400, "agent_memory_payload_invalid", "Invalid methods mode.");
  const ids = input.capsuleIds ?? null;
  const named = ids ? await namedCapsules(capsules, user, institution, ids) : null;
  const titles = new Map((named ?? []).map((capsule) => [capsule.id, capsule.title]));

  /** @type {{ items: any[], mode: string, contextOnly: true, sources: { memory: number, capsule: number } }} */
  let recalled;
  if (!named) {
    recalled = user
      ? /** @type {any} */ (await recallAcrossMemory({ capsules, memorySubstrate }, user, { ...input, limit }))
      : { items: [], mode: "none", contextOnly: true, sources: { memory: 0, capsule: 0 } };
  } else {
    const scope = input.scope ?? "all";
    const memory = scope === "capsule" || !user
      ? { items: [] }
      : await recallAcrossMemory({ capsules: null, memorySubstrate }, user, { ...input, limit, scope: "conversation" });
    /** @type {any[]} */
    const capsuleItems = [];
    let mode = "none";
    if (scope !== "conversation") {
      for (const ownerId of [...new Set(named.map((capsule) => capsule.ownerId))]) {
        const own = ownerId === user?.id;
        const found = await capsules.recall(ownerId, {
          query: input.query,
          // A document's facts belong to its project, and the institution's
          // projects are not the subject's.
          projectId: own ? input.projectId ?? null : null,
          limit: Math.min(CAPSULE_RECALL_MAX_LIMIT, limit),
          factKinds: input.factKinds ?? [],
          since: input.since ?? null,
          scope: "capsule",
          selection: named.filter((capsule) => capsule.ownerId === ownerId).map((capsule) => ({ capsuleId: capsule.id, mode: "named" })),
        });
        mode = typeof found?.mode === "string" ? found.mode : mode;
        capsuleItems.push(...(found?.items ?? []).map((/** @type {any} */ item) => ({ ...item, source: "capsule", contextOnly: true })));
      }
    }
    recalled = {
      items: [...memory.items, ...capsuleItems].slice(0, limit),
      mode,
      contextOnly: true,
      sources: { memory: memory.items.length, capsule: capsuleItems.length },
    };
  }

  /** @type {any[]} */
  let methods = [];
  if (methodMode !== "none") {
    const own = methodMode === "capsules" || !user ? [] : await ownMethods(learning, user.id, input.projectId ?? null, {
      maxCount: MAX_MOUNTED_LEARNED_METHODS, maxBytes: MAX_MOUNTED_CAPSULE_METHOD_BYTES,
    });
    /** @type {any[]} */
    const borrowed = [];
    if (methodMode !== "own") {
      if (named) {
        for (const ownerId of [...new Set(named.map((capsule) => capsule.ownerId))]) {
          borrowed.push(...await capsuleMethods(capsules, ownerId, ownerId === user?.id ? input.projectId ?? null : null,
            named.filter((capsule) => capsule.ownerId === ownerId).map((capsule) => ({ capsuleId: capsule.id, mode: "named" })), titles));
        }
      } else if (capsules && user) {
        borrowed.push(...await capsuleMethods(capsules, user.id, input.projectId ?? null, null, titles));
      }
    }
    // One budget, the person's own first.
    let bytes = 0;
    for (const method of [...own, ...borrowed]) {
      if (methods.length >= MAX_MOUNTED_CAPSULE_METHODS) break;
      if (methods.length > 0 && bytes + method.bytes > MAX_MOUNTED_CAPSULE_METHOD_BYTES) continue;
      bytes += method.bytes;
      methods.push(method);
    }
    methods = methods.map(({ bytes: _bytes, ...method }) => method);
  }

  return {
    ...recalled,
    methods,
    ...(named ? { capsules: named.map(({ ownerId: _ownerId, ...capsule }) => capsule) } : {}),
  };
}
