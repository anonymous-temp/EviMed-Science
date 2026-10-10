// The orchestrator's two ticks serve their projects in turn: a tick takes at most a bound's worth of projects, the one it served longest
// ago first, so the project after the bound is reached by a later tick instead of never (the starvation class of the market's M-3, found in
// the schedule tick: it read the oldest 200 projects by creation and the 201st active project was never scheduled).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoOrchestrator } from "../src/geoOrchestrator.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {any} */ let isolated;
/** @type {ControlPlaneDatabase} */ let database;
/** @type {GeoStore} */ let store;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geoturn");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});
after(async () => {
  await database?.close();
  await isolated?.drop();
});
// Each case sees only its own projects: a tick takes every active project of the database, whoever made it.
beforeEach(async () => {
  if (database) await database.query("TRUNCATE evimed_geo.projects CASCADE");
});

/** Active projects of one account, oldest first. @param {number} count */
async function projects(count) {
  const userId = `turn-${randomUUID().slice(0, 8)}`;
  const made = [];
  for (let index = 0; index < count; index += 1) {
    made.push(await store.createProject({ userId, projectId: `p${index}-${randomUUID().slice(0, 6)}`, engines: ["deepseek"], coverageDays: 90 }));
  }
  return made;
}

/**
 * The store with a note of each project the schedule serves: its first read of a project is its baseline round, one per project served, in
 * the order served. `fail` makes that read throw for one project.
 * @param {string[]} ids @param {string[]} served @param {string | null} [fail]
 */
function scheduleSpy(ids, served, fail = null) {
  return new Proxy(store, {
    get(target, key) {
      if (key === "query") {
        return async (/** @type {string} */ sql, /** @type {any[]} */ values) => {
          if (/FROM evimed_geo\.rounds WHERE geo_project_id = \$1\s+AND kind IN \('baseline', 'single_step'\)/.test(sql) && ids.includes(values[0])) {
            served.push(values[0]);
            if (values[0] === fail) throw new Error("one project's failure");
          }
          return target.query(sql, values);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("the schedule tick takes its projects in turn: more projects than one tick can take are all reached, none starved", options, async () => {
  const made = await projects(5);
  const ids = made.map((project) => project.id);
  /** @type {string[]} */
  const served = [];
  const spy = scheduleSpy(ids, served);
  const orchestrator = new GeoOrchestrator({ store: /** @type {any} */ (spy), config: {}, projectsPerTick: 2, enqueueRound: async () => null });
  const rounds = [];
  for (let tick = 0; tick < 3; tick += 1) {
    served.length = 0;
    const counts = await orchestrator.tickSchedules();
    assert.ok(counts.projects <= 2, "a tick takes no more than its bound");
    rounds.push([...served]);
  }
  assert.deepEqual(rounds[0], [ids[0], ids[1]], "the first tick: the oldest projects, none served before");
  assert.deepEqual(rounds[1], [ids[2], ids[3]], "the next tick: the ones not yet served, not the same two again");
  assert.deepEqual(rounds[2], [ids[4], ids[0]], "then the last one, and the one served longest ago");
  assert.deepEqual(new Set(rounds.flat()), new Set(ids), "every project was reached within three ticks");
});

test("a paused project is not in the schedule's turn, and one that failed has had its turn all the same", options, async () => {
  const made = await projects(4);
  const ids = made.map((project) => project.id);
  await store.updateProject(made[1].userId, ids[1], { status: "paused" });
  /** @type {string[]} */
  const served = [];
  const spy = scheduleSpy(ids, served, ids[0]);
  const orchestrator = new GeoOrchestrator({ store: /** @type {any} */ (spy), config: {}, projectsPerTick: 2, enqueueRound: async () => null });
  await orchestrator.tickSchedules();
  assert.deepEqual(served, [ids[0], ids[2]], "the paused project is not scheduled; the first one's read fails and the tick goes on");
  assert.equal(orchestrator.status().counters.projectErrors, 1, "the failure is counted");
  served.length = 0;
  await orchestrator.tickSchedules();
  assert.deepEqual(served, [ids[3], ids[0]], "the project not yet served comes before the failed one, which does not sit at the front for good");
});

test("the program tick takes its projects in turn as well", options, async () => {
  const made = await projects(5);
  const ids = made.map((project) => project.id);
  const orchestrator = new GeoOrchestrator({ store, config: {}, projectsPerTick: 2 });
  /** @type {string[]} */
  let advanced = [];
  orchestrator.advance = async (/** @type {string} */ id) => { advanced.push(id); return { dispatched: null, deferred: null, enqueued: [] }; };
  const rounds = [];
  for (let tick = 0; tick < 3; tick += 1) {
    advanced = [];
    const counts = await orchestrator.tick();
    assert.ok(counts.projects <= 2, "a tick takes no more than its bound");
    rounds.push(advanced.filter((id) => ids.includes(id)));
  }
  assert.deepEqual(rounds.flat().slice(0, 4), [ids[0], ids[1], ids[2], ids[3]], "the ones not yet served come before any that has been");
  assert.deepEqual(new Set(rounds.flat()), new Set(ids), "every project was reached");
});

test("at the real bound: the 201st active project is reached by the second tick of either loop, not never", options, async () => {
  // 205 active projects and the bound of 200. Both loops used to read the same oldest 200 for ever (the program's by last update, the
  // schedule's by creation); the five after them were never advanced and never scheduled however many ticks passed.
  const made = await projects(205);
  const ids = new Set(made.map((project) => project.id));
  const orchestrator = new GeoOrchestrator({ store, config: {} });
  /** @type {Set<string>} */
  const advanced = new Set();
  orchestrator.advance = async (/** @type {string} */ id) => { advanced.add(id); return { dispatched: null, deferred: null, enqueued: [] }; };
  for (let tick = 0; tick < 2; tick += 1) await orchestrator.tick();
  assert.equal([...advanced].filter((id) => ids.has(id)).length, 205, "the program tick has advanced every project");
  /** @type {string[]} */
  const served = [];
  const scheduler = new GeoOrchestrator({ store: /** @type {any} */ (scheduleSpy([...ids], served)), config: {}, enqueueRound: async () => null });
  for (let tick = 0; tick < 2; tick += 1) await scheduler.tickSchedules();
  assert.equal(new Set(served).size, 205, "and the schedule tick has taken its turn with every project");
});
