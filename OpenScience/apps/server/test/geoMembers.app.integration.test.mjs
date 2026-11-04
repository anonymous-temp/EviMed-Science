// Project members and the audience, in the real hosted app over HTTP on a real PostgreSQL (flywheel F29): under the audience `all` a
// non-operator account makes a project, runs a step and sees only its own data; the owner brings an editor, a medical reviewer and
// a viewer in by role; each operation is judged by the ability of the roles held; an account without a membership reads the project as
// one that does not exist; and the people a product card discloses are the real named members.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import pg from "pg";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { GEO_ROUTE_ERROR_CODES, knownErrorCodeMessage } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { brandRegistry, registryKey } from "../src/geoParse.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const accounts = { owner: `own${suffix}`, editor: `edi${suffix}`, reviewer: `rev${suffix}`, viewer: `vie${suffix}`, outsider: `out${suffix}`, operator: `ops${suffix}` };
const NAMES = { owner: "王负责人", editor: "李编辑", reviewer: "张医生", viewer: "赵观察", outsider: "钱外人", operator: "运营" };
const PASSWORD = "test-only-geo-password";
/** @type {any} */ let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */ let isolated = null;
/** @type {any[]} */ const dispatched = [];

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geomembers");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-geo-members-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    staticDir: process.env.OPEN_SCIENCE_GEO_BROWSER_TEST === "1" ? path.resolve("apps/web/dist") : "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    operatorUsers: [accounts.operator], geoEnabled: true, geoAudience: "all",
    geoDispatchRun: async (/** @type {any} */ input) => { dispatched.push(input); return { runId: `run-${dispatched.length}`, sessionId: `session-${dispatched.length}`, status: "running" }; } });
  for (const [role, id] of Object.entries(accounts)) await app.store.createUser(id, PASSWORD, /** @type {any} */ (NAMES)[role]);
  const address = await app.listen(0, "127.0.0.1");
  await app.geo.worker.close();
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [role, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[role] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0], "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir };
});
after(async () => {
  if (context) { await context.app.close(); await rm(context.dataDir, { recursive: true, force: true }); }
  await isolated?.drop();
});

/** @param {string} role @param {string} method @param {string} route @param {unknown} [body] */
async function call(role, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[role], body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
/** @param {Record<string, any>} [project] */
async function made(project = {}) {
  const created = await call("owner", "POST", "/api/geo/projects", { brandName: `产品${Math.random().toString(36).slice(2, 6)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  if (Object.keys(project).length) assert.equal((await call("owner", "PATCH", `/api/geo/projects/${id}`, project)).status, 200);
  return id;
}

test("under the audience all a non-operator account makes a project, runs a step, and sees only its own data", options, async () => {
  const id = await made();
  const run = await call("owner", "POST", `/api/geo/projects/${id}/run`, { step: "evidence" });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(dispatched.at(-1).userId, accounts.owner);
  assert.equal((await call("owner", "GET", "/api/me")).body.data.features.geo, true, "a non-operator is offered the module");
  assert.equal((await call("outsider", "GET", "/api/geo/projects")).body.data.projects.length, 0, "another account's list holds none of it");
  for (const route of [`/api/geo/projects/${id}`, `/api/geo/projects/${id}/articles`, `/api/geo/projects/${id}/cards`, `/api/geo/projects/${id}/members`]) {
    const answer = await call("outsider", "GET", route);
    assert.deepEqual([answer.status, answer.body.code], [404, "geo_project_not_found"], route);
  }
  assert.deepEqual([(await call("outsider", "POST", `/api/geo/projects/${id}/run`, { step: "evidence" })).status], [404]);
});

test("project measurement history includes failed and skipped rounds outside the default observation selection", options, async () => {
  const store = context.app.geo.service.store;
  const id = await made({ engines: ["deepseek"] });
  const before = await call("owner", "GET", `/api/geo/projects/${id}`);
  assert.equal(before.body.data.hasMeasurementHistory, false);
  for (const status of ["partial", "done"]) {
    await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,planned,done,surface)
      VALUES($1,$2,$3,'single_step',$4,1,'{deepseek}',1,1,'{}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status`, [`${id}-empty`, accounts.owner, id, status]);
    const after = await call("owner", "GET", `/api/geo/projects/${id}`);
    assert.equal(after.body.data.hasMeasurementHistory, true);
    assert.equal(after.body.data.selection.counts.snapshots, 0);
    assert.deepEqual(after.body.data.selection.roundIds, []);
    assert.equal((await call("outsider", "GET", `/api/geo/projects/${id}`)).status, 404);
  }
});

