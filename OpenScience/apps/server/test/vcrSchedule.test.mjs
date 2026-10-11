// The schedule of activities (review gap G10), without a database: what a run may write through `vcr_write`, what the runtime reads
// back, how a virtual patient's visit times are taken from the schedule, and what the package prints of it. The rows themselves
// (replacing a visit, carrying the schedule to a new protocol version, the cap) are proven on a real PostgreSQL in
// `vcrSchedule.integration.test.mjs`.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { canonicalVcrDocument } from "../src/vcrDocumentExport.mjs";
import { createVcrGatewayHandler, vcrRuntimeWrite } from "../src/vcrGateway.mjs";
import { renderVcrNumbers, vcrReportModel } from "../src/vcrRender.mjs";
import { markdownTable, readSchedule, reportSchedule, resolveVisitsRef, scheduleTable, visitsFromRows } from "../src/vcrScheduleView.mjs";
import { HttpError } from "../src/security.mjs";
import { VcrService } from "../src/vcrService.mjs";
import { presentExport } from "../src/vcrViews.mjs";


const visit = (name, day, activities, windowDays = null, note = "") =>
  ({ visit: name, day, windowDays, note, procedures: activities.map((entry) => (typeof entry === "string" ? { name: entry, note: "" } : entry)) });

const SCHEDULE = {
  protocol: { id: "prt_2", version: 2, title: "EV-201" },
  visits: [
    visit("筛选期", -14, ["知情同意", "血常规"], 7),
    visit("基线", 1, ["体格检查", "血常规"], 0, "首次给药当天"),
    visit("第 2 周", 15, ["血常规"], 3),
    visit("第 4 周", 29, ["血常规", { name: "肿瘤评估", note: "RECIST 1.1" }], 3),
    visit("第 8 周", 57, ["血常规", "肿瘤评估"], 3),
    visit("治疗结束", null, ["体格检查"]),
  ],
};

const study = { id: "std_1", userId: "u1", projectId: "prj_1", name: "EV-201", dataTier: "T0", intendedUse: "exploratory", status: "active", steps: {}, budget: {}, outcomeSeal: {} };


// --- the pure part --------------------------------------------------------------------------------------------------------------------

test("flat rows are read back as visits by day, an undated visit last, each visit's activities in the order they were written", () => {
  const row = (ordinal, position, visitName, day, procedure, extra = {}) => ({ ordinal, position, visit: visitName, day, window_days: 3, procedure, note: "", visit_note: "", ...extra });
  const visits = visitsFromRows([
    row(2, 1, "第 4 周", "29", "肿瘤评估", { note: "RECIST" }), row(0, 0, "筛选期", "-14", "知情同意"), row(2, 0, "第 4 周", "29", "血常规"),
    row(3, 0, "治疗结束", null, "体格检查", { window_days: null }), row(1, 0, "基线", "1", "体格检查", { visit_note: "首次给药" }),
    row(4, 0, "第 2 周", "15", "血常规"),
  ]);
  assert.deepEqual(visits.map((entry) => entry.visit), ["筛选期", "基线", "第 2 周", "第 4 周", "治疗结束"], "by day, the undated one last — not by the order they were written");
  assert.deepEqual(visits.find((entry) => entry.visit === "第 4 周"), { visit: "第 4 周", day: 29, windowDays: 3, note: "", procedures: [{ name: "血常规", note: "" }, { name: "肿瘤评估", note: "RECIST" }] });
  assert.equal(visits[1].note, "首次给药");
  assert.equal(visits[4].day, null);
  assert.deepEqual(visitsFromRows([]), []);
});

