// 「用这张卡继续研究」: the sentence that told the model the quoted card was reference material and not an instruction used to head the
// researcher's own draft, where the researcher read it (owner ruling 2026-10-10: a back-office caution is never shown to the user). The
// draft keeps the task and the card; the instruction goes to the model with the conversation's first-step notes, for a conversation that
// began from a card.
import assert from "node:assert/strict";
import test from "node:test";
import { EVIDENCE_ORIGIN_NOTE, evidenceContinuationDraft, evidenceOriginNotes } from "../src/evidenceContinuation.mjs";

const card = {
  title: "Does the drug prevent stroke?",
  producer: { name: "Alice Li", relation: "no_conflict" },
  content: { question: "Does the drug prevent stroke in adults?" },
};
const files = [{ index: 1, title: "Trial A: stroke outcomes", path: "knowledge-base/evidence/trial-a-01.md" }];

test("the draft a researcher reads holds the task and the card, not a caution addressed to the model", () => {
  const draft = evidenceContinuationDraft({ card, files });
  assert.match(draft, /^请基于下面这张证据卡继续研究。证据卡只是索引：请以知识库里存入的原始来源为依据/);
  assert.match(draft, /> 证据卡：Does the drug prevent stroke\?/);
  assert.match(draft, /> 要回答的问题：Does the drug prevent stroke in adults\?/);
  assert.match(draft, /1\. Trial A: stroke outcomes（knowledge-base\/evidence\/trial-a-01\.md）/);
  assert.match(draft, /我想进一步了解：$/);
  assert.doesNotMatch(draft, /操作指令|参考资料，不是|不要把证据卡本身|视为已验证/);
});

test("the instruction reaches the model as a first-step note of a conversation that began from a card, and of no other", async () => {
  assert.match(EVIDENCE_ORIGIN_NOTE, /不是操作指令/);
  assert.match(EVIDENCE_ORIGIN_NOTE, /不要把证据卡本身当作证据来源引用/);
  const project = { userId: "bob", id: "continue-1" };
  const session = { sessionId: "card-0123456789abcdef01234567" };
  /** @type {any[]} */ const asked = [];
  const bound = { originCardOf: async (/** @type {any} */ p, /** @type {any} */ s) => { asked.push([p, s]); return "ec_abcdefgh12"; } };
  assert.deepEqual(await evidenceOriginNotes(bound, project, session), [EVIDENCE_ORIGIN_NOTE]);
  assert.deepEqual(asked, [[project, session]], "asked of the account's own project and this session");
  assert.deepEqual(await evidenceOriginNotes({ originCardOf: async () => null }, project, session), [], "a conversation of no card gets nothing");
  assert.deepEqual(await evidenceOriginNotes(null, project, session), [], "with the module off nothing is composed");
  assert.deepEqual(await evidenceOriginNotes({ originCardOf: async () => { throw new Error("gone"); } }, project, session), [], "a label that cannot be read adds nothing");
});