test('the composed exact-run reader resolves the complete owner account for its real workspace and programme history', options, async () => {
  const id = await made();
  await call('owner', 'POST', `/api/geo/projects/${id}/members`, { userId: accounts.viewer, role: 'viewer' });
  const project = await context.app.geo.service.requireProject(await context.app.store.userById(accounts.viewer), id);
  assert.equal(project.userId, accounts.owner);
  const control = await context.app.geo.signalResults.controlProject(project);
  assert.equal(control.userId, accounts.owner); assert.equal(control.id, project.projectId);
  assert.equal(typeof control.workspaceDir, 'string');
  assert.ok(control.workspaceDir.includes(`${path.sep}${accounts.owner}${path.sep}`));
  assert.deepEqual(await context.app.geo.signalResults.programmeRuns(project), []);
  assert.deepEqual(await context.app.geo.signals.runs(project), []);
});

test("the owner brings in an editor, a medical reviewer and a viewer; the list names them with what each may do", options, async () => {
  const id = await made();
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "editor" })).status, 201);
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.reviewer, role: "medical_reviewer", detail: { hospital: "某某医院", department: "内分泌科", title: "主任医师" } })).status, 201);
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.viewer, role: "viewer" })).status, 201);
  // The same role again changes nothing; one person may hold two roles.
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "editor" })).status, 201);
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "viewer" })).status, 201);
  const listed = await call("owner", "GET", `/api/geo/projects/${id}/members`);
  assert.equal(listed.status, 200);
  const byId = Object.fromEntries(listed.body.data.members.map((/** @type {any} */ member) => [member.userId, member]));
  assert.deepEqual([byId[accounts.owner].owner, byId[accounts.owner].roles, byId[accounts.owner].name], [true, ["owner"], "王负责人"]);
  assert.deepEqual(byId[accounts.editor].roles, ["editor", "viewer"]);
  assert.deepEqual(byId[accounts.editor].abilities, ["read", "edit", "run"]);
  assert.deepEqual(byId[accounts.reviewer].abilities, ["read", "review"]);
  assert.deepEqual(byId[accounts.reviewer].roleLabels, ["医学审核"]);
  assert.deepEqual(byId[accounts.viewer].abilities, ["read"]);
  assert.deepEqual(byId[accounts.owner].abilities, ["read", "edit", "run", "review", "manage_money", "manage_members", "delete"]);
  assert.deepEqual(listed.body.data.you.roles, ["owner"]);
  // A member's own view says what they are.
  assert.deepEqual((await call("reviewer", "GET", `/api/geo/projects/${id}/members`)).body.data.you, { roles: ["medical_reviewer"], abilities: ["read", "review"] });
  // The project is on each member's list, under the owner's name for it.
  for (const role of ["editor", "reviewer", "viewer"]) {
    const projects = (await call(role, "GET", "/api/geo/projects")).body.data.projects;
    assert.ok(projects.some((/** @type {any} */ project) => project.id === id), `${role} sees the project they were given`);
  }
});

