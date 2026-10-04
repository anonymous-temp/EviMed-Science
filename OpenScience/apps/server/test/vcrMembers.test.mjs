// 「虚拟临研」's study members and roles, without a database.
//
// The double below is the member half of `VcrDataStore` with the real store's
// bounds: `(study, user, role)` is the key, an unknown role is a TypeError,
// and a member row never exists for the study owner. The same paths run
// against real PostgreSQL in `vcrDataPlane.integration.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { VCR_MEMBER_ROLES, roleAllows } from "@evimed/domain";

import { VCR_ACCESS_CODES } from "../src/vcrAccess.mjs";
import { VCR_MANAGING_ROLES, VCR_MEMBER_CODES, VcrMembers, abilitiesOfRoles } from "../src/vcrMembers.mjs";

class StoreDouble {
  constructor() {
    /** @type {Map<string, any>} */ this.studies = new Map();
    /** @type {any[]} */ this.members = [];
    /** @type {any[]} */ this.auditRows = [];
  }

  /** @param {any} study */
  addStudy(study) {
    this.studies.set(study.id, { projectId: `prj_${study.id}`, deletedAt: null, ...study });
  }

  async studyForAccess(studyId) {
    const study = this.studies.get(String(studyId));
    if (!study || study.deletedAt) return null;
    return { id: study.id, userId: study.userId, projectId: study.projectId };
  }

  async rolesOf(studyId, userId) {
    return this.members.filter((row) => row.studyId === studyId && row.userId === userId).map((row) => row.role).sort();
  }

  async listMembers(studyId) {
    return this.members.filter((row) => row.studyId === studyId)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.userId.localeCompare(b.userId) || a.role.localeCompare(b.role));
  }

  async addMember(entry) {
    if (!VCR_MEMBER_ROLES.includes(entry.role)) throw new TypeError(`unknown role ${entry.role}`);
    if (!entry.studyId || !entry.userId) throw new TypeError("a member row needs a study and a user");
    const existing = this.members.find((row) =>
      row.studyId === entry.studyId && row.userId === entry.userId && row.role === entry.role);
    const row = existing ?? {
      studyId: entry.studyId, userId: entry.userId, role: entry.role,
      invitedBy: entry.invitedBy ?? null, detail: {}, createdAt: "2026-09-28T00:00:00.000Z",
    };
    row.detail = entry.detail ?? {};
    if (!existing) this.members.push(row);
    await this.audit({ studyId: entry.studyId, action: "member.add", object: `${entry.userId}:${entry.role}` });
    return { ...row };
  }

  async removeMember(entry) {
    const before = this.members.length;
    this.members = this.members.filter((row) =>
      !(row.studyId === entry.studyId && row.userId === entry.userId && row.role === entry.role));
    const removed = this.members.length < before;
    if (removed) await this.audit({ studyId: entry.studyId, action: "member.remove", object: `${entry.userId}:${entry.role}` });
    return { removed };
  }

  // The access judge asks for these; no study in these scenes carries a source.
  async sourceFor() { return null; }
  async getSnapshot() { return null; }
  async liveGrants() { return []; }
  async listFieldMaps() { return []; }

  async audit(entry) {
    if (!entry?.action) throw new TypeError("an audit row needs an action");
    this.auditRows.push(entry);
  }
}

function scene() {
  const store = new StoreDouble();
  store.addStudy({ id: "std_1", userId: "owner" });
  store.addStudy({ id: "std_other", userId: "stranger" });
  return { store, members: new VcrMembers({ store, now: () => new Date("2026-09-28T00:00:00Z") }) };
}

test("AC-17 the owner is a lead without a member row, and is listed as the owner", async () => {
  const { members } = scene();
  const people = await members.list({ actor: "owner", studyId: "std_1" });
  assert.equal(people.length, 1);
  assert.equal(people[0].userId, "owner");
  assert.equal(people[0].owner, true);
  assert.deepEqual(people[0].roles, ["lead"]);
  assert.deepEqual(people[0].roleLabels, ["研究负责人"]);
  assert.ok(people[0].abilities.includes("manage_members"));
});

