// The first human stop on a real PostgreSQL: a coordinator confirms one patient
// by name before the ledger may enter a contact state (plan §10.1, AC-18), the
// decision is taken on the locked row with the caller's roles read again inside
// the transaction, and every refusal is a registered status and is written down.
//
// What this proves that the policy tests cannot: two people clicking at once,
// a member removed a moment ago, another study's referral id, and that a
// refused act leaves the ledger exactly as it was.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VCR_CONTACT_REFUSAL_STATUS, createVcrContact } from "../src/vcrContact.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { VCR_SCHEMA } from "../src/vcrPersistence.mjs";
import { VCR_RECRUIT_REFUSALS } from "../src/vcrRecruit.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const run = randomBytes(4).toString("hex");
const OWNER = `owner-${run}`;
const people = {
  coordinator: `coord-${run}`, second: `coord2-${run}`, viewer: `viewer-${run}`, site: `site-${run}`, otherSite: `site2-${run}`,
  stranger: `stranger-${run}`, siteless: `siteless-${run}`,
};

/** @type {ControlPlaneDatabase} */
let database;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {VcrStore} */
let store;
/** @type {VcrDataStore} */
let dataStore;
/** @type {VcrMatchStore} */
let matchStore;
/** @type {ReturnType<typeof createVcrContact>} */
let contact;
/** @type {any} */
let study;
/** @type {any} */
let elsewhere;
/** @type {any} */
let siteA;
/** @type {any} */
let siteB;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrcontact");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3_000 });
  store = new VcrStore({ database });
  dataStore = new VcrDataStore({ database });
  matchStore = new VcrMatchStore({ database });
  await store.ready();
  contact = createVcrContact({ store: matchStore });
  study = await store.createStudy({ userId: OWNER, projectId: `prj-${run}`, name: "联系确认" });
  elsewhere = await store.createStudy({ userId: `other-${run}`, projectId: `prj2-${run}`, name: "另一个研究" });
  siteA = await matchStore.upsertSite({ site: { studyId: study.id, name: "中心 A" }, userId: OWNER });
  siteB = await matchStore.upsertSite({ site: { studyId: study.id, name: "中心 B" }, userId: OWNER });
  for (const [user, role, detail] of /** @type {[string, string, Record<string, string>][]} */ ([
    [people.coordinator, "recruiter", {}], [people.second, "recruiter", {}], [people.viewer, "viewer", {}],
    [people.site, "site", { siteId: siteA.id }], [people.otherSite, "site", { siteId: siteB.id }], [people.siteless, "site", {}],
  ])) {
    await dataStore.addMember({ studyId: study.id, userId: user, role, invitedBy: OWNER, detail });
  }
});

after(async () => {
  await database?.close?.().catch(() => {});
  await isolated?.drop();
});

let sequence = 0;
/** A referral of the study in a chosen state, with or without an approver. @param {Record<string, any>} [over] */
async function referral(over = {}) {
  sequence += 1;
  const created = await matchStore.createReferral({
    referral: { studyId: over.studyId ?? study.id, subjectKey: `S-${run}-${sequence}`, siteId: over.siteId ?? null, actor: "test" }, userId: OWNER,
  });
  if (over.state && over.state !== "candidate") {
    await database.query(`UPDATE ${VCR_SCHEMA}.referrals SET state = $2, contact_approved_by = $3 WHERE id = $1`,
      [created.id, over.state, over.approver ?? null]);
  }
  return created;
}

const asUser = (/** @type {string} */ id) => ({ id });
const events = async (/** @type {string} */ id) => (await matchStore.listReferralEvents(id)).map((event) => `${event.fromState ?? "-"}>${event.toState}:${event.actor}`);
const auditRows = async (/** @type {string} */ id, /** @type {string} */ action) => (await database.query(
  `SELECT outcome, reason, actor FROM ${VCR_SCHEMA}.audit WHERE object = $1 AND action = $2 ORDER BY occurred_at, id`, [id, action])).rows;

