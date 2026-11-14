// What a run is served of a document is filed on one row per study, conversation and document (`evimed_vcr.cloud_reads`). On
// production (2026-11-11) concurrent evidence searches of one conversation queued on that row: every served passage was its own
// INSERT … ON CONFLICT and UPDATE, and 35 of 111 searches were cancelled by the statement timeout (Postgres 57014). A read that adds
// nothing new must not wait for another transaction on the row; a read that adds a window still does, and is recorded once it can.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrDataStore } from "../src/vcrDataStore.mjs";
import { vcrId } from "../src/vcrStoreBase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** @type {any} */ let isolated = null;
/** @type {any} */ let database = null;
/** @type {VcrDataStore} */ let store;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrreads");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  // A short statement timeout turns a wait on the row into a failure the test can see.
  store = new VcrDataStore({ database, statementTimeoutMs: 1_000 });
  await store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** @param {number} start @param {number} end */
const windowAt = (start, end) => ({ hash: `h${start}-${end}`, served: [start, end], chars: 1000, extraction: "unknown" });

test("a read that adds nothing new to a conversation's read row never waits on it; a new window waits, then is recorded with the rest", options, async () => {
  const studyId = vcrId("study");
  await database.query(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, question, data_tier, intended_use)
    VALUES ($1, 'reads-owner', $2, 'reads', 'reads', 'T1', 'design_support')`, [studyId, `prj_${studyId}`]);
  const context = { sessionId: "ses_reads", runId: "run_reads" };
  await store.recordCloudRead(studyId, "doc_1", context);
  await store.recordCloudWindows(studyId, "doc_1", context, [windowAt(0, 10), windowAt(10, 20)]);

  // Another transaction updates the row and stays open, as a concurrent search's write does while its connection waits.
  const holder = new pg.Client({ connectionString: isolated.url });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("UPDATE evimed_vcr.cloud_reads SET windows=windows WHERE study_id=$1 AND session_id=$2 AND projection_id='doc_1'", [studyId, context.sessionId]);

    await store.recordCloudRead(studyId, "doc_1", { ...context, runId: "run_later" });
    await store.recordCloudWindows(studyId, "doc_1", context, [windowAt(0, 10)]);
    await store.recordCloudWindow(studyId, "doc_1", context, windowAt(10, 20));
    await assert.rejects(store.recordCloudWindows(studyId, "doc_1", context, [windowAt(0, 10), windowAt(20, 30)]),
      (/** @type {any} */ error) => error?.code === "57014", "a window not yet recorded still takes the row lock");

    await holder.query("ROLLBACK");
  } finally {
    await holder.end();
  }
  await store.recordCloudWindows(studyId, "doc_1", context, [windowAt(0, 10), windowAt(20, 30)]);
  const rows = (await database.query("SELECT run_id, windows FROM evimed_vcr.cloud_reads WHERE study_id=$1", [studyId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, "run_reads", "the conversation's first reading run stays the row's");
  assert.deepEqual(Object.keys(rows[0].windows).sort(), ["0-10:h0-10", "10-20:h10-20", "20-30:h20-30"]);
  assert.equal(rows[0].windows["20-30:h20-30"].runId, "run_reads");
});
