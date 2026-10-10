// The value profiles' upkeep without a database (G10c): the account of every place a profile's version number is stored, and the loop's inputs.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { createGeoValueUpkeep } from "../src/geoValueUpkeep.mjs";

const SRC = new URL("../src/", import.meta.url);

test("every file that records which version of a value profile something stood on is accounted for by the pruning's table of references", async () => {
  // A version is pruned unless something points to it, so a pointer the pruning does not know about is how a version is lost. These words
  // write or read a version number; a file not named here that uses one has found a reference to add to `GEO_VALUE_REFERENCES` (and to
  // this list, with the object that holds it).
  const accounted = {
    "geoJudge.mjs": "facts.judge_extract.valueBasisVersion: the version an answer was judged against",
    "geoMeasureStore.mjs": "rounds.ref.evaluationBasis.value.version: the profile a round froze when it started",
    "geoOrchestrator.mjs": "schedule_marks.detail.basisVersion: the version a research request was made on",
    "geoService.mjs": "the value read, which reports the basis version of the observations it counts",
    "geoStore.mjs": "articles.value_context.basisVersion: the version an article stands on",
    "geoValueImport.mjs": "the research result the profile itself holds, copied from the request",
    "geoValueStore.mjs": "the coverage read, which groups the observations by the basis version of the answer",
    "geoValueUpkeep.mjs": "the pruning, whose table of references this is",
  };
  const found = [];
  for (const name of (await readdir(SRC)).filter((entry) => /^geo.*\.mjs$/.test(entry)).sort()) {
    if (/\b(?:basisVersion|valueBasisVersion|evaluationBasis)\b/.test(await readFile(new URL(name, SRC), "utf8"))) found.push(name);
  }
  assert.deepEqual(found, Object.keys(accounted).sort(), "a file that records a version of the profile is named here and in the table, or the pruning loses it");
});

test("the upkeep needs its store, and keeps twenty versions and prunes two hundred a tick unless the deployment says otherwise", async () => {
  assert.throws(() => createGeoValueUpkeep(/** @type {any} */ ({})), /needs the GEO store/);
  const asked = [];
  const upkeep = createGeoValueUpkeep({ store: { query: async (/** @type {string} */ _sql, /** @type {unknown[]} */ values) => { asked.push(values); return { rows: [] }; } } });
  assert.deepEqual(await upkeep.tick(), { projectsChecked: 0, versionsPruned: 0, projectsPruned: 0, watchProjects: 0, changesFlagged: 0 });
  assert.deepEqual(asked, [[20]]);
  const narrower = createGeoValueUpkeep({ store: { query: async (/** @type {string} */ _sql, /** @type {unknown[]} */ values) => { asked.push(values); return { rows: [] }; } },
    config: { geoValueKeepVersions: 5 } });
  await narrower.tick();
  assert.deepEqual(asked.at(-1), [5]);
});