test("a schedule is a table of strings, and a markdown table that holds a pipe and a line break in a cell", () => {
  const table = scheduleTable(SCHEDULE.visits);
  assert.deepEqual(table.columns, ["访视", "计划日", "窗口", "评估与操作"]);
  assert.deepEqual(table.rows[1], ["基线", "第 1 天", "±0 天", "体格检查、血常规；备注：首次给药当天"]);
  assert.deepEqual(table.rows[3], ["第 4 周", "第 29 天", "±3 天", "血常规、肿瘤评估（RECIST 1.1）"]);
  assert.deepEqual(table.rows[5], ["治疗结束", "—", "—", "体格检查"]);
  const markdown = markdownTable({ columns: ["访视", "说明"], rows: [["a|b", "第一行\n第二行"]] });
  assert.equal(markdown, "| 访视 | 说明 |\n| --- | --- |\n| a\\|b | 第一行 第二行 |");
});

test("the part of the report model a schedule is carries what it adds up to, and none at all when the study has none", () => {
  assert.equal(reportSchedule(null), null);
  assert.equal(reportSchedule({ protocol: SCHEDULE.protocol, visits: [] }), null);
  const part = reportSchedule(SCHEDULE);
  assert.equal(part.protocolVersion, 2);
  assert.deepEqual(part.totals, { visits: 6, activities: 4, entries: 10, firstDay: -14, lastDay: 57 });
  assert.equal(part.visits.length, 6);
});

test("what the runtime reads of a schedule says which times a trajectory would take, and from which baseline", () => {
  const read = readSchedule(SCHEDULE);
  assert.deepEqual(read.protocol, SCHEDULE.protocol);
  assert.equal(read.visitTimes.baselineDay, 1, "the first visit on or after day 0");
  assert.deepEqual(read.visitTimes.days, [0, 14, 28, 56]);
  assert.deepEqual(read.visitTimes.weeks, [0, 2, 4, 8]);
  assert.deepEqual(read.visitTimes.months, [0, 0.46, 0.9199, 1.8398]);
  assert.equal(readSchedule({ protocol: null, visits: [] }).visitTimes, null);
  assert.equal(readSchedule({ protocol: null, visits: [] }).totals.visits, 0);
});

test("where a scenario takes visit times, the schedule may be named; a list is left alone and a wrong naming is refused", async () => {
  const schedule = async () => SCHEDULE;
  const none = async () => null;
  assert.deepEqual(await resolveVisitsRef({ visits: [0, 3, 6] }, none), { ok: true, scenario: { visits: [0, 3, 6] } });
  assert.deepEqual(await resolveVisitsRef({ design: {} }, none), { ok: true, scenario: { design: {} } });
  const named = await resolveVisitsRef({ design: { nTreat: 60 }, visits: { fromSoa: true, unit: "weeks" } }, schedule);
  assert.deepEqual(named, { ok: true, scenario: { design: { nTreat: 60 }, visits: [0, 2, 4, 8] }, timeUnit: { unit: "weeks", basis: "stated" } });
  // The module's one unit rule (vcrTimeUnits): any spelling of a unit in the table is that unit, and a reference naming none is read in
  // months and says so -- never refused for it. Only a unit outside the table, which cannot carry a schedule's days, is.
  assert.deepEqual(await resolveVisitsRef({ visits: { fromSoa: true, unit: "周" } }, schedule),
    { ok: true, scenario: { visits: [0, 2, 4, 8] }, timeUnit: { unit: "weeks", basis: "stated" } });
  for (const unstated of [{ fromSoa: true }, { fromSoa: true, unit: null }, { fromSoa: true, unit: " " }]) {
    assert.deepEqual(await resolveVisitsRef({ visits: unstated }, schedule),
      { ok: true, scenario: { visits: [0, 0.46, 0.9199, 1.8398] }, timeUnit: { unit: "months", basis: "assumed" } }, JSON.stringify(unstated));
  }
  for (const [visits, reader, expected] of [
    [{ fromSoa: true, unit: "fortnights" }, schedule, /unit 写 days、weeks、months、years/],
    [{ fromSoa: true, unit: 2 }, schedule, /unit 写/],
    [{ fromSoa: true, unit: "weeks" }, none, /还没有访视日程/],
    [{ fromSoa: true, unit: "weeks" }, async () => ({ visits: [visit("a", 0, ["x"])] }), /不足两个/],
    [{ fromSoa: false, unit: "weeks" }, schedule, /"fromSoa": true/],
    [{ fromSoa: true, unit: "weeks", extra: 1 }, schedule, /"fromSoa": true/],
    ["schedule", schedule, /"fromSoa": true/],
  ]) {
    const refused = await resolveVisitsRef({ visits }, reader);
    assert.equal(refused.ok, false, JSON.stringify(visits));
    assert.match(refused.message, expected, JSON.stringify(visits));
  }
});


