// Real PostgreSQL round trips must agree with the matching evaluator's UTC date-only semantics.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { VcrMatchStore } from "../src/vcrMatchStore.mjs";
import { VcrStore } from "../src/vcrStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required" };
let database, isolated, store, study;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrfactdates");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000 });
  store = new VcrMatchStore({ database });
  study = await new VcrStore({ database }).createStudy({ userId: "u_dates", projectId: "p_dates", name: "Fact dates", question: "q", dataTier: "T0" });
});
after(async () => { await database?.close(); await isolated?.drop(); });

const fact = (subjectKey) => ({ subjectKey, variable: "creatinine", value: 1.1, unit: "mg/dL", polarity: "affirmed",
  surface: "Creatinine 1.1 mg/dL", occurredAt: "2100-03-01", recordedAt: "2100-03-02", visibleAt: "2100-03-03" });
const save = (input) => store.saveFact({ studyId: study.id, userId: study.userId, fact: input });

for (const zone of ["UTC", "Asia/Shanghai"]) {
  test(`fact dates have the same UTC instant in ${zone}`, options, async () => {
    await database.transaction((client) => database.withTransactionClient(client, async () => {
      await client.query("SELECT set_config('TimeZone', $1, true)", [zone]);
      assert.equal((await client.query("SHOW TimeZone")).rows[0].TimeZone, zone);
      const input = fact(`patient_${zone}`);
      const saved = await save(input);
      assert.deepEqual([saved.occurredAt, saved.recordedAt, saved.visibleAt],
        ["2100-03-01T00:00:00.000Z", "2100-03-02T00:00:00.000Z", "2100-03-03T00:00:00.000Z"]);
      assert.deepEqual(await store.listFacts({ studyId: study.id, subjectKey: input.subjectKey }), [saved]);
      assert.equal((await store.listFacts({ studyId: study.id, subjectKey: input.subjectKey, visibleBy: "2100-03-02T23:59:59Z" })).length, 0);
      assert.equal((await store.listFacts({ studyId: study.id, subjectKey: input.subjectKey, visibleBy: "2100-03-03T00:00:00Z" })).length, 1);
      // Keep the historical raw-input key, so a repeated reading remains one fact and keeps its first visibility.
      const key = createHash("sha256").update(JSON.stringify([input.subjectKey, input.variable, input.polarity,
        input.value, input.unit, null, null, null, input.occurredAt, null])).digest("hex");
      assert.equal((await client.query("SELECT fact_key FROM evimed_vcr.matching_facts WHERE id=$1", [saved.id])).rows[0].fact_key, key);
      assert.deepEqual(await save({ ...input, visibleAt: "2100-03-04" }), saved);

      const zoned = await save({ ...fact(`zoned_${zone}`), occurredAt: "2024-02-29T23:59:59.123-05:00",
        recordedAt: "2024-03-01T12:59:59.123+08:00", visibleAt: "2024-03-01T04:59:59.123Z" });
      assert.deepEqual([zoned.occurredAt, zoned.recordedAt, zoned.visibleAt], Array(3).fill("2024-03-01T04:59:59.123Z"));
      const undated = await save({ ...fact(`undated_${zone}`), occurredAt: undefined, recordedAt: null });
      assert.equal(undated.occurredAt, null);
      assert.equal(undated.recordedAt, null);
    }));
  });
}

test("invalid calendar dates and ambiguous timestamps are rejected before a fact is stored", options, async () => {
  const badDates = ["2100-02-29", "2024-02-30T08:00:00Z", "0000-01-01", "2024-13-01", "2024-01-00", "2024-03-01T08:00:00",
    "2024-03-01T24:00:00Z", "03/01/2024", "", "not a date", 1709251200000];
  for (const field of ["occurredAt", "recordedAt", "visibleAt"]) {
    for (const value of badDates) {
      await assert.rejects(save({ ...fact("invalid"), [field]: value }), { status: 400, code: "vcr_payload_invalid" }, `${field}: ${value}`);
    }
  }
  assert.deepEqual(await store.listFacts({ studyId: study.id, subjectKey: "invalid" }), []);
});
