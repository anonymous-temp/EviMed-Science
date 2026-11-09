import assert from "node:assert/strict";
import test from "node:test";
import { resolveJobSubject, vcrConversationSubject } from "../src/vcrSubjects.mjs";

// Live defect D1b (2026-11-07, phase 3, conversation a): three design grids a conversation started without a subjectId -- 250 per arm
// followed 30 months (power 83.6%), 250 per arm followed 240 months (89.0%), and a null check of 250 and 306 per arm -- were filed as
// versions 1, 2 and 3 of ONE grid object; the first two results were superseded, so the 83.6% the reply cited was on no page. A grid's
// defining inputs decide which grid it is, as a single design's do (vcrSubjectSizing.test.mjs).
const base = { design: { kind: "two_arm_fixed", nTreat: 250, nControl: 250 }, endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 12 },
  analysis: { method: "logrank", alpha: 0.025, sided: 1 } };
const followed30 = { ...base, accrual: { kind: "uniform", duration: 12, followup: 30 }, designs: [{ nTreat: 250, nControl: 250 }], truths: [{ hazardRatio: 0.75 }] };
const followed240 = { ...followed30, accrual: { kind: "uniform", duration: 12, followup: 240 } };
const nullCheck = { ...followed30, designs: [{ nTreat: 250, nControl: 250 }, { nTreat: 306, nControl: 306 }], truths: [{ hazardRatio: 1 }] };

/** A study's grids as the PostgreSQL store keeps them: one row per grid, its own id, a study-wide version, the newest read as current. */
function gridStore() {
  /** @type {any[]} */
  const grids = [];
  return { grids, store: {
    async latestDesignGrid() { return grids.at(-1) ?? null; },
    async methodConfigurationObject(/** @type {any} */ _client, /** @type {string} */ _studyId, /** @type {string} */ _kind, /** @type {string | null} */ subjectId,
      /** @type {Record<string, any>} */ scenario, /** @type {string} */ name) {
      const found = subjectId ? grids.find((row) => row.id === subjectId)
        : [...grids].reverse().find((row) => row.name === name && JSON.stringify({ ...row.dimensions.base, designs: row.dimensions.designs, truths: row.truthScenarios }) === JSON.stringify(scenario));
      return found ?? null;
    },
    async saveDesignGrid(/** @type {any} */ input) {
      const row = { id: `grd_${grids.length + 1}`, version: grids.length + 1, name: input.name, dimensions: input.dimensions, truthScenarios: input.truthScenarios, cells: [] };
      grids.push(row);
      return row;
    },
    async transaction(/** @type {(client: any) => Promise<any>} */ run) { return run({ query: async () => ({ rows: [] }) }); },
  } };
}
const study = { id: "std_1", userId: "u1", scope: "conversation" };

/** What the gateway's start does with a conversation's grid: make an object when none fits, then resolve the one it is about. */
async function fileGrid(/** @type {any} */ store, /** @type {Record<string, any>} */ scenario, /** @type {string | null} */ subjectId = null) {
  const madeFor = await vcrConversationSubject({ store, study, userId: "u1", kind: "design_grid", subjectId, scenario });
  return (await resolveJobSubject({ store, study, kind: "design_grid", subjectId: madeFor ?? subjectId, scenario })).row.id;
}

test("the live case: three grids with different follow-up, sizes and truth are three grids, and the same grid again is the same one", async () => {
  const { store, grids } = gridStore();
  const first = await fileGrid(store, followed30);
  const second = await fileGrid(store, followed240);
  const third = await fileGrid(store, nullCheck);
  assert.equal(new Set([first, second, third]).size, 3, `three grids, not three versions of one: ${[first, second, third]}`);
  assert.equal(grids.length, 3);
  assert.deepEqual(grids.map((row) => row.dimensions.base.accrual.followup), [30, 240, 30]);
  assert.deepEqual(grids[2].truthScenarios, [{ hazardRatio: 1 }]);
  // Each grid has a name of its own.
  assert.equal(new Set(grids.map((row) => row.name)).size, 3, grids.map((row) => row.name).join(", "));
  // The null check run again (another stage, the same scenario) is that grid, and a scenario that only adds to it too.
  assert.equal(await fileGrid(store, nullCheck), third);
  assert.equal(await fileGrid(store, { ...nullCheck, performance: ["type_one_error"] }), third);
  assert.equal(grids.length, 3);
});

test("a grid named by id and sent with other defining inputs is filed under a grid that holds them", async () => {
  const { store, grids } = gridStore();
  const first = await fileGrid(store, followed30);
  assert.equal(await fileGrid(store, followed30, first), first, "the named grid restated is that grid");
  // A grid written with labels is the grid its label-less scenario restates (the start leaves labels out before it files anything).
  grids[0].dimensions.designs = [{ nTreat: 250, nControl: 250, label: "A 每组 250" }];
  grids[0].truthScenarios = [{ hazardRatio: 0.75, label: "设计目标" }];
  assert.equal(await fileGrid(store, followed30, first), first, "a label only the object holds is no other grid");
  assert.equal(await fileGrid(store, followed30), first, "and the same holds without the id");
  assert.equal(grids.length, 1);
  const revised = await fileGrid(store, followed240, first);
  assert.notEqual(revised, first, "a 240-month follow-up is not the 30-month grid it names");
  assert.equal(grids.find((row) => row.id === revised)?.dimensions.base.accrual.followup, 240);
});