// --- what a run writes -----------------------------------------------------------------------------------------------------------------

/** A store double that records what it was asked and answers the way the real one does. @param {Record<string, any>} [overrides] */
function recordingStore(overrides = {}) {
  /** @type {any[]} */
  const calls = [];
  const store = {
    async latestProtocolVersion() { return { id: "prt_2", version: 2, title: "EV-201" }; },
    async saveScheduleVisits(input) {
      calls.push(["soa", input]);
      return input.visits.map((entry, index) => ({ visit: entry.visit, id: entry.remove ? null : `soa_${index}`, activities: entry.procedures.length,
        replaced: entry.visit === "基线", removed: entry.remove === true && entry.visit === "基线" }));
    },
    async latestSchedule() { return SCHEDULE; },
    ...overrides,
  };
  return { calls, store };
}

const write = (store, what, items) => vcrRuntimeWrite({ store, service: {}, orchestrator: null, study, what, items, data: null });

test("a visit is written to the protocol's current version, its words trimmed and each activity a name or a name with a note", async () => {
  const { calls, store } = recordingStore();
  const done = await write(store, "soa", [{ visit: "  基线 ", day: 1, windowDays: 0, note: " 首次给药当天 ", procedures: ["体格检查", " 血常规 ", { name: "ECG", note: " 12 导联 " }] }]);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.ids, ["soa_0"]);
  assert.deepEqual(done.issues, []);
  assert.deepEqual(calls[0][1], { studyId: "std_1", userId: "u1", protocolVersionId: "prt_2", actor: "ai_set", visits: [
    { visit: "基线", day: 1, windowDays: 0, note: "首次给药当天", remove: false,
      procedures: [{ name: "体格检查", note: "" }, { name: "血常规", note: "" }, { name: "ECG", note: "12 导联" }] }] });
  assert.deepEqual(done.results, [{ index: 0, visit: "基线", activities: 3, replaced: true, protocolVersion: 2 }], "the run is told that this visit replaced one");
});

test("a visit with no planned day is written with none, and nothing is made up for it", async () => {
  const { calls, store } = recordingStore();
  const done = await write(store, "soa", [{ visit: "提前终止", procedures: ["不良事件评估"] }, { visit: "随访", day: null, windowDays: null, procedures: ["电话随访"] }]);
  assert.deepEqual(done.ids.length, 2);
  assert.deepEqual(calls.map((call) => [call[1].visits[0].day, call[1].visits[0].windowDays]), [[null, null], [null, null]]);
});

