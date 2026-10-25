// The follow-up judge's example bank is data (2026-10-25, owner decision 4): no regex or keyword list decides what a message means; the model reads
// it, helped by a fixed set of contrasts and its nearest examples, and code checks what is decidable. These tests hold the data to its own rules:
// a verdict of the closed list, a quotation that is a substring of its message, an anchor and a pool for every verdict.
import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_EVIDENCE_VERDICTS, LEARNING_RULE_VERDICTS } from "@evimed/domain";
import {
  FOLLOW_UP_EXAMPLES, FOLLOW_UP_EXAMPLES_VERSION, characterNgrams, followUpAnchors, followUpExampleIssues, followUpPool, ngramSimilarity, nearestByNgrams, renderFollowUpAnchors,
} from "@evimed/domain/follow-up-examples";

test("every example is of the closed verdicts, and a quotation is a substring of its message, for the verdicts that carry one", () => {
  assert.deepEqual(followUpExampleIssues(FOLLOW_UP_EXAMPLES), []);
  assert.ok(FOLLOW_UP_EXAMPLES.length >= 40, "a bank worth retrieving from");
  assert.ok(Number.isInteger(FOLLOW_UP_EXAMPLES_VERSION) && FOLLOW_UP_EXAMPLES_VERSION >= 1);
  for (const example of FOLLOW_UP_EXAMPLES) {
    assert.ok(LEARNING_EVIDENCE_VERDICTS.includes(example.verdict), example.id);
    if (LEARNING_RULE_VERDICTS.includes(example.verdict)) {
      assert.ok(example.quote && example.message.replace(/\s+/g, " ").includes(example.quote.replace(/\s+/g, " ")), `${example.id}: the quotation is in the message`);
    } else assert.equal(example.quote, null, `${example.id}: ${example.verdict} carries no quotation`);
    assert.ok(example.why.length > 10, `${example.id}: a reason that names what decides it`);
  }
});

test("the bank has an anchor and a pool for every verdict, in both languages, and the near misses the owner named are anchors", () => {
  const anchors = followUpAnchors();
  const pool = followUpPool();
  assert.equal(anchors.length + pool.length, FOLLOW_UP_EXAMPLES.length);
  for (const verdict of LEARNING_EVIDENCE_VERDICTS) {
    assert.ok(anchors.some((example) => example.verdict === verdict), `an anchor for ${verdict}`);
    assert.ok(pool.some((example) => example.verdict === verdict), `a pool example for ${verdict}`);
  }
  assert.ok(anchors.length <= 16, "a small fixed set, not the bank");
  assert.ok(FOLLOW_UP_EXAMPLES.some((example) => example.lang === "en") && FOLLOW_UP_EXAMPLES.some((example) => example.lang === "zh"));
  const byMessage = (text) => anchors.find((example) => example.message.includes(text));
  assert.equal(byMessage("这次就这样吧")?.verdict, "accept", "「这次就这样吧」 is accept, not adopt");
  assert.equal(byMessage("以后周报都按这个来")?.verdict, "adopt");
  assert.equal(byMessage("记住我喜欢短的")?.verdict, "preference", "「记住我喜欢短的」 is a preference, not an adoption");
  assert.equal(byMessage("格式就按这个，内容再补两条")?.verdict, "correction", "the format is kept and the content changes: a correction");
  const rendered = renderFollowUpAnchors(anchors);
  assert.ok(anchors.every((example) => rendered.includes(`${JSON.stringify(example.message)} → ${example.verdict}.`)));
  assert.ok(!pool.some((example) => rendered.includes(`${JSON.stringify(example.message)} →`)), "the pool is what the anchors are not");
});

test("a malformed bank is named, one fault at a time", () => {
  const good = FOLLOW_UP_EXAMPLES.map((example) => ({ ...example }));
  const faults = (change) => followUpExampleIssues(change(good.map((example) => ({ ...example }))));
  assert.ok(faults((bank) => { bank[0].verdict = "applause"; return bank; }).some((issue) => /not one of/.test(issue)));
  assert.ok(faults((bank) => { bank[0].quote = "not in the message at all"; return bank; }).some((issue) => /not a substring/.test(issue)));
  const accept = good.findIndex((example) => example.verdict === "accept");
  assert.ok(faults((bank) => { bank[accept].quote = "好"; return bank; }).some((issue) => /carries no quotation/.test(issue)));
  assert.ok(faults((bank) => { bank[1].id = bank[0].id; return bank; }).some((issue) => /repeated/.test(issue)));
  assert.ok(faults((bank) => { bank[1].message = bank[0].message; return bank; }).some((issue) => /repeats another/.test(issue)));
  assert.ok(faults((bank) => bank.map((example) => (example.verdict === "adopt" ? { ...example, anchor: undefined } : example))).some((issue) => /no adopt example is an anchor/.test(issue)));
  assert.ok(faults((bank) => bank.filter((example) => !(example.verdict === "none" && !example.anchor))).some((issue) => /no none example is in the pool/.test(issue)));
  assert.deepEqual(followUpExampleIssues([]), ["the bank holds no examples"]);
});

test("the n-gram measure ranks by shared characters in both languages and is deterministic; nothing in common is nothing", () => {
  assert.equal(ngramSimilarity("以后周报都按这个来", "以后周报都按这个来"), 1);
  assert.ok(ngramSimilarity("以后月报也按这个来", "以后周报都按这个来") > ngramSimilarity("以后月报也按这个来", "太长了"));
  assert.equal(ngramSimilarity("", "太长了"), 0);
  assert.ok(characterNgrams("A-B c").size > 0, "punctuation is not a character of the message");
  assert.deepEqual([...characterNgrams("短")], ["短"], "a single character is its own gram");
  const pool = followUpPool();
  const near = nearestByNgrams("Please always do it like this from now on", pool, 3);
  assert.equal(near.length, 3);
  assert.deepEqual(nearestByNgrams("Please always do it like this from now on", pool, 3).map((example) => example.id), near.map((example) => example.id), "same query, same examples");
  assert.ok(near.every((example) => !example.anchor));
  assert.deepEqual(nearestByNgrams("🦄", pool, 3), [], "no gram in common, no example chosen");
  assert.deepEqual(nearestByNgrams("太长", pool, 0), []);
});
