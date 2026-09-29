import assert from "node:assert/strict";
import test from "node:test";

import { VCR_COMPARATOR_ROUTES, VCR_CONCLUSIONS, VCR_CRITERION_STATES, VCR_JOB_STATES, VCR_MEMBER_ROLES, VCR_REFERRAL_STATES, VCR_VALUE_SOURCES } from "@evimed/domain";

import { VCR_SCHEMA, VCR_TABLES, vcrSchemaSql } from "../src/vcrPersistence.mjs";
import { VCR_ID_PREFIXES, vcrId } from "../src/vcrStoreBase.mjs";

/**
 * The schema as text. These run without a database on purpose: the DDL is the
 * contract seven work packages code against, and a typo in it is a merge-day
 * problem, not a deployment-day one. `vcrPersistence.integration.test.mjs`
 * runs the same text against PostgreSQL.
 */
const sql = vcrSchemaSql();

test("every table the module declares is created, and every created table is declared", () => {
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS evimed_vcr\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...created].sort(), [...VCR_TABLES].sort(),
    "a table created and not listed is a table no deletion path cleans up");
  assert.equal(new Set(created).size, created.length, "a table is created twice");
  assert.equal(VCR_SCHEMA, "evimed_vcr");
});

test("the schema is one idempotent, additive script", () => {
  const creates = [...sql.matchAll(/CREATE (TABLE|INDEX|SCHEMA)( UNIQUE)?/g)].length;
  const guarded = [...sql.matchAll(/CREATE (?:TABLE|INDEX|SCHEMA) IF NOT EXISTS/g)].length;
  assert.equal(creates, guarded, "every statement is IF NOT EXISTS, so a second start is a no-op");
  assert.ok(!/DROP |ALTER TABLE [a-z_.]+ DROP/i.test(sql), "the migration never drops anything");
});

test("patient-level rows have no home in this schema", () => {
  // The data plane holds the rows; this schema holds a reference and a hash
  // (plan §8.1). A table here with a patient row in it would put it one join
  // away from everything the model can already read.
  assert.ok(/snapshots[\s\S]*?location\s+text NOT NULL/.test(sql));
  assert.ok(/snapshots[\s\S]*?sha256\s+text NOT NULL/.test(sql));
  for (const table of ["patient_rows", "raw_rows", "subject_rows"]) {
    assert.ok(!VCR_TABLES.includes(table), `${table} would hold patient-level rows`);
  }
});

test("closed vocabularies reach the schema as CHECKs", () => {
  for (const word of VCR_CONCLUSIONS) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
  for (const word of VCR_CRITERION_STATES) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
  for (const word of VCR_REFERRAL_STATES) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
  for (const word of VCR_MEMBER_ROLES) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
  for (const word of VCR_COMPARATOR_ROUTES) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
  for (const word of VCR_JOB_STATES) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
  for (const word of VCR_VALUE_SOURCES) assert.ok(sql.includes(`'${word}'`), `${word} is not CHECKed anywhere`);
});

test("a study is one ordinary project, once per account", () => {
  assert.match(sql, /evimed_vcr\.studies[\s\S]*?UNIQUE \(user_id, project_id\)/);
});

test("the objects a result is built from are versioned, so nothing is recomputed under a finished result", () => {
  for (const table of ["study_definitions", "protocol_versions", "populations", "patient_sets", "comparator_designs", "design_grids"]) {
    const block = sql.slice(sql.indexOf(`evimed_vcr.${table} (`));
    assert.match(block.slice(0, 1_200), /version\s+integer NOT NULL/, `${table} is not versioned`);
  }
  assert.match(sql, /evimed_vcr\.assumptions[\s\S]*?UNIQUE \(study_id, key, version\)/);
});

test("a job can be cancelled, checkpointed and held at a budget, and is claimed once", () => {
  const block = sql.slice(sql.indexOf("evimed_vcr.jobs ("), sql.indexOf("CREATE INDEX IF NOT EXISTS vcr_jobs_claim_idx"));
  for (const column of ["cancel_requested", "checkpoint", "progress", "cpu_seconds_limit", "cpu_seconds_used", "lease_owner", "lease_until", "idempotency_key"]) {
    assert.ok(block.includes(column), `jobs has no ${column}`);
  }
  assert.ok(block.includes("awaiting_budget") || sql.includes("'awaiting_budget'"), "a job cannot wait for a budget confirmation");
  assert.match(block, /UNIQUE \(user_id, idempotency_key\)/);
});

test("executions and snapshots are immutable records, and audit outlives its object", () => {
  assert.match(sql, /evimed_vcr\.executions[\s\S]*?environment\s+jsonb/);
  assert.match(sql, /evimed_vcr\.executions[\s\S]*?output_hash\s+text/);
  assert.match(sql, /evimed_vcr\.snapshots[\s\S]*?UNIQUE \(source_id, version\)/);
  // The audit table takes no foreign key into studies: deleting a study must
  // not delete the record that it existed.
  const audit = sql.slice(sql.indexOf("evimed_vcr.audit ("), sql.indexOf("CREATE INDEX IF NOT EXISTS vcr_audit_study_idx"));
  assert.ok(!audit.includes("REFERENCES"), "audit rows would be deleted with the study they describe");
});

test("a sealed outcome field is a column on the snapshot, not a convention", () => {
  assert.match(sql, /snapshots[\s\S]*?sealed_fields\s+text\[\]/);
  assert.match(sql, /snapshots[\s\S]*?sealed_until\s+timestamptz/);
});

test("a screen failure points at the criterion that failed", () => {
  assert.match(sql, /referrals[\s\S]*?screen_fail_criterion_id\s+text REFERENCES evimed_vcr\.criteria\(id\)/);
});

test("contacting a patient is a column two people have to fill", () => {
  assert.match(sql, /referrals[\s\S]*?contact_approved_by\s+text/);
  assert.match(sql, /referrals[\s\S]*?contact_approved_at\s+timestamptz/);
});

test("ids carry their kind, and an unknown kind is refused", () => {
  assert.match(vcrId("study"), /^std_[0-9a-f]{22}$/);
  assert.match(vcrId("assumption"), /^asm_[0-9a-f]{22}$/);
  assert.notEqual(vcrId("job"), vcrId("job"));
  assert.throws(() => vcrId(/** @type {any} */("nonsense")));
  assert.equal(new Set(Object.values(VCR_ID_PREFIXES)).size, Object.values(VCR_ID_PREFIXES).length,
    "two object kinds share a prefix, so a log line cannot be read");
});