test("a member is listed by name, never by account id: the name when there is one, the neutral label for an account that is gone, nothing where no join exists", async () => {
  const { store, members } = scene();
  await members.add({ actor: "owner", studyId: "std_1", userId: "usr_5c8e1f2a", role: "statistical_reviewer" });
  await members.add({ actor: "owner", studyId: "std_1", userId: "wang.dm", role: "data_manager" });
  // The same join `reviews()` makes, as the store's `personNames`: an account that no longer exists is absent from the answer.
  /** @type {any[]} */
  const asked = [];
  store.personNames = async (/** @type {Iterable<string>} */ ids) => { asked.push([...ids].sort()); return new Map([["owner", "刘负责人"], ["wang.dm", "王数据"]]); };
  const people = await members.list({ actor: "owner", studyId: "std_1" });
  assert.deepEqual(asked, [["owner", "usr_5c8e1f2a", "wang.dm"]], "one question for everyone on the study, the owner included");
  assert.deepEqual(people.map((person) => [person.userId, person.name]), [["owner", "刘负责人"], ["usr_5c8e1f2a", "已注销的账号"], ["wang.dm", "王数据"]]);
  assert.equal(JSON.stringify(people.map((person) => person.name)).includes("usr_"), false);
  // A store with no such join, or one that cannot answer: no name, and still the list (the page says nothing of the person rather than their id).
  delete store.personNames;
  assert.deepEqual((await members.list({ actor: "owner", studyId: "std_1" })).map((person) => person.name), [null, null, null]);
  store.personNames = async () => { throw new Error("users table down"); };
  assert.equal((await members.list({ actor: "owner", studyId: "std_1" })).length, 3);
});

test("AC-17 a non-member cannot list the members and is told the study does not exist", async () => {
  const { members } = scene();
  await assert.rejects(() => members.list({ actor: "outsider", studyId: "std_1" }),
    (error) => error.status === 404 && error.code === VCR_ACCESS_CODES.studyNotFound);
  await assert.rejects(() => members.list({ actor: "outsider", studyId: "std_nope" }),
    (error) => error.status === 404 && error.code === VCR_ACCESS_CODES.studyNotFound);
});

test("AC-17 only an account that may manage members may add one", async () => {
  const { store, members } = scene();
  const added = await members.add({ actor: "owner", studyId: "std_1", userId: "dm", role: "data_manager" });
  assert.equal(added.role, "data_manager");
  assert.equal(added.roleLabel, "数据管理");
  assert.equal(added.invitedBy, "owner");
  assert.equal(store.auditRows.filter((row) => row.action === "member.add").length, 1);
  await assert.rejects(() => members.add({ actor: "dm", studyId: "std_1", userId: "friend", role: "viewer" }),
    (error) => error.status === 403 && error.code === VCR_ACCESS_CODES.roleForbids,
    "a data manager who could invite people would be a way around every field grant");
  await assert.rejects(() => members.add({ actor: "outsider", studyId: "std_1", userId: "friend", role: "viewer" }),
    (error) => error.status === 404);
});

test("AC-17 adding refuses an unknown role, a missing account and the owner", async () => {
  const { members } = scene();
  await assert.rejects(() => members.add({ actor: "owner", studyId: "std_1", userId: "x", role: "principal" }),
    (error) => error.status === 400 && error.code === VCR_MEMBER_CODES.roleUnknown);
  await assert.rejects(() => members.add({ actor: "owner", studyId: "std_1", userId: "  ", role: "viewer" }),
    (error) => error.status === 400 && error.code === VCR_MEMBER_CODES.selfRequired);
  await assert.rejects(() => members.add({ actor: "owner", studyId: "std_1", userId: "owner", role: "lead" }),
    (error) => error.status === 409 && error.code === VCR_MEMBER_CODES.ownerFixed,
    "the owner's lead is the study row; a second copy is a second thing to keep in step");
});

