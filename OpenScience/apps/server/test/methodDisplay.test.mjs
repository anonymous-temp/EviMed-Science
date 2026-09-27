// The line a researcher reads for a learned method that came without one.
import assert from "node:assert/strict";
import test from "node:test";

import { MethodDescriber } from "../src/methodDisplay.mjs";

const config = { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key", deepseekModel: "deepseek-v4-flash" };
const document = { id: "method:learned:claim-verdict-audit", payload: { frontmatter: {
  name: "claim-verdict-audit", description: "Re-verifies the statements of a delivered evidence pack one claim at a time.",
  whenToUse: "After a pack carrying a citation ledger has been delivered.",
}, body: "## Purpose\nRe-verify." } };

test("a method is named in the researcher's language through one metered call", async () => {
  /** @type {any[]} */
  const calls = [];
  const describer = new MethodDescriber(config, {
    callModel: async (_deps, call) => {
      calls.push(call);
      return { choices: [{ message: { content: JSON.stringify({ title: "交付后逐条复核主张", summary: "证据包交付后，逐条把陈述拿回它引用的原文核对，看哪些站得住。" }) } }] };
    },
  });
  const display = await describer.describe(document, { userId: "u1", projectId: "p1" });
  assert.deepEqual(display, { title: "交付后逐条复核主张", summary: "证据包交付后，逐条把陈述拿回它引用的原文核对，看哪些站得住。" });
  assert.equal(calls[0].purpose, "learning", "metered as learning, beside the runs that learnt the method");
  assert.match(calls[0].body.messages[1].content, /claim-verdict-audit/);
});

test("the steps come back in the researcher's language beside the line, and stand alone when the line does not", async () => {
  // 2026-09-26 audit (M-5): opening a method showed its English SKILL.md.
  const answer = { title: "交付后逐条复核主张", summary: "证据包交付后，逐条把陈述拿回它引用的原文核对。", steps: "1. 交付后取出每条陈述\r\n2. 对回原文\n\n\n3. 记下站不住的" };
  const describer = new MethodDescriber(config, { callModel: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) });
  const display = await describer.describe(document, { userId: "u1", projectId: "p1" });
  assert.equal(display?.title, answer.title);
  assert.equal(display?.steps, "1. 交付后取出每条陈述\n2. 对回原文\n\n3. 记下站不住的");
  const stepsOnly = new MethodDescriber(config, { callModel: async () => ({ choices: [{ message: { content: JSON.stringify({ title: "标".repeat(60), summary: "", steps: "1. 只有步骤" }) } }] }) });
  assert.deepEqual(await stepsOnly.describe(document, { userId: "u1", projectId: null }), { title: "", summary: "", steps: "1. 只有步骤" });
});

test("an answer that is not a usable line is no line, and a failure is never a throw", async () => {
  const tooLong = new MethodDescriber(config, { callModel: async () => ({ choices: [{ message: { content: JSON.stringify({ title: "标".repeat(60), summary: "说明" }) } }] }) });
  assert.equal(await tooLong.describe(document, { userId: "u1", projectId: null }), null);
  const failing = new MethodDescriber(config, { callModel: async () => { throw Object.assign(new Error("upstream"), { code: "model_gateway_upstream_error" }); } });
  assert.equal(await failing.describe(document, { userId: "u1", projectId: null }), null);
  const off = new MethodDescriber({ ...config, deepseekProviderEnabled: false }, { callModel: async () => { throw new Error("must not call"); } });
  assert.equal(await off.describe(document, { userId: "u1", projectId: null }), null);
});
