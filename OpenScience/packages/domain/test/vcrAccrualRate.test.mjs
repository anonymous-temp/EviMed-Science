// 「每月入组 20 人」 is a rate. The platform accepts it as stated, derives the duration by code (people / rate, in the scenario's unit)
// before the scenario is frozen, and refuses it where the people are the thing the method computes (plan R12).
import assert from "node:assert/strict";
import test from "node:test";
import { validateScenario, vcrDeriveAccrualDuration, vcrNormalizeScenarioKeys } from "../index.mjs";

const SIM = Object.freeze({
  design: { kind: "two_arm_fixed", nTreat: 300, nControl: 300 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 12 },
  analysis: { alpha: 0.025, sided: 1 }, accrual: { rate: 20, followup: 24 }, timeUnit: "months",
});
const codes = (/** @type {any} */ scenario) => validateScenario("design.simulate", scenario).map((issue) => `${issue.code}@${issue.field}`);

test("a rate per month gives the duration of its people, in the scenario's unit, and the scenario then validates", () => {
  assert.deepEqual(codes(SIM), ["scenario_field_missing@scenario.accrual.duration"], "the key is read by the schema, and a rate that reaches the engine alone is refused, not run with no duration");
  const read = vcrNormalizeScenarioKeys("design.simulate", SIM);
  assert.equal(read.conflicts.length, 0);
  assert.equal(read.scenario.accrual.duration, 30, "600 people at 20 a month");
  assert.equal(read.scenario.accrual.rate, 20, "the rate stays as stated");
  assert.deepEqual(read.applied.map((entry) => [entry.field, entry.value]), [["accrual.duration", 30]]);
  assert.match(read.applied[0].took, /^derived: 600 people at 20 per months take 30 months/);
  assert.deepEqual(codes(read.scenario), []);
  assert.equal(SIM.accrual.duration, undefined, "the input is not mutated");
});

test("an unequal allocation and another unit: the sizes add up, and the rate's unit is converted exactly", () => {
  const unequal = vcrNormalizeScenarioKeys("design.simulate", { ...SIM, design: { kind: "two_arm_fixed", nTreat: 200, nControl: 100 } });
  assert.equal(unequal.scenario.accrual.duration, 15);
  const noControl = vcrNormalizeScenarioKeys("design.simulate", { ...SIM, design: { kind: "two_arm_fixed", nTreat: 50 } });
  assert.equal(noControl.scenario.accrual.duration, 5, "nControl defaults to the treatment arm, as the engine takes it");
  const weekly = vcrNormalizeScenarioKeys("design.simulate", { ...SIM, timeUnit: "weeks", accrual: { rate: 10, rateUnit: "weeks", followup: 52 } });
  assert.equal(weekly.scenario.accrual.duration, 60);
  const mixed = vcrNormalizeScenarioKeys("design.simulate", { ...SIM, timeUnit: "months", accrual: { rate: 12, rateUnit: "years", followup: 24 } });
  assert.equal(mixed.scenario.accrual.duration, 600 / 12 * 12, "50 years of enrolment at 12 a year is 600 months");
});

test("a duration beside the rate is kept when it is the rate's quotient and refused when it is not", () => {
  assert.equal(vcrNormalizeScenarioKeys("design.simulate", { ...SIM, accrual: { rate: 20, duration: 30, followup: 24 } }).conflicts.length, 0);
  const wrong = vcrNormalizeScenarioKeys("design.simulate", { ...SIM, accrual: { rate: 20, duration: 12, followup: 24 } });
  assert.equal(wrong.conflicts[0].field, "scenario.accrual.duration");
  assert.match(wrong.conflicts[0].detail, /600 people at 20 per months take 30 months/);
});