test("a visit that fails is refused alone with the field named; the others are written", async () => {
  const { calls, store } = recordingStore();
  const done = await write(store, "soa", [
    { visit: "第 2 周", day: 15, procedures: ["血常规"] },
    { visit: "第 4 周", day: "29", procedures: ["血常规"] },
    { visit: "第 6 周", day: 43, mystery: 1, procedures: ["血常规"] },
    { visit: "第 8 周", day: 57, procedures: ["血常规", "肿瘤评估", "血常规"] },
    { visit: "第 12 周", day: 85 },
    { visit: "第 16 周", day: 113, procedures: [] },
    { visit: "第 20 周", day: 141, windowDays: -1, procedures: [7, { name: "x", extra: 1 }, { name: "" }] },
    { day: 169, procedures: ["血常规"] },
    { visit: "第 24 周", day: 169, procedures: ["血常规"] },
  ]);
  assert.deepEqual(done.ids, ["soa_0", "soa_0"], "the first and the last visit; each call wrote one visit");
  assert.equal(calls.length, 2);
  const at = (index) => done.issues.filter((issue) => issue.index === index).map((issue) => [issue.field, issue.code]);
  assert.deepEqual(at(1), [["day", "vcr_write_value_invalid"]]);
  assert.deepEqual(at(2), [["mystery", "vcr_write_field_forbidden"]]);
  assert.deepEqual(at(3), [["procedures[2]", "vcr_write_value_invalid"]], "an activity written twice is refused, not made one");
  assert.match(done.issues.find((issue) => issue.index === 3).message, /血常规.*procedures\[0\]/);
  assert.deepEqual(at(4), [["procedures", "vcr_write_value_invalid"]]);
  assert.deepEqual(at(5), [["procedures", "vcr_write_value_invalid"]]);
  assert.deepEqual(at(6), [["windowDays", "vcr_write_value_invalid"], ["procedures[0]", "vcr_write_value_invalid"], ["procedures[1].extra", "vcr_write_value_invalid"], ["procedures[2].name", "vcr_write_value_invalid"]]);
  assert.deepEqual(at(7), [["visit", "vcr_write_value_invalid"]]);
});

test("an engine output cannot be written into a schedule, at any depth", async () => {
  const { calls, store } = recordingStore();
  const done = await write(store, "soa", [{ visit: "基线", day: 1, procedures: [{ name: "血常规", note: "x" }], measures: [] }, { visit: "第 2 周", procedures: [{ name: "血常规", results: 1 }] }]);
  assert.equal(done.ok, false);
  assert.deepEqual(done.issues.map((issue) => [issue.index, issue.code]), [[0, "vcr_write_field_forbidden"], [1, "vcr_write_field_forbidden"]]);
  assert.equal(calls.length, 0);
});

test("a schedule needs a protocol version to belong to: without one the visit is refused in a sentence that says what to write first", async () => {
  const { calls, store } = recordingStore({ async latestProtocolVersion() { return null; } });
  const done = await write(store, "soa", [{ visit: "基线", day: 1, procedures: ["血常规"] }]);
  assert.equal(done.ok, false);
  assert.equal(done.issues[0].code, "vcr_write_refused");
  assert.match(done.issues[0].message, /what: protocol/);
  assert.equal(calls.length, 0);
});

test("remove takes a visit out, alone: with other fields it is refused, and a visit the schedule does not have is said so", async () => {
  const { calls, store } = recordingStore();
  const done = await write(store, "soa", [{ visit: "基线", remove: true }, { visit: "第 9 周", remove: true }, { visit: "第 2 周", remove: true, day: 15 }, { visit: "第 3 周", remove: "yes" }]);
  assert.deepEqual(done.ids, ["prt_2"], "the object edited is the protocol version's schedule");
  assert.deepEqual(done.results, [{ index: 0, visit: "基线", removed: true, protocolVersion: 2 }]);
  assert.deepEqual(done.issues.map((issue) => [issue.index, issue.field]), [[1, "visit"], [2, "day"], [3, "remove"], [3, "procedures"]],
    "a remove that is not true is read as a visit to write, and a visit to write needs its activities");
  assert.match(done.issues[0].message, /没有「第 9 周」/);
  assert.equal(calls.length, 2, "the refused ones never reached the store");
});

test("what the store refuses underneath is one item's issue; the others stand", async () => {
  const { store } = recordingStore({
    async saveScheduleVisits(input) {
      if (input.visits[0].visit === "满") throw new HttpError(409, "vcr_write_refused", "方案的一个版本最多写 80 次访视。");
      return [{ visit: input.visits[0].visit, id: "soa_1", activities: 1, replaced: false, removed: false }];
    },
  });
  const done = await write(store, "soa", [{ visit: "满", day: 1, procedures: ["a"] }, { visit: "第 2 周", day: 15, procedures: ["a"] }]);
  assert.deepEqual(done.ids, ["soa_1"]);
  assert.deepEqual(done.issues.map((issue) => [issue.index, issue.code, issue.message]), [[0, "vcr_write_refused", "方案的一个版本最多写 80 次访视。"]]);
});


