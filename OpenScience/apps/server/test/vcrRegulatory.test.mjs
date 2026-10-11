// The regulatory-contact log (review gap G10), without a database: what a run may write through `vcr_write`, what a form may send, and
// what the package prints of the log. The rows themselves (the identical repeat, the cap, the order, deleting a study) are proven on a
// real PostgreSQL in `vcrRegulatory.integration.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalVcrDocument } from "../src/vcrDocumentExport.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { vcrReportModel } from "../src/vcrRender.mjs";
import { checkRegulatoryContact, contactsTable, reportContacts } from "../src/vcrScheduleView.mjs";
import { presentExport } from "../src/vcrViews.mjs";

const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201", dataTier: "T0", intendedUse: "exploratory", status: "active", steps: {}, budget: {}, outcomeSeal: {} };

// --- the pure part --------------------------------------------------------------------------------------------------------------------


test("a regulatory contact is checked field by field with the field named: a real date, an agency, bounded words, a short list of references", () => {
  const ok = checkRegulatoryContact({ date: "2026-08-14", agency: " NMPA-CDE ", type: "Pre-IND 沟通交流", summary: "讨论单臂加外部对照", outcome: "同意以外部对照作支持性证据",
    attachments: [" minutes.pdf ", "briefing/package.zip"] });
  assert.deepEqual(ok, { ok: true, value: { date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND 沟通交流", summary: "讨论单臂加外部对照",
    outcome: "同意以外部对照作支持性证据", attachments: ["minutes.pdf", "briefing/package.zip"] } });
  assert.deepEqual(checkRegulatoryContact({ date: "2026-08-14", agency: "FDA" }), { ok: true, value: { date: "2026-08-14", agency: "FDA", type: "", summary: "", outcome: "", attachments: [] } });
  const fields = (row) => checkRegulatoryContact(row).issues?.map((issue) => issue.field);
  assert.deepEqual(fields({ agency: "FDA" }), ["date"]);
  assert.deepEqual(fields({ date: "上个月", agency: "FDA" }), ["date"]);
  assert.deepEqual(fields({ date: "2026-02-30", agency: "FDA" }), ["date"], "a day that does not exist");
  assert.deepEqual(fields({ date: "2026-13-01", agency: "FDA" }), ["date"]);
  assert.deepEqual(fields({ date: "2026-08-14" }), ["agency"]);
  assert.deepEqual(fields({ date: "2026-08-14", agency: "x".repeat(121) }), ["agency"]);
  assert.deepEqual(fields({ date: "2026-08-14", agency: "FDA", summary: "字".repeat(4001), outcome: 5 }), ["summary", "outcome"]);
  assert.deepEqual(fields({ date: "2026-08-14", agency: "FDA", attachments: "minutes.pdf" }), ["attachments"]);
  assert.deepEqual(fields({ date: "2026-08-14", agency: "FDA", attachments: ["a", "", 7] }), ["attachments[1]", "attachments[2]"]);
  assert.deepEqual(fields({ date: "2026-08-14", agency: "FDA", attachments: Array.from({ length: 11 }, (_, index) => `f${index}`) }), ["attachments"]);
});

