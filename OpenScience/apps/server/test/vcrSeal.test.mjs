// Outcome sealing: the two timestamps that make 「事先规定」 provable.
//
// Nobody can answer afterwards whether the analysis plan was fixed before the
// outcomes were seen, so the platform records the order while it happens. This
// suite holds the rules that decide what is recorded, in what order, and what
// the package's cover is allowed to say about it.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_PLAN_FIELDS, VCR_SEALED_USES, VCR_SEAL_EXPLORATORY_NOTE, createVcrSeal, vcrEffectiveSeal, vcrOutcomeColumns, vcrOutcomeReadable,
  vcrPlanHash, vcrSealRequired, vcrSealState,
} from "../src/vcrSeal.mjs";

/** A store double: one study in memory, the same shape `vcrStore` answers with. */
function storeDouble(study) {
  const rows = new Map([[study.id, { ...study }]]);
  /** @type {any[]} */
  const audits = [];
  return {
    audits,
    async studyById(id) { const row = rows.get(id); return row ? { ...row } : null; },
    async updateStudy(id, patch) {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },
    async audit(entry) { audits.push(entry); },
  };
}

const plan = {
  estimand: { population: "二线 NSCLC", variable: "PFS", intercurrentEvents: [{ event: "后续抗肿瘤治疗", strategy: "treatment_policy" }] },
  endpoint: { type: "time_to_event" },
  population: { id: "pop_1", version: 3 },
  comparator: { route: "external_control", estimand: "ATT" },
  analysis: { method: "comparator.entropy_balance" },
  assumptions: ["asm_a@3", "asm_b@1"],
  intendedUse: "specified_analysis",
};

test("a confirmatory use seals outcomes; an exploratory one does not", () => {
  assert.deepEqual([...VCR_SEALED_USES], ["specified_analysis", "submission_preparation"]);
  assert.equal(vcrSealRequired("specified_analysis"), true);
  assert.equal(vcrSealRequired("submission_preparation"), true);
  assert.equal(vcrSealRequired("design_support"), false);
  assert.equal(vcrSealRequired("exploratory"), false);
});

test("the plan hash covers the plan's own fields and nothing else", () => {
  const base = vcrPlanHash(plan);
  assert.match(base, /^[a-f0-9]{64}$/);
  // A field outside the plan cannot move the hash: an unrelated edit to the
  // study is not a changed plan.
  assert.equal(vcrPlanHash({ ...plan, studyName: "renamed", notes: "anything" }), base);
  // Key order does not move it either.
  assert.equal(vcrPlanHash(Object.fromEntries([...Object.entries(plan)].reverse())), base);
  // A field inside the plan does.
  assert.notEqual(vcrPlanHash({ ...plan, analysis: { method: "comparator.propensity_weight" } }), base);
  assert.ok(VCR_PLAN_FIELDS.includes("assumptions"));
  assert.notEqual(vcrPlanHash({ ...plan, assumptions: ["asm_a@4", "asm_b@1"] }), base);
});

test("AC-32 the plan freeze is recorded with its time and hash, and freezing the same plan again does not move the time", async () => {
  const study = { id: "std_1", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} };
  const store = storeDouble(study);
  let clock = Date.parse("2026-09-28T10:00:00Z");
  const seal = createVcrSeal({ store, now: () => new Date(clock) });

  const first = await seal.freezePlan({ studyId: "std_1", plan, sealedFields: ["pfs_event", "pfs_time", "os_event"], actor: "u1" });
  assert.equal(first.planFrozenAt, "2026-09-28T10:00:00.000Z");
  assert.equal(first.planHash, vcrPlanHash(plan));
  assert.equal(first.planVersion, 1);
  assert.deepEqual(first.sealedFields, ["pfs_event", "pfs_time", "os_event"]);
  assert.equal(first.ordered, true, "frozen, nothing read yet");

  clock += 3_600_000;
  const again = await seal.freezePlan({ studyId: "std_1", plan, actor: "u1" });
  assert.equal(again.unchanged, true);
  assert.equal(again.planFrozenAt, "2026-09-28T10:00:00.000Z", "a retried run cannot move the timestamp forward");
  assert.equal(again.planVersion, 1);

  // A real revision is a new version and keeps the old one.
  const revised = await seal.freezePlan({ studyId: "std_1", plan: { ...plan, analysis: { method: "comparator.maic" } }, actor: "u1" });
  assert.equal(revised.planVersion, 2);
  assert.equal(revised.planFrozenAt, "2026-09-28T11:00:00.000Z");
  assert.equal(revised.history.length, 1);
  assert.equal(revised.history[0].planHash, vcrPlanHash(plan), "the superseded freeze is kept, not overwritten");
});

