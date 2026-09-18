import assert from "node:assert/strict";
import test from "node:test";

import { validateClinicalEvidencePackage } from "@evimed/domain/clinical-evidence";

import { nextClaimId, proseShape, readMatrix, renderClinicalReport, upsertClaim } from "../index.mjs";

test("a matrix is read as the run wrote it, or refused without being rewritten", () => {
  assert.deepEqual(readMatrix(null), { ok: true, matrix: { claims: [] } });
  assert.deepEqual(readMatrix("  "), { ok: true, matrix: { claims: [] } });
  assert.deepEqual(readMatrix('{"questionPico": {"population": "adults"}}'), { ok: true, matrix: { questionPico: { population: "adults" }, claims: [] } });
  const broken = readMatrix('{"claims": [ {"claim": "a "quoted" word"} ]}');
  assert.equal(broken.ok, false);
  assert.match(/** @type {any} */ (broken).reason, /not valid JSON/);
  assert.equal(readMatrix("[]").ok, false, "an array is not the contract's shape");
  assert.equal(readMatrix('{"claims": {}}').ok, false);
});

test("an upsert replaces by id, appends a new id, numbers an unnamed claim, and keeps the matrix root", () => {
  const matrix = { questionPico: { population: "≥70" }, claims: [{ claimId: "CLM-002", claim: "a" }, { claimId: "CLM-010", claim: "b" }] };
  assert.equal(nextClaimId(matrix.claims), "CLM-011");
  assert.equal(nextClaimId([]), "CLM-001");

  const replaced = upsertClaim(matrix, { claimId: "CLM-002", claim: "a2" });
  assert.equal(replaced.created, false);
  assert.deepEqual(replaced.matrix.claims.map((/** @type {any} */ claim) => claim.claim), ["a2", "b"], "replaced in place, order kept");
  assert.deepEqual(replaced.matrix.questionPico, { population: "≥70" });
  assert.equal(matrix.claims[0].claim, "a", "the input is not mutated");

  const numbered = upsertClaim(replaced.matrix, { claim: "c" });
  assert.equal(numbered.claim.claimId, "CLM-011");
  assert.equal(numbered.created, true);
  const again = upsertClaim(numbered.matrix, numbered.claim);
  assert.equal(again.matrix.claims.length, 3, "the same claim twice is one row");
});

test("a report already in order comes back byte for byte", () => {
  const report = "# T\n\n## 结果\n\n甲 [1]，乙 [1-3]。<!-- claim:CLM-001 -->\n\n## 参考文献\n\n1. A. doi:10.1/a\n2. B. doi:10.1/b\n3. C. doi:10.1/c\n";
  const rendered = renderClinicalReport({ reportText: report, matrix: { claims: [{ claimId: "CLM-001", referenceNumber: 1 }] } });
  assert.equal(rendered.text, report);
  assert.deepEqual(rendered.changed, { report: false, matrix: false });
  assert.equal(rendered.renumbered, false);
  assert.equal(rendered.references, 3);
  assert.deepEqual(rendered.unresolved, { citations: [], claims: [] });
});

test("a cited number with no entry is built from its claim, or reported; uncited entries keep a number after the cited ones", () => {
  const report = "# T\n\n## 结果\n\n甲 [2]。<!-- claim:CLM-001 -->\n乙 [7]。<!-- claim:CLM-404 -->\n\n## 参考文献\n\n1. Uncited source. doi:10.1/u\n";
  const matrix = { claims: [{ claimId: "CLM-001", referenceNumber: 2, sourceTitle: "Built from the claim", identifier: "PMID:12345678", sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/12345678/" }] };
  const rendered = renderClinicalReport({ reportText: report, matrix });
  assert.match(rendered.text, /甲 \[1\]。/);
  assert.match(rendered.text, /乙 \[2\]。/);
  assert.match(rendered.text, /\n1\. Built from the claim\. PMID:12345678\. https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12345678\/\n3\. Uncited source\. doi:10\.1\/u\n/);
  assert.deepEqual(rendered.added, [1]);
  assert.deepEqual(rendered.uncited, [3]);
  assert.deepEqual(rendered.unresolved, { citations: [2], claims: ["CLM-404"] });
  assert.equal(/** @type {any} */ (rendered.matrix).claims[0].referenceNumber, 1);
});

test("a report with no reference heading gains one, and the entry style becomes the one every reader counts", () => {
  const withBrackets = "# T\n\n## 结果\n\n甲 [1]。\n\n## 参考文献\n\n[1] A. doi:10.1/a\n";
  const normalized = renderClinicalReport({ reportText: withBrackets });
  assert.match(normalized.text, /## 参考文献\n\n1\. A\. doi:10\.1\/a\n$/);
  assert.equal(normalized.renumbered, false, "the numbers did not change, only the spelling of the list");

  const headless = renderClinicalReport({ reportText: "# T\n\n甲 [1]。", matrix: { claims: [{ claimId: "CLM-001", referenceNumber: 1, sourceTitle: "A", sourceUrl: "https://example.org/a" }] } });
  assert.match(headless.text, /甲 \[1\]。\n\n## 参考文献\n\n1\. A\. https:\/\/example\.org\/a\n$/);
});

test("the renumbered report reads the same to the gate as the renderer meant it to", () => {
  // The renderer and the gate share one grammar. After a render, every claim's
  // reference number resolves and every cited number has its entry — the two
  // reference-closure findings a hand renumbering used to leave behind.
  const report = [
    "# 标题", "", "## 结果", "",
    "出血增加 [3]。<!-- claim:CLM-001 -->",
    "事件未减少 [5]。<!-- claim:CLM-002 -->",
    "", "## 参考文献", "",
    "3. McNeil. Aspirin. doi:10.1056/nejmoa1805819",
    "5. Chan. Cohort. doi:10.1136/bmj.i1",
    "",
  ].join("\n");
  const matrix = { claims: [{ claimId: "CLM-001", referenceNumber: 3 }, { claimId: "CLM-002", referenceNumber: 5 }] };
  const rendered = renderClinicalReport({ reportText: report, matrix });
  const verdict = validateClinicalEvidencePackage({ reportText: rendered.text, matrix: rendered.matrix });
  const closure = verdict.issueChecks.filter((finding) => ["citation-closure", "reference-number-unresolved", "claim-reference-number"].includes(String(finding.check)));
  assert.deepEqual(closure, [], JSON.stringify(closure));
});

test("the prose shape is one row per paragraph and a count per phrase asked for", () => {
  const report = [
    "# 标题", "", "## 结果", "",
    "此外，第一段的开头。", "它延续到第二行。<!-- claim:CLM-001 -->", "",
    "| 表 | 格 |", "- 列表项此外", "",
    "## 讨论", "", "综上所述，第二段。", "",
  ].join("\n");
  const shape = proseShape(report, ["此外", "综上所述", "不存在的词", "", "x".repeat(40)]);
  assert.deepEqual(shape.paragraphs, [
    { section: "结果", chars: 18, opening: "此外，第一段的开头。它延续到第二" },
    { section: "讨论", chars: 9, opening: "综上所述，第二段。" },
  ].map((row) => ({ ...row, opening: [...row.opening].slice(0, 14).join("") })));
  assert.deepEqual(shape.phrases, { 此外: 2, 综上所述: 1 }, "counted over the text, lists included; absent and malformed phrases dropped");
  assert.equal(shape.truncated, 0);
});
