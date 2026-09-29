// 「虚拟临研」's per-operation access judgment, without a database.
//
// The store double below answers exactly what `VcrDataStore` answers — nulls
// for what is not there, live grants only, roles as a list — and refuses any
// shape the real store would refuse, so a test cannot pass on a lenience the
// real store does not have (`store-doubles-need-real-bounds`). The same
// scenarios are replayed against real PostgreSQL in
// `vcrDataPlane.integration.test.mjs`, which is what binds the two.
import assert from "node:assert/strict";
import { test } from "node:test";

import { VCR_MEMBER_ROLES } from "@evimed/domain";

import { VCR_ACCESS_CODES, VcrAccess, grantAllowsField, granteeMatches, vcrAccessError } from "../src/vcrAccess.mjs";

/** An in-memory stand-in for `VcrDataStore`, with the real store's bounds. */
class StoreDouble {
  constructor() {
    /** @type {Map<string, any>} */ this.studies = new Map();
    /** @type {{ studyId: string, userId: string, role: string }[]} */ this.members = [];
    /** @type {Map<string, any>} */ this.sources = new Map();
    /** @type {any[]} */ this.grants = [];
    /** @type {Map<string, any>} */ this.snapshots = new Map();
    /** @type {Map<string, any[]>} */ this.fieldMaps = new Map();
    /** @type {any[]} */ this.auditRows = [];
  }

  /** @param {any} study */
  addStudy(study) {
    this.studies.set(study.id, { projectId: `prj_${study.id}`, deletedAt: null, ...study });
    return study.id;
  }

  /** @param {string} studyId @param {string} userId @param {string} role */
  addMember(studyId, userId, role) {
    if (!VCR_MEMBER_ROLES.includes(role)) throw new TypeError(`unknown role ${role}`);
    this.members.push({ studyId, userId, role });
  }

  /** @param {any} source */
  addSource(source) {
    this.sources.set(source.id, {
      studyId: null, allowedUses: [], visibleWindow: {}, status: "frozen", format: "csv", ...source,
    });
    return source.id;
  }

  /** @param {any} grant */
  addGrant(grant) {
    this.grants.push({
      fields: [], fieldMode: "allow", purposes: [], windowStart: null, windowEnd: null,
      revokedAt: null, role: null, studyId: null, ...grant,
    });
    return grant.id;
  }

  /** @param {any} snapshot */
  addSnapshot(snapshot) {
    this.snapshots.set(snapshot.id, { studyId: null, sealedFields: [], sealedUntil: null, ...snapshot });
    return snapshot.id;
  }

  /** @param {string} snapshotId @param {any[]} maps */
  setFieldMaps(snapshotId, maps) {
    this.fieldMaps.set(snapshotId, maps.map((map) => ({ identifier: false, timeKind: null, missingReason: null, ...map })));
  }

  // --- the surface `VcrAccess` uses -----------------------------------------

  async studyForAccess(studyId) {
    const study = this.studies.get(String(studyId));
    if (!study || study.deletedAt) return null;
    return { id: study.id, userId: study.userId, projectId: study.projectId };
  }

  async rolesOf(studyId, userId) {
    return this.members.filter((row) => row.studyId === studyId && row.userId === userId)
      .map((row) => row.role).sort();
  }

  async sourceFor(sourceId) {
    return this.sources.get(String(sourceId)) ?? null;
  }

  async liveGrants({ sourceId, studyId = null }) {
    if (!sourceId) throw new TypeError("sourceId is required.");
    return this.grants.filter((grant) => grant.sourceId === sourceId && !grant.revokedAt
      && (!studyId || grant.studyId == null || grant.studyId === studyId));
  }

  async getSnapshot(snapshotId) {
    return this.snapshots.get(String(snapshotId)) ?? null;
  }

  async listFieldMaps(snapshotId) {
    return this.fieldMaps.get(String(snapshotId)) ?? [];
  }

  async audit(entry) {
    if (!entry?.action) throw new TypeError("an audit row needs an action");
    this.auditRows.push(entry);
  }
}