test("each operation is judged by the ability of the roles held, and a refusal names the ability", options, async () => {
  const id = await made();
  for (const [role, member] of [["editor", "editor"], ["reviewer", "medical_reviewer"], ["viewer", "viewer"]]) {
    await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: /** @type {any} */ (accounts)[role], role: member });
  }
  const forbidden = (/** @type {any} */ answer) => [answer.status, answer.body.code];
  // read: every member.
  for (const role of ["editor", "reviewer", "viewer"]) assert.equal((await call(role, "GET", `/api/geo/projects/${id}/articles`)).status, 200, role);
  // run: the owner and editors, not the reviewer or the viewer.
  const before = dispatched.length;
  assert.equal((await call("editor", "POST", `/api/geo/projects/${id}/run`, { step: "evidence" })).status, 200);
  assert.equal(dispatched.at(-1).userId, accounts.owner, "the run is the owner's: their project, their workspace, their money");
  for (const role of ["reviewer", "viewer"]) assert.deepEqual(forbidden(await call(role, "POST", `/api/geo/projects/${id}/run`, { step: "evidence" })), [403, "geo_member_forbidden"], role);
  assert.equal(dispatched.length, before + 1);
  // edit: settings and the producer.
  assert.equal((await call("editor", "PATCH", `/api/geo/projects/${id}`, { producer: { kind: "enterprise", name: "某某制药" } })).status, 200);
  assert.deepEqual(forbidden(await call("viewer", "PATCH", `/api/geo/projects/${id}`, { tier: "3" })), [403, "geo_member_forbidden"]);
  // The name: an editor renames the project, which is the owner's project — the owner and every member read the new name, and a viewer cannot.
  assert.equal((await call("editor", "PATCH", `/api/geo/projects/${id}`, { name: "改过的项目名" })).status, 200);
  for (const role of ["owner", "editor", "viewer"]) {
    assert.equal((await call(role, "GET", `/api/geo/projects/${id}`)).body.data.name, "改过的项目名", `${role} reads the new name`);
  }
  assert.deepEqual(forbidden(await call("viewer", "PATCH", `/api/geo/projects/${id}`, { name: "不该成功" })), [403, "geo_member_forbidden"]);
  assert.deepEqual(forbidden(await call("editor", "PATCH", `/api/geo/projects/${id}`, { name: "   " })), [400, "geo_project_name_invalid"]);
  assert.deepEqual(forbidden(await call("reviewer", "POST", `/api/geo/projects/${id}/cards/refresh`, {})), [403, "geo_member_forbidden"]);
  // money, members and deletion: the owner's alone.
  assert.deepEqual(forbidden(await call("editor", "PUT", `/api/geo/projects/${id}/budget`, { totalCny: 1000, dailyCny: 100 })), [403, "geo_member_forbidden"]);
  assert.deepEqual(forbidden(await call("editor", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.outsider, role: "viewer" })), [403, "geo_member_forbidden"]);
  assert.deepEqual(forbidden(await call("editor", "DELETE", `/api/geo/projects/${id}`)), [403, "geo_member_forbidden"]);
  assert.deepEqual(forbidden(await call("editor", "DELETE", `/api/geo/projects/${id}/members/${accounts.viewer}`)), [403, "geo_member_forbidden"]);
  // The safety stop: a person looks. The reviewer and the owner may release it; an editor may not.
  const geo = context.app.geo;
  const project = await geo.store.getProject(accounts.owner, id);
  const [articleId] = await geo.store.registerArticles(accounts.owner, project.id, [{ path: "deliverables/geo-content/articles/a.md", layer: "popular", title: "稿件", groupId: null,
    claimIds: [], gate: "passed", safety: "open", contentSha256: "a".repeat(64), deliverableId: "geo-content" }]);
  assert.deepEqual(forbidden(await call("editor", "POST", `/api/geo/projects/${id}/articles/${articleId}/release`, {})), [403, "geo_member_forbidden"]);
  assert.equal((await call("reviewer", "POST", `/api/geo/projects/${id}/articles/${articleId}/release`, {})).status, 200);
  // Withdrawing is an edit.
  assert.equal((await call("editor", "POST", `/api/geo/projects/${id}/articles/${articleId}/withdraw`, {})).status, 200);
});

test("an account without a membership reads the project as nonexistent, even where it names a member's id", options, async () => {
  const id = await made();
  await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.viewer, role: "viewer" });
  for (const [method, route, body] of [["GET", `/api/geo/projects/${id}`, undefined], ["POST", `/api/geo/projects/${id}/members`, { userId: accounts.outsider, role: "editor" }],
    ["DELETE", `/api/geo/projects/${id}/members/${accounts.viewer}`, undefined], ["GET", `/api/geo/projects/${id}/articles/x/references`, undefined]]) {
    const answer = await call("outsider", method, route, body);
    assert.deepEqual([answer.status, answer.body.code], [404, "geo_project_not_found"], `${method} ${route}`);
  }
  assert.ok((await call("viewer", "GET", `/api/geo/projects/${id}`)).status === 200);
  // After the owner takes the role away the account is an outsider again.
  assert.equal((await call("owner", "DELETE", `/api/geo/projects/${id}/members/${accounts.viewer}`)).body.data.removed, 1);
  assert.equal((await call("viewer", "GET", `/api/geo/projects/${id}`)).status, 404);
});

test("the owner's roles are not a member's, a role outside the list is refused, and a member may leave on their own", options, async () => {
  const id = await made();
  const refused = (/** @type {any} */ answer) => [answer.status, answer.body.code];
  assert.deepEqual(refused(await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.owner, role: "viewer" })), [409, "geo_member_owner_fixed"]);
  assert.deepEqual(refused(await call("owner", "DELETE", `/api/geo/projects/${id}/members/${accounts.owner}`)), [409, "geo_member_owner_fixed"]);
  assert.deepEqual(refused(await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "owner" })), [400, "geo_member_role_invalid"]);
  assert.deepEqual(refused(await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: "bad id!", role: "viewer" })), [400, "geo_member_user_required"]);
  assert.deepEqual(refused(await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "viewer", detail: { salary: "1" } })), [400, "geo_member_detail_invalid"]);
  await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "editor" });
  assert.equal((await call("editor", "DELETE", `/api/geo/projects/${id}/members/${accounts.editor}`)).body.data.removed, 1, "a member leaves on their own");
  assert.equal((await call("editor", "GET", `/api/geo/projects/${id}`)).status, 404);
});