test("the study lead confirms a candidate: the patient passes 「可联系」 to 「已联系」 in one act, under the lead's own name", options, async () => {
  const target = await referral();
  const result = await contact.contactReferral(asUser(OWNER), study, target.id, { reason: "符合全部入选标准", note: "已核对病历" });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyContacted, false);
  assert.equal(result.referral.state, "contacted");
  assert.equal(result.referral.contactApprovedBy, OWNER, "the approver is the session's account and nobody else");
  assert.ok(result.referral.contactApprovedAt);
  assert.deepEqual(await events(target.id), [`-`.concat(">candidate:test"), `candidate>contactable:${OWNER}`, `contactable>contacted:${OWNER}`]);
  const stored = (await matchStore.listReferralEvents(target.id)).at(-1);
  assert.match(String(stored?.note), /符合全部入选标准\n已核对病历/, "the reason and the note travel with the events");
  assert.deepEqual((await auditRows(target.id, "vcr.referral.contact_approved")).map((row) => row.actor), [OWNER]);
  assert.equal((await auditRows(target.id, "vcr.referral.contact")).length, 1);
  assert.equal((await auditRows(target.id, "vcr.referral.transition")).length, 2, "each move is audited");
});

test("a recruiter confirms a contactable referral: one move, and the second click writes nothing more", options, async () => {
  const target = await referral({ state: "contactable" });
  const first = await contact.contactReferral(asUser(people.coordinator), study, target.id, {});
  assert.equal(first.referral.state, "contacted");
  assert.equal(first.referral.contactApprovedBy, people.coordinator);
  const before = await events(target.id);
  assert.equal(before.length, 2);

  const again = await contact.contactReferral(asUser(people.coordinator), study, target.id, {});
  assert.equal(again.alreadyContacted, true);
  const other = await contact.contactReferral(asUser(people.second), study, target.id, {});
  assert.equal(other.alreadyContacted, true);
  assert.equal(other.referral.contactApprovedBy, people.coordinator, "a second coordinator does not replace the first name");
  assert.deepEqual(await events(target.id), before, "no event was added");
});

test("two coordinators clicking at once: one approval, one set of events, both answered", options, async () => {
  const target = await referral();
  const settled = await Promise.all([people.coordinator, people.second, OWNER].map((id) => contact.contactReferral(asUser(id), study, target.id, {})));
  assert.deepEqual(settled.map((answer) => answer.referral.state), ["contacted", "contacted", "contacted"]);
  assert.equal(settled.filter((answer) => answer.alreadyContacted === false).length, 1, "exactly one of them made it happen");
  const winner = settled.find((answer) => answer.alreadyContacted === false);
  assert.ok(settled.every((answer) => answer.referral.contactApprovedBy === winner?.referral.contactApprovedBy), "everyone is told the same name");
  assert.equal((await events(target.id)).length, 3, "candidate, contactable, contacted — once");
  assert.equal((await auditRows(target.id, "vcr.referral.contact_approved")).length, 1);
});