test("AC-32 the first outcome read is recorded once, and the package gets both timestamps in order", async () => {
  const store = storeDouble({ id: "std_1", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} });
  let clock = Date.parse("2026-09-28T10:00:00Z");
  const seal = createVcrSeal({ store, now: () => new Date(clock) });
  await seal.freezePlan({ studyId: "std_1", plan, sealedFields: ["pfs_event"], actor: "u1" });

  clock = Date.parse("2026-09-28T12:00:00Z");
  const read = await seal.recordOutcomeAccess({ studyId: "std_1", fields: ["pfs_event", "pfs_time"], actor: "u1", reason: "comparator weighting" });
  assert.equal(read.outcomeFirstReadAt, "2026-09-28T12:00:00.000Z");
  assert.deepEqual(read.outcomeFieldsRead, ["pfs_event", "pfs_time"]);
  assert.equal(read.ordered, true, "the plan was frozen two hours before the first outcome was read");

  clock = Date.parse("2026-09-29T09:00:00Z");
  const second = await seal.recordOutcomeAccess({ studyId: "std_1", fields: ["os_event"], actor: "u1" });
  assert.equal(second.outcomeFirstReadAt, "2026-09-28T12:00:00.000Z", "only the first read sets the timestamp");
  assert.deepEqual(second.outcomeFieldsRead, ["os_event", "pfs_event", "pfs_time"], "the field list accumulates");
  assert.match(second.note, /2026-09-28T10:00:00\.000Z 冻结/);
  assert.match(second.note, /2026-09-28T12:00:00\.000Z 首次读取/);
});

test("AC-32 outcomes read before the plan was frozen read as out of order — recorded, never rewritten", () => {
  const state = vcrSealState({
    intendedUse: "submission_preparation",
    outcomeSeal: { planFrozenAt: "2026-09-28T12:00:00.000Z", outcomeFirstReadAt: "2026-09-28T10:00:00.000Z", planHash: "a".repeat(64) },
  });
  assert.equal(state.required, true);
  assert.equal(state.ordered, false);
  assert.match(state.note, /2026-09-28T10:00:00\.000Z 首次读取/);
});

test("outcome fields are unreadable under a confirmatory use until the plan is frozen, and always readable otherwise", () => {
  const unsealed = { intendedUse: "exploratory", outcomeSeal: {} };
  assert.deepEqual(vcrOutcomeReadable(unsealed), { readable: true, reason: "not_sealed" });
  assert.equal(vcrSealState(unsealed).note, VCR_SEAL_EXPLORATORY_NOTE);

  const beforeFreeze = { intendedUse: "specified_analysis", outcomeSeal: {} };
  assert.deepEqual(vcrOutcomeReadable(beforeFreeze), { readable: false, reason: "plan_not_frozen" });
  assert.equal(vcrSealState(beforeFreeze).ordered, false);

  const afterFreeze = { intendedUse: "specified_analysis", outcomeSeal: { planFrozenAt: "2026-09-28T10:00:00.000Z" } };
  assert.deepEqual(vcrOutcomeReadable(afterFreeze), { readable: true, reason: "plan_frozen" });
});