test("the contacts table and the report model's part carry the log as recorded", () => {
  const contacts = [{ id: "reg_2", date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND", summary: "讨论", outcome: "同意", attachments: ["a.pdf", "b.pdf"], source: "researcher", recordedAt: "2026-08-15T00:00:00.000Z" },
    { id: "reg_1", date: null, agency: "FDA", type: "", summary: "", outcome: "", attachments: [], source: "ai_set", recordedAt: "2026-08-01T00:00:00.000Z" }];
  assert.deepEqual(contactsTable(contacts).rows, [["2026-08-14", "NMPA-CDE", "Pre-IND", "讨论", "同意", "a.pdf；b.pdf"], ["—", "FDA", "—", "—", "—", "—"]]);
  assert.deepEqual(reportContacts(contacts)[0], { id: "reg_2", date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND", summary: "讨论", outcome: "同意", attachments: ["a.pdf", "b.pdf"] });
  assert.deepEqual(reportContacts(null), []);
});


// --- what a run writes -----------------------------------------------------------------------------------------------------------------

/** A store double that records what it was asked and answers the way the real one does. */
function recordingStore() {
  /** @type {any[]} */
  const calls = [];
  const store = { async addRegulatoryContact(input) { calls.push(["contact", input]); return { id: "reg_1", existing: input.agency === "FDA", ...input }; } };
  return { calls, store };
}

const write = (store, what, items) => vcrRuntimeWrite({ store, service: {}, orchestrator: null, study, what, items, data: null });


test("a regulatory contact is written as the run's own (ai_set), and a repeat of one that is already in the log says so", async () => {
  const { calls, store } = recordingStore();
  const done = await write(store, "regulatory_contact", [
    { date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND", summary: "讨论", outcome: "同意", attachments: ["minutes.pdf"] },
    { date: "2026-02-30", agency: "FDA" },
    { date: "2026-08-15", agency: "FDA", outcome: "无异议" },
    { date: "2026-08-16", mystery: 1, agency: "EMA" },
  ]);
  assert.deepEqual(done.ids, ["reg_1", "reg_1"]);
  assert.deepEqual(calls[0][1], { studyId: "std_1", userId: "u1", actor: "ai_set", date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND", summary: "讨论", outcome: "同意", attachments: ["minutes.pdf"] });
  assert.deepEqual(done.issues.map((issue) => [issue.index, issue.field, issue.code]), [[1, "date", "vcr_write_value_invalid"], [3, "mystery", "vcr_write_field_forbidden"]]);
  assert.deepEqual(done.results.map((entry) => [entry.index, entry.existing === true]), [[0, false], [2, true]]);
  assert.match(done.results[1].note, /完全相同/);
});


// --- what the package prints -----------------------------------------------------------------------------------------------------------

const REPORTING_STUDY = { id: "std_1", name: "EV-201", question: "q", dataTier: "T0", intendedUse: "exploratory" };
const CONTACTS = [{ id: "reg_1", date: "2026-08-14", agency: "NMPA-CDE", type: "Pre-IND", summary: "讨论外部对照", outcome: "同意作支持性证据", attachments: ["minutes.pdf"], source: "researcher", recordedAt: "2026-08-15T00:00:00.000Z" }];
const bundleOf = (row, more = {}) => ({ now: new Date("2026-10-10"), study: REPORTING_STUDY, exports: [row], definition: null, assumptions: [], results: [], allResults: [],
  seal: null, reviews: [], stale: [], models: [], populations: [], comparators: [], comparator: null, scenarios: [], patientSets: [], executions: new Map(), decisions: [],
  currentNodes: null, regulatory: CONTACTS, ...more });

test("the report model carries the log, and a package frozen before it existed is not changed by its being there", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, contacts: CONTACTS });
  assert.deepEqual(model.regulatoryContacts.map((entry) => entry.agency), ["NMPA-CDE"]);
  const bare = vcrReportModel({ study: REPORTING_STUDY });
  assert.deepEqual(bare.regulatoryContacts, []);

  const frozenBefore = { ...bare };
  delete frozenBefore.regulatoryContacts;
  const row = { id: "exp_1", kind: "study_package", state: "ready", createdAt: "2026-10-01T00:00:00.000Z", cover: { results: frozenBefore, reports: [{ section: "main", template: "正文。", rendered: "正文。" }] } };
  const shown = presentExport(row, bundleOf(row));
  assert.equal(shown.snapshotChanged, undefined, "adding a contact to the study since is not a change to a package built without the log");
  assert.ok(shown.document.sections.map((section) => section.id).includes("regulatory"), "an older package shows what the study has now, as it shows the decisions");
});

test("a package built with the log prints it after the decision record, and says when it moved since", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, contacts: CONTACTS });
  const row = { id: "exp_1", kind: "study_package", state: "ready", createdAt: "2026-10-01T00:00:00.000Z", cover: { results: model, reports: [{ section: "main", template: "正文。", rendered: "正文。" }] } };
  const shown = presentExport(row, bundleOf(row, { decisions: [{ id: "dec_1", question: "选哪个方案", chosen: { label: "B" }, rationale: "功效够", createdAt: "2026-09-30T00:00:00.000Z" }] }));
  assert.deepEqual(shown.document.sections.map((section) => section.id).filter((id) => ["summary", "results", "decisions", "regulatory"].includes(id)), ["summary", "results", "decisions", "regulatory"]);
  const log = shown.document.sections.find((section) => section.id === "regulatory");
  assert.equal(log.title, "监管沟通记录");
  assert.deepEqual(log.table.rows[0], ["2026-08-14", "NMPA-CDE", "Pre-IND", "讨论外部对照", "同意作支持性证据", "minutes.pdf"]);
  assert.equal(shown.snapshotChanged, undefined);
  // a contact recorded after the package froze is a change the page says
  const later = presentExport(row, bundleOf(row, { regulatory: [...CONTACTS, { ...CONTACTS[0], id: "reg_2", agency: "FDA" }] }));
  assert.equal(later.snapshotChanged, true);
});

test("the exported document ends with the log, and a package with none is unchanged", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, contacts: CONTACTS });
  const cover = { results: model, reports: [{ section: "main", template: "正文。" }] };
  const document = canonicalVcrDocument(REPORTING_STUDY, { kind: "study_package", cover });
  const { canonicalMarkdown } = document;
  assert.ok(canonicalMarkdown.indexOf("正文。") < canonicalMarkdown.indexOf("## 监管沟通记录"), "the run's words first, then the platform's table");
  assert.match(canonicalMarkdown, /\| 2026-08-14 \| NMPA-CDE \| Pre-IND \| 讨论外部对照 \| 同意作支持性证据 \| minutes\.pdf \|/);
  const bare = canonicalVcrDocument(REPORTING_STUDY, { kind: "study_package", cover: { results: vcrReportModel({ study: REPORTING_STUDY }), reports: cover.reports } });
  assert.ok(!bare.canonicalMarkdown.includes("## 监管沟通记录"));
  assert.notEqual(bare.revision, document.revision, "a package that carries the log is another document");
});
