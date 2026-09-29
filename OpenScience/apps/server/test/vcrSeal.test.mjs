// Outcome sealing: the two timestamps that make 「事先规定」 provable.
//
// Nobody can answer afterwards whether the analysis plan was fixed before the
// outcomes were seen, so the platform records the order while it happens. This
// suite holds the rules that decide what is recorded, in what order, and what
// the package's cover is allowed to say about it.
import assert from "node:assert/strict";
import test from "node:test";
import {
  VCR_PLAN_FIELDS, VCR_SEALED_USES, VCR_SEAL_EXPLORATORY_NOTE, createVcrSeal, vcrOutcomeReadable, vcrPlanHash,
  vcrSealRequired, vcrSealState,
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
  assert.deepEqual(second.outcomeFieldsRead, ["pfs_event", "pfs_time", "os_event"], "the field list accumulates");
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

test("the data plane is told which fields to withhold, and a deployment without one still records the seal", async () => {
  /** @type {any[]} */
  const sealed = [];
  const store = storeDouble({ id: "std_1", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} });
  const withPlane = createVcrSeal({ store, dataPlane: { async sealFields(input) { sealed.push(input); } } });
  await withPlane.freezePlan({ studyId: "std_1", plan, sealedFields: ["pfs_event"], actor: "u1" });
  assert.deepEqual(sealed, [{ studyId: "std_1", fields: ["pfs_event"], until: null }]);

  const bare = createVcrSeal({ store: storeDouble({ id: "std_2", userId: "u1", intendedUse: "specified_analysis", outcomeSeal: {} }) });
  const state = await bare.freezePlan({ studyId: "std_2", plan, sealedFields: ["pfs_event"], actor: "u1" });
  assert.equal(state.planVersion, 1, "the seal is recorded even where no data plane can enforce it");
  assert.deepEqual(await bare.readable("std_2"), { readable: true, reason: "plan_frozen" });
});

test("a study that does not exist answers rather than throwing", async () => {
  const seal = createVcrSeal({ store: storeDouble({ id: "std_1", userId: "u1", intendedUse: "exploratory", outcomeSeal: {} }) });
  assert.equal(await seal.freezePlan({ studyId: "gone", plan }), null);
  assert.equal(await seal.recordOutcomeAccess({ studyId: "gone", fields: [] }), null);
  assert.deepEqual(await seal.readable("gone"), { readable: false, reason: "study_not_found" });
});