test("an id no account has is refused by name and stores nothing; a registered account is added with no invitation to accept (G9)", options, async () => {
  const id = await made();
  const members = async () => (await call("owner", "GET", `/api/geo/projects/${id}/members`)).body.data.members.map((/** @type {any} */ member) => member.userId);
  const typo = await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: `${accounts.editor}x`, role: "editor" });
  assert.deepEqual([typo.status, typo.body.code], [400, "geo_member_user_unknown"], "a well-formed id that no account has");
  assert.deepEqual(await members(), [accounts.owner], "the typo is not a member");
  assert.ok(GEO_ROUTE_ERROR_CODES.includes("geo_member_user_unknown"), "the refusal is registered");
  assert.match(knownErrorCodeMessage("geo_member_user_unknown") ?? "", /账号/, "and has a sentence the page shows");
  // The registered account is in at once: it reads the project the moment it is named, with nothing for it to accept.
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "editor" })).status, 201);
  assert.deepEqual((await members()).sort(), [accounts.editor, accounts.owner].sort());
  assert.equal((await call("editor", "GET", `/api/geo/projects/${id}`)).status, 200);
});

test("a product card's author and reviewer are the real named members, and without a reviewing doctor no card is written", options, async () => {
  const id = await made({ producer: { kind: "enterprise", name: "某某制药有限公司", relation: "own_product" } });
  const geo = context.app.geo;
  const owner = await geo.store.getProject(accounts.owner, id);
  // The claims a card is made of, with the preserved source it quotes.
  await geo.store.upsertClaims(accounts.owner, owner.id, [{ claimKey: "dose", statement: "每周一次皮下注射。", quote: "本品每周一次皮下注射给药", sourceRef: "说明书",
    sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" }]);
  const readSource = async () => "【用法用量】本品每周一次皮下注射给药，起始剂量为 2.5 mg。";
  await assert.rejects(() => geo.cards.refresh(owner, { readSource }), (error) => /** @type {any} */ (error).code === "geo_card_reviewer_required");
  await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.editor, role: "editor" });
  await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.reviewer, role: "medical_reviewer", detail: { hospital: "某某医院", department: "内分泌科", title: "主任医师" } });
  await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.viewer, role: "viewer" });
  const result = await geo.cards.refresh(await geo.store.getProject(accounts.owner, id), { readSource });
  assert.equal(result.cards.length, 1);
  const [card] = (await context.app.store.database.query("SELECT producer, disclosure FROM evimed_frontier.evidence_cards WHERE id = $1", [result.cards[0].cardId])).rows;
  assert.deepEqual(card.disclosure.authors.map((/** @type {any} */ person) => person.name), ["王负责人", "李编辑"], "the owner and the editors write it; a viewer is no author");
  assert.deepEqual(card.disclosure.reviewers, [{ name: "张医生", affiliation: "某某医院 内分泌科", title: "主任医师" }]);
  assert.equal(card.producer.name, "某某制药有限公司");
});

