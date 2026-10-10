/**
 * The capsule's half of the resident profile: who the researcher is and how they like to work, from their own capsule, as
 * memos the profile block renders beside the research-memory records (`residentProfile.mjs`).
 *
 * Hidden knowledge: this was a block of its own — a file in the project's workspace (`.evimed-capsule/profile.md`) that the
 * socket injected as `<evimed-capsule>` at the start of every run (2026-09-18 review, E §10.7 item 4: the slot was declared,
 * read and injected, and nothing wrote it). Two things were wrong with a block of its own. One file per project is read by
 * every conversation of the project, so a conversation that did not need it again was handed it again, and two conversations
 * dispatched together could take each other's. And it introduced its entries in sentences — 「均经用户确认」 until
 * 2026-10-10, then 「标“未经确认”的是助手…记下的」 — that a model can say back to the researcher. It is one block now, in the
 * conversation's own context, with every entry carrying the same closed attribute a research memory does.
 *
 * What goes in is decided by closed vocabularies, not by reading the text: approved entries, of the kinds that describe the
 * person rather than a project or an episode, from capsules that are the researcher's own. A guest (reference) activation
 * brings someone else's methods and standards and, by design, never their identity (spec §19.15). Methods are not here
 * either: they are mounted as skills (`capsuleMethods.mjs`). Everything else stays one recall away.
 *
 * @module capsuleProfile
 */

import { stripPlatformTags } from "@evimed/domain";

/** The kinds a resident profile carries, in the order it lists them. */
export const CAPSULE_PROFILE_FACT_KINDS = Object.freeze([
  "profile",
  "expertise",
  "preference",
  "stance",
  "writing_style",
]);

/** The whole profile block's budget in tokens (spec §19.7), research memories and capsule entries together. */
export const CAPSULE_PROFILE_MAX_TOKENS = 1_500;

/** One entry's share of the block at most, so one long entry cannot crowd out the rest. */
const ENTRY_MAX_CHARS = 400;

/** @param {string} text */
function oneLine(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= ENTRY_MAX_CHARS ? flat : `${chars.slice(0, ENTRY_MAX_CHARS - 1).join("")}…`;
}

/**
 * The capsule's profile entries as memos, in the order the profile lists them: by kind, and within a kind the newest first
 * (a corrected entry is newer than the one it replaced, and when the budget runs out it is the older that is left out).
 *
 * `origin` is the entry's own and nothing is said about it: an entry the researcher wrote is `explicit`, a note the assistant
 * took in a conversation is `inferred` (effective at once by the 2026-09-19 ruling, no confirmation step; principle 18: an
 * inference never auto-promotes to a fact), and the block renders each as the one closed word.
 *
 * @param {ReadonlyArray<{ id?: string | null, factKind: string, content: string, updatedAt?: string | null, origin?: string | null }>} facts
 * @returns {Array<{ id: string, memoryType: string, kind: string, scope: string, origin?: string, content: string, updatedAt: string | null }>}
 */
export function capsuleFactMemos(facts) {
  const byKind = new Map(CAPSULE_PROFILE_FACT_KINDS.map((kind) => [kind, /** @type {any[]} */ ([])]));
  for (const fact of Array.isArray(facts) ? facts : []) {
    const bucket = byKind.get(fact?.factKind);
    if (bucket && typeof fact.content === "string" && fact.content.trim()) bucket.push(fact);
  }
  const memos = [];
  for (const kind of CAPSULE_PROFILE_FACT_KINDS) {
    const entries = /** @type {any[]} */ (byKind.get(kind)).sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const seen = new Set();
    for (const fact of entries) {
      // Platform tags in an entry are envelopes nobody typed; one the model was talked into writing must not open a block
      // of its own inside this one.
      const content = oneLine(stripPlatformTags(fact.content));
      if (!content || seen.has(content)) continue;
      seen.add(content);
      memos.push({
        id: fact.id ? `fact:${fact.id}` : "fact",
        memoryType: "capsule",
        kind,
        scope: "capsule",
        ...(fact.origin ? { origin: String(fact.origin) } : {}),
        content,
        updatedAt: fact.updatedAt ?? null,
      });
    }
  }
  return memos;
}