// --- virtual patients read the schedule -------------------------------------------------------------------------------------------------

const config = { vcrEnabled: true, vcrAudience: "all", modelGatewayInternalUrl: "http://127.0.0.1:8788/internal/models/v1" };
const runtimeManager = { assertActiveModelGatewayToken: (/** @type {string} */ token) => {
  if (token !== "token") throw new Error("bad token");
  return { userId: "u1", projectId: "prj_1" };
} };

/** @param {Record<string, any>} storeOverrides */
function gateway(storeOverrides = {}) {
  /** @type {any[]} */
  const saved = [];
  /** @type {any[]} */
  const queued = [];
  const boundary = new VcrService({ store: /** @type {any} */ ({}), config: {} });
  const store = {
    async studyByControlProject() { return study; },
    async latestSchedule() { return SCHEDULE; },
    async savePatientSet(input) { saved.push(input); return { id: "pts_1", version: 1 }; },
    async patientSets() { return [{ id: "pts_1", version: 1, name: "虚拟患者" }]; },
    async models() { return []; },
    ...storeOverrides,
  };
  const jobs = {
    async enqueue(input) { queued.push(input); return { job: { id: "job_1", kind: input.kind, state: "queued", progress: {} }, created: true }; },
    async get() { return null; }, async cancel() { return { job: { id: "job_1", state: "canceled" }, canceled: true }; },
  };
  const service = { allows: () => true, counters: { reads: 0, writes: 0, writeIssues: 0 }, forModel: (/** @type {unknown} */ payload) => boundary.forModel(payload) };
  const handler = createVcrGatewayHandler(config, runtimeManager, { vcr: { service, store, jobs, orchestrator: null } });
  const send = async (/** @type {string} */ operation, /** @type {unknown} */ body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", url: `/internal/vcr/v1/${operation}`, headers: { authorization: "Bearer token" } });
    const res = { status: 0, body: "", writeHead(/** @type {number} */ code) { this.status = code; return this; }, end(/** @type {string} */ chunk = "") { this.body = String(chunk); }, json() { return JSON.parse(this.body); } };
    await handler(req, res, () => {});
    return res;
  };
  return { saved, queued, send };
}

const TRAJECTORY = { design: { nTreat: 150, nControl: 150 }, endpoint: { type: "continuous" }, truth: { effect: -0.2, intercept: 50, slope: -0.4, sd: 3 } };

test("a patient set whose trajectory takes the protocol's schedule has the visit times written in, in the unit it names or in months", async () => {
  const { saved, send } = gateway();
  const res = await send("write", { what: "patient_set", items: [
    { name: "按日程", scenario: { ...TRAJECTORY, visits: { fromSoa: true, unit: "weeks" } } },
    { name: "手写", scenario: { ...TRAJECTORY, visits: [0, 3, 6] } },
    { name: "没写单位", scenario: { ...TRAJECTORY, visits: { fromSoa: true } } },
    { name: "表外单位", scenario: { ...TRAJECTORY, visits: { fromSoa: true, unit: "cycles" } } },
  ] });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json().data.ids.length, 3);
  assert.deepEqual(saved.map((entry) => entry.scenario.visits), [[0, 2, 4, 8], [0, 3, 6], [0, 0.46, 0.9199, 1.8398]],
    "the stored scenario carries numbers, as the engine's schema reads them; an unstated unit is months");
  // The run is told which unit the schedule's days were read in, and that months was assumed where it named none.
  assert.deepEqual(res.json().data.results, [
    { index: 0, visitTimes: { unit: "weeks", basis: "stated", times: [0, 2, 4, 8] } },
    { index: 2, visitTimes: { unit: "months", basis: "assumed", times: [0, 0.46, 0.9199, 1.8398] } },
  ]);
  assert.deepEqual(res.json().data.issues.map((issue) => [issue.index, issue.field]), [[3, "scenario.visits"]]);
  assert.match(res.json().data.issues[0].message, /unit 写/);
});

