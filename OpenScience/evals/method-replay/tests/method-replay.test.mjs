// The replay judge's calibration instrument: the case file, the scoring and the runner with a stubbed model. No network, no key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as module from "../../../apps/server/src/methodReplay.mjs";
import { main, parseArguments, runCases, shownFor } from "../run.mjs";
import { caseIssues, render, summarize } from "../score.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(await readFile(path.join(here, "../cases.json"), "utf8"));

test("the case file is sound: unique ids, both labels, both languages, each case says why", () => {
  assert.deepEqual(caseIssues(cases), []);
  assert.ok(cases.length >= 24);
  const count = (/** @type {string} */ key, /** @type {string} */ value) => cases.filter((/** @type {any} */ item) => item[key] === value).length;
  assert.ok(count("label", "contradiction") >= 10 && count("label", "none") >= 10, "balanced enough to read a false-positive rate");
  assert.ok(count("lang", "zh") >= 8 && count("lang", "en") >= 8);
  assert.ok(caseIssues([{ ...cases[0], label: "maybe" }, { ...cases[0] }]).length >= 2, "a bad label and a repeated id are both said");
});

test("each case is rendered by the module's own text functions, and a contradiction's words are in what the judge is shown", () => {
  for (const item of cases) {
    const shown = shownFor(item, module);
    assert.ok(shown.methodText.includes(item.method.name.replace(/-/g, " ")), item.id);
    assert.ok(item.run.requests.every((/** @type {string} */ request) => shown.runText.includes(request)), item.id);
  }
  const verdict = module.replayVerdictFrom(JSON.stringify({ inScope: true, scopeQuote: "分三节：入组、脱落、不良事件", contradicts: true, methodQuote: "周报一律写成恰好十节", runQuote: "分三节：入组、脱落、不良事件" }), shownFor(cases[0], module));
  assert.equal(verdict.verdict, "contradiction", "the first case's own words ground a verdict");
});

test("the runner scores what the module counts: a contradiction is one only when both quotations are in what was shown", async () => {
  const judge = { read: async (/** @type {any} */ shown, /** @type {any} */ owner) => {
    const id = owner.runId.replace("eval-", "");
    const item = cases.find((/** @type {any} */ candidate) => candidate.id === id);
    if (id === "mr-005") return null;
    if (id === "mr-013") return JSON.stringify({ inScope: true, scopeQuote: "帮我查一下近三年", contradicts: true, methodQuote: "周报一律写成恰好十节", runQuote: "帮我查一下近三年" });
    if (id === "mr-014") return JSON.stringify({ inScope: true, scopeQuote: "a request nobody made", contradicts: true, methodQuote: "a rule the method never states", runQuote: "a request nobody made" });
    if (item.label === "contradiction") {
      const request = item.run.requests[0];
      const line = item.method.body.split("\n").find((/** @type {string} */ text) => /^1\. /.test(text)).replace(/^1\. /, "");
      return JSON.stringify({ inScope: true, scopeQuote: request, contradicts: true, methodQuote: line, runQuote: request });
    }
    return JSON.stringify({ contradicts: false, methodQuote: null, runQuote: null });
  } };
  const results = await runCases({ cases, judge, module, samples: 2, concurrency: 3 });
  assert.equal(results.length, cases.length * 2);
  const summary = summarize(results);
  assert.deepEqual([summary.recall.found, summary.recall.of], [11 * 2, 12 * 2], "mr-005's call failed");
  assert.deepEqual(summary.falsePositive.ids.sort(), ["mr-013", "mr-013"], "a grounded verdict on a case that does not contradict is a false positive");
  assert.equal(summary.unverified, 2, "mr-014's quotations are not in what was shown");
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.missed.map((entry) => entry.id).sort(), ["mr-005", "mr-005"]);
  assert.match(render(summary), /false positives 2\/24/);
});

test("the dry run shows the module's own request, and the arguments are bounded", async () => {
  let printed = "";
  assert.equal(await main(["--dry-run", "--only", "mr-001"], (text) => { printed += text; }), 0);
  const shown = JSON.parse(printed);
  assert.equal(shown.instructionsAreTheModules, true);
  assert.equal(shown.request.thinking.type, "disabled");
  assert.deepEqual(Object.keys(JSON.parse(shown.request.messages[1].content)), ["method", "run"]);
  assert.equal(parseArguments(["--samples", "99"]).samples, 9);
  assert.throws(() => parseArguments(["--nope"]), /unknown argument/);
  await assert.rejects(() => main(["--only", "nothing"]), /no case selected/);
});
