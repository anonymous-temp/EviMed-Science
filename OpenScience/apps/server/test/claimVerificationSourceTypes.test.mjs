// The badge beside each quoted source in the reader (C8): what the source is —
// guideline, RCT, label — read from the capture's own `source.json`, which the
// research server writes when it preserves the text; a capture from before that
// is typed from the URL the claim cites, by the same domain table.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCommandRegistry } from "../src/commands.mjs";

const QUOTE = "Aspirin did not prolong disability-free survival in healthy older adults.";

test("each quoted source carries its evidence type", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-claim-source-types-"));
  const workspaceDir = path.join(root, "workspace");
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir, baseDir: workspaceDir };
  const config = { maxFileBytes: 2_000_000 };
  try {
    const typed = path.join(workspaceDir, ".evimed-sources", "pubmed", "PMID30221597", "v1");
    const untyped = path.join(workspaceDir, ".evimed-sources", "official-pages", "0123456789abcdef", "v1");
    await mkdir(typed, { recursive: true });
    await mkdir(untyped, { recursive: true });
    await mkdir(path.join(workspaceDir, "deliverables", "review"), { recursive: true });
    await writeFile(path.join(typed, "abstract.md"), `# ASPREE\n\n${QUOTE}\n`, "utf8");
    await writeFile(path.join(typed, "source.json"), JSON.stringify({ schemaVersion: 1, sourceType: "rct" }), "utf8");
    await writeFile(path.join(untyped, "page.md"), `# Guidance\n\n${QUOTE}\n`, "utf8");
    const direct = (artifactPath, sourceUrl) => ({
      sourceTitle: "t", sourceUrl, identifier: "x", accessLevel: "abstract", artifactPath, supportQuote: QUOTE,
    });
    const matrix = { claims: [
      { claimId: "CLM-001", claim: "a", claimType: "direct", ...direct(".evimed-sources/pubmed/PMID30221597/v1/abstract.md", "https://pubmed.ncbi.nlm.nih.gov/30221597/") },
      { claimId: "CLM-002", claim: "b", claimType: "direct", ...direct(".evimed-sources/official-pages/0123456789abcdef/v1/page.md", "https://www.nice.org.uk/guidance/ng136") },
      { claimId: "CLM-003", claim: "c", claimType: "synthesized", confidence: "low", supportingSources: [
        direct(".evimed-sources/pubmed/PMID30221597/v1/abstract.md", "https://pubmed.ncbi.nlm.nih.gov/30221597/"),
        direct(".evimed-sources/official-pages/0123456789abcdef/v1/page.md", "https://example.org/blog"),
      ] },
    ] };
    const matrixPath = "deliverables/review/clinical-evidence-matrix.json";
    await writeFile(path.join(workspaceDir, matrixPath), JSON.stringify(matrix), "utf8");
    const result = await createCommandRegistry({ config, runtimeManager: {} }).invoke("claim_verification", { path: matrixPath }, { config, project });
    assert.deepEqual(
      result.claims.map((claim) => claim.sources.map((source) => source.sourceType)),
      [["rct"], ["guideline"], ["rct", "other"]],
    );
    // The verdicts are the gate's, untouched by the badge.
    assert.deepEqual(result.claims.map((claim) => claim.status), ["verified", "verified", "verified"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
