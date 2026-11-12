// Who reads what of a saved judgment, in the real hosted app over HTTP: a viewer sees verdicts and aggregates, not reasons or sentences; a member with no grant on the source gets the row with those
// removed and a note saying so; exact small counts are the owner's; the export follows the same judgment. And a document deleted or a person withdrawn leaves nothing of theirs on the page or in a file.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { seedJudged } from "./helpers/vcrJudgedSeed.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = Math.random().toString(36).slice(2, 8);
const PASSWORD = "test-only-vcr-password";
const accounts = { owner: `own${suffix}`, datamanager: `dm${suffix}`, lead2: `lead${suffix}`, viewer: `view${suffix}`, granted: `grant${suffix}` };
let context, isolated, seeded;
const SENTENCE = "2025年3月确诊肺腺癌";

async function call(who, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[who], body: body === undefined ? undefined : JSON.stringify(body) });
  const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, body: parsed, text };
}

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "s9access");
  const dataDir = await mkdtemp(path.join(tmpdir(), "vcr-s9-access-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url,
    operatorMetricsToken: "test-only-metrics-token", rateLimitMaxRequests: 100000, authRateLimitMaxRequests: 1000, vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3600000, vcrDataPlaneDir: plane,
    vcrStartStudy: async () => ({ accepted: true }), vcrDispatchRun: async () => ({ runId: "run_1", sessionId: "session_1", status: "running" }) });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const sessions = {};
  for (const [name, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const answer = await login.json();
    sessions[name] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": answer.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
  seeded = await seedJudged({ app, call, owner: accounts.owner });
  for (const [who, role] of [["datamanager", "data_manager"], ["lead2", "lead"], ["viewer", "viewer"], ["granted", "lead"]]) {
    const added = await call("owner", "POST", `/api/vcr/studies/${seeded.study.id}/members`, { userId: accounts[who], role });
    assert.equal(added.status, 201, added.text);
  }
  const source = (await app.vcr.dataStore.getSourceFile(seeded.study.id, seeded.document)).sourceId;
  await app.vcr.dataPlane.createGrant({ userId: accounts.owner, actor: accounts.owner, studyId: seeded.study.id, sourceId: source, grantee: accounts.granted, fields: [], fieldMode: "allow", purposes: [] });
});
after(async () => { if (context) { await context.app.close(); await rm(context.dataDir, { recursive: true, force: true }); } await isolated?.drop(); });

const judged = (who, query) => call(who, "GET", `/api/vcr/studies/${seeded.study.id}/matching/judged?${query}`);

test("B5: a viewer reads verdicts, not reasons, groups, summaries or sentences", options, async () => {
  const person = await judged("viewer", `direction=patient_to_trial&subjectKey=${seeded.patient}`);
  assert.equal(person.status, 200, person.text);
  const data = person.body.data;
  assert.ok(data.trials.length > 0, "the verdicts are there");
  assert.ok(data.trials.every((row) => typeof row.verdict === "string"));
  assert.ok(!person.text.includes("肺腺癌，ECOG"), "no reason repeats the record");
  assert.ok(!person.text.includes("62 岁"));
  assert.ok(!person.text.includes(SENTENCE));
  assert.equal(data.selected.summary, null);
  assert.deepEqual(data.selected.groups, {});
  assert.deepEqual(data.selected.clauses, [], "a clause row is a fact about one person: a viewer has the verdict and no clause");
  assert.match(data.selected.reasonsWithheld, /角色/u);
  for (const row of data.trials) assert.ok(!/确诊|岁|ECOG/u.test(String(row.why)), row.why);
});