/** A study owned by `owner` with one data source of its own. */
function scene() {
  const store = new StoreDouble();
  store.addStudy({ id: "std_1", userId: "owner" });
  store.addStudy({ id: "std_other", userId: "stranger" });
  store.addSource({ id: "src_1", userId: "partner", studyId: "std_1", allowedUses: ["vcr"] });
  store.addSnapshot({ id: "snp_1", sourceId: "src_1", studyId: "std_1", userId: "partner" });
  store.setFieldMaps("snp_1", [
    { columnName: "USUBJID", identifier: true },
    { columnName: "PATIENT_NAME", identifier: true },
    { columnName: "AGE" }, { columnName: "ECOG" }, { columnName: "OS_TIME" }, { columnName: "OS_EVENT" },
  ]);
  return { store, access: new VcrAccess({ store, now: () => new Date("2026-09-28T00:00:00Z") }) };
}

// ---------------------------------------------------------------------------
// AC-17: another account's study never exists
// ---------------------------------------------------------------------------

test("AC-17 another account's study reads exactly like one that never existed", async () => {
  const { store, access } = scene();
  const real = await access.judge({ actor: "outsider", studyId: "std_other", ability: "read" });
  const imaginary = await access.judge({ actor: "outsider", studyId: "std_does_not_exist", ability: "read" });
  assert.equal(real.allowed, false);
  assert.equal(imaginary.allowed, false);
  assert.equal(real.code, VCR_ACCESS_CODES.studyNotFound);
  assert.equal(real.code, imaginary.code, "the two refusals must be indistinguishable");
  assert.equal(real.reason, imaginary.reason);
  assert.deepEqual(real.roles, imaginary.roles);
  assert.equal(vcrAccessError(real).status, 404);
  assert.equal(store.auditRows.filter((row) => row.outcome === "denied").length, 2, "both refusals are on the record");
});

test("AC-17 a deleted study and a study with no member both read as not found", async () => {
  const { store, access } = scene();
  store.studies.get("std_1").deletedAt = "2026-09-01T00:00:00Z";
  assert.equal((await access.judge({ actor: "owner", studyId: "std_1", ability: "read" })).code,
    VCR_ACCESS_CODES.studyNotFound, "the owner of a deleted study is not a reader of it");
  store.studies.get("std_1").deletedAt = null;
  assert.equal((await access.judge({ actor: "nobody", studyId: "std_1", ability: "read" })).code,
    VCR_ACCESS_CODES.studyNotFound);
});

test("AC-17 an anonymous caller is refused before anything is looked up", async () => {
  const { store, access } = scene();
  const decision = await access.judge({ actor: "", studyId: "std_1", ability: "read" });
  assert.equal(decision.code, VCR_ACCESS_CODES.noActor);
  assert.equal(store.auditRows.length, 1);
  assert.equal(vcrAccessError(decision).status, 403);
});

// ---------------------------------------------------------------------------
// Roles: the owner is a lead, and abilities come from `roleAllows`
// ---------------------------------------------------------------------------

test("AC-17 the study owner is a lead without a member row", async () => {
  const { access } = scene();
  const decision = await access.judge({ actor: "owner", studyId: "std_1", ability: "manage_members" });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.roles, ["lead"]);
  assert.equal(decision.code, VCR_ACCESS_CODES.ok);
});

test("AC-17 a role that does not carry the ability is refused by name", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "viewer1", "viewer");
  const read = await access.judge({ actor: "viewer1", studyId: "std_1", ability: "read" });
  assert.equal(read.allowed, true);
  const run = await access.judge({ actor: "viewer1", studyId: "std_1", ability: "run" });
  assert.equal(run.allowed, false);
  assert.equal(run.code, VCR_ACCESS_CODES.roleForbids);
  assert.equal(vcrAccessError(run).status, 403, "a forbidden ability inside a visible study is a 403, not a 404");
  assert.match(run.reason, /角色/);
});

