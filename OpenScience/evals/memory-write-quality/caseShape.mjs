/**
 * The shape of a case in `cases-general/`, one definition for the two arms.
 *
 * The native arm (`run_native_eval.mjs`) replays a case through OpenViking's engine and the legacy arm
 * (`run_write_quality_eval.mjs`) through the platform's own extractor. A case says which of them it is for (`arms`, both when
 * absent) and asks only checks that code can decide over what one replay left: records by kind, a string present or absent,
 * a count of operations, the card's keys. A check that a reading is needed for is a `judge` question printed beside the
 * result, never matched.
 *
 * Added with the 2026-10-23 work-order corpus (research G §6): `requireAnyKind` (the keep-side is satisfied by any of several
 * kinds: a form complaint may land as a preference or as a correction), a `replay.seed` (a conversation held first, so a case
 * can start from a memory the engine itself wrote: the recall echo, the upgrade, the repeated demonstration), `seedKeeps` and
 * `unchangedSinceSeed` (what the seed must have stored, and that the case's own conversation left it byte for byte),
 * `droppedAtTheDoor` (the messages the memory door must not forward: platform text posing as the person's words) and
 * `requireConflictWith` (the legacy extractor's `conflictsWith`, which never fired on production).
 *
 * @module caseShape
 */

/** Every check a case of `cases-general/` may ask. A misspelt one decides nothing, so it is a shape error. */
export const GENERAL_EXPECT_FIELDS = Object.freeze([
  "noTextContains", "noRecordOfKinds", "atMostRecords", "atLeastRecords", "requireKinds", "requireAnyKind", "requireTextContains",
  "briefRefusedWhenTagged", "identifierShapes", "requireKeys", "noKeys", "keyValues",
  "seedKeeps", "unchangedSinceSeed", "droppedAtTheDoor", "requireConflictWith",
]);

/** The two arms a case may be for. */
export const CASE_ARMS = Object.freeze(["native", "legacy"]);

/** @param {any} value */
const nonEmptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry);

/** @param {string} where @param {any} messages */
function messageIssues(where, messages) {
  if (!Array.isArray(messages) || !messages.length) return [`${where} holds no message`];
  const issues = [];
  const ids = new Set();
  for (const message of messages) {
    if (typeof message?.id !== "string" || !message.id || ids.has(message.id)) issues.push(`${where}: a message has no id of its own`);
    ids.add(message?.id);
    if (!["user", "assistant"].includes(message?.role)) issues.push(`${where}: message ${message?.id} is neither a user's nor an assistant's`);
    if (typeof message?.text !== "string" || !message.text.trim()) issues.push(`${where}: message ${message?.id} has no text`);
  }
  return issues;
}

/**
 * What is wrong with one case of the general corpus, or [].
 * @param {any} item a case with its `file`
 */
export function generalCaseIssues(item) {
  const issues = [];
  if (typeof item.id !== "string" || `${item.id}.json` !== item.file) issues.push(`${item.file}: the file is not named after its id`);
  if (typeof item.class !== "string" || !item.class) issues.push(`${item.file}: class is missing`);
  if (typeof item.expected !== "string" || !item.expected.trim()) issues.push(`${item.file}: expected is missing`);
  issues.push(...messageIssues(`${item.file}: replay`, item.replay?.messages));
  if (item.replay?.seed !== undefined) issues.push(...messageIssues(`${item.file}: replay.seed`, item.replay.seed?.messages));
  if (item.arms !== undefined && !(nonEmptyStrings(item.arms) && item.arms.every((/** @type {string} */ arm) => CASE_ARMS.includes(arm)))) {
    issues.push(`${item.file}: arms is not a non-empty list of ${CASE_ARMS.join(" / ")}`);
  }
  if (item.decidable !== false && !item.expect) issues.push(`${item.file}: a decidable case names no expectation`);
  if (item.decidable === false && typeof item.judge !== "string") issues.push(`${item.file}: an undecidable case names no judge question`);
  const expect = item.expect ?? {};
  for (const field of Object.keys(expect)) if (!GENERAL_EXPECT_FIELDS.includes(field)) issues.push(`${item.file}: expect.${field} is not a check the runners decide`);
  if (expect.requireAnyKind !== undefined && !nonEmptyStrings(expect.requireAnyKind)) issues.push(`${item.file}: expect.requireAnyKind is not a list of record kinds`);
  if (expect.seedKeeps !== undefined && !nonEmptyStrings(expect.seedKeeps)) issues.push(`${item.file}: expect.seedKeeps is not a list of strings`);
  if ((expect.seedKeeps !== undefined || expect.unchangedSinceSeed !== undefined) && !item.replay?.seed) issues.push(`${item.file}: a check about the seed needs replay.seed`);
  if (expect.unchangedSinceSeed !== undefined && expect.unchangedSinceSeed !== true) issues.push(`${item.file}: expect.unchangedSinceSeed is true or absent`);
  if (expect.droppedAtTheDoor !== undefined) {
    const ids = new Set((item.replay?.messages ?? []).map((/** @type {any} */ message) => message?.id));
    if (!nonEmptyStrings(expect.droppedAtTheDoor) || !expect.droppedAtTheDoor.every((/** @type {string} */ id) => ids.has(id))) {
      issues.push(`${item.file}: expect.droppedAtTheDoor is not a list of ids of the case's own messages`);
    }
  }
  if (expect.requireConflictWith !== undefined) {
    const held = new Set((item.replay?.existingKeys ?? []).map((/** @type {any} */ record) => record?.key));
    if (!nonEmptyStrings(expect.requireConflictWith) || !expect.requireConflictWith.every((/** @type {string} */ key) => held.has(key))) {
      issues.push(`${item.file}: expect.requireConflictWith names a key the case does not store first (replay.existingKeys)`);
    }
    if (!Array.isArray(item.arms) || item.arms.length !== 1 || item.arms[0] !== "legacy") issues.push(`${item.file}: a conflict is the legacy extractor's: arms is ["legacy"]`);
  }
  return issues;
}

/** Whether a case is for an arm. @param {any} item @param {"native" | "legacy"} arm */
export function runsOnArm(item, arm) {
  return !Array.isArray(item.arms) || item.arms.includes(arm);
}