test("a patient set cannot take a schedule the study does not have; the refusal says what to write", async () => {
  const { saved, send } = gateway({ async latestSchedule() { return { protocol: { id: "prt_2", version: 2, title: "" }, visits: [] }; } });
  const res = await send("write", { what: "patient_set", items: [{ name: "按日程", scenario: { ...TRAJECTORY, visits: { fromSoa: true, unit: "months" } } }] });
  assert.equal(res.json().data.ok, false);
  assert.match(res.json().data.issues[0].message, /what: soa/);
  assert.equal(saved.length, 0);
});

test("a trajectory started with the schedule's visit times is frozen with the numbers, and refused by name when the schedule cannot give them", async () => {
  const { queued, send } = gateway();
  const started = await send("simulate", { action: "start", kind: "generate_patients_longitudinal", subjectId: "pts_1", scenario: { ...TRAJECTORY, visits: { fromSoa: true, unit: "days" } } });
  assert.equal(started.status, 200, started.body);
  assert.deepEqual(queued[0].scenario.visits, [0, 14, 28, 56]);
  assert.equal(queued[0].detail.subjectId, "pts_1");
  assert.deepEqual(queued[0].detail.timeUnitBasis, { unit: "days", basis: "stated" }, "the result says the unit its times are in");
  assert.deepEqual(started.json().data.notes, { visitTimes: { unit: "days", basis: "stated", times: [0, 14, 28, 56] } });
  // The same request with a list is the same job (the idempotency key reads the numbers, not the way they were asked for).
  const again = await send("simulate", { action: "start", kind: "generate_patients_longitudinal", subjectId: "pts_1", scenario: { ...TRAJECTORY, visits: [0, 14, 28, 56] } });
  assert.equal(again.status, 200);
  assert.equal(queued[1].idempotencyKey, queued[0].idempotencyKey);

  // A trajectory that names no unit is read in months and says so, where the run and the result page read it.
  const unstated = await send("simulate", { action: "start", kind: "generate_patients_longitudinal", subjectId: "pts_1", scenario: { ...TRAJECTORY, visits: { fromSoa: true } } });
  assert.equal(unstated.status, 200, unstated.body);
  assert.deepEqual(queued[2].scenario.visits, [0, 0.46, 0.9199, 1.8398]);
  assert.deepEqual(queued[2].detail.timeUnitBasis, { unit: "months", basis: "assumed" });
  assert.equal(unstated.json().data.notes.visitTimes.basis, "assumed");

  const lonely = gateway({ async latestSchedule() { return null; } });
  const refused = await lonely.send("simulate", { action: "start", kind: "generate_patients_longitudinal", subjectId: "pts_1", scenario: { ...TRAJECTORY, visits: { fromSoa: true, unit: "days" } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json().code, "vcr_simulate_payload_invalid");
  assert.match(refused.json().error, /还没有访视日程/);
  assert.equal(lonely.queued.length, 0);
});


// --- what the package prints -----------------------------------------------------------------------------------------------------------

const REPORTING_STUDY = { id: "std_1", name: "EV-201", question: "q", dataTier: "T0", intendedUse: "exploratory" };
const bundleOf = (row, more = {}) => ({ now: new Date("2026-10-10"), study: REPORTING_STUDY, exports: [row], definition: null, assumptions: [], results: [], allResults: [],
  seal: null, reviews: [], stale: [], models: [], populations: [], comparators: [], comparator: null, scenarios: [], patientSets: [], executions: new Map(), decisions: [],
  currentNodes: null, schedule: SCHEDULE, ...more });

test("the report model carries the schedule, and a package frozen before it existed is not changed by its being there", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, schedule: SCHEDULE });
  assert.equal(model.schedule.totals.visits, 6);
  assert.equal(vcrReportModel({ study: REPORTING_STUDY }).schedule, null);

  const frozenBefore = { ...vcrReportModel({ study: REPORTING_STUDY }) };
  delete frozenBefore.schedule;
  const row = { id: "exp_1", kind: "study_package", state: "ready", createdAt: "2026-10-01T00:00:00.000Z", cover: { results: frozenBefore, reports: [{ section: "main", template: "正文。", rendered: "正文。" }] } };
  const shown = presentExport(row, bundleOf(row));
  assert.equal(shown.snapshotChanged, undefined, "adding a schedule to the study since is not a change to a package built without one");
  assert.ok(shown.document.sections.map((section) => section.id).includes("schedule"), "an older package shows what the study has now, as it shows the decisions");
});