test("AC-17 one person holding two roles gets the union of what they allow", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "doctor", "site");
  store.addMember("std_1", "doctor", "clinical_reviewer");
  const decision = await access.judge({ actor: "doctor", studyId: "std_1", ability: "review_clinical" });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.roles, ["clinical_reviewer", "site"]);
  assert.equal((await access.judge({ actor: "doctor", studyId: "std_1", ability: "write_referrals" })).allowed, true);
  assert.equal((await access.judge({ actor: "doctor", studyId: "std_1", ability: "manage_members" })).allowed, false);
  await assert.rejects(() => access.judge({ actor: "doctor", studyId: "std_1", ability: "invent_an_ability" }), TypeError);
});

// ---------------------------------------------------------------------------
// The source, and the grant that is required to read it
// ---------------------------------------------------------------------------

test("AC-17 a source outside the study reads as not found, and a missing grant reads as a missing grant", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "dm", "data_manager");
  store.addSource({ id: "src_elsewhere", userId: "partner", studyId: "std_other" });
  const elsewhere = await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_elsewhere", ability: "read_patient_level",
  });
  assert.equal(elsewhere.code, VCR_ACCESS_CODES.sourceNotFound, "a source of another study does not exist here");
  assert.equal(vcrAccessError(elsewhere).status, 404);
  const noGrant = await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level",
  });
  assert.equal(noGrant.code, VCR_ACCESS_CODES.noGrant, "inside a study the caller can see, the missing grant is told plainly");
  assert.equal(vcrAccessError(noGrant).status, 403);
});

test("AC-17 the source's own account needs no grant, and a withdrawn source is refused", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "partner", "data_manager");
  assert.equal((await access.judge({
    actor: "partner", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level",
  })).allowed, true);
  store.sources.get("src_1").status = "withdrawn";
  const withdrawn = await access.judge({
    actor: "partner", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level",
  });
  assert.equal(withdrawn.code, VCR_ACCESS_CODES.sourceWithdrawn);
});

test("AC-17 a grant names a person, a role or the study, and a revoked one is not judged on", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "dm", "data_manager");
  store.addMember("std_1", "coord", "recruiter");
  assert.equal(granteeMatches("role:data_manager", "dm", "std_1", ["data_manager"]), true);
  assert.equal(granteeMatches("role:lead", "dm", "std_1", ["data_manager"]), false);
  assert.equal(granteeMatches("study:std_1", "anyone", "std_1", []), true);
  assert.equal(granteeMatches("study:std_other", "anyone", "std_1", []), false);
  assert.equal(granteeMatches("role:not_a_role", "dm", "std_1", ["not_a_role"]), false);

  const grantId = store.addGrant({ id: "grt_1", sourceId: "src_1", userId: "partner", grantee: "role:data_manager", purposes: ["vcr"] });
  assert.equal((await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", purpose: "vcr",
  })).grantId, grantId);
  assert.equal((await access.judge({
    actor: "coord", studyId: "std_1", sourceId: "src_1", ability: "read", purpose: "vcr",
  })).code, VCR_ACCESS_CODES.noGrant, "a role grant reaches only that role");
  store.grants[0].revokedAt = "2026-09-20T00:00:00Z";
  assert.equal((await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", purpose: "vcr",
  })).code, VCR_ACCESS_CODES.noGrant, "a revoked grant authorises nothing");
});

test("AC-17 a purpose outside the registration or the grant is refused", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "dm", "data_manager");
  store.addGrant({ id: "grt_1", sourceId: "src_1", userId: "partner", grantee: "dm", purposes: ["vcr"] });
  assert.equal((await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", purpose: "geo",
  })).code, VCR_ACCESS_CODES.purposeNotGranted, "the source's registered uses bind everyone");
  store.sources.get("src_1").allowedUses = ["vcr", "geo"];
  assert.equal((await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", purpose: "geo",
  })).code, VCR_ACCESS_CODES.purposeNotGranted, "and so does the grant's own list");
  assert.equal((await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", purpose: "vcr",
  })).allowed, true);
});