test("saving the producer and naming the reviewing doctor write the cards by themselves; until then the project says what is missing (D-28)", options, async () => {
  const id = await made();
  const geo = context.app.geo;
  const owner = await geo.store.getProject(accounts.owner, id);
  await geo.store.upsertClaims(accounts.owner, owner.id, [{ claimKey: "dose", statement: "每周一次皮下注射。", quote: "本品每周一次皮下注射给药", sourceRef: "说明书",
    sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" }]);
  const control = await context.app.store.requireProject(await context.app.store.userById(accounts.owner), owner.projectId);
  await mkdir(path.join(control.workspaceDir, ".evimed-sources"), { recursive: true });
  await writeFile(path.join(control.workspaceDir, ".evimed-sources", "label.txt"), "【用法用量】本品每周一次皮下注射给药，起始剂量为 2.5 mg。");
  const cardCount = async () => (await geo.cards.list(await geo.store.getProject(accounts.owner, id))).cards.length;
  const blockedBy = async () => (await call("owner", "GET", `/api/geo/projects/${id}`)).body.data.cards.blockedBy;
  // Nobody speaks for the product yet, and the project says so.
  assert.equal(await blockedBy(), "producer");
  // The company named: still nobody to review, so no card, and the project says what is next.
  const saved = await call("owner", "PATCH", `/api/geo/projects/${id}`, { producer: { kind: "enterprise", name: "某某制药有限公司", relation: "own_product" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.cards, { blockedBy: "reviewer", written: 0 });
  assert.equal(await blockedBy(), "reviewer");
  assert.equal(await cardCount(), 0);
  // The reviewing doctor named: the cards that waited for one are written the same moment.
  const added = await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.reviewer, role: "medical_reviewer" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body.data.cards, { blockedBy: null, written: 1 });
  assert.equal(await cardCount(), 1);
  assert.equal(await blockedBy(), null);
  // A doctor who speaks for their own product needs no one else: the save writes the cards.
  const doctorId = await made();
  const doctor = await geo.store.getProject(accounts.owner, doctorId);
  await geo.store.upsertClaims(accounts.owner, doctor.id, [{ claimKey: "dose", statement: "每周一次皮下注射。", quote: "本品每周一次皮下注射给药", sourceRef: "说明书",
    sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" }]);
  const doctorControl = await context.app.store.requireProject(await context.app.store.userById(accounts.owner), doctor.projectId);
  await mkdir(path.join(doctorControl.workspaceDir, ".evimed-sources"), { recursive: true });
  await writeFile(path.join(doctorControl.workspaceDir, ".evimed-sources", "label.txt"), "【用法用量】本品每周一次皮下注射给药，起始剂量为 2.5 mg。");
  const byDoctor = await call("owner", "PATCH", `/api/geo/projects/${doctorId}`, { producer: { kind: "doctor", name: "张医生", relation: "user_of_therapy" } });
  assert.deepEqual(byDoctor.body.data.cards, { blockedBy: null, written: 1 });
});

test("an article a safety finding holds is told to the reviewing doctor who can clear it, and to the editor, as well as to the owner (D-29)", options, async () => {
  const id = await made();
  for (const [account, role] of /** @type {const} */ ([["reviewer", "medical_reviewer"], ["editor", "editor"], ["viewer", "viewer"]])) {
    assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts[account], role })).status, 201);
  }
  const geo = context.app.geo;
  const project = await geo.store.getProject(accounts.owner, id);
  const title = `减重科普${suffix}`;
  await geo.orchestrator.notifier.articleSafety(project, { id: `art-${suffix}`, title });
  const told = (await context.app.store.database.query("SELECT user_id, source FROM evimed_inbox.notifications WHERE title LIKE $1 ORDER BY user_id", [`%${title}%`])).rows;
  assert.deepEqual(told.map((/** @type {any} */ row) => row.user_id).sort(), [accounts.editor, accounts.owner, accounts.reviewer].sort(),
    "the owner, the reviewing doctor and the editor; a viewer reads the project and is not asked to act");
  assert.ok(told.every((/** @type {any} */ row) => row.source.id === `${id}/content`), "each opens the project's content page");
  // The reviewing doctor can in fact clear it from there: the notice goes to the one member the stop waits for.
  const abilities = (await call("reviewer", "GET", `/api/geo/projects/${id}/members`)).body.data.you.abilities;
  assert.ok(abilities.includes("review"));
});

test("the audience all end to end: a project's readiness and metrics count the module, the forbidden are counted", options, async () => {
  const text = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  assert.match(text, /^open_science_geo_enabled 1$/m);
  assert.match(text, /open_science_geo_service_total\{kind="forbidden"\} [1-9]/);
  assert.match(text, /open_science_geo_cards_total\{event="refused"\} [1-9]/);
});

test("doctor use: a doctor project writes cards under their own name, and an article leaves signed, with the relation said and the AI label", options, async () => {
  const id = await made({ producer: { kind: "doctor", name: "张医生", hospital: "某某医院", department: "内分泌科", specialty: "糖尿病", relation: "user_of_therapy" } });
  const geo = context.app.geo;
  const owner = await geo.store.getProject(accounts.owner, id);
  await geo.store.upsertClaims(accounts.owner, owner.id, [{ claimKey: "dose", statement: "每周一次皮下注射。", quote: "本品每周一次皮下注射给药", sourceRef: "说明书",
    sourceKind: "label", inLabel: true, artifactPath: ".evimed-sources/label.txt" }]);
  const result = await geo.cards.refresh(owner, { readSource: async () => "【用法用量】本品每周一次皮下注射给药，起始剂量为 2.5 mg。" });
  assert.equal(result.cards.length, 1, "a doctor is the author and the reviewer, so no member has to be added first");
  const [card] = (await context.app.store.database.query("SELECT producer, disclosure FROM evimed_frontier.evidence_cards WHERE id = $1", [result.cards[0].cardId])).rows;
  assert.equal(card.producer.kind, "doctor");
  assert.deepEqual(card.disclosure.authors, [{ name: "张医生", affiliation: "某某医院 内分泌科", title: "糖尿病" }]);
  assert.deepEqual(card.disclosure.reviewers, card.disclosure.authors);
  // The card-layer article leaves with the doctor's byline and the label, without the platform's claim references.
  const [article] = (await geo.store.listArticles(owner.id)).filter((/** @type {any} */ entry) => entry.layer === "card");
  assert.ok(article);
  await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: accounts.viewer, role: "viewer" });
  const text = await call("viewer", "GET", `/api/geo/projects/${id}/articles/${article.id}/text`);
  assert.equal(text.status, 200, JSON.stringify(text.body));
  assert.equal(text.body.data.aiGenerated, true);
  assert.match(text.body.data.markdown, /作者：张医生\u3000某某医院 内分泌科\u3000糖尿病\n与产品的关系：出品方是该疗法的使用者\n本文由 AI 辅助生成/);
  assert.doesNotMatch(text.body.data.markdown, /\[\[ref:/);
  assert.equal((await call("outsider", "GET", `/api/geo/projects/${id}/articles/${article.id}/text`)).status, 404);
  // Its references resolve: the card layer cites nothing a card does not hold.
  const references = await call("owner", "GET", `/api/geo/projects/${id}/articles/${article.id}/references`);
  assert.equal(references.status, 200, JSON.stringify(references.body));
  assert.equal(references.body.data.ok, true);
});

test("a member whose display name is their login name, or an address, is listed under a neutral word", options, async () => {
  const id = await made();
  // A local account's display name defaults to its login name; a member list is shown to everyone on the project.
  await context.app.store.createUser("plain_login_member", PASSWORD, "plain_login_member");
  await context.app.store.createUser("address_named_member", PASSWORD, "someone@example.invalid");
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: "plain_login_member", role: "viewer" })).status, 201);
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/members`, { userId: "address_named_member", role: "viewer" })).status, 201);
  const listed = await call("owner", "GET", `/api/geo/projects/${id}/members`);
  const byId = Object.fromEntries(listed.body.data.members.map((/** @type {any} */ member) => [member.userId, member]));
  assert.equal(byId.plain_login_member.name, "项目成员");
  assert.equal(byId.address_named_member.name, "项目成员");
  assert.equal(byId[accounts.owner].name, "王负责人", "a real display name is kept");
});


test("project summaries and recurring choices use current member abilities and preserve the real actor", options, async () => {
  const id=await made();
  await call("owner","POST",`/api/geo/projects/${id}/members`,{userId:accounts.viewer,role:"viewer"});
  await call("owner","POST",`/api/geo/projects/${id}/members`,{userId:accounts.editor,role:"editor"});
  const listed=(await call("viewer","GET","/api/geo/projects")).body.data.projects.find(row=>row.id===id);
  assert.equal(listed.access.owner,false);
  assert.equal(listed.access.abilities.includes("run"),false);
  assert.equal((await call("viewer","POST",`/api/geo/projects/${id}/monitoring/automation`,{enabled:true})).status,403);
  const started=await call("editor","POST",`/api/geo/projects/${id}/monitoring/automation`,{enabled:true});
  assert.equal(started.status,200,JSON.stringify(started.body));
  const current=(await call("owner","GET",`/api/geo/projects/${id}`)).body.data;
  assert.equal(current.steps.monitoring.automation.actorId,accounts.editor);
  assert.equal(current.steps.monitoring.automation.state,"confirmed");
  await call("owner","PATCH",`/api/geo/projects/${id}`,{status:"paused"});
  assert.equal((await call("editor","POST",`/api/geo/projects/${id}/monitoring/automation`,{enabled:true})).status,409);
  assert.equal((await call("editor","POST",`/api/geo/projects/${id}/monitoring/automation`,{enabled:false})).status,200);
  assert.equal((await call("owner","GET",`/api/geo/projects/${id}`)).body.data.steps.monitoring.automation.state,"declined");
});

test("confirmation preview and authorization use the exact server scope over HTTP", options, async () => {
  const id = await made({ engines: ["deepseek"] });
  const store = context.app.geo.service.store;
  const groups = [{ name: "Synthetic", questions: [{ text: "Synthetic question?", isMeasured: true }] }];
  await store.writeQuestionSet(accounts.owner, id, { groups, contract: { samplingMode: "recurring", engines: ["deepseek"], repeats: 2 } });
  const route = `/api/geo/projects/${id}/monitoring/confirmation-authorization`;
  const first = await call("owner", "GET", route);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.data.questionVersion, first.body.data.repeats, first.body.data.cost, first.body.data.authorized], [1, 2, null, false]);
  const grant = await call("owner", "POST", route, { token: first.body.data.token });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await call("owner", "GET", route)).body.data.authorized, true);
  await store.writeQuestionSet(accounts.owner, id, { groups, contract: { samplingMode: "recurring", engines: ["deepseek"], repeats: 7 } });
  assert.equal((await call("owner", "POST", route, { token: first.body.data.token })).status, 409);
  const next = (await call("owner", "GET", route)).body.data;
  assert.deepEqual([next.questionVersion, next.repeats, next.authorized], [2, 7, false]);
  assert.equal((await call("owner", "POST", route, { token: next.token })).status, 200);
  assert.equal((await call("owner", "GET", route)).body.data.authorized, true);
  assert.equal((await call("owner", "DELETE", route)).status, 200);
  assert.equal((await call("owner", "GET", route)).body.data.authorized, false);
  assert.equal((await call("outsider", "GET", route)).status, 404);
});

test("confirmation writes recheck member authority after a slow body and a waiting transaction", options, async () => {
  const id = await made({ engines: ["deepseek"] });
  const service = context.app.geo.service;
  await service.store.writeQuestionSet(accounts.owner, id, { groups: [{ name: "Synthetic", questions: [{ text: "Q?", isMeasured: true }] }],
    contract: { samplingMode: "recurring", engines: ["deepseek"], repeats: 2 } });
  await service.store.addMember({ geoId: id, userId: accounts.editor, role: "editor", invitedBy: accounts.owner });
  const route = `/api/geo/projects/${id}/monitoring/confirmation-authorization`;
  const token = (await call("owner", "GET", route)).body.data.token;
  const original = service.requireProject.bind(service);
  let notify;
  service.requireProject = async (...args) => { const result = await original(...args); if (args[0]?.id === accounts.editor && args[1] === id) notify?.(); return result; };
  try {
    let seen = new Promise(resolve => { notify = resolve; });
    let response;
    const reply = new Promise((resolve, reject) => {
      response = httpRequest(`${context.base}${route}`, { method: "POST", headers: context.sessions.editor }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      response.on("error", reject);
    });
    response.write('{"token":"');
    await seen;
    await service.store.removeMember({ geoId: id, userId: accounts.editor, role: "editor" });
    await service.store.addMember({ geoId: id, userId: accounts.editor, role: "viewer", invitedBy: accounts.owner });
    response.end(`${token}"}`);
    assert.equal(await reply, 403);
    assert.equal((await call("owner", "GET", route)).body.data.authorized, false);
    await service.store.addMember({ geoId: id, userId: accounts.editor, role: "editor", invitedBy: accounts.owner });
    assert.equal((await call("owner", "POST", route, { token })).status, 200);
    const blocker = new pg.Client({ connectionString: isolated.url });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-set:' || $1))`, [id]);
      seen = new Promise(resolve => { notify = resolve; });
      const pending = call("editor", "DELETE", route);
      await seen;
      await service.store.removeMember({ geoId: id, userId: accounts.editor, role: "editor" });
      await blocker.query("COMMIT");
      assert.equal((await pending).status, 403);
      assert.equal((await call("owner", "GET", route)).body.data.authorized, true);
    } finally { await blocker.query("ROLLBACK").catch(() => {}); await blocker.end(); }
  } finally { service.requireProject = original; }
});