test("every refusal is a registered status, leaves the ledger as it was, and is in the audit", options, async () => {
  const candidate = await referral();
  const screening = await referral({ state: "screening", approver: "li" });
  const withdrawn = await referral({ state: "withdrawn" });
  const foreign = await referral({ studyId: elsewhere.id });

  /** @type {[string, string, string, string, number, string][]} */
  const cases = [
    ["a viewer", people.viewer, study.id, candidate.id, 403, "vcr_contact_role_forbidden"],
    ["a site", people.site, study.id, candidate.id, 403, "vcr_contact_role_forbidden"],
    ["an account that is not a member", people.stranger, study.id, candidate.id, 403, "vcr_contact_role_forbidden"],
    ["a referral past the contact stage", people.coordinator, study.id, screening.id, 409, "vcr_referral_transition_invalid"],
    ["a withdrawn referral", people.coordinator, study.id, withdrawn.id, 409, "vcr_referral_transition_invalid"],
    ["another study's referral", people.coordinator, study.id, foreign.id, 404, "vcr_referral_not_found"],
    ["an id that does not exist", people.coordinator, study.id, "ref_nowhere", 404, "vcr_referral_not_found"],
  ];
  for (const [label, who, studyId, referralId, status, code] of cases) {
    const before = await database.query(`SELECT count(*)::int AS n FROM ${VCR_SCHEMA}.referral_events`);
    await assert.rejects(() => contact.contactReferral(asUser(who), { id: studyId, userId: OWNER }, referralId, {}),
      (error) => { assert.equal(error.status, status, label); assert.equal(error.code, code, label); return true; }, label);
    const after = await database.query(`SELECT count(*)::int AS n FROM ${VCR_SCHEMA}.referral_events`);
    assert.equal(after.rows[0].n, before.rows[0].n, `${label}: no event written`);
    assert.ok(Object.hasOwn(VCR_CONTACT_REFUSAL_STATUS, code), `${code} has a status`);
  }
  for (const [id, state] of [[candidate.id, "candidate"], [screening.id, "screening"], [withdrawn.id, "withdrawn"]]) {
    assert.equal((await matchStore.getReferral(id)).state, state, "a refused act leaves the state alone");
  }
  assert.equal((await matchStore.getReferral(candidate.id)).contactApprovedBy, null, "and records no approver");
  const refused = await auditRows(candidate.id, "vcr.referral.contact");
  assert.deepEqual(refused.map((row) => [row.outcome, row.reason]), [
    ["refused", "vcr_contact_role_forbidden"], ["refused", "vcr_contact_role_forbidden"], ["refused", "vcr_contact_role_forbidden"],
  ], "who was stopped, and why, is in the record");
  const foreignRefusals = await database.query(
    `SELECT study_id FROM ${VCR_SCHEMA}.audit WHERE object = $1 AND action = 'vcr.referral.contact' AND outcome = 'refused'`, [foreign.id]);
  assert.deepEqual(foreignRefusals.rows.map((row) => row.study_id), [study.id],
    "an attempt on another study's id is recorded against the caller's own study, where the caller's study can see it");
});

test("the caller's roles are read inside the transaction: a member removed a moment ago is refused", options, async () => {
  const target = await referral();
  const stale = { id: study.id, userId: OWNER };
  await dataStore.addMember({ studyId: study.id, userId: people.stranger, role: "recruiter", invitedBy: OWNER });
  // The route resolved this account a moment ago; the membership is gone by the time the stop is asked.
  await dataStore.removeMember({ studyId: study.id, userId: people.stranger, role: "recruiter", actor: OWNER });
  await assert.rejects(() => contact.contactReferral(asUser(people.stranger), stale, target.id, {}), { status: 403, code: "vcr_contact_role_forbidden" });
  assert.equal((await matchStore.getReferral(target.id)).state, "candidate");
});

test("the approver is never taken from the request: the policy's names for a batch and for a missing name are still refused", options, async () => {
  const target = await referral();
  // The only way to pass a list is to bypass the route; the stop does not accept it either.
  assert.ok(VCR_RECRUIT_REFUSALS.includes("vcr_contact_approval_not_per_person"));
  await assert.rejects(() => contact.contactReferral(asUser(people.coordinator), study, /** @type {any} */ (["a", "b"]), {}), { status: 404 },
    "an array is not an id, so it finds no referral (and nothing is approved)");
  assert.equal((await matchStore.getReferral(target.id)).contactApprovedBy, null);
});

