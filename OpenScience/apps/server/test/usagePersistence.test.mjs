// The usage ledger's purpose CHECK migration, without a database: what it decides from the constraints the table holds, and that it adds the
// constraint NOT VALID in one transaction and validates it in another. The same migration on a real PostgreSQL is in
// `usageLedger.integration.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";

import { USAGE_PURPOSES } from "@evimed/domain";

import { USAGE_PURPOSE_CHECK, migrateUsageLedger, purposeCheckPlan } from "../src/usagePersistence.mjs";

/** A CHECK as PostgreSQL writes its list back. @param {readonly string[]} purposes @param {boolean} [validated] */
const definition = (purposes, validated = true) => `CHECK ((purpose = ANY (ARRAY[${purposes.map((purpose) => `'${purpose}'::text`).join(", ")}])))${validated ? "" : " NOT VALID"}`;
const OLDER = "usage_model_requests_purpose_000000000000_check";
const NEWER = "usage_model_requests_purpose_ffffffffffff_check";

test("the purpose CHECK is replaced only when the one the table holds does not admit every purpose of this release", () => {
  // None yet, or an older list: replaced, and the new one validated.
  assert.deepEqual(purposeCheckPlan([]), { drop: [], add: true, validate: USAGE_PURPOSE_CHECK });
  assert.deepEqual(purposeCheckPlan([{ name: OLDER, definition: definition(["kernel", "other"]), validated: true }]),
    { drop: [OLDER], add: true, validate: USAGE_PURPOSE_CHECK });
  // This release's own: nothing to do, or only the validation a start before this one did not finish.
  assert.deepEqual(purposeCheckPlan([{ name: USAGE_PURPOSE_CHECK, definition: definition(USAGE_PURPOSES), validated: true }]), { drop: [], add: false, validate: null });
  assert.deepEqual(purposeCheckPlan([{ name: USAGE_PURPOSE_CHECK, definition: definition(USAGE_PURPOSES, false), validated: false }]),
    { drop: [], add: false, validate: USAGE_PURPOSE_CHECK });
  // A later release's wider list (a rollback to this one): kept, so the rows of the newer purpose are not refused and the start does not fail.
  const wider = { name: NEWER, definition: definition([...USAGE_PURPOSES, "future-work"]), validated: true };
  assert.deepEqual(purposeCheckPlan([wider]), { drop: [], add: false, validate: null });
  assert.deepEqual(purposeCheckPlan([wider, { name: OLDER, definition: definition(["kernel"]), validated: true }]), { drop: [OLDER], add: false, validate: null });
  // A list that lacks one of this release's purposes is not wider, whatever it adds; a purpose is matched whole, never as a prefix.
  const lacking = USAGE_PURPOSES.filter((purpose) => purpose !== "evidence");
  assert.deepEqual(purposeCheckPlan([{ name: NEWER, definition: definition([...lacking, "future-work"]), validated: true }]).add, true);
  assert.ok(USAGE_PURPOSES.includes("evidence-upkeep"), "evidence-upkeep is listed, and must not stand for evidence");
  // Constraints that are not purpose CHECKs are none of its business.
  assert.deepEqual(purposeCheckPlan([{ name: "usage_model_requests_currency_check", definition: "CHECK ((currency = 'CNY'::text))", validated: true }]),
    { drop: [], add: true, validate: USAGE_PURPOSE_CHECK });
});

/** A database that records each transaction's statements and answers the catalogue reads. @param {any[]} held the purpose CHECKs the table holds */
function recordingDatabase(held) {
  /** @type {string[][]} */ const transactions = [];
  return {
    transactions,
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      /** @type {string[]} */ const statements = [];
      transactions.push(statements);
      return work({ async query(/** @type {string} */ sql, /** @type {unknown[]} */ params = []) {
        statements.push(sql);
        if (/FROM pg_constraint\s+WHERE conrelid='evimed_usage\.model_requests'::regclass AND contype='c'/.test(sql)) return { rows: held, rowCount: held.length };
        if (/AND NOT convalidated/.test(sql)) return { rows: [{}], rowCount: held.some((row) => row.name === params[0] && row.validated) ? 0 : 1 };
        return { rows: [], rowCount: 0 };
      } });
    },
  };
}

test("the purpose CHECK is added NOT VALID in one transaction and validated in a second, so reservations are not held behind the scan", async () => {
  const database = recordingDatabase([{ name: OLDER, definition: definition(["kernel", "other"]), validated: true }]);
  await migrateUsageLedger(database);
  assert.equal(database.transactions.length, 2);
  const [first, second] = database.transactions;
  assert.ok(first.some((sql) => sql === `ALTER TABLE evimed_usage.model_requests DROP CONSTRAINT ${OLDER}`));
  const add = first.find((sql) => sql.includes(`ADD CONSTRAINT ${USAGE_PURPOSE_CHECK}`));
  assert.ok(add && /NOT VALID\s*$/.test(add), "added NOT VALID");
  for (const purpose of USAGE_PURPOSES) assert.ok(add.includes(`'${purpose}'`));
  assert.ok(first.every((sql) => !sql.includes(`VALIDATE CONSTRAINT ${USAGE_PURPOSE_CHECK}`)), "no validation in the transaction that took the ACCESS EXCLUSIVE lock");
  assert.ok(first.join("\n").indexOf("pg_advisory_xact_lock") < first.join("\n").indexOf("ADD CONSTRAINT"));
  assert.deepEqual(second.filter((sql) => /VALIDATE CONSTRAINT/.test(sql)), [`ALTER TABLE evimed_usage.model_requests VALIDATE CONSTRAINT ${USAGE_PURPOSE_CHECK}`]);
  // Once per database object, however often it is asked.
  await migrateUsageLedger(database);
  assert.equal(database.transactions.length, 2);
});

test("a later release's wider purpose CHECK is left alone, and nothing is validated", async () => {
  const database = recordingDatabase([{ name: NEWER, definition: definition([...USAGE_PURPOSES, "future-work"]), validated: true }]);
  await migrateUsageLedger(database);
  assert.equal(database.transactions.length, 1);
  assert.ok(database.transactions[0].every((sql) => !/(DROP|ADD|VALIDATE) CONSTRAINT usage_model_requests_purpose_/.test(sql)));
});
