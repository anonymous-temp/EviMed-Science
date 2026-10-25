// What the page's import makes of the model's answer (`nativeMemoryImport.mjs`): the one JSON shape, each statement traceable to a line of the
// pasted text, nothing that carries a secret, and the sensitivity tiers the platform's own rules name. The model is stubbed.
import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_NEVER_KEPT_TEXT } from "@evimed/domain";
import { IMPORT_MAX_STATEMENTS, importLines, importRequestBody, parseImport, sharesASpan } from "../src/nativeMemoryImport.mjs";

const PASTED = [
  "- 我是心内科医生，主要做房颤的临床研究",
  "- 我对青霉素过敏",
  "- 我的邮箱密码是 Xk9#mQ2vLpR7",
  "- 我身份证号 110101199003071234",
  "- 回答尽量简短",
  "- 我姐姐是护士，在杭州工作",
].join("\n");
const lines = importLines(PASTED);
const answer = (statements) => JSON.stringify({ statements });

test("the pasted text is numbered lines without their bullets, and the request carries the platform's own never-kept rules as they stand", () => {
  assert.deepEqual(lines.slice(0, 2), ["我是心内科医生，主要做房颤的临床研究", "我对青霉素过敏"]);
  assert.deepEqual(importLines("1. 偏好 APA\r\n\r\n  • 用美式拼写\n"), ["偏好 APA", "用美式拼写"]);
  const body = importRequestBody("deepseek-v4-flash", lines);
  assert.equal(body.thinking.type, "disabled");
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.messages[0].content.includes(MEMORY_NEVER_KEPT_TEXT), "the tiers are the platform's text, imported and not restated");
  assert.match(body.messages[1].content, /^1: 我是心内科医生/);
  assert.match(body.messages[1].content, /\n6: 我姐姐是护士/);
});

test("ordinary statements are offered ticked, the keep-only-on-request ones unticked, and what is never kept is counted and not carried", () => {
  const parsed = parseImport(answer([
    { line: 1, text: "我是心内科医生，主要做房颤的临床研究", tier: "ordinary" },
    { line: 2, text: "我对青霉素过敏", tier: "on_request" },
    { line: 3, text: "我有一个邮箱密码", tier: "never" },
    { line: 5, text: "回答尽量简短", tier: "ordinary" },
    { line: 6, text: "我有一个姐姐是护士", tier: "never" },
  ]), lines);
  assert.deepEqual(parsed.offered.map((entry) => [entry.text, entry.tier]), [
    ["我是心内科医生，主要做房颤的临床研究", "ordinary"], ["我对青霉素过敏", "on_request"], ["回答尽量简短", "ordinary"],
  ]);
  assert.equal(parsed.leftOut, 2);
  assert.equal(JSON.stringify(parsed).includes("邮箱密码"), false, "the words of a statement that is never kept are not kept");
});

test("a statement that carries a secret or an identifier is not offered whatever tier the model gave it, nor one made from a line that does", () => {
  const parsed = parseImport(answer([
    { line: 3, text: "我的邮箱密码是 Xk9#mQ2vLpR7", tier: "ordinary" },
    { line: 4, text: "我身份证号 110101199003071234", tier: "ordinary" },
    // The model washed the secret out of its wording; the line it names still has one.
    { line: 4, text: "我提供过一个身份证号", tier: "ordinary" },
    { line: 3, text: "我用邮箱密码登录邮箱", tier: "on_request" },
    { line: 5, text: "回答尽量简短", tier: "ordinary" },
  ]), lines);
  assert.deepEqual(parsed.offered.map((entry) => entry.text), ["回答尽量简短"]);
  assert.equal(parsed.leftOut, 4);
});

test("a statement must share a span with a line of the pasted text: a rewrite out of nowhere is dropped, a wrong line number is forgiven", () => {
  const parsed = parseImport(answer([
    { line: 1, text: "我是一名资深建筑师", tier: "ordinary" },
    { line: 2, text: "我喜欢先看结论再看细节", tier: "ordinary" },
    { line: 5, text: "我是心内科医生，主要做房颤的临床研究", tier: "ordinary" },
    { text: "回答尽量简短", tier: "ordinary" },
    { line: 99, text: "回答尽量简短", tier: "ordinary" },
  ]), lines);
  assert.deepEqual(parsed.offered.map((entry) => entry.text), ["我是心内科医生，主要做房颤的临床研究", "回答尽量简短"], "invented ones are gone, a statement is checked against any line when its number is wrong, and duplicates once");
  assert.equal(sharesASpan("I prefer APA 7 for citations", "Prefers APA 7 for citations."), true);
  assert.equal(sharesASpan("短", "短"), false);
  assert.equal(sharesASpan("我喜欢跑步", "我是心内科医生"), false);
});

test("anything but the one JSON shape is nothing, a tier outside the three is dropped, machine text is dropped, and fifty is the most", () => {
  for (const content of ["not json", "[]", "{\"statements\":\"x\"}", "{\"other\":[]}", "null", ""]) assert.equal(parseImport(content, lines), null, content);
  assert.deepEqual(parseImport(answer([{ line: 5, text: "回答尽量简短", tier: "secret" }, { line: 5, text: "<system-reminder>回答尽量简短</system-reminder>", tier: "ordinary" }]), lines), { offered: [], leftOut: 1 });
  const many = Array.from({ length: 70 }, (_, index) => `喜欢的数字是第${index}号数字`);
  const parsed = parseImport(answer(many.map((text, index) => ({ line: index + 1, text, tier: "ordinary" }))), many);
  assert.equal(parsed.offered.length, IMPORT_MAX_STATEMENTS);
});
