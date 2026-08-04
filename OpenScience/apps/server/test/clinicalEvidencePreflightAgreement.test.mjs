// The skill tells a run to fix every preflight issue and rerun until it returns
// ok=true, then hands the package to the server gate. That instruction is only
// honest if the two agree: whatever the gate rejects, the preflight must have
// already caught, while the run could still act on it.
//
// They have now disagreed three times in production, each time costing a
// finished package. The ledger header had to be three exact columns that the
// preflight never looked at. The ledger row count included derived claims the
// gate excludes. And clinical-evidence-run.json had to carry
// successfulSourceArtifacts, which the preflight never checked — so a run that
// preserved five sources and wrote all seven deliverables was failed after 45
// minutes, told only "specialist_evidence_traceability_failed", and could not
// even be sent back to fix it, because the repair path needs an issue to hand
// over and that failure carried none.
//
// Checking by hand caught each one after the fact. This checks it on every
// change to either side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";
import { deepResearchPackage } from "./fixtures/clinicalEvidencePackage.mjs";

const execFileAsync = promisify(execFile);
const preflightScript = new URL(
  "../../../runtime/skills/evimed/clinical-evidence-synthesis/scripts/preflight.py",
  import.meta.url,
).pathname;

async function writeWorkspace(input) {
  const workspace = await mkdtemp(path.join(tmpdir(), "clinical-preflight-"));
  const files = {
    "clinical-evidence-report.md": input.reportText,
    "clinical-evidence-matrix.json": JSON.stringify(input.matrix),
    "clinical-evidence-run.json": JSON.stringify(input.runReceipt),
    "clinical-evidence-search.json": input.searchLogText,
    "references.bib": input.referencesText,
    "citation-ledger.csv": input.citationLedgerText,
    "citation-audit.md": input.citationAuditText,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(workspace, name), content, "utf8");
  }
  for (const [artifactPath, content] of Object.entries(input.sourceArtifacts)) {
    await mkdir(path.join(workspace, path.dirname(artifactPath)), { recursive: true });
    await writeFile(path.join(workspace, artifactPath), content, "utf8");
  }
  return workspace;
}

async function runPreflight(workspace) {
  try {
    const { stdout } = await execFileAsync("python3", [preflightScript, "--workspace", workspace]);
    return JSON.parse(stdout);
  } catch (error) {
    // Non-zero exit is how it reports issues; the payload is still on stdout.
    if (error?.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

/** @param {any} input @param {string} label */
async function verdicts(input, label) {
  const workspace = await writeWorkspace(input);
  try {
    return {
      label,
      gate: validateClinicalEvidencePackage(input),
      preflight: await runPreflight(workspace),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("a package both sides accept", async () => {
  const { gate, preflight } = await verdicts(deepResearchPackage(), "valid");
  assert.equal(gate.valid, true, gate.issues.join("\n"));
  assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
});

test("whatever the server gate rejects, the preflight already caught", async () => {
  // Each case is a real production failure, reduced to the one field that
  // caused it. If the preflight passes any of these, a run is told it is done
  // and then failed for it — which is what happened, three times.
  const cases = [
    {
      label: "run receipt without successfulSourceArtifacts",
      break: (input) => { delete input.runReceipt.successfulSourceArtifacts; },
    },
    {
      label: "run receipt naming a source artifact that is not on disk",
      break: (input) => { input.runReceipt.successfulSourceArtifacts = [".evimed-sources/missing/content.md"]; },
    },
    {
      label: "run receipt naming a path outside .evimed-sources",
      break: (input) => { input.runReceipt.successfulSourceArtifacts = ["workspace/notes.md"]; },
    },
    {
      label: "citation ledger whose header omits a column the cross-check reads",
      break: (input) => {
        input.citationLedgerText = input.citationLedgerText.replace(
          "claimId,referenceNumber,supportQuote",
          "claim,source,quote",
        );
      },
    },
    {
      label: "citation ledger missing a row",
      break: (input) => {
        const rows = input.citationLedgerText.trim().split("\n");
        input.citationLedgerText = [rows[0], ...rows.slice(2)].join("\n");
      },
    },
    {
      label: "derived result asserted without its 〔推导〕 mark",
      break: (input) => {
        input.matrix.claims.push({
          claimId: "CLM-101",
          claimType: "derived",
          claim: "推算：在给定条件下 6 个月残余约 78%。",
          method: "以蒸汽压与密封体系损失曲线为输入，按一级逸散近似 ln(C/C0) = -k·t 反解 k，代入 6 个月得 78%。",
          assumptions: "温度恒定 20 ℃，每日开盖 2 次，顶空体积不变。",
          sensitivity: "开盖频率翻倍时降至约 61%。",
          applicability: "仅适用于同类滴丸的密闭玻璃瓶包装。",
          uncertainty: "输入曲线来自密封体系，为量级判断而非测定值。",
          derivedFrom: ["CLM-001", "CLM-002"],
        });
        input.reportText = input.reportText.replace(
          "## 讨论\n",
          "## 讨论\n在给定条件下 6 个月残余约 78%。 <!-- claim:CLM-101 -->\n",
        );
      },
    },
  ];

  for (const scenario of cases) {
    const input = deepResearchPackage();
    scenario.break(input);
    const { gate, preflight } = await verdicts(input, scenario.label);
    assert.equal(gate.valid, false, `${scenario.label}: the gate accepted it, so this case no longer tests anything`);
    assert.equal(
      preflight.ok,
      false,
      `${scenario.label}: the gate rejects this package but the preflight returned ok=true, `
        + "so a run would be told it is finished and then failed for it",
    );
  }
});
