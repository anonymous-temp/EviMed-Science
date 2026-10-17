// The three records of the community bundles agree with the pin and with each other.
//
// `plugin-support.json`, `try-install.json` and `sources.json` each carried the same bundle versions by hand, and they
// disagreed within one day (2026-10-13: academic-writing was 0.2.0 in one and 0.3.2 in the other two). Versions are
// written by `scripts/dev/sync-community-records.mjs` from `deps-version.json` (what is installed) and from
// `try-install.json` (what a candidate was tried at); this holds the files as that writer leaves them.
import assert from "node:assert/strict";
import test from "node:test";

import { installedBundles, readRecords, syncedRecords } from "../../../scripts/dev/sync-community-records.mjs";

test("the records carry exactly the versions their sources name", () => {
  const records = readRecords();
  const { changes } = syncedRecords(records);
  assert.deepEqual(changes, [], "run node scripts/dev/sync-community-records.mjs, then read the diff for the evidence fields it does not write");
  // The installed set is the three the image installs, in the image's order.
  assert.deepEqual(records.tryInstall.installed, installedBundles(records.pins).map((bundle) => `${bundle.npm}@${bundle.version}`));
  assert.equal(records.support.kernel, `@deepseek-ai/dsh@${records.pins.dsh.version}`);
});

test("a disagreement is found, in whichever file it is, and the writer says what it would change", () => {
  const records = readRecords();
  const drifted = structuredClone(records);
  drifted.support.communityToolBundles.find((/** @type {any} */ row) => row.name === "dsh-cite").version = "0.0.1";
  drifted.tryInstall.installed = ["dsh-cite@0.0.1"];
  drifted.sources.deferred.find((/** @type {any} */ row) => row.name === "dsh-cite").reason = "Tool bundle. Installed whole at 0.0.1; the rest.";
  const { changes, support, tryInstall, sources } = syncedRecords(drifted);
  assert.equal(changes.length, 3);
  assert.equal(support.communityToolBundles.find((/** @type {any} */ row) => row.name === "dsh-cite").version, records.pins.dsh.citeVersion);
  assert.deepEqual(tryInstall.installed, records.tryInstall.installed);
  assert.match(sources.deferred.find((/** @type {any} */ row) => row.name === "dsh-cite").reason, new RegExp(`Installed whole at ${records.pins.dsh.citeVersion.replace(/\./g, "\\.")};`));
  // Nothing of what was observed is generated: the evidence of a bundle is left alone by the writer.
  const cite = records.support.communityToolBundles.find((/** @type {any} */ row) => row.name === "dsh-cite");
  assert.equal(support.communityToolBundles.find((/** @type {any} */ row) => row.name === "dsh-cite").evidence, cite.evidence);
});

test("a candidate tried and not taken carries the version it was tried at, in both records", () => {
  const { support, tryInstall } = syncedRecords(readRecords());
  for (const entry of support.communityToolBundles.filter((/** @type {any} */ row) => row.status !== "installed")) {
    const candidate = tryInstall.candidates.find((/** @type {any} */ row) => row.name === entry.name);
    if (candidate?.version && /^\d+\.\d+\.\d+/.test(candidate.version)) assert.equal(entry.version, candidate.version, entry.name);
  }
});

test("a retest block records the version its candidate carries, and what it found is in the verdict record too", () => {
  const records = readRecords();
  const retest = records.tryInstall.dataQualityRetest;
  const candidate = records.tryInstall.candidates.find((/** @type {any} */ row) => row.name === "dsh-data-quality");
  assert.ok(retest && candidate);
  assert.deepEqual(Object.keys(retest.results), [`dsh-data-quality@${candidate.version}`], "the retest was at the version the candidate now carries");
  assert.deepEqual(Object.keys(retest.scan), Object.keys(retest.results));
  const verdict = records.support.communityToolBundles.find((/** @type {any} */ row) => row.name === "dsh-data-quality");
  assert.equal(verdict?.version, candidate.version);
  assert.equal(verdict?.testedOn, retest.testedAt);
  assert.ok(records.sources.deferred.some((/** @type {any} */ row) => row.name === "dsh-data-quality"), "sources.json says why it is not vendored");
});