test("AC-17 one person holds several roles and adding one twice is idempotent", async () => {
  const { store, members } = scene();
  await members.add({ actor: "owner", studyId: "std_1", userId: "doctor", role: "site" });
  await members.add({ actor: "owner", studyId: "std_1", userId: "doctor", role: "clinical_reviewer" });
  await members.add({ actor: "owner", studyId: "std_1", userId: "doctor", role: "site", detail: { site: "华西" } });
  assert.equal(store.members.filter((row) => row.userId === "doctor").length, 2);
  const people = await members.list({ actor: "owner", studyId: "std_1" });
  const doctor = people.find((person) => person.userId === "doctor");
  assert.deepEqual(doctor.roles, ["clinical_reviewer", "site"]);
  assert.deepEqual(doctor.roleLabels, ["临床复核", "中心"]);
  assert.equal(doctor.owner, false);
  // The union of what the two roles allow, from the domain — never a second table.
  assert.deepEqual(doctor.abilities, abilitiesOfRoles(["clinical_reviewer", "site"]));
  assert.ok(doctor.abilities.includes("review_clinical") && doctor.abilities.includes("write_referrals"));
  assert.ok(!doctor.abilities.includes("manage_members"));
});

test("AC-17 removing a role takes only that role and is recorded", async () => {
  const { store, members } = scene();
  await members.add({ actor: "owner", studyId: "std_1", userId: "doctor", role: "site" });
  await members.add({ actor: "owner", studyId: "std_1", userId: "doctor", role: "clinical_reviewer" });
  const result = await members.remove({ actor: "owner", studyId: "std_1", userId: "doctor", role: "site" });
  assert.equal(result.removed, true);
  assert.deepEqual(await store.rolesOf("std_1", "doctor"), ["clinical_reviewer"]);
  assert.equal(store.auditRows.filter((row) => row.action === "member.remove").length, 1);
  assert.equal((await members.remove({ actor: "owner", studyId: "std_1", userId: "doctor", role: "site" })).removed,
    false, "removing a role nobody holds changes nothing and says so");
});

test("AC-17 a study always keeps an account that can manage it", async () => {
  const { store, members } = scene();
  assert.deepEqual(VCR_MANAGING_ROLES, VCR_MEMBER_ROLES.filter((role) => roleAllows(role, "manage_members")));
  await members.add({ actor: "owner", studyId: "std_1", userId: "colead", role: "lead" });
  assert.equal((await members.remove({ actor: "owner", studyId: "std_1", userId: "colead", role: "lead" })).removed, true,
    "a co-lead may go");
  // The lockout is prevented by construction, not by a check: the owner's
  // `lead` is the study row, so there is no member row to remove and no
  // sequence of member edits that leaves the study unmanageable.
  await assert.rejects(() => members.remove({ actor: "owner", studyId: "std_1", userId: "owner", role: "lead" }),
    (error) => error.status === 409 && error.code === VCR_MEMBER_CODES.ownerFixed);
  assert.deepEqual(store.members.filter((row) => row.userId === "owner"), []);
  const after = await members.abilitiesOf({ studyId: "std_1", userId: "owner" });
  assert.ok(after.abilities.includes("manage_members"));
});

test("AC-17 abilities of a non-member are empty rather than an error", async () => {
  const { members } = scene();
  assert.deepEqual(await members.abilitiesOf({ studyId: "std_1", userId: "nobody" }), { roles: [], abilities: [] });
  assert.deepEqual(await members.abilitiesOf({ studyId: "std_nope", userId: "owner" }), { roles: [], abilities: [] });
  const owner = await members.abilitiesOf({ studyId: "std_1", userId: "owner" });
  assert.deepEqual(owner.roles, ["lead"]);
  assert.deepEqual(owner.abilities, abilitiesOfRoles(["lead"]));
  await members.add({ actor: "owner", studyId: "std_1", userId: "rec", role: "recruiter" });
  const recruiter = await members.abilitiesOf({ studyId: "std_1", userId: "rec" });
  assert.ok(recruiter.abilities.includes("contact_patients"));
  assert.ok(!recruiter.abilities.includes("read_patient_level"),
    "a coordinator contacts people; reading their rows is a different ability");
});

test("abilitiesOfRoles is the union of the domain's table and nothing else", () => {
  assert.deepEqual(abilitiesOfRoles([]), []);
  assert.deepEqual(abilitiesOfRoles(["not_a_role"]), []);
  assert.deepEqual(abilitiesOfRoles(["viewer"]), ["read"]);
  const both = abilitiesOfRoles(["viewer", "recruiter"]);
  assert.deepEqual(both, [...new Set([...abilitiesOfRoles(["viewer"]), ...abilitiesOfRoles(["recruiter"])])].sort());
});
