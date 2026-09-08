// The test `constants.mjs` says exists.
//
// Its own doc comment promises: "A test asserts each of these is exported and
// numeric, so a later 'just make it configurable' has to argue with the three
// questions first." There was no such test — the file claimed a guard it did
// not have, which is worse than having neither, because the claim is what a
// reader checks instead of the code.
//
// The second half is newer and is the reason this file appeared now: two of
// these numbers had no consumer anywhere in the product. A constant nobody
// reads is not a design invariant, it is a note; `MEMORY_PROMOTION_MIN_RUNS`
// sat here declaring that a fact must be seen in separate runs while the code
// counted observations and never runs, so "three independent observations"
// could be one conversation repeating itself three times.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as constants from "../src/constants.mjs";
import * as domain from "../index.mjs";

/** Every number this module is allowed to hold: a number, or a frozen record of them.
 *  @param {string} name @param {any} value */
function assertAlgorithmConstant(name, value) {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${name} must be a finite number`);
    return;
  }
  assert.equal(typeof value, "object", `${name} must be a number or a frozen record of numbers`);
  assert.ok(Object.isFrozen(value), `${name} must be frozen: a shared constant that can be mutated is a global variable`);
  const entries = Object.entries(value);
  assert.ok(entries.length > 0, `${name} must not be empty`);
  for (const [key, item] of entries) {
    assert.equal(typeof item, "number", `${name}.${key} must be a number`);
    assert.ok(Number.isFinite(item), `${name}.${key} must be finite`);
  }
}

test("every algorithm constant is exported, numeric and reachable from the package root", () => {
  const declared = Object.entries(constants);
  const rooted = Object.fromEntries(Object.entries(domain));
  // The walk has to prove it walked: an import that resolved to an empty
  // namespace would satisfy every loop below.
  assert.ok(declared.length >= 24, `constants.mjs exported ${declared.length} names; the module holds at least 24`);
  for (const [name, value] of declared) {
    assertAlgorithmConstant(name, value);
    assert.ok(name in rooted, `${name} is not re-exported from @evimed/domain, so no consumer can reach it`);
    assert.equal(rooted[name], value, `${name} resolves to a different value at the package root`);
  }
});

test("the memory-promotion rule is a rule two numbers can express", () => {
  assert.equal(constants.MEMORY_PROMOTION_MIN_OCCURRENCES, 3);
  assert.equal(constants.MEMORY_PROMOTION_MIN_RUNS, 2);
  // An occurrence floor below the run floor would be unsatisfiable: a fact
  // cannot appear in more runs than it was observed times.
  assert.ok(constants.MEMORY_PROMOTION_MIN_OCCURRENCES >= constants.MEMORY_PROMOTION_MIN_RUNS,
    "a fact cannot appear in more runs than it has occurrences");
  assert.ok(constants.MEMORY_PROMOTION_MIN_RUNS >= 2,
    "one run agreeing with itself is not independence, which is the whole point of this number");
});

test("the unconsumed constants are named, so the next reader knows which ones are still notes", async () => {
  // Three constants below have no consumer in the product today. They belong to
  // the learned-method loop (`METHOD_INDUCTION_MIN_TRAJECTORIES`), capsule fact
  // strength (`CAPSULE_SOURCE_WEIGHTS`) and generated-SKILL.md limits
  // (`SKILL_AUTHORING_LIMITS`), which is a separate effort — they are left
  // alone deliberately rather than left unnoticed. This test fails if one of
  // them is deleted or renamed without the loop that was going to read it,
  // which is the moment to decide which of the two happened.
  for (const name of ["METHOD_INDUCTION_MIN_TRAJECTORIES", "CAPSULE_SOURCE_WEIGHTS", "SKILL_AUTHORING_LIMITS"]) {
    assert.ok(name in constants, `${name} disappeared; it was reserved for the learned-method loop`);
  }
  // And the file still explains why a number lives here rather than in the
  // control plane's config, because that is the rule this whole module is.
  const source = await readFile(new URL("../src/constants.mjs", import.meta.url), "utf8");
  assert.match(source, /configuration only when two deployments/);
});
