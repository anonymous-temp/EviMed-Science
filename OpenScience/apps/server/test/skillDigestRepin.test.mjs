// A re-pin is a change to what content *is*, never to what was concluded about
// it. Both halves of that sentence are load-bearing and both are asserted here:
// the security review fields survive untouched, and the diff a reviewer reads
// contains nothing but digests.
//
// The second one is not pedantry. The first implementation re-serialised the
// parsed inventory, which reformatted a hand-indented block and turned a
// 36-line change into a 684-line one — a diff nobody can review is a review
// that did not happen, and re-pinning attestations is precisely where that
// matters.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ATTESTATION_FIELDS,
  movedDigests,
  readRepinLedger,
  replaceDigest,
  unexplainedDigests,
} from "../../../scripts/build/repin-curated-skill-digests.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const curatedRoot = path.join(repoRoot, "runtime/skills/curated-scientific");
const inventoryPath = path.join(curatedRoot, "inventory.json");
const ledgerPath = path.join(curatedRoot, "digest-repins.jsonl");

/** Every digest value blanked, so what remains is everything a re-pin must not touch. */
function withoutDigests(text) {
  return text.replace(/"digest": "sha256:[0-9a-f]{64}"/g, '"digest": "<pinned>"');
}

test("re-pinning every digest changes nothing but the digests", async () => {
  const before = await readFile(inventoryPath, "utf8");
  const inventory = JSON.parse(before);
  let after = before;
  for (const [index, skill] of inventory.skills.entries()) {
    const replacement = `sha256:${String(index).padStart(64, "0")}`;
    after = replaceDigest(after, skill.digest, replacement, skill.name);
  }
  assert.notEqual(after, before, "the fixture must actually re-pin something");
  assert.equal(withoutDigests(after), withoutDigests(before));

  // And the same statement made structurally, so a future format change cannot
  // satisfy the text comparison while moving a conclusion.
  const reparsed = JSON.parse(after);
  assert.equal(reparsed.skills.length, inventory.skills.length);
  for (const [index, skill] of inventory.skills.entries()) {
    const moved = reparsed.skills[index];
    assert.equal(moved.name, skill.name);
    for (const field of ATTESTATION_FIELDS) {
      assert.deepEqual(moved[field], skill[field], `${skill.name}.${field} must survive a re-pin untouched`);
    }
  }
});

test("an ambiguous digest is refused rather than re-pinned by guesswork", () => {
  const source = '{"a":{"digest": "sha256:aa"},"b":{"digest": "sha256:aa"}}';
  assert.throws(
    () => replaceDigest(source, "sha256:aa", "sha256:bb", "a"),
    /appears 2 times/,
  );
  assert.throws(
    () => replaceDigest(source, "sha256:zz", "sha256:bb", "a"),
    /appears 0 times/,
  );
});

test("the ledger explains where every moved digest is now", async () => {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const ledger = await readRepinLedger(ledgerPath);
  assert.ok(ledger.length > 0, "the migration's own re-pin should be on the record");
  assert.deepEqual(unexplainedDigests(inventory.skills, ledger), []);
  for (const entry of ledger) {
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(entry.reason.trim().length >= 20, `${entry.skill}: a reason has to say something`);
    assert.match(entry.from, /^sha256:[0-9a-f]{64}$/);
    assert.match(entry.to, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(entry.from, entry.to);
  }
});

test("a hand-edited digest is caught, because that is the edit the ledger exists to catch", () => {
  const ledger = [{ skill: "alpha", from: "sha256:1", to: "sha256:2", reason: "r", at: "2026-08-24T00:00:00Z" }];
  assert.deepEqual(unexplainedDigests([{ name: "alpha", digest: "sha256:2" }], ledger), []);
  assert.deepEqual(
    unexplainedDigests([{ name: "alpha", digest: "sha256:9" }], ledger),
    [{ skill: "alpha", expected: "sha256:2", actual: "sha256:9" }],
  );
  // A skill the ledger never mentions is still on its original pin.
  assert.deepEqual(unexplainedDigests([{ name: "beta", digest: "sha256:7" }], ledger), []);
});

test("the committed digests match the committed content", async () => {
  assert.deepEqual(await movedDigests(curatedRoot), []);
});