test("browser reviews and confirms the changed question contract through the real HTTP API", { skip: !databaseUrl || process.env.OPEN_SCIENCE_GEO_BROWSER_TEST !== "1" }, async () => {
  const { chromium } = await import("playwright-core");
  const id = await made({ engines: ["deepseek"] });
  const store = context.app.geo.service.store;
  const groups = [{ name: "Synthetic", questions: [{ text: "Synthetic question?", isMeasured: true }] }];
  const contract = (repeats) => ({ samplingMode: "recurring", engines: ["deepseek"], repeats });
  await store.writeQuestionSet(accounts.owner, id, { groups, contract: contract(2) });
  assert.equal((await call("owner", "POST", `/api/geo/projects/${id}/monitoring/automation`, { enabled: true })).status, 200);
  const browser = await chromium.launch({ executablePath: process.env.OPEN_SCIENCE_BROWSER_PATH, headless: true });
  try {
    const browserContext = await browser.newContext();
    const cookie = context.sessions.owner.cookie;
    const separator = cookie.indexOf("=");
    await browserContext.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: context.base }]);
    const page = await browserContext.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(`${context.base}/app/geo/${id}/visibility`);
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "项目设置" }).click();
    await page.getByText(/题集 v1 · 1 个问题/).waitFor();
    await page.getByText(/每个错误每轮计划 2 次/).waitFor();
    await page.getByText(/预计费用暂不可核实/).waitFor();
    await page.getByRole("button", { name: "确认开启错误复问" }).click();
    await page.getByText("已授权当前范围的自动确认。").waitFor();
    await page.getByRole("button", { name: "停止错误复问" }).click();
    await page.getByRole("button", { name: "确认开启错误复问" }).waitFor();
    assert.equal((await call("owner", "GET", `/api/geo/projects/${id}`)).body.data.steps.monitoring.automation.state, "confirmed");
    await page.getByRole("button", { name: "确认开启错误复问" }).click();
    await page.getByText("已授权当前范围的自动确认。").waitFor();
    await store.writeQuestionSet(accounts.owner, id, { groups, contract: contract(7) });
    await page.reload();
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "项目设置" }).click();
    await page.getByText(/题集 v2 · 1 个问题/).waitFor();
    await page.getByText(/每个错误每轮计划 7 次/).waitFor();
    await page.getByRole("button", { name: "确认开启错误复问" }).click();
    await page.getByText("已授权当前范围的自动确认。").waitFor();
  } finally { await browser.close(); }
});