test("a rate that cannot give a duration is refused by name with the reason and nothing else changes", () => {
  const analytic = { design: { kind: "two_arm_fixed" }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 12 },
    analysis: { alpha: 0.025, power: 0.9, sided: 1 }, accrual: { rate: 20, followup: 12 }, timeUnit: "months" };
  const read = vcrNormalizeScenarioKeys("design.analytic", analytic);
  assert.equal(read.conflicts[0].field, "scenario.accrual.rate");
  assert.match(read.conflicts[0].detail, /computes the number of people/);
  assert.deepEqual(read.scenario, analytic);
  for (const rate of [0, -3, "20", Number.NaN]) assert.equal(vcrDeriveAccrualDuration("design.simulate", { ...SIM, accrual: { rate } }).conflicts[0]?.field, "scenario.accrual.rate", String(rate));
  assert.equal(vcrDeriveAccrualDuration("design.simulate", { ...SIM, accrual: { rate: 20, rateUnit: "fortnights" } }).conflicts[0].field, "scenario.accrual.rateUnit");
  assert.equal(vcrDeriveAccrualDuration("design.simulate", { ...SIM, design: { kind: "single_arm", n: 40 } }).conflicts[0].field, "scenario.accrual.rate");
  // no rate: nothing is touched
  const none = { ...SIM, accrual: { duration: 12, followup: 12 } };
  assert.equal(vcrDeriveAccrualDuration("design.simulate", none).scenario, none);
});

test("every method whose schema carries accrual.rate derives the duration: the generators (control arm defaults to none) and a grid whose designs enrol the same", () => {
  const gen = { design: { nTreat: 100, nControl: 100 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 },
    accrual: { rate: 10, followup: 12 }, timeUnit: "months" };
  const made = vcrNormalizeScenarioKeys("patients.time_to_event", gen);
  assert.equal(made.conflicts.length, 0);
  assert.equal(made.scenario.accrual.duration, 20, "200 people at 10 a month");
  assert.match(made.applied[0].took, /^derived: 200 people at 10 per months/);
  assert.deepEqual(validateScenario("patients.time_to_event", made.scenario).map((issue) => issue.code), []);
  const noControl = vcrNormalizeScenarioKeys("patients.time_to_event", { ...gen, design: { nTreat: 100 } });
  assert.equal(noControl.scenario.accrual.duration, 10, "a generator's control arm defaults to none, as the engine takes it");
  const grid = { design: { kind: "two_arm_fixed", nTreat: 10 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.7, controlMedian: 12 },
    accrual: { rate: 10, followup: 12 }, timeUnit: "months",
    designs: [{ kind: "two_arm_fixed", nTreat: 100, nControl: 100 }, { kind: "group_sequential", nTreat: 150, nControl: 50, informationRates: [0.5, 1], spending: "obrien_fleming" }],
    truths: [{ hazardRatio: 0.7, controlMedian: 12 }] };
  assert.equal(vcrNormalizeScenarioKeys("design.grid", grid).scenario.accrual.duration, 20);
  const unequal = vcrNormalizeScenarioKeys("design.grid", { ...grid, designs: [{ kind: "two_arm_fixed", nTreat: 100 }, { kind: "two_arm_fixed", nTreat: 50 }] });
  assert.equal(unequal.conflicts[0].field, "scenario.accrual.rate", "designs of different sizes have no one duration; the rate is refused by name");
  assert.equal(unequal.scenario.accrual.duration, undefined);
  // the schema's reading and the derivation's agree: every method the schema gives a rate key derives, and the others refuse by name
  const keyed = ["design.simulate", "design.grid", "patients.continuous", "patients.binary", "patients.time_to_event", "design.analytic", "design.confirmatory"];
  for (const method of keyed) {
    const offered = validateScenario(method, { design: { kind: "futility_group_sequential" }, endpoint: { type: "time_to_event" }, accrual: { rate: 5 } }).every((issue) => issue.field !== "scenario.accrual.rate");
    const derives = !vcrDeriveAccrualDuration(method, { design: { kind: "two_arm_fixed", nTreat: 10, nControl: 10 }, designs: [{ kind: "two_arm_fixed", nTreat: 10, nControl: 10 }], accrual: { rate: 5 } }).conflicts.length;
    assert.equal(offered, derives, `${method}: the schema ${offered ? "reads" : "refuses"} accrual.rate and the derivation ${derives ? "gives" : "refuses"} a duration`);
  }
});
