import assert from "node:assert/strict";
import test from "node:test";
import { VCR_MATCHING_WRITE_WHATS, VCR_RESULT_KIND_TABS, VCR_TABS } from "@evimed/domain";
import { VCR_WRITE_WHATS } from "../src/vcrService.mjs";
import { vcrResultAddress, vcrResultEntry, vcrResultTab, withJobEntry, withWriteEntry } from "../src/vcrResultEntry.mjs";
import { vcrJobNoticeText } from "../src/vcrNotify.mjs";
import { vcrResultKindFor } from "../src/vcrJobs.mjs";

// F3 (VCR remediation 2026-11-01): the entry to a result page is built here, by the server, and handed to the model in the tool's answer.
// The model spells no address.

const PUBLIC = "https://evimed.example";
const conversation = { id: "std_conv", completionOrigin: { rootSessionId: "sess_1" } };

test("an entry is the study, the tab, the words and the absolute address built from the public address", () => {
  assert.deepEqual(vcrResultEntry({ studyId: "std_conv", tab: "matching", publicUrl: PUBLIC }), {
    studyId: "std_conv", tab: "matching", label: "在“匹配”页查看", url: "https://evimed.example/app/virtual-research/std_conv/matching" });
  assert.equal(vcrResultEntry({ studyId: "std_conv", tab: "patients", publicUrl: `${PUBLIC}/ignored/path?x=1` }).url, "https://evimed.example/app/virtual-research/std_conv/patients");
  assert.equal(vcrResultEntry({ studyId: "std_conv", tab: "trial", publicUrl: "http://127.0.0.1:5173" }).url, "http://127.0.0.1:5173/app/virtual-research/std_conv/trial");
});

test("a deployment that does not know its own address gives the words and the place, never a relative address", () => {
  for (const publicUrl of ["", null, undefined, "not a url", "ftp://evimed.example", "/app"]) {
    const entry = vcrResultEntry({ studyId: "std_conv", tab: "trial", publicUrl });
    assert.deepEqual(entry, { studyId: "std_conv", tab: "trial", label: "在“试验”页查看" }, String(publicUrl));
    assert.equal(vcrResultAddress(publicUrl, "std_conv", "trial"), null);
  }
});

test("a study or a tab the application has no page for is no entry", () => {
  for (const studyId of ["", "../x", "a/b", "x".repeat(161), null, 5]) assert.equal(vcrResultEntry({ studyId, tab: "matching", publicUrl: PUBLIC }), null, String(studyId));
  for (const tab of ["", "chat", "models", "../matching", null, "Matching"]) assert.equal(vcrResultEntry({ studyId: "std_conv", tab, publicUrl: PUBLIC }), null, String(tab));
  for (const tab of VCR_TABS) assert.ok(vcrResultEntry({ studyId: "std_conv", tab, publicUrl: PUBLIC }), tab);
});

test("a result is read on the tab of its kind, the overview for a kind the table does not name; the notice and the entry agree", () => {
  assert.equal(vcrResultTab("trial_scenario"), "trial");
  assert.equal(vcrResultTab("patient_set"), "patients");
  assert.equal(vcrResultTab("evidence_pool"), "data");
  assert.equal(vcrResultTab("model_fit"), "overview");
  for (const [kind, tab] of Object.entries(VCR_RESULT_KIND_TABS)) {
    assert.equal(vcrResultTab(kind), tab);
    // The notice that says the same computation is done opens the same tab.
    assert.equal(vcrJobNoticeText({ resultKind: kind, state: "succeeded", result: {} })?.tab ?? tab, tab, kind);
  }
  // Every job kind the model can start lands on a tab of the study page.
  for (const kind of ["generate_population", "build_cohort", "generate_patients", "design_simulation", "design_grid", "match_criteria", "accrual_forecast", "pool_evidence", "weighted_cox"]) {
    assert.ok(VCR_TABS.includes(vcrResultTab(vcrResultKindFor(kind))), kind);
  }
});

test("a job's answer carries the entry in every state it can be read in, and a refusal that started nothing does not", () => {
  for (const state of ["queued", "running", "awaiting_budget", "succeeded", "failed", "canceled"]) {
    const answer = withJobEntry({ jobId: "job_1", state }, { study: conversation, resultKind: "trial_scenario", publicUrl: PUBLIC });
    assert.equal(answer.resultEntry.tab, "trial", state);
    assert.equal(answer.resultEntry.studyId, "std_conv");
    assert.equal(answer.state, state);
  }
  const refused = { state: "not_started", reason: "no_inputs" };
  assert.equal(withJobEntry(refused, { study: conversation, resultKind: "trial_scenario", publicUrl: PUBLIC }), refused);
  const noJob = { state: "running" };
  assert.equal(withJobEntry(noJob, { study: conversation, resultKind: "trial_scenario", publicUrl: PUBLIC }), noJob);
});

test("only a conversation's call gets an entry: the programme's quiet runs and an unattributed read have nobody to give it to", () => {
  const programme = { id: "std_prog", completionOrigin: null };
  const answer = { jobId: "job_1", state: "succeeded" };
  assert.equal(withJobEntry(answer, { study: programme, resultKind: "comparator", publicUrl: PUBLIC }), answer);
  assert.equal(withJobEntry(answer, { study: { id: null, completionOrigin: {} }, resultKind: "comparator", publicUrl: PUBLIC }), answer);
  const written = { ok: true, ids: ["f1"], issues: [] };
  assert.equal(withWriteEntry("fact", written, { study: programme, publicUrl: PUBLIC }), written);
});

test("a matching write carries the entry to 匹配; a write that wrote nothing, or put nothing on that tab, does not", () => {
  for (const what of VCR_MATCHING_WRITE_WHATS) {
    const answer = withWriteEntry(what, { ok: true, ids: ["x"], issues: [] }, { study: conversation, publicUrl: PUBLIC });
    assert.equal(answer.resultEntry.tab, "matching", what);
    assert.equal(answer.resultEntry.url, "https://evimed.example/app/virtual-research/std_conv/matching");
  }
  const refused = { ok: false, ids: [], issues: [{ code: "x" }] };
  assert.equal(withWriteEntry("fact", refused, { study: conversation, publicUrl: PUBLIC }), refused);
  const population = { ok: true, ids: ["pop_1"], issues: [] };
  assert.equal(withWriteEntry("population", population, { study: conversation, publicUrl: PUBLIC }), population);
  // The writes named exist: a rename in the vocabulary of writes cannot leave one dead.
  for (const what of VCR_MATCHING_WRITE_WHATS) assert.ok(VCR_WRITE_WHATS.includes(what), what);
});