test("a move on the ledger: a site moves its own referrals, a coordinator is stopped at the contact states without a confirmation", options, async () => {
  const own = await referral({ state: "site_responded", approver: "li", siteId: siteA.id });
  const theirs = await referral({ state: "site_responded", approver: "li", siteId: siteB.id });
  const moved = await contact.transitionReferral(asUser(people.site), study, own.id, { to: "screening", note: "开始筛选" });
  assert.equal(moved.referral.state, "screening");
  for (const [label, who, id] of /** @type {[string, string, string][]} */ ([
    ["a site on another site's referral", people.site, theirs.id],
    ["a site account with no site of its own", people.siteless, theirs.id],
  ])) {
    await assert.rejects(() => contact.transitionReferral(asUser(who), study, id, { to: "screening" }),
      { status: 403, code: "vcr_referral_role_forbidden" }, label);
  }
  assert.equal((await matchStore.getReferral(theirs.id)).state, "site_responded");

  const unconfirmed = await referral({ state: "contactable" });
  await assert.rejects(() => contact.transitionReferral(asUser(people.coordinator), study, unconfirmed.id, { to: "contacted" }),
    { status: 403, code: "vcr_contact_not_approved" }, "the move route is not a way around the confirmation");
  await assert.rejects(() => contact.transitionReferral(asUser(people.viewer), study, unconfirmed.id, { to: "withdrawn" }),
    { status: 403, code: "vcr_referral_role_forbidden" });
  await assert.rejects(() => contact.transitionReferral(asUser(people.coordinator), study, unconfirmed.id, { to: "teleported" }),
    { status: 400, code: "vcr_referral_state_unknown" });
  await assert.rejects(() => contact.transitionReferral(asUser(people.coordinator), study, unconfirmed.id, { to: "enrolled" }),
    { status: 409, code: "vcr_referral_transition_invalid" });

  const confirmed = await contact.contactReferral(asUser(people.coordinator), study, unconfirmed.id, {});
  const interested = await contact.transitionReferral(asUser(people.coordinator), study, confirmed.referral.id, { to: "interested" });
  assert.equal(interested.referral.state, "interested", "after the confirmation the ledger moves on by the ordinary route");
  assert.deepEqual((await auditRows(unconfirmed.id, "vcr.referral.transition")).filter((row) => row.outcome === "refused").map((row) => row.reason).sort(),
    ["vcr_contact_not_approved", "vcr_referral_role_forbidden", "vcr_referral_transition_invalid"],
    "each stop that held is in the audit under the reason it gave (an unknown state is refused before any row is touched)");
});

test("a site names its own site on a transition only; another study's site or criterion is refused by name", options, async () => {
  const target = await referral({ state: "site_responded", approver: "li", siteId: siteA.id });
  await assert.rejects(() => contact.transitionReferral(asUser(people.site), study, target.id, { to: "screening", siteId: siteB.id }),
    { status: 403, code: "vcr_referral_role_forbidden" }, "a site cannot re-home a referral");
  const foreignSite = await matchStore.upsertSite({ site: { studyId: elsewhere.id, name: "别的研究的中心" }, userId: `other-${run}` });
  await assert.rejects(() => contact.transitionReferral(asUser(OWNER), study, target.id, { to: "screening", siteId: foreignSite.id }),
    { status: 404, code: "vcr_site_not_found" });
  const screening = await contact.transitionReferral(asUser(people.site), study, target.id, { to: "screening" });
  await assert.rejects(() => contact.transitionReferral(asUser(people.site), study, screening.referral.id, { to: "screen_failed", screenFailCriterionId: "crt_of_no_study" }),
    { status: 400, code: "vcr_screen_failure_needs_criterion" });
  assert.equal((await matchStore.getReferral(target.id)).state, "screening");
});

test("who reads which referrals: every role that reads the study reads them all, a site reads its own site's, nobody else reads any", options, async () => {
  const mine = await referral({ siteId: siteA.id });
  const theirs = await referral({ siteId: siteB.id });
  const unassigned = await referral();
  const ids = async (/** @type {string} */ who) => (await contact.listReferrals(asUser(who), study)).referrals.map((row) => row.id);
  for (const who of [OWNER, people.coordinator, people.viewer]) {
    const all = await ids(who);
    assert.ok([mine.id, theirs.id, unassigned.id].every((id) => all.includes(id)), `${who} reads them all`);
  }
  assert.deepEqual((await ids(people.site)).filter((id) => [mine.id, theirs.id, unassigned.id].includes(id)), [mine.id]);
  assert.deepEqual(await ids(people.siteless), [], "a site account without a site sees nothing rather than everything");
  await assert.rejects(() => contact.listReferrals(asUser(people.stranger), study), { status: 403, code: "vcr_forbidden" });
  const filtered = await contact.listReferrals(asUser(OWNER), study, { state: "site_responded" });
  assert.ok(filtered.referrals.every((row) => row.state === "site_responded"));
});
