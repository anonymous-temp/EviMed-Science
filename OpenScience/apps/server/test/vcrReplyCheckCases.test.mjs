// The labelled cases of the 虚拟临研 reply check (evals/vcr-reply-check/cases.json): given the labelled claims — the language judgement
// the reviewer makes — the code half's verdict on every sentence is what the case says. The model half is measured live, never here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { acceptReplyClaims, studyNumbers, vcrReplyVerdicts } from "../src/vcrReplyCheck.mjs";

const cases = JSON.parse(await readFile(new URL("../../../evals/vcr-reply-check/cases.json", import.meta.url), "utf8"));

test("every labelled sentence gets the verdict its label says, from the study's results", () => {
  assert.ok(cases.cases.length >= 12, "the walk proves it walked");
  const candidates = studyNumbers(cases.study);
  const kinds = new Set();
  for (const entry of cases.cases) {
    const claims = acceptReplyClaims({ claims: [{ sentence: 0, numbers: entry.claims }] }, [{ index: 0, sentence: entry.sentence }]);
    const verdicts = vcrReplyVerdicts({ claims, candidates });
    const got = !claims.length ? "nothing" : verdicts.length ? "not_found" : "found";
    assert.equal(got, entry.expect, `${entry.id}: ${entry.sentence}`);
    kinds.add(entry.expect);
  }
  assert.deepEqual([...kinds].sort(), ["found", "not_found", "nothing"], "the three outcomes are all held");
});
