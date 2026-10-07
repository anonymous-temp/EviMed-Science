// Project members and the audience, in the real hosted app over HTTP on a real PostgreSQL (flywheel F29): under the audience `all` a
// non-operator account makes a project, runs a step and sees only its own data; the owner brings an editor, a medical reviewer and
// a viewer in by role; each operation is judged by the ability of the roles held; an account without a membership reads the project as
// one that does not exist; and the people a product card discloses are the real named members.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

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