test("the data plane is asked to lift the seal as of the freeze instant — again on a retry — and a lift that fails does not undo the freeze", async () => {
  /** @type {any[]} */
  const lifts = [];
  let fail = false;
  const store = storeDouble({ id: "std_1", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} });
  const clock = Date.parse("2026-09-28T10:00:00Z");
  const withPlane = createVcrSeal({ store, now: () => new Date(clock), dataPlane: {
    async liftStudySeal(input) { if (fail) throw Object.assign(new Error("plane down"), { code: "vcr_data_plane_down" }); lifts.push(input); return [{ sealedFields: ["pfs_event"] }]; },
  } });
  const state = await withPlane.freezePlan({ studyId: "std_1", plan, actor: "u1" });
  assert.deepEqual(lifts.map((lift) => [lift.studyId, lift.at]), [["std_1", "2026-09-28T10:00:00.000Z"]], "lifted as of the instant the plan froze");
  assert.deepEqual(state.liftedFields, ["pfs_event"]);
  // The same plan again: nothing new is recorded, and the lift is asked for again (idempotent on the plane's side).
  const again = await withPlane.freezePlan({ studyId: "std_1", plan, actor: "u1" });
  assert.equal(again.unchanged, true);
  assert.equal(lifts.length, 2);
  // A plane that is down: the freeze stands and the failure is on the ledger.
  const other = storeDouble({ id: "std_2", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} });
  fail = true;
  const failing = createVcrSeal({ store: other, now: () => new Date(clock), dataPlane: { async liftStudySeal() { throw Object.assign(new Error("plane down"), { code: "vcr_data_plane_down" }); } } });
  const stood = await failing.freezePlan({ studyId: "std_2", plan, actor: "u1" });
  assert.equal(stood.planVersion, 1);
  assert.ok(other.audits.some((row) => row.action === "vcr.seal.lift_failed" && row.reason === "vcr_data_plane_down"));

  const bare = createVcrSeal({ store: storeDouble({ id: "std_3", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} }) });
  const recorded = await bare.freezePlan({ studyId: "std_3", plan, sealedFields: ["pfs_event"], actor: "u1" });
  assert.equal(recorded.planVersion, 1, "the seal is recorded even where no data plane can enforce it");
  assert.deepEqual(await bare.readable("std_3"), { readable: true, reason: "plan_frozen" });
});

test("the seal is written under a row lock: one SELECT … FOR UPDATE, one UPDATE, the audit row in the same transaction", async () => {
  /** @type {string[]} */
  const statements = [];
  let row = { id: "std_1", user_id: "u1", intended_use: "specified_analysis", outcome_seal: {} };
  const client = {
    async query(sql, values) {
      statements.push(sql.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" "));
      if (/^SELECT/.test(sql.trim())) return { rows: [row] };
      if (/^UPDATE/.test(sql.trim())) { row = { ...row, outcome_seal: JSON.parse(values[1]) }; return { rows: [] }; }
      throw new Error("unexpected statement");
    },
  };
  /** @type {any[]} */
  const audits = [];
  const store = {
    schema: "evimed_vcr",
    async transaction(work) { statements.push("BEGIN"); const out = await work(client); statements.push("COMMIT"); return out; },
    async audit(entry) { statements.push("AUDIT"); audits.push(entry); },
  };
  const seal = createVcrSeal({ store, now: () => new Date("2026-09-28T10:00:00Z") });
  await seal.freezePlan({ studyId: "std_1", plan, actor: "u1" });
  assert.deepEqual(statements, ["BEGIN", "SELECT id, user_id, intended_use,", "UPDATE evimed_vcr.studies SET outcome_seal", "AUDIT", "COMMIT"]);
  assert.equal(audits[0].client, client, "the audit row is in the transaction that changed the seal");
  statements.length = 0;
  await seal.freezePlan({ studyId: "std_1", plan, actor: "u1" });
  assert.deepEqual(statements, ["BEGIN", "SELECT id, user_id, intended_use,", "COMMIT"], "an unchanged plan writes nothing");
  statements.length = 0;
  await seal.recordOutcomeAccess({ studyId: "std_1", fields: ["os_time"], actor: "u1" });
  await seal.recordOutcomeAccess({ studyId: "std_1", fields: ["os_time"], actor: "u1" });
  assert.deepEqual(statements.filter((statement) => statement.startsWith("UPDATE")).length, 1, "a second read of the same field changes nothing");
});

test("the effective seal is decided from the study: confirmatory until the plan froze, then nothing; otherwise only a dated seal", () => {
  const now = Date.parse("2026-09-28T00:00:00Z");
  const snapshot = { sealedFields: ["os_time"], sealedUntil: null };
  const confirmatory = { intendedUse: "specified_analysis", outcomeSeal: {} };
  const held = vcrEffectiveSeal({ study: confirmatory, snapshot, outcomeColumns: ["os_event"], now });
  assert.deepEqual([...held.sealed].sort(), ["os_event", "os_time"]);
  assert.equal(held.reason, "plan_not_frozen");
  assert.equal(vcrEffectiveSeal({ study: { ...confirmatory, outcomeSeal: { planFrozenAt: "2026-09-01T00:00:00Z" } }, snapshot, outcomeColumns: ["os_event"], now }).sealed.size, 0);
  assert.equal(vcrEffectiveSeal({ study: { ...confirmatory, outcomeSeal: { planFrozenAt: "2026-10-01T00:00:00Z" } }, snapshot, outcomeColumns: [], now }).reason, "plan_not_frozen");
  const exploratory = { intendedUse: "exploratory", outcomeSeal: {} };
  assert.equal(vcrEffectiveSeal({ study: exploratory, snapshot, outcomeColumns: ["os_event"], now }).sealed.size, 0);
  assert.deepEqual([...vcrEffectiveSeal({ study: exploratory, snapshot: { ...snapshot, sealedUntil: "2026-12-01T00:00:00Z" }, now }).sealed], ["os_time"]);
  assert.equal(vcrEffectiveSeal({ study: null, snapshot: null, now }).reason, "not_sealed");
  assert.deepEqual(vcrOutcomeColumns([{ columnName: "AGE" }, { columnName: "T", role: "outcome_time" }, { column: "E", role: "outcome_event" }, { columnName: "S", outcome: true }, { columnName: "T", role: "outcome_time" }]), ["E", "S", "T"]);
});

