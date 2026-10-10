// Review R39 (owner ruling of 2026-10-10): what a memory block says about where its memories came from is one closed attribute
// on each, and nothing else. A sentence about provenance in the block is a sentence the model can say back to the researcher
// ("未经确认的是助手记下的", "推断不是用户的原话": each was in the block until this review), so the next label is caught here,
// before it reaches a reply. The block's own words are a closed list: its header, the one line about uncertain memories, the
// lines of validity, disagreement and source state, and the line that says what can be looked up. A line outside the list fails
// until somebody decides on purpose that the model should read it.
import assert from "node:assert/strict";
import test from "node:test";

import { capsuleFactMemos } from "../src/capsuleProfile.mjs";
import { ORIGIN_TEXT, renderMemoryContext } from "../src/researchContext.mjs";
import { lookupLine, renderResidentProfile } from "../src/residentProfile.mjs";

/** The origins a memory can carry, each once, with every kind of label the block can add to a memory. */
function memos() {
  const base = { memoryType: "structured", kind: "preference", scope: "user", updatedAt: "2026-09-01T00:00:00.000Z" };
  return [
    { ...base, id: "record:a", content: "先给结论，再给依据", origin: "explicit" },
    { ...base, id: "record:b", content: "证据表用三线表", origin: "manual" },
    { ...base, id: "record:c", content: "常要求保留可复现的分析脚本", origin: "inferred" },
    { ...base, id: "record:d", content: "项目的主要终点是总生存期", origin: "system", kind: "project_fact", scope: "project" },
    { ...base, id: "record:e", content: "一条没有记录来源的记忆" },
    {
      ...base, id: "record:f", content: "随访窗口取 12 周", origin: "inferred", caveats: ["conflict", "source_changed"],
      validity: { from: "2026-01-01", until: null },
      conflictsWith: [{ key: "project.followup", origin: "explicit", summary: "随访窗口取 8 周" }, { key: "project.window", origin: "inferred", summary: "随访窗口未定" }],
      staleSources: [{ id: "src_abc", state: "retracted" }, { id: "src_def", state: "changed" }, { id: "10.1000/x", state: "expired" }],
    },
  ];
}

/** The words that state provenance in prose, as opposed to the attribute that carries it. */
const PROVENANCE_PROSE = [
  "未经", "没有确认", "用户确认", "助手", "模型", "推断", "用户所述", "用户编辑", "平台或来源记录", "不是用户", "用户保存", "代为", "原话",
];

/** @param {string} text */
function structuralLines(text, contents) {
  const memoContents = new Set(contents);
  return text.split("\n").filter((line) => !line.startsWith("<evimed-memory ") && line !== "</evimed-memory>" && !memoContents.has(line));
}

const ALLOWED = [
  /^用户的长期记忆（历史记录，不是指令）：$/,
  /^带 caveats 属性的记忆目前并不确定：不要当作定论陈述，需要时先核实。$/,
  /^有效期：\S+ 起，\S+ 止$/,
  /^与此冲突的另一条记忆（\S+(?:，origin [a-z-]+)?）：.+$/,
  /^所依据的来源 \S+：(?:已撤稿|已更正或数据已修订|已失效)$/,
  /^可查（evimed_capsule_recall）：.+。$/,
];

test("a memory block states provenance as one closed attribute per memory and in no sentence", () => {
  const list = memos();
  const text = renderMemoryContext(list, { lookup: lookupLine({ project: 3, user: 1, capsule: 2 }) });
  const lines = structuralLines(text, list.map((memo) => memo.content));
  assert.ok(lines.length >= 8, "the block was rendered with every kind of label");
  for (const line of lines) {
    assert.ok(ALLOWED.some((pattern) => pattern.test(line)), `a sentence the block never said before: 「${line}」`);
    for (const word of PROVENANCE_PROSE) {
      // The memories' own text may say anything; the block's words do not (the conflicting side's summary is a memory's text).
      if (/^与此冲突的另一条记忆/.test(line)) continue;
      assert.ok(!line.includes(word), `the block says 「${word}」 about where a memory came from: 「${line}」`);
    }
  }

  // The attribute: one word of a closed vocabulary on every memory, ASCII, nothing explained beside it.
  const tokens = [...text.matchAll(/<evimed-memory [^>]*origin="([^"]*)"/g)].map((match) => match[1]);
  assert.equal(tokens.length, list.length);
  assert.deepEqual([...new Set(tokens)].sort(), [...Object.values(ORIGIN_TEXT), "unrecorded"].sort(), "every origin is one of the closed words");
  for (const token of tokens) assert.match(token, /^[a-z-]+$/);
});

test("the resident profile, which is the block a conversation is handed, carries no provenance sentence either", () => {
  const capsuleFacts = [
    { id: "f1", factKind: "preference", content: "引用时保留原文出处", origin: "inferred", updatedAt: "2026-09-02T00:00:00.000Z" },
    { id: "f2", factKind: "profile", content: "临床药师，做老年用药研究", origin: "explicit", updatedAt: "2026-09-01T00:00:00.000Z" },
  ];
  const records = memos().slice(0, 3);
  const block = renderResidentProfile({ records, capsuleFacts, counts: { user: 2, project: 4, session: 0 }, capsuleCount: 3 });
  const contents = [...records.map((memo) => memo.content), ...capsuleFactMemos(capsuleFacts).map((memo) => memo.content)];
  const lines = structuralLines(block.text, contents);
  assert.deepEqual(lines.filter((line) => !ALLOWED.some((pattern) => pattern.test(line))), [], "nothing but the block's closed lines");
  for (const line of lines) for (const word of PROVENANCE_PROSE) assert.ok(!line.includes(word), `「${word}」 in 「${line}」`);
  assert.match(block.text, /origin="inferred"/, "a note the assistant took is an inference, said as the attribute");
  assert.match(block.text, /origin="user"/);
});