test("browser keeps the frozen competitor cohort, historical name and return filters across pages", { skip: !databaseUrl || process.env.OPEN_SCIENCE_GEO_BROWSER_TEST !== "1" }, async () => {
  const { chromium } = await import("playwright-core");
  const created = await call("editor", "POST", "/api/geo/projects", { brandName: "Synthetic pair" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id, owner = accounts.editor;
  assert.equal((await call("editor", "PATCH", `/api/geo/projects/${id}`, { engines: ["deepseek"] })).status, 200);
  const store = context.app.geo.service.store;
  const product = { brandName: "Synthetic Ours" };
  const competitors = Array.from({ length: 20 }, (_, index) => ({ id: `rival-${index}`, brandName: index ? `Rival ${index}` : "Rival Now" }));
  const historic = competitors.map((item, index) => index ? item : { ...item, brandName: "Rival Old" });
  const basis = { product, competitors: historic, owned: { domains: [], urls: [] } };
  const round = `${id}-paired`, brandKey = registryKey(brandRegistry(product, historic), basis.owned);
  await store.query(`UPDATE evimed_geo.projects SET product=$2::jsonb, competitors=$3::jsonb WHERE id=$1`, [id, JSON.stringify(product), JSON.stringify(competitors)]);
  await store.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES
    ($1||'-p1',$2,$1,1,'P1','Synthetic brand'),($1||'-p2',$2,$1,1,'P2','Synthetic category')`, [id, owner]);
  await store.query(`INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    SELECT $1||'-q'||n,$2,$1,CASE WHEN n=1 THEN $1||'-p1' ELSE $1||'-p2' END,1,
      CASE WHEN n=1 THEN 'P1' ELSE 'P2' END,'Synthetic question '||n,true FROM generate_series(1,41)n`, [id, owner]);
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface,ref)
    VALUES($1,$2,$3,'baseline','done',1,'{deepseek}','2026-10-02',$4::jsonb,$5::jsonb)`,
  [round, owner, id, JSON.stringify({ mode: "web", measurementContract: { samplingMode: "legacy_recurring", repeats: 1, metricIds: ["M-01", "M-16"], sourceBasis: "answers" } }), JSON.stringify({ evaluationBasis: basis })]);
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
    SELECT $1||'-s'||n,$2,$1,$3,$1||'-q'||n,'deepseek','2026-10-02','valid','Synthetic answer '||n,'{"mode":"web"}' FROM generate_series(1,41)n`, [id, owner, round]);
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,registry_key,parser_version)
    SELECT $1||'-s'||n,$2,$1,'2026-10-02',jsonb_build_array(
      jsonb_build_object('name','Synthetic Ours','ours',true,'count',CASE WHEN n%2=0 THEN 1 ELSE 0 END),
      jsonb_build_object('name','Rival Old','competitor',true,'count',CASE WHEN n BETWEEN 2 AND 11 THEN 1 ELSE 0 END)),
      n%2=0,'{"judgementCoverage":{"status":"complete"}}',$3,'geo-parser-test' FROM generate_series(1,41)n`, [id, owner, brandKey]);
  const browser = await chromium.launch({ executablePath: process.env.OPEN_SCIENCE_BROWSER_PATH, headless: true });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cookie = context.sessions.editor.cookie, separator = cookie.indexOf("=");
    await browserContext.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: context.base }]);
    const page = await browserContext.newPage(), reads = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.endsWith("/analysis") && url.searchParams.get("viewId") === "V08") reads.push(url.searchParams); });
    page.setDefaultTimeout(15_000);
    await page.goto(`${context.base}/app/geo/${id}/visibility?from=2026-10-01&to=2026-10-03&engine=deepseek`);
    const comparison = page.getByRole("region", { name: "本品与竞品提及率" });
    await comparison.getByText(/当前登记：Rival Now（历史登记：Rival Old）/).waitFor();
    await comparison.getByText("本品 50% · 竞品 25%").waitFor();
    assert.equal(await page.getByText(/还没有测量结果/).count(), 0, "existing answers must not be presented as an unstarted diagnosis");
    assert.ok(reads.some(query => query.get("offset") === "20" && query.has("selectionRef") && query.has("expectedDigest")), "the second page must use the frozen selection and digest");
    if (process.env.OPEN_SCIENCE_TEST_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OPEN_SCIENCE_TEST_SCREENSHOT_DIR, "geo-paired-rivals.png"), fullPage: true });
    await comparison.getByRole("link", { name: "查看全部竞品分析" }).click();
    await page.waitForURL(url => url.searchParams.get("analysis") === "V08" && Boolean(url.searchParams.get("selectionRef")));
    await page.getByRole("combobox", { name: "分析视角" }).selectOption("");
    await page.waitForURL(url => !url.searchParams.has("analysis") && !url.searchParams.has("selectionRef"));
    const returned = new URL(page.url());
    assert.equal(returned.searchParams.get("from"), "2026-10-01");
    assert.equal(returned.searchParams.get("to"), "2026-10-03");
    assert.equal(returned.searchParams.get("engine"), "deepseek");
  } finally { await browser.close(); }
});
