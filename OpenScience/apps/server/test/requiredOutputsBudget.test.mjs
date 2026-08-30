// A new required file is a new way for a finished package to be rejected, which
// makes it the same kind of decision as a new blocking point — and the budget
// that counts blocking points does not see it. The count held at six all the
// while the clinical contract went from seven required files to eight, and the
// only place that showed up was in runs spending repair attempts.
//
// So: required outputs are ratcheted the way blocking points are budgeted. Add
// one as `required: false`, watch it in gate-health.mjs, then promote it here in
// a change that says why.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baselinePath = path.join(repoRoot, "required-outputs-baseline.json");

async function manifests() {
  const dir = path.join(repoRoot, "capabilities");
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "capability.yaml");
    const body = await readFile(file, "utf8").catch(() => null);
    if (body) out.push([entry.name, parseYaml(body)]);
  }
  return out;
}

test("no contract quietly requires more files than the baseline records", async () => {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const found = await manifests();
  assert.ok(found.length >= 10, `only ${found.length} manifests read — the walk found nothing`);

  let checked = 0;
  const grew = [];
  const unrecorded = [];
  for (const [name, manifest] of found) {
    for (const produces of manifest.produces ?? []) {
      const kind = produces.contractKind;
      const required = (produces.outputs ?? []).filter((output) => output.required !== false);
      const recorded = baseline.contracts[kind];
      if (!recorded) {
        unrecorded.push(`${name} -> ${kind}`);
        continue;
      }
      checked += 1;
      if (required.length > recorded.requiredCount) {
        grew.push(`${kind}: ${recorded.requiredCount} recorded, ${required.length} declared`);
      }
      // A rename is an addition wearing the old count, so paths are compared
      // too — the number alone would let one file swap for another silently.
      const recordedPaths = new Set(recorded.outputs.filter((o) => o.required).map((o) => o.path));
      for (const output of required) {
        if (!recordedPaths.has(output.path)) {
          grew.push(`${kind}: "${output.path}" is required and not in the baseline`);
        }
      }
    }
  }
  assert.deepEqual(unrecorded, [], "a contract with no baseline entry can grow without anyone seeing it");
  assert.equal(checked, Object.keys(baseline.contracts).length,
    `${checked} contracts checked against ${Object.keys(baseline.contracts).length} recorded — the walk is short`);
  assert.deepEqual(
    grew, [],
    "A required output was added without moving the baseline. Ship it as `required: false` first, "
    + "watch `node scripts/ops/gate-health.mjs`, then promote it here in its own change — same weight "
    + "as a seventh blocking point.",
  );
});

test("every baseline entry records when it became required", async () => {
  // Without the date, "this package is old" and "this package is wrong" are the
  // same failure, and the expansion tax cannot be separated from real defects.
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const undated = [];
  for (const [kind, contract] of Object.entries(baseline.contracts)) {
    for (const output of contract.outputs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(output.addedOn ?? ""))) undated.push(`${kind}/${output.path}`);
    }
  }
  assert.deepEqual(undated, [], "an undated required output cannot be told apart from a real defect");
});

test("the baseline counts what it lists", async () => {
  // A recorded count that disagrees with the recorded list is a ratchet that
  // ratchets nothing: the first test compares against the number.
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  for (const [kind, contract] of Object.entries(baseline.contracts)) {
    const listed = contract.outputs.filter((output) => output.required).length;
    assert.equal(contract.requiredCount, listed, `${kind}: requiredCount ${contract.requiredCount} but ${listed} listed`);
  }
});
