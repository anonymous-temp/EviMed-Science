// The runbook's alert table is what an operator opens when an alert fires. Its row for the reply check's first pass
// named `ReviewJevFailing`, an alert the per-site `JevFailing` replaced, and `JevCalibrationDrift` had no row at all.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The first cell of every row of the runbook's "Alert Response" table, as the alert names it carries. */
async function runbookAlertRows() {
  const text = await readFile(path.join(repoRoot, "docs/WEB_OPERATIONS_RUNBOOK.md"), "utf8");
  const section = text.slice(text.indexOf("## Alert Response"), text.indexOf("## Secret Rotation"));
  return section.split("\n").filter((line) => line.startsWith("| `")).map((line) => ({
    names: [...line.split("|")[1].matchAll(/`([A-Za-z0-9]+)`/g)].map((match) => match[1]),
    text: line,
  }));
}
async function shippedAlerts() {
  const rules = JSON.parse(await readFile(path.join(repoRoot, "deploy/web/monitoring/open-science.rules.json"), "utf8"));
  return new Set(rules.groups.flatMap((/** @type {any} */ group) => group.rules).map((/** @type {any} */ rule) => rule.alert).filter(Boolean));
}

test("every alert the runbook's table names is an alert the rules ship", async () => {
  const alerts = await shippedAlerts();
  const rows = await runbookAlertRows();
  assert.ok(rows.length >= 20 && alerts.size >= 40, `read ${rows.length} rows and ${alerts.size} alerts; the scan did not walk`);
  const stale = rows.flatMap((row) => row.names).filter((name) => !alerts.has(name));
  assert.deepEqual(stale, [], "the runbook describes an alert that no longer exists (ReviewJevFailing became JevFailing)");
});

test("the Jev alerts each have a row that says where to look and what the sites fall back to", async () => {
  const rows = await runbookAlertRows();
  for (const name of ["JevFailing", "JevCalibrationDrift"]) {
    const row = rows.find((candidate) => candidate.names.includes(name));
    assert.ok(row, `${name} has a row in the runbook's alert table`);
    assert.match(row.text, /open_science_jev_/, `${name}'s row names the metrics to read`);
  }
  const failing = rows.find((row) => row.names.includes("JevFailing"))?.text ?? "";
  assert.match(failing, /OPEN_SCIENCE_JEV_DISABLED_SITES/, "and the lever that switches one site off");
  assert.match(failing, /refused/, "and says what is not a provider failure");
});