test("AC-17 a read outside the authorised window is refused by name", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "dm", "data_manager");
  store.addGrant({
    id: "grt_1", sourceId: "src_1", userId: "partner", grantee: "dm",
    windowStart: "2026-01-01T00:00:00Z", windowEnd: "2026-06-30T00:00:00Z",
  });
  const inside = await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", asOf: "2026-03-01T00:00:00Z",
  });
  assert.equal(inside.allowed, true);
  assert.equal(inside.asOf, "2026-03-01T00:00:00.000Z");
  for (const asOf of ["2025-12-31T00:00:00Z", "2026-07-01T00:00:00Z"]) {
    const outside = await access.judge({
      actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", asOf,
    });
    assert.equal(outside.code, VCR_ACCESS_CODES.outsideWindow, `${asOf} was admitted`);
  }
  // The source's own registered visible window binds as well as the grant's.
  store.grants[0].windowEnd = null;
  store.sources.get("src_1").visibleWindow = { end: "2026-02-01T00:00:00Z" };
  assert.equal((await access.judge({
    actor: "dm", studyId: "std_1", sourceId: "src_1", ability: "read_patient_level", asOf: "2026-03-01T00:00:00Z",
  })).code, VCR_ACCESS_CODES.outsideWindow);
});

// ---------------------------------------------------------------------------
// AC-06, AC-22, AC-32: sealed fields, and direct identifiers
// ---------------------------------------------------------------------------

test("AC-22 a sealed field is refused to everyone, the study lead included", async () => {
  const { store, access } = scene();
  store.addGrant({ id: "grt_all", sourceId: "src_1", userId: "partner", grantee: "study:std_1" });
  store.snapshots.get("snp_1").sealedFields = ["OS_TIME", "OS_EVENT"];
  store.snapshots.get("snp_1").sealedUntil = "2027-01-01T00:00:00Z";
  const decision = await access.judge({
    actor: "owner", studyId: "std_1", snapshotId: "snp_1", ability: "read_patient_level",
    fields: ["AGE", "ECOG", "OS_TIME"], purpose: "vcr",
  });
  assert.equal(decision.allowed, true, "the open fields are still readable");
  assert.deepEqual(decision.fields.allowed, ["AGE", "ECOG"]);
  assert.equal(decision.fields.denied.length, 1);
  assert.equal(decision.fields.denied[0].field, "OS_TIME");
  assert.equal(decision.fields.denied[0].code, VCR_ACCESS_CODES.fieldSealed);
  assert.match(decision.fields.denied[0].reason, /不做推断或填补/);
});

test("AC-22 asking only for sealed fields is a refusal, not an empty success", async () => {
  const { store, access } = scene();
  store.addGrant({ id: "grt_all", sourceId: "src_1", userId: "partner", grantee: "study:std_1" });
  store.snapshots.get("snp_1").sealedFields = ["OS_TIME", "OS_EVENT"];
  const decision = await access.judge({
    actor: "owner", studyId: "std_1", snapshotId: "snp_1", ability: "read_patient_level", fields: ["OS_TIME", "OS_EVENT"],
  });
  assert.equal(decision.allowed, false, "a caller that reads `allowed` alone must not proceed");
  assert.equal(decision.code, VCR_ACCESS_CODES.fieldSealed);
  assert.equal(decision.fields.denied.length, 2);
  assert.deepEqual(decision.fields.allowed, []);
});

test("AC-32 a seal that has lapsed stops refusing, and the judgment is on the record", async () => {
  const { store, access } = scene();
  store.addGrant({ id: "grt_all", sourceId: "src_1", userId: "partner", grantee: "study:std_1" });
  store.snapshots.get("snp_1").sealedFields = ["OS_TIME"];
  store.snapshots.get("snp_1").sealedUntil = "2026-09-01T00:00:00Z";
  const decision = await access.judge({
    actor: "owner", studyId: "std_1", snapshotId: "snp_1", ability: "read_patient_level", fields: ["OS_TIME"],
  });
  assert.equal(decision.allowed, true, "the seal lifted on 2026-09-01 and the judge runs at 2026-09-28");
  const still = await access.judge({
    actor: "owner", studyId: "std_1", snapshotId: "snp_1", ability: "read_patient_level",
    fields: ["OS_TIME"], asOf: "2026-08-01T00:00:00Z",
  });
  assert.equal(still.code, VCR_ACCESS_CODES.fieldSealed, "a read dated inside the seal is still sealed");
  const rows = store.auditRows.filter((row) => row.action === "access.read_patient_level");
  assert.equal(rows.length, 2, "allowed reads are recorded too, not only refusals");
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[1].outcome, "denied");
  assert.equal(rows[1].reason, VCR_ACCESS_CODES.fieldSealed);
  assert.deepEqual(rows[0].detail.fields, ["OS_TIME"]);
});