test("a template may bind a number to the schedule, as the package skill says: the count of visits and the day of one of them", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, schedule: SCHEDULE });
  const rendered = renderVcrNumbers("日程共 {{n:schedule.totals.visits|int}} 次访视，第四次在第 {{n:schedule.visits[3].day|int}} 天。", model);
  assert.equal(rendered.text, "日程共 6 次访视，第四次在第 29 天。");
  assert.deepEqual(rendered.issues, [], "both references resolved");
  const bare = renderVcrNumbers("日程共 {{n:schedule.totals.visits|int}} 次访视。", vcrReportModel({ study: REPORTING_STUDY }));
  assert.match(bare.text, /未计算/, "a study with no schedule has no count to print, and the report says so rather than printing zero");
});

test("a package built with the schedule prints it after the summary, and says when it moved since", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, schedule: SCHEDULE });
  const row = { id: "exp_1", kind: "study_package", state: "ready", createdAt: "2026-10-01T00:00:00.000Z", cover: { results: model, reports: [{ section: "main", template: "正文。", rendered: "正文。" }] } };
  const shown = presentExport(row, bundleOf(row, { decisions: [{ id: "dec_1", question: "选哪个方案", chosen: { label: "B" }, rationale: "功效够", createdAt: "2026-09-30T00:00:00.000Z" }] }));
  assert.deepEqual(shown.document.sections.map((section) => section.id).filter((id) => ["summary", "schedule", "results", "decisions"].includes(id)), ["summary", "schedule", "results", "decisions"]);
  const schedule = shown.document.sections.find((section) => section.id === "schedule");
  assert.equal(schedule.title, "访视日程");
  assert.deepEqual(schedule.table.rows[3], ["第 4 周", "第 29 天", "±3 天", "血常规、肿瘤评估（RECIST 1.1）"]);
  assert.equal(shown.snapshotChanged, undefined);
  // a visit written after the package froze is a change the page says
  const later = presentExport(row, bundleOf(row, { schedule: { ...SCHEDULE, visits: [...SCHEDULE.visits, visit("第 12 周", 85, ["血常规"], 3)] } }));
  assert.equal(later.snapshotChanged, true);
});

test("the exported document ends with the schedule table, and a package with none is unchanged", () => {
  const model = vcrReportModel({ study: REPORTING_STUDY, schedule: SCHEDULE });
  const cover = { results: model, reports: [{ section: "main", template: "正文。" }] };
  const document = canonicalVcrDocument(REPORTING_STUDY, { kind: "study_package", cover });
  const { canonicalMarkdown } = document;
  assert.ok(canonicalMarkdown.indexOf("正文。") < canonicalMarkdown.indexOf("## 访视日程"), "the run's words first, then the platform's table");
  assert.match(canonicalMarkdown, /\| 第 4 周 \| 第 29 天 \| ±3 天 \| 血常规、肿瘤评估（RECIST 1.1） \|/);
  const bare = canonicalVcrDocument(REPORTING_STUDY, { kind: "study_package", cover: { results: vcrReportModel({ study: REPORTING_STUDY }), reports: cover.reports } });
  assert.ok(!bare.canonicalMarkdown.includes("## 访视日程"));
  assert.notEqual(bare.revision, document.revision, "a package that carries it is another document");
});