test("a study that does not exist answers rather than throwing", async () => {
  const seal = createVcrSeal({ store: storeDouble({ id: "std_1", userId: "u1", intendedUse: "exploratory", outcomeSeal: {} }) });
  assert.equal(await seal.freezePlan({ studyId: "gone", plan }), null);
  assert.equal(await seal.recordOutcomeAccess({ studyId: "gone", fields: [] }), null);
  assert.deepEqual(await seal.readable("gone"), { readable: false, reason: "study_not_found" });
});

test("the model analysis plan is frozen first, under the analysis plan's own instant and hash, and its freeze is passed what the seal will become", async () => {
  const study = { id: "std_1", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} };
  const store = storeDouble(study);
  /** @type {string[]} */
  const order = [];
  const updateStudy = store.updateStudy;
  store.updateStudy = async (id, patch) => { order.push("seal-written"); return updateStudy(id, patch); };
  /** @type {any[]} */
  const frozen = [];
  const modelPlans = { async freeze(/** @type {any} */ input) { order.push("model-plan-frozen"); frozen.push(input); return { created: true, plan: { version: 1, contentHash: "h".repeat(64) } }; } };
  const seal = createVcrSeal({ store, modelPlans, now: () => new Date("2026-09-28T10:00:00Z") });
  const first = await seal.freezePlan({ studyId: "std_1", plan, actor: "orchestrator" });
  assert.deepEqual(order, ["model-plan-frozen", "seal-written"], "before the write that makes the outcome columns readable");
  assert.equal(frozen[0].frozenAt, first.planFrozenAt, "one instant for both");
  assert.deepEqual(frozen[0].seal, { planHash: vcrPlanHash(plan), planVersion: 1, outcomeFirstReadAt: null });
  assert.deepEqual(first.modelPlan, { version: 1, created: true, contentHash: "h".repeat(64) });
  // Frozen again with the same analysis plan: the seal does not move, and the model plan is asked again (its content may have changed).
  await seal.freezePlan({ studyId: "std_1", plan, actor: "runtime" });
  assert.equal(frozen[1].seal.planVersion, 1, "an unchanged analysis plan keeps its version");
  // A changed plan is version 2, and an outcome read in between is what the model plan is told.
  await seal.recordOutcomeAccess({ studyId: "std_1", fields: ["pfs_time"], actor: "analyst" });
  await seal.freezePlan({ studyId: "std_1", plan: { ...plan, analysis: { method: "comparator.propensity_weight" } }, actor: "runtime" });
  assert.equal(frozen[2].seal.planVersion, 2);
  assert.ok(frozen[2].seal.outcomeFirstReadAt, "the read that came first is on the record");
});

test("a model analysis plan that cannot be frozen is audited and the analysis plan freezes anyway; a seal with no model plan service is unchanged", async () => {
  const store = storeDouble({ id: "std_1", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} });
  const seal = createVcrSeal({ store, modelPlans: { async freeze() { throw Object.assign(new Error("boom"), { code: "XX000" }); } } });
  const frozen = await seal.freezePlan({ studyId: "std_1", plan, actor: "runtime" });
  assert.ok(frozen?.planFrozenAt, "the analysis plan froze");
  assert.equal(frozen?.modelPlan, null);
  assert.deepEqual(store.audits.filter((entry) => entry.action === "vcr.model_plan.freeze_failed").map((entry) => [entry.outcome, entry.reason]), [["failed", "XX000"]]);
  const without = createVcrSeal({ store: storeDouble({ id: "std_2", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} }) });
  assert.equal((await without.freezePlan({ studyId: "std_2", plan, actor: "runtime" }))?.modelPlan, null);
});
