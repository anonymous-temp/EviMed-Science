// What the editor reads of the sources a package cites (reviewService.mjs
// claimsWithSources): each source once, whole when short, and around its
// quotes when long — wide enough that a detail the abstract states a few
// hundred characters from the quote is in view (2026-09-23: two of four live
// findings called such details unsupported under a ±300 window).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimsWithSources } from "../src/reviewService.mjs";

test("each source is shown once, whole when short, and around its quotes when long", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-sources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const short = ".evimed-sources/pubmed/PMID41569211/a/abstract.md";
  const long = ".evimed-sources/pubmed/PMID1/b/fulltext.md";
  const abstract = "METHODS: This prospective multicenter randomized controlled trial included patients ≥65 years with elevated stroke risk from 2 secondary care centers in the Netherlands. RESULTS: Between November 2022 and December 2023, 437 patients were randomized (219 intervention, 218 control).";
  const detail = "The trial enrolled patients from 2 secondary care centers in the Netherlands.";
  const quote = "New atrial fibrillation was detected in 9.6% of the intervention group.";
  const body = `${"Background filler. ".repeat(300)}${detail}${" More filler here.".repeat(50)} ${quote}${" Tail filler text.".repeat(400)}`;
  await fs.mkdir(path.join(root, path.dirname(short)), { recursive: true });
  await fs.mkdir(path.join(root, path.dirname(long)), { recursive: true });
  await fs.writeFile(path.join(root, short), abstract);
  await fs.writeFile(path.join(root, long), body);
  const matrix = JSON.stringify({ claims: [
    { claimId: "CLM-073", claimType: "direct", claim: "荷兰两家二级医疗中心的 RCT 纳入 437 例。", artifactPath: short, supportQuote: "Between November 2022 and December 2023, 437 patients were randomized", sourceTitle: "Smartwatch AF screening" },
    { claimId: "CLM-074", claimType: "direct", claim: "同一试验。", artifactPath: short, supportQuote: "437 patients were randomized", sourceTitle: "Smartwatch AF screening" },
    { claimId: "CLM-075", claimType: "direct", claim: "干预组房颤检出 9.6%。", artifactPath: long, supportQuote: quote, sourceTitle: "Long report" },
    { claimId: "CLM-076", claimType: "direct", claim: "无法读取的来源。", artifactPath: "../outside.md", supportQuote: "x", sourceTitle: "Outside" },
  ] });

  const { claims, sources } = await claimsWithSources(root, matrix);
  assert.deepEqual(sources.map((source) => source.id), ["S1", "S2"], "two readable sources, each once");
  assert.equal(sources[0].text, abstract, "a short source is shown whole");
  assert.ok(sources[1].text.includes(detail), "a detail ~1,000 characters before the quote is in view");
  assert.ok(sources[1].text.includes(quote));
  assert.ok(sources[1].text.length < body.length && sources[1].text.startsWith("…"), "a long source is shown as passages");
  assert.deepEqual(claims.map((claim) => claim.sources.map((source) => source.sourceId)), [["S1"], ["S1"], ["S2"], [null]]);
});
