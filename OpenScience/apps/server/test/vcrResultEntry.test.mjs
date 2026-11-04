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

test("P2-10 the two computations whose completion only the conversation heard have inbox words of their own: a reading of records and a check of a population", () => {
  const read = vcrJobNoticeText({ resultKind: "match_extract", state: "succeeded", result: { measures: [{ name: "records_read", value: 312 }], diagnostics: { remaining: 0 } } });
  assert.deepEqual([read?.title, read?.tab], ["病历阅读完成：读完 312 份病历", "matching"]);
  assert.match(String(read?.body), /匹配/);
  const stopped = vcrJobNoticeText({ resultKind: "match_extract", state: "succeeded", result: { measures: [{ name: "records_read", value: 40 }], diagnostics: { remaining: 272, canceled: true } } });
  assert.equal(stopped?.title, "病历阅读完成：读了 40 份病历，中途停下，还有 272 份没读");
  assert.equal(vcrJobNoticeText({ resultKind: "match_extract", state: "succeeded", result: { measures: [{ name: "records_read", value: 0 }] } })?.title, "病历阅读完成");
  const partly = vcrJobNoticeText({ resultKind: "match_extract", state: "succeeded", result: { measures: [{ name: "records_read", value: 40 }, { name: "records_failed", value: 2 }], diagnostics: { remaining: 0 } } });
  assert.equal(partly?.title, "病历阅读完成：读完 40 份病历，2 份没读成", "failures are said in the title, not left for the page");
  const judged = vcrJobNoticeText({ resultKind: "match_judge", state: "succeeded", result: { measures: [{ name: "pairs_finished", value: 18 }, { name: "pairs_total", value: 20 }, { name: "pairs_failed", value: 2 }] } });
  assert.deepEqual([judged?.title, judged?.tab], ["患者与试验判定完成：判定了 18/20 对，2 对没判成", "matching"]);
  const nothing = vcrJobNoticeText({ resultKind: "match_judge", state: "failed", error: { code: "insufficient_quota", message: "20 对都没有判定成" } });
  assert.match(String(nothing?.title), /^患者与试验判定没有算完/);
  const failed = vcrJobNoticeText({ resultKind: "match_extract", state: "failed", error: { code: "usage_budget_exceeded" } });
  assert.match(String(failed?.title), /^病历阅读没有算完/);
  const check = vcrJobNoticeText({ resultKind: "population_check", state: "succeeded", result: { measures: [{ name: "variables_compared", value: 6 }, { name: "variables_apart", value: 2 }] } });
  assert.deepEqual([check?.title, check?.tab], ["人群核对完成：比较了 6 个变量，2 个有差异", "population"]);
  assert.equal(vcrJobNoticeText({ resultKind: "population_check", state: "succeeded", result: { measures: [{ name: "variables_compared", value: 6 }, { name: "variables_apart", value: 0 }] } })?.title, "人群核对完成：比较了 6 个变量，都接近");
});

// 2026-11-02: a reply said an E-value of 3.0 and the page 2.22, the newest comparison of the study. The comparison tab opens on the saved
// comparison its link names; no other tab reads a name.
test("the link to the comparison tab names the saved comparison the answer is about, and no other tab names one", () => {
  const entry = vcrResultEntry({ studyId: "std_conv", tab: "comparator", publicUrl: PUBLIC, object: "cmp_3a" });
  assert.deepEqual(entry, { studyId: "std_conv", tab: "comparator", label: "在“对照”页查看", object: "cmp_3a", url: "https://evimed.example/app/virtual-research/std_conv/comparator?object=cmp_3a" });
  assert.deepEqual(vcrResultEntry({ studyId: "std_conv", tab: "comparator", publicUrl: "" , object: "cmp_3a" }), { studyId: "std_conv", tab: "comparator", label: "在“对照”页查看", object: "cmp_3a" });
  assert.equal(vcrResultEntry({ studyId: "std_conv", tab: "trial", publicUrl: PUBLIC, object: "scn_1" }).url, "https://evimed.example/app/virtual-research/std_conv/trial");
  for (const object of ["", "../x", "a/b", "x".repeat(161), null, 5]) assert.equal(vcrResultEntry({ studyId: "std_conv", tab: "comparator", publicUrl: PUBLIC, object }).url, "https://evimed.example/app/virtual-research/std_conv/comparator", String(object));
  // a start's answer names the comparison it filed the job under; a status answer is given the job's own record of it
  const started = { jobId: "job_1", state: "queued", subject: { kind: "comparator", id: "cmp_3a", version: 1 } };
  assert.equal(withJobEntry(started, { study: conversation, resultKind: "comparator", publicUrl: PUBLIC }).resultEntry.object, "cmp_3a");
  assert.equal(withJobEntry({ jobId: "job_1", state: "succeeded" }, { study: conversation, resultKind: "comparator", publicUrl: PUBLIC, object: "cmp_9" }).resultEntry.url,
    "https://evimed.example/app/virtual-research/std_conv/comparator?object=cmp_9");
  assert.equal(withJobEntry({ jobId: "job_1", state: "queued" }, { study: conversation, resultKind: "comparator", publicUrl: PUBLIC }).resultEntry.object, undefined);
});