test("B5: a member who may read patient-level data but holds no grant on the source gets the row with reasons and sentences removed, and a plain note", options, async () => {
  const documentRead = await call("lead2", "GET", `/api/vcr/studies/${seeded.study.id}/data/documents/${seeded.document}`);
  assert.equal(documentRead.status, 403, documentRead.text);
  const person = await judged("lead2", `direction=patient_to_trial&subjectKey=${seeded.patient}`);
  assert.equal(person.status, 200);
  const selected = person.body.data.selected;
  assert.ok(!person.text.includes(SENTENCE), "the sentence");
  assert.ok(!person.text.includes("62 岁"), "the reason");
  assert.deepEqual(selected.groups, {});
  assert.ok(selected.clauses.every((clause) => clause.reason === "" && clause.evidence.length === 0));
  assert.match(selected.reasonsWithheld, /授权/u);
});

test("B5: the export follows the same judgment, and says what it left out", options, async () => {
  const file = await call("lead2", "GET", `/api/vcr/studies/${seeded.study.id}/matching/export?direction=patient_to_trial&subjectKey=${seeded.patient}&kind=clauses&format=csv`);
  assert.equal(file.status, 200);
  assert.ok(!file.text.includes(SENTENCE), "the sentence");
  assert.ok(!file.text.includes("62 岁"), "the reason");
  assert.match(file.text, /授权/u, "the file says why the columns are empty");
  const pairs = await call("lead2", "GET", `/api/vcr/studies/${seeded.study.id}/matching/export?direction=patient_to_trial&subjectKey=${seeded.patient}&kind=pairs&format=json`);
  assert.equal(pairs.status, 200);
  assert.ok(!pairs.text.includes("确诊"), pairs.text.slice(0, 300));
  const viewer = await call("viewer", "GET", `/api/vcr/studies/${seeded.study.id}/matching/export?direction=patient_to_trial&subjectKey=${seeded.patient}&kind=clauses&format=csv`);
  assert.equal(viewer.status, 403, "a viewer has no export at all");
});

test("B5: a member with the grant reads the reasons and the sentences; exact small counts stay the owner's", options, async () => {
  const route = `direction=trial_to_patient&protocolVersionId=${seeded.protocolId}&limit=100`;
  const granted = await judged("granted", `direction=patient_to_trial&subjectKey=${seeded.patient}`);
  assert.ok(granted.text.includes(SENTENCE), "a grant opens the sentence");
  assert.equal(granted.body.data.selected.reasonsWithheld, undefined);

  const owner = await judged("owner", route);
  const small = owner.body.data.clauses.rows.find((row) => row.against >= 1 && row.against < 5);
  assert.ok(small, "the seeded funnel has a small cell for the owner to read");
  const smallTally = Object.entries(owner.body.data.tallies).find(([, value]) => value >= 1 && value < 5);
  assert.ok(smallTally, "and a small tally");

  for (const who of ["viewer", "lead2", "granted"]) {
    const read = await judged(who, route);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.data.tallies[smallTally[0]], null, `${who}: a small tally is hidden`);
    const row = read.body.data.clauses.rows.find((entry) => entry.number === small.number);
    assert.equal(row.against, null, `${who}: a small cell of the funnel is hidden`);
    assert.ok(row.clause, "the clause itself stays");
    for (const value of Object.values(read.body.data.tallies).filter((entry) => typeof entry === "number")) assert.ok(value === 0 || value >= 10, `${who}: ${value}`);
  }
  const viewer = await judged("viewer", route);
  assert.ok(viewer.body.data.people.every((row) => owner.body.data.tallies[row.verdict] >= 5), "a viewer's list leaves out the groups too small to show");
});

