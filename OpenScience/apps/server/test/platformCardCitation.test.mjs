// Rule 2 end to end on the control plane (flywheel plan §4.3, §11): a delivered clinical package whose report and
// matrix cite one of EviMed's own evidence cards as a source is still delivered, with no mark; the reader is told
// once, in the sentence the plan names, and the operator's counter moves once for the run. Without the rule none of
// this exists, and with the rule a card cited in a package changes nothing about whether it ships.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PLATFORM_CARD_CITATION_SENTENCE } from "@evimed/domain";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { platformContentCitedMetricFamilies, recordPlatformContentCited, resetPlatformContentCited } from "../src/evidenceCitationMetrics.mjs";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";
import { deepResearchPackage } from "./fixtures/clinicalEvidencePackage.mjs";
import { noticeTexts } from "./helpers/noticeTexts.mjs";

const CARD_PAGE = "https://www.evimed.com/evidence/c/ec_0123456789abcdef0123456789abcdef";
const citedTotal = () => platformContentCitedMetricFamilies().find((family) => family.name === "open_science_evidence_platform_content_cited_total")?.series[0].value;
const citedRuns = () => platformContentCitedMetricFamilies().find((family) => family.name === "open_science_evidence_platform_content_cited_runs_total")?.series[0].value;

/** The fixture package with one source's address replaced by an EviMed card page, in the report and the matrix alike. */
function packageCitingACard() {
  const pkg = deepResearchPackage();
  const original = "https://www.escardio.org/evidence/source-3";
  const rewrite = (value) => value.split(original).join(CARD_PAGE);
  pkg.reportText = rewrite(pkg.reportText);
  pkg.matrix = JSON.parse(rewrite(JSON.stringify(pkg.matrix)));
  return pkg;
}

test("the clinical gate names a card cited in the report and in a claim, as advice in no blocking tier", () => {
  const verdict = validateClinicalEvidencePackage(packageCitingACard());
  const found = verdict.findings.filter((finding) => finding.check === "platform-card-citation");
  assert.ok(found.length >= 2, "the reference list's link and the claim's source address are each named");
  for (const finding of found) {
    assert.equal(finding.tier, "advisory");
    assert.ok(finding.text.startsWith(PLATFORM_CARD_CITATION_SENTENCE), finding.text);
    assert.ok(finding.text.includes(CARD_PAGE));
  }
  assert.ok(found.some((finding) => /clinical-evidence-report\.md 第 \d+ 行/.test(finding.text)), "the report's line");
  assert.ok(found.some((finding) => /claims\[\d+\]\.sourceUrl|CLM-\d+\.sourceUrl/.test(finding.text)), "the claim's own address");
  assert.deepEqual(verdict.blockingIssues.filter((text) => text.includes(CARD_PAGE)), [], "nothing about the card blocks");
  assert.equal(verdict.safetyIssues.some((text) => text.includes(CARD_PAGE)), false);
  const clean = validateClinicalEvidencePackage(deepResearchPackage());
  assert.equal(clean.findings.some((finding) => finding.check === "platform-card-citation"), false, "a package that cites no card is told nothing");
});

test("a card page in the report is a notice on a delivered run, not a mark and not a failure, and the guardrail counter moves once", async () => {
  resetPlatformContentCited();
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-card-citation-"));
  try {
    const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_card_citation", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const pkg = packageCitingACard();
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis", version: "1.0.0", runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [{ path: "clinical-evidence-report.md", required: true }, { path: "clinical-evidence-matrix.json", required: true }],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 20,
      readSessionHistory: async () => history, readSessionStatus: async () => "idle", maxClinicalRepairAttempts: 0,
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId, dispatchId: "turn_card_citation", question: pkg.briefText,
      effectiveAgentId: "clinical-evidence-synthesis", effectiveAgentVersion: "1.0.0", effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));
    const deliverables = new Map([["clinical-evidence-report.md", pkg.reportText], ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)]]);
    for (const [relative, content] of deliverables) await writeFile(path.join(project.workspaceDir, relative), content, "utf8");
    for (const [artifactPath, content] of Object.entries(pkg.sourceArtifacts)) {
      await mkdir(path.join(project.workspaceDir, path.dirname(artifactPath)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, artifactPath), content, "utf8");
    }
    history = [{
      info: { id: "msg_card_citation", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...Object.entries(pkg.sourceArtifacts).map(([artifactPath, content]) => ({
          type: "tool", tool: "evimed-research_evimed_open_access_full_text",
          state: { status: "completed", output: JSON.stringify({ status: "success", artifacts: [artifactPath],
            data: { artifactSha256s: { [artifactPath]: createHash("sha256").update(content, "utf8").digest("hex") } } }) },
        })),
        ...[...deliverables.keys()].map((filePath) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath } } })),
        { type: "text", text: "Completed." },
      ],
    }];
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    assert.equal(finished.status, "succeeded", "advice withholds nothing");
    assert.equal(finished.errorCode, null);
    assert.ok(finished.artifacts.includes("clinical-evidence-report.md"));
    assert.equal(finished.verification ?? null, null, "a card cited is a remark on the work, not a mark on it");
    const said = noticeTexts(finished).filter((text) => text.includes(PLATFORM_CARD_CITATION_SENTENCE));
    assert.ok(said.length >= 1, noticeTexts(finished).join(" | "));
    assert.equal(new Set(said).size, said.length, "each address and line is said once, however many checks read the report");
    assert.ok(finished.qualityNotices.some((notice) => notice.check === "platform-card-citation" && notice.severity === "advice"));
    const countedOnce = citedTotal();
    assert.equal(countedOnce, new Set(said).size, "the counter holds the distinct citations");
    assert.equal(citedRuns(), 1);
    // The verdict is rebuilt whenever a run is evaluated again: the same run adds nothing.
    await store.reconcileSession(project, binding.sessionId);
    assert.equal(citedTotal(), countedOnce);
    assert.equal(citedRuns(), 1);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the counter ignores a verdict that names no citation and counts a run once", () => {
  resetPlatformContentCited();
  recordPlatformContentCited("run-a", 0);
  assert.equal(citedTotal(), 0);
  recordPlatformContentCited("run-a", 2);
  recordPlatformContentCited("run-a", 5);
  recordPlatformContentCited("run-b", 1);
  assert.equal(citedTotal(), 3);
  assert.equal(citedRuns(), 2);
  resetPlatformContentCited();
});
