// Every occurrence of the pin is classified, and the classification is the
// part that matters.
//
// A rewriter for this job was built and refuted from three angles: it missed
// every pin written as an escaped regex, it skipped its own sweep whenever
// deps-version already read the target and reported the empty result as a
// clean one, and it left the npm `--before` cutoff behind so a documented
// invocation produced a Dockerfile that could not build the version it named.
// Underneath all three was one wrong premise — that these occurrences are one
// kind of thing.
//
// They are three, and only one moves. The expensive mistake is not missing a
// pin (a mixed tree fails loudly at install); it is rewriting a provenance
// string, which makes a fixture claim it was recorded off a binary it never
// saw, and nothing downstream can tell.
import assert from "node:assert/strict";
import test from "node:test";

import { RULES, checkPinInventory, classify } from "../../../scripts/ops/check-pin-inventory.mjs";

test("every occurrence of the pin is classified", async () => {
  const report = await checkPinInventory({});
  assert.deepEqual(
    report.unclassified.map((entry) => `${entry.file}:${entry.line}`),
    [],
    "an unclassified occurrence becomes whichever kind it is treated as; decide before an upgrade, not after",
  );
  // Not a floor: an inventory that suddenly finds a handful of sites has a
  // broken search, and a broken search reports nothing wrong.
  assert.ok(report.occurrences.length > 50, `only ${report.occurrences.length} occurrences; the sweep is broken`);
  for (const kind of ["pin", "provenance", "history", "prose"]) {
    assert.ok(report.counts[kind] > 0, `no ${kind} occurrences; a whole category vanished from the sweep`);
  }
});

test("a record of what a live kernel did outranks the prose rule that would swallow it", async () => {
  // Rule order is load-bearing, and getting it wrong is silent. The prose rule
  // ("a comment naming a version something happened at") was written first
  // because it is the narrowest test, and it promptly absorbed six real
  // provenance records — "Confirmed against a running 0.1.2-alpha.3",
  // "established by booting", "not inferred". The inventory stayed green the
  // whole time: nothing was unclassified, protection had just moved to a
  // weaker bucket. That is this repository's most familiar failure shape.
  const report = await checkPinInventory({});
  const kindOf = (needle) => report.occurrences.find((entry) => entry.file.includes(needle))?.verdict?.kind;
  for (const file of ["src/dshMux.mjs", "src/mockDshRuntime.mjs", "src/dshRuntimeAdapter.mjs"]) {
    assert.equal(kindOf(file), "provenance", `${file} records what a running kernel did and must not be filed as prose`);
  }
  assert.ok(report.counts.provenance >= 13, `only ${report.counts.provenance} provenance records; a rule is swallowing them`);
});

test("what a live kernel produced is never filed as a pin", async () => {
  // These are the ones a batch replace must not reach. Each is an assertion
  // about a specific binary's behaviour, so moving it forward is a false
  // claim rather than a stale one.
  const report = await checkPinInventory({});
  const kindOf = (file, line) => report.occurrences.find((entry) => entry.file === file && entry.line === line)?.verdict?.kind;
  assert.equal(kindOf("OpenScience/apps/server/test/fixtures/dsh/golden-frames.json", 3), "provenance");
  assert.equal(kindOf("OpenScience/apps/server/src/dshRuntimeAdapter.mjs", 58), "provenance");
  assert.equal(kindOf("OpenScience/scripts/ops/check-kernel-defaults.mjs", 101), "provenance");
});

test("the escaped spelling is swept, which is what the rewriter missed", async () => {
  // `assert.match(dockerfile, /ARG DSH_VERSION=0\.1\.2-alpha\.5/)` is this
  // repository's house style for a pin assertion, and it is invisible to a
  // search for the literal. Ten such sites existed while a tool reported the
  // tree fully swept.
  const report = await checkPinInventory({});
  const escaped = report.occurrences.filter((entry) => entry.text.includes("\\."));
  assert.ok(escaped.length > 0, "the escaped spelling must be found, not just the literal");
  assert.ok(escaped.every((entry) => entry.verdict !== null), "an escaped pin must be classified like any other");
});

test("a file no rule claims is reported rather than absorbed", () => {
  // The mutation control. Three real trees carry no rule today — evals
  // results, the MCP server, capability manifests — so a version string
  // appearing in one of them is a question for a person, not a default.
  //
  // The first draft of this test used a new compose file under `deploy/web/`
  // and failed: that directory IS claimed, and correctly so. Worth keeping the
  // note — an example chosen to prove a guard has a gap, which turns out to
  // land inside the guard, is the guard being right.
  for (const file of [
    "OpenScience/evals/capability-audit/results/tool-probe-v3.json",
    "OpenScience/runtime/mcp/evimed-research/server.py",
    "OpenScience/capabilities/clinical-evidence-synthesis/capability.yaml",
  ]) {
    assert.equal(classify({ file, line: 1, text: "0.1.2-rc.1" }), null, `${file} must be reported, not defaulted`);
  }
  // And a rule cannot claim everything: the catch-all that would make this
  // test pass forever is the failure mode, so assert a real path still lands
  // where it should.
  assert.equal(classify({ file: "OpenScience/deps-version.json", line: 4, text: '"version": "0.1.2-rc.1"' })?.kind, "pin");
  assert.ok(RULES.every((rule) => rule.why && rule.why.length > 20), "every rule states why its kind is the right one");
});