test("asking for a person by key does not open one in a group too small to show, and what is opened for a viewer has no clause", options, async () => {
  const route = `direction=trial_to_patient&protocolVersionId=${seeded.protocolId}&limit=100`;
  const owner = await judged("owner", route);
  const smallVerdict = Object.entries(owner.body.data.tallies).find(([, value]) => value >= 1 && value < 5)[0];
  const largeVerdict = Object.entries(owner.body.data.tallies).find(([, value]) => value >= 10)?.[0];
  const small = owner.body.data.people.find((row) => row.verdict === smallVerdict);
  const hidden = await judged("viewer", `${route}&subjectKey=${small.subjectKey}`);
  assert.equal(hidden.body.data.selected, null, "a person in a small group is not opened by key");
  assert.ok(!hidden.text.includes(small.subjectKey) || hidden.body.data.people.every((row) => row.subjectKey !== small.subjectKey));
  if (largeVerdict) {
    const large = owner.body.data.people.find((row) => row.verdict === largeVerdict);
    const shown = await judged("viewer", `${route}&subjectKey=${large.subjectKey}`);
    assert.equal(shown.body.data.selected.verdict, largeVerdict);
    assert.deepEqual(shown.body.data.selected.clauses, []);
  }
});


test("B2: a row that survived with a sentence whose record has since changed is not printed, on the page or in the export, and the row says so", options, async () => {
  const vcr = context.app.vcr;
  const plane = vcr.dataPlane;
  const source = await plane.registerSource({ userId: accounts.owner, studyId: seeded.study.id, name: "别的病历" });
  const text = "患者王五，身份证号 110101199003078888，肌酐 9.9。";
  const up = await plane.storeUpload({ actor: accounts.owner, studyId: seeded.study.id, sourceId: source.id, name: "n.txt", role: "document", subject: "SYNTHETIC-F5", stream: Readable.from([Buffer.from(text)]) });
  const key = String(up.file.detail.subjectKey);
  await vcr.matchJudgments.save({ studyId: seeded.study.id, userId: accounts.owner, subjectKey: key, targetKind: "candidate_trial", targetId: "NCT08888888", targetHash: "t", documentHash: "d", mode: "criteria", promptVersion: "criteria-5", model: "m", thinking: "off", producer: "job", status: "done", verdict: "possible", documentIds: [up.file.id],
    answer: { target: { kind: "candidate_trial", id: "NCT08888888", registry: "clinicaltrials.gov", registryId: "NCT08888888", title: "t" }, rows: [{ number: 1, kind: "inclusion", clause: "c", label: "included", basis: "stated", reason: "肌酐偏高", sentenceIds: [0], evidence: [{ sentenceId: 0, text: "一句病历里已经没有的话。", start: 0, end: 12, documentId: up.file.id }] }], missing: [] } });
  const file = await call("owner", "GET", `/api/vcr/studies/${seeded.study.id}/matching/export?direction=patient_to_trial&subjectKey=${key}&kind=clauses&format=csv`);
  assert.equal(file.status, 200);
  assert.ok(!file.text.includes("已经没有的话"), "the export re-reads each sentence like the page");
  const page = await judged("owner", `direction=patient_to_trial&subjectKey=${key}`);
  assert.equal(page.body.data.selected.withheld, 1);
  assert.match(page.body.data.selected.evidenceNote, /读不到/u);
});


test("the page's 开始评估 reaches the matching package (it answered 503 vcr_unavailable once the contact service left), and the rule file is behind the same export route", options, async () => {
  const started = await call("owner", "POST", `/api/vcr/studies/${seeded.study.id}/jobs`, { kind: "match_criteria", selection: { direction: "trial_to_patient" } });
  assert.notEqual(started.status, 503, started.text);
  assert.notEqual(started.body?.code, "vcr_unavailable");
  const file = await call("owner", "GET", `/api/vcr/studies/${seeded.study.id}/matching/export?direction=trial_to_patient&source=rules&kind=pairs&format=csv`);
  assert.equal(file.status, 200, file.text);
  assert.match(file.text, /^\uFEFF?患者,结论,满足,不满足,未知,待复评,评估时间,判定方式/u);
  const viewer = await call("viewer", "GET", `/api/vcr/studies/${seeded.study.id}/matching/export?direction=trial_to_patient&source=rules&kind=pairs&format=csv`);
  assert.equal(viewer.status, 403, "the same ability check as the judged file");
});