test("AC-03 a direct identifier is refused even under a grant that names it", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "dm", "data_manager");
  store.addGrant({ id: "grt_1", sourceId: "src_1", userId: "partner", grantee: "dm", fields: ["PATIENT_NAME", "AGE"] });
  const decision = await access.judge({
    actor: "dm", studyId: "std_1", snapshotId: "snp_1", ability: "read_patient_level", fields: ["PATIENT_NAME", "AGE"],
  });
  assert.deepEqual(decision.fields.allowed, ["AGE"]);
  assert.equal(decision.fields.denied[0].code, VCR_ACCESS_CODES.fieldIdentifying);
  assert.match(decision.fields.denied[0].reason, /假名编号/);
});

test("AC-17 a grant's field list narrows what may be read, in either direction", async () => {
  const { store, access } = scene();
  store.addMember("std_1", "dm", "data_manager");
  const allow = { fields: ["AGE"], fieldMode: "allow" };
  const deny = { fields: ["OS_TIME"], fieldMode: "deny" };
  assert.equal(grantAllowsField(allow, "AGE"), true);
  assert.equal(grantAllowsField(allow, "ECOG"), false);
  assert.equal(grantAllowsField(deny, "OS_TIME"), false);
  assert.equal(grantAllowsField(deny, "ECOG"), true);
  assert.equal(grantAllowsField({ fields: [], fieldMode: "allow" }, "anything"), true,
    "a grant written with no field list is source-wide, which is what it means");

  store.addGrant({ id: "grt_1", sourceId: "src_1", userId: "partner", grantee: "dm", ...allow });
  const decision = await access.judge({
    actor: "dm", studyId: "std_1", snapshotId: "snp_1", ability: "read_patient_level", fields: ["AGE", "ECOG"],
  });
  assert.deepEqual(decision.fields.allowed, ["AGE"]);
  assert.equal(decision.fields.denied[0].code, VCR_ACCESS_CODES.fieldNotGranted);
});

test("AC-17 a snapshot belonging to another study reads as not found", async () => {
  const { store, access } = scene();
  store.addSnapshot({ id: "snp_other", sourceId: "src_1", studyId: "std_other", userId: "partner" });
  const decision = await access.judge({
    actor: "owner", studyId: "std_1", snapshotId: "snp_other", ability: "read_patient_level",
  });
  assert.equal(decision.code, VCR_ACCESS_CODES.snapshotNotFound);
  assert.equal(vcrAccessError(decision).status, 404);
  assert.equal((await access.judge({
    actor: "owner", studyId: "std_1", snapshotId: "snp_nope", ability: "read",
  })).code, VCR_ACCESS_CODES.snapshotNotFound);
});

test("AC-17 `require` throws the refusal and returns the decision when allowed", async () => {
  const { access } = scene();
  await assert.rejects(
    () => access.require({ actor: "outsider", studyId: "std_1", ability: "read" }),
    (error) => error.status === 404 && error.code === VCR_ACCESS_CODES.studyNotFound);
  const decision = await access.require({ actor: "owner", studyId: "std_1", ability: "read" });
  assert.equal(decision.allowed, true);
});

test("AC-17 a failed audit write never turns an allowed read into a refusal", async () => {
  const { store, access } = scene();
  store.audit = async () => { throw new Error("the ledger is down"); };
  const decision = await access.judge({ actor: "owner", studyId: "std_1", ability: "read" });
  assert.equal(decision.allowed, true, "the judgment stands whether or not the ledger could be written");
});
