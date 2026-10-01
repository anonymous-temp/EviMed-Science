// What a reader is shown beside each sentence of a clinical evidence report:
// whether the claim it rests on quotes the source it names. Since 2026-09-17
// this mark is what the delivery gate's quotation check is for — the package is
// delivered either way, and the reader is told claim by claim.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCommandRegistry } from "../src/commands.mjs";

const QUOTE = "Empagliflozin reduced the risk of kidney disease progression or cardiovascular death in a broad range of patients.";

async function withProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "os-claim-verification-"));
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir: path.join(root, "workspace"), baseDir: path.join(root, "workspace") };
  const config = { maxFileBytes: 2_000_000 };
  try {
    await mkdir(path.join(project.workspaceDir, "deliverables", "review"), { recursive: true });
    await mkdir(path.join(project.workspaceDir, ".evimed-sources", "PMC1", "abc"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, ".evimed-sources", "PMC1", "abc", "fulltext.md"), `# Trial\n\n${QUOTE}\n`, "utf8");
    const invoke = (args) => createCommandRegistry({ config, runtimeManager: {} }).invoke("claim_verification", args, { config, project });
    await fn({ project, invoke });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const source = (overrides = {}) => ({
  sourceTitle: "EMPA-KIDNEY",
  sourceUrl: "https://example.org/empa",
  identifier: "PMC1",
  accessLevel: "full_text",
  artifactPath: ".evimed-sources/PMC1/abc/fulltext.md",
  supportQuote: QUOTE,
  ...overrides,
});

test("each claim is marked by whether its quotation is in the preserved source it names", async () => {
  await withProject(async ({ project, invoke }) => {
    const matrix = { claims: [
      { claimId: "CLM-001", claim: "Found.", claimType: "direct", ...source() },
      { claimId: "CLM-002", claim: "Paraphrased.", claimType: "direct", ...source({ supportQuote: "Empagliflozin was shown to be broadly protective of the kidney across every subgroup studied." }) },
      { claimId: "CLM-003", claim: "Source never preserved.", claimType: "direct", ...source({ artifactPath: ".evimed-sources/PMC2/def/fulltext.md" }) },
      { claimId: "CLM-004", claim: "An estimate.", claimType: "derived", derivedFrom: ["CLM-001"], method: "Multiplied the reported rate by the cohort size to bound the count." },
      { claimId: "CLM-005", claim: "Two sources.", claimType: "synthesized", confidence: "moderate", supportingSources: [source(), source({ supportQuote: "A sentence that is nowhere in the preserved file at all, by construction." })] },
    ] };
    const matrixPath = "deliverables/review/clinical-evidence-matrix.json";
    await writeFile(path.join(project.workspaceDir, matrixPath), JSON.stringify(matrix), "utf8");

    const result = await invoke({ path: matrixPath });
    assert.deepEqual(
      Object.fromEntries(result.claims.map((claim) => [claim.claimId, claim.status])),
      { "CLM-001": "verified", "CLM-002": "quote_not_found", "CLM-003": "source_unavailable", "CLM-004": "derived", "CLM-005": "quote_not_found" },
    );
    assert.deepEqual(result.counts, { verified: 1, quote_not_found: 2, source_unavailable: 1, derived: 1 });
    assert.deepEqual(result.claims[4].sources.map((entry) => entry.status), ["verified", "quote_not_found"]);
  });
});

test("only a claim matrix is read, and a claim cannot point the check outside the workspace", async () => {
  await withProject(async ({ project, invoke }) => {
    await writeFile(path.join(project.workspaceDir, "deliverables", "review", "notes.json"), "{}", "utf8");
    await assert.rejects(invoke({ path: "deliverables/review/notes.json" }), (error) => error.code === "not_a_claim_matrix");
    await assert.rejects(invoke({ path: "deliverables/review/clinical-evidence-matrix.json" }), (error) => error.code === "file_not_found");

    await writeFile(path.join(project.rootDir, "outside.md"), `${QUOTE}\n`, "utf8");
    const matrixPath = "deliverables/review/clinical-evidence-matrix.json";
    await writeFile(path.join(project.workspaceDir, matrixPath), JSON.stringify({ claims: [
      { claimId: "CLM-001", claim: "Escapes.", claimType: "direct", ...source({ artifactPath: ".evimed-sources/../../outside.md" }) },
    ] }), "utf8");
    const result = await invoke({ path: matrixPath });
    assert.notEqual(result.claims[0].status, "verified", "a traversing path is never read as a preserved source");
  });
});

test("a synthesized claim's explicit bond keeps its own verdict, source type and DOI", async () => {
  await withProject(async ({ project }) => {
    const claim = {
      claimId: "CLM-053", claim: "Two sources.", claimType: "synthesized",
      ...source({ sourceUrl: "https://www.nice.org.uk/guidance/ng136", identifier: "DOI:10.1234/explicit", supportQuote: "This explicit top-level quotation is not present in the preserved document." }),
      supportingSources: [source(), source()],
    };
    const matrixPath = "deliverables/review/clinical-evidence-matrix.json";
    await writeFile(path.join(project.workspaceDir, matrixPath), JSON.stringify({ claims: [claim] }), "utf8");
    const config = { maxFileBytes: 2_000_000 };
    const asked = [];
    const registry = createCommandRegistry({ config, runtimeManager: {}, sourceUpdates: {
      lookup: async (dois) => { asked.push(...dois); return new Map([["10.1234/explicit", []]]); },
    } });
    const result = await registry.invoke("claim_verification", { path: matrixPath }, { config, project });
    assert.equal(result.claims[0].status, "quote_not_found");
    assert.deepEqual(result.claims[0].sources.map((entry) => [entry.status, entry.sourceType]), [
      ["verified", "other"], ["verified", "other"], ["quote_not_found", "guideline"],
    ]);
    assert.deepEqual(asked, ["10.1234/explicit"]);
    assert.equal(result.claims[0].sources[2].doi, "10.1234/explicit");
    assert.deepEqual(result.claims[0].sources[2].updates, []);
  });
});

for (const artifactPath of ["./.evimed-sources/PMC1/abc/fulltext.md", ".evimed-sources/PMC1/abc/../abc/fulltext.md", ".evimed-sources/../../outside.md"]) {
  test(`an explicit bond at ${artifactPath} keeps its origin without making its path readable`, async () => {
    await withProject(async ({ project }) => {
      const claim = {
        claimId: "CLM-053", claim: "Two sources.", claimType: "synthesized",
        ...source({ artifactPath, sourceUrl: "https://www.nice.org.uk/guidance/ng136", identifier: "DOI:10.1234/explicit", supportQuote: "This explicit quotation is not in the preserved document." }),
        supportingSources: [source(), source()],
      };
      const matrixPath = "deliverables/review/clinical-evidence-matrix.json";
      await writeFile(path.join(project.workspaceDir, matrixPath), JSON.stringify({ claims: [claim] }), "utf8");
      const config = { maxFileBytes: 2_000_000 };
      const registry = createCommandRegistry({ config, runtimeManager: {}, sourceUpdates: {
        lookup: async () => new Map([["10.1234/explicit", []]]),
      } });
      const result = await registry.invoke("claim_verification", { path: matrixPath }, { config, project });
      assert.equal(result.claims[0].status, "no_quote");
      assert.deepEqual(result.claims[0].sources.map((entry) => [entry.status, entry.sourceType]), [
        ["verified", "other"], ["verified", "other"], ["no_quote", "guideline"],
      ]);
      assert.equal(result.claims[0].sources[2].artifactPath, null);
      assert.equal(result.claims[0].sources[2].doi, "10.1234/explicit");
    });
  });
}
