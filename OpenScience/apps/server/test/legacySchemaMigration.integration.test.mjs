import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateNotifications } from "../src/notificationPersistence.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { relationalIntegrity } from "../src/relationalIntegrity.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

test("legacy orphan rows do not block startup while every new foreign write is rejected", options, async () => {
  const adminUrl = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname));
  assert.match(adminUrl.pathname, /evimed_test/);
  const name = `evimed_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${name}`;
  let first;
  let second;
  try {
    first = new ControlPlaneDatabase({ databaseUrl: isolatedUrl.toString(), databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
    await first.query("SELECT 1");
    await migrateProductStore(first);
    await migrateNotifications(first);
    await migrateUsageLedger(first);
    await first.query(`DO $$ DECLARE row record; BEGIN
      FOR row IN SELECT n.nspname,t.relname,c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND n.nspname IN ('evimed_product','evimed_inbox','evimed_usage')
      LOOP EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I',row.nspname,row.relname,row.conname); END LOOP;
      END $$;
      INSERT INTO evimed_product.documents(user_id,kind,id,payload) VALUES('orphan','source','legacy-source','{}');
      INSERT INTO evimed_product.jobs(id,user_id,kind,idempotency_key,payload) VALUES('legacy-job','orphan','ingest','legacy-key','{}');
      INSERT INTO evimed_inbox.preferences(user_id) VALUES('orphan');
      INSERT INTO evimed_usage.model_requests(id,user_id,project_id,model,price_version,currency,request_fingerprint,status,reserved_cost,reservation_expires_at,created_at)
        VALUES('legacy-usage','orphan','missing','model','price','CNY',repeat('a',64),'released',0,now(),now());`);
    await first.close(); first = null;

    second = new ControlPlaneDatabase({ databaseUrl: isolatedUrl.toString(), databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
    await migrateProductStore(second);
    await migrateNotifications(second);
    await migrateUsageLedger(second);
    const constraints = await second.query(`SELECT c.conname,c.convalidated FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND n.nspname IN ('evimed_product','evimed_inbox','evimed_usage')
      AND c.conname IN ('product_documents_user_fk','product_jobs_user_fk','inbox_preferences_user_fk','usage_model_requests_user_fk') ORDER BY c.conname`);
    assert.equal(constraints.rowCount, 4);
    assert.equal(constraints.rows.every((row) => row.convalidated === false), true);
    await assert.rejects(second.query("INSERT INTO evimed_product.documents(user_id,kind,id,payload) VALUES('new-orphan','source','new-source','{}')"), { code: "23503" });
    assert.equal((await second.query("SELECT count(*)::integer AS count FROM evimed_product.documents WHERE user_id='orphan'")).rows[0].count, 1);
    const debt = await relationalIntegrity(second);
    assert.equal(debt.ok, false);
    assert.equal(debt.orphanTotal >= 4, true);
    assert.equal(debt.unvalidated.length >= 4, true);
    await second.query(`DELETE FROM evimed_product.jobs WHERE user_id='orphan';
      DELETE FROM evimed_product.documents WHERE user_id='orphan';
      DELETE FROM evimed_inbox.preferences WHERE user_id='orphan';
      DELETE FROM evimed_usage.model_requests WHERE user_id='orphan';`);
    const repaired = await relationalIntegrity(second, { validate: true });
    assert.equal(repaired.ok, true);
    assert.deepEqual(repaired.unvalidated, []);
  } finally {
    await first?.close().catch(() => {});
    await second?.close().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.close();
  }
});
