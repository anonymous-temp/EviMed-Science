/**
 * The resident capsule profile: who the researcher is and how they like to
 * work, rendered from their own capsule into the one file every run of the
 * project reads at its start (`workspaceLayout.capsuleProfileFile`,
 * `.evimed-capsule/profile.md`).
 *
 * Hidden knowledge: the slot was declared, read and injected — the socket
 * wraps it as `<evimed-capsule>` with the caveat that it is context, not
 * instruction — and nothing wrote it (2026-09-18 review, E §10.7 item 4). An
 * approved capsule entry therefore reached a run only if the run thought to
 * call the recall tool with words the entry happened to contain, and on a
 * term-matcher deployment the capsule's lexical search matched a whole
 * question against each entry and returned nothing for 16 of 16 questions
 * (`evals/memory-recall/README.md`). The researcher approved the entry; the
 * run never saw it.
 *
 * What goes in is decided by closed vocabularies, not by reading the text:
 * approved entries, of the kinds that describe the person rather than a
 * project or an episode, from capsules that are the researcher's own. A guest
 * (reference) activation brings someone else's methods and standards and, by
 * design, never their identity (spec §19.15). Methods are not here either:
 * they are mounted as skills (`capsuleMethods.mjs`). Everything else stays one
 * recall away.
 *
 * Budgeted at 1,500 tokens (spec §19.7) by the same estimate the model
 * gateway reserves with, which errs high.
 *
 * @module capsuleProfile
 */

import { SOCKET_TOOL_NAMES, stripPlatformTags } from "@evimed/domain";
import { estimatePromptTokens } from "./modelGateway.mjs";

/** The kinds a resident profile carries, in the order it lists them. */
export const CAPSULE_PROFILE_FACT_KINDS = Object.freeze([
  "profile",
  "expertise",
  "preference",
  "stance",
  "writing_style",
]);

/** How each kind is labelled in the block; the page's own words where it has them. */
const KIND_LABELS_ZH = Object.freeze({
  profile: "身份",
  expertise: "背景知识",
  preference: "偏好",
  stance: "立场",
  writing_style: "写作偏好",
});

/** The block's budget (spec §19.7). */
export const CAPSULE_PROFILE_MAX_TOKENS = 1_500;

/** One entry's share of the block at most, so one long entry cannot crowd out the rest. */
const ENTRY_MAX_CHARS = 400;

/**
 * The block's first line. Only an entry the researcher wrote (`origin: "explicit"`) is theirs in so many words;
 * a note the assistant took in a conversation (`inferred`, effective at once by the 2026-09-19 ruling, no
 * confirmation step) is said to be one. Until 2026-10-10 every entry was introduced as 「均经用户确认」, so a
 * sentence a page talked the model into noting reached every later run as the user's confirmed word
 * (principle 18: an inference never auto-promotes to a fact).
 */
const HEADER_CONFIRMED = "以下条目来自用户本人的记忆胶囊，由用户写下：";
const HEADER_MIXED = "以下条目来自用户本人的记忆胶囊；标“未经确认”的是助手在对话中记下的，用户没有确认过：";
const UNCONFIRMED = "（未经确认）";

/** @param {string} text */
function oneLine(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= ENTRY_MAX_CHARS ? flat : `${chars.slice(0, ENTRY_MAX_CHARS - 1).join("")}…`;
}

/**
 * The profile block, or "" when there is nothing to say.
 *
 * @param {ReadonlyArray<{ factKind: string, content: string, updatedAt?: string | null, origin?: string | null }>} facts
 * @param {{ maxTokens?: number }} [options]
 * @returns {string}
 */
export function renderCapsuleProfile(facts, { maxTokens = CAPSULE_PROFILE_MAX_TOKENS } = {}) {
  const byKind = new Map(CAPSULE_PROFILE_FACT_KINDS.map((kind) => [kind, /** @type {any[]} */ ([])]));
  for (const fact of Array.isArray(facts) ? facts : []) {
    const bucket = byKind.get(fact?.factKind);
    if (bucket && typeof fact.content === "string" && fact.content.trim()) bucket.push(fact);
  }
  const lines = [];
  // Room kept for the line that says something was left out, so saying it
  // cannot itself break the budget.
  const budget = maxTokens - estimatePromptTokens(omittedLine(9_999));
  let used = estimatePromptTokens(HEADER_MIXED);
  let unconfirmed = 0;
  let omitted = 0;
  for (const kind of CAPSULE_PROFILE_FACT_KINDS) {
    // The current value first: a corrected entry is newer than the one it
    // replaced, and when the budget runs out it is the older that is left out.
    const entries = /** @type {any[]} */ (byKind.get(kind))
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const seen = new Set();
    for (const fact of entries) {
      // Platform tags in an entry are envelopes nobody typed; one the model was talked into writing must not open
      // a block of its own inside this one.
      const content = oneLine(stripPlatformTags(fact.content));
      if (!content || seen.has(content)) continue;
      seen.add(content);
      const confirmed = fact.origin === "explicit";
      const line = `- ${KIND_LABELS_ZH[/** @type {keyof typeof KIND_LABELS_ZH} */ (kind)]}：${content}${confirmed ? "" : UNCONFIRMED}`;
      const cost = estimatePromptTokens(line) + 1;
      if (used + cost > budget) {
        omitted += 1;
        continue;
      }
      lines.push(line);
      used += cost;
      if (!confirmed) unconfirmed += 1;
    }
  }
  if (!lines.length) return "";
  return [unconfirmed ? HEADER_MIXED : HEADER_CONFIRMED, ...lines, ...(omitted ? [omittedLine(omitted)] : [])].join("\n") + "\n";
}

/** @param {number} count */
function omittedLine(count) {
  return `（另有 ${count} 条未列出；需要时用 ${SOCKET_TOOL_NAMES.capsuleRecall} 检索。）`;
}
