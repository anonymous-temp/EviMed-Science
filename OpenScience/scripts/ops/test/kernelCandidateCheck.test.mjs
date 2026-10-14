// The candidate check's pure parts: what a dist-tag set means, what a composition diff says, what blocks a candidate.
//
// The compositions are recordings: the web profile a kernel closure's own CLI composes (`dsh --profile web
// --dump-config` in a scratch home), reduced to the rows' ids, names and disabled keys. `before` is the closure the pin
// held before the 0.2 line and `after` the first 0.2 candidate; the diff between them is the "+4 -3 rows" the upgrade
// audit counted by hand. The versions used below are synthetic: a test of arithmetic does not need a real release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  candidateVersions, compositionDiff, daysBetween, packageNameDiff, parseCompositionRows, peerFindings, pollDescriptors, shapeSeams, verdictFor,
} from "../kernel-candidate-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (/** @type {string} */ name) => readFileSync(path.join(here, "fixtures", name), "utf8");
const pins = JSON.parse(readFileSync(path.join(here, "..", "..", "..", "deps-version.json"), "utf8"));

test("a dist-tag names a candidate, and the pin is recognised as one of them", () => {
  const found = candidateVersions({ latest: "2.0.0", next: "2.0.0", alpha: "2.1.0", "named-tag": "2.0.5" }, "2.0.0");
  assert.deepEqual(found, [
    { version: "2.0.0", tags: ["latest", "next"], samePin: true },
    { version: "2.1.0", tags: ["alpha"], samePin: false },
  ], "only latest, next and alpha are candidates; a named dist-tag of the closure's own is not");
  assert.deepEqual(candidateVersions({}, "1.0.0"), []);
});

test("days are measured between instants, and an unreadable instant is null rather than zero", () => {
  assert.equal(daysBetween("2026-09-29T09:56:27.792Z", "2026-10-09T08:18:00.501Z"), 9.9);
  assert.equal(daysBetween("2026-10-14T00:00:00Z", "2026-10-13T12:00:00Z"), -0.5);
  assert.equal(daysBetween(undefined, "2026-10-13T12:00:00Z"), null);
});

test("the composition diff of two recorded closures is the rows that moved, by id", () => {
  const pinned = parseCompositionRows(fixture("web-profile-rows.before.yml"));
  const candidate = parseCompositionRows(fixture("web-profile-rows.after.yml"));
  assert.ok(pinned.size > 150 && candidate.size > 150, `only ${pinned.size} and ${candidate.size} rows were read; the parser, not the kernel, is wrong`);
  const diff = compositionDiff(pinned, candidate);
  assert.deepEqual(diff.added.map((row) => row.id).sort(), ["desktop-product-telemetry", "otel", "product-analytics", "ui-settings-session-log"]);
  assert.deepEqual(diff.removed.map((row) => row.id).sort(), ["schedule", "time-context", "ui-schedule"]);
  assert.deepEqual(diff.changed, [], "no row changed its package or its disabled expression between the two");
  assert.equal(diff.rows.candidate - diff.rows.pinned, 1);
  // A disabled expression is part of a row: the product-usage pair is disabled by a profile-name expression upstream.
  assert.match(candidate.get("product-analytics")?.disabled ?? "", /profileContext/);
  assert.equal(compositionDiff(candidate, candidate).added.length, 0);
});

test("a row whose package or disabled key changed is reported as changed, not as added and removed", () => {
  const a = parseCompositionRows("- id: x\n  name: '@a/one'\n  disabled: true\n- id: y\n  name: '@a/two'\n");
  const b = parseCompositionRows("- id: x\n  name: '@a/one'\n- id: y\n  name: '@a/three'\n");
  assert.deepEqual(compositionDiff(a, b).changed, [
    { id: "x", from: "@a/one true", to: "@a/one" },
    { id: "y", from: "@a/two", to: "@a/three" },
  ]);
});

test("package names are diffed as sets", () => {
  assert.deepEqual(packageNameDiff(["a", "b", "c"], ["b", "c", "d", "e"]), { added: ["d", "e"], removed: ["a"] });
});

test("a bundle's peer range is checked against what the candidate installs, the kernel by its own version", () => {
  const satisfies = (/** @type {string} */ version, /** @type {string} */ range) => {
    if (range === "<2.1.0") return version.startsWith("2.0.");
    if (range === "~4.0.4") return version.startsWith("4.0.");
    return true;
  };
  const found = peerFindings([
    { bundle: "a-plugin@1.0.0", peers: { "@deepseek-ai/dsh": "<2.1.0", "@deepseek-ai/dsh-llm": "~4.0.4" } },
    { bundle: "a-bundle@2.0.0", peers: { cordis: "~4.0.4" } },
    { bundle: "a-memory@3.0.0", peers: { "@deepseek-ai/dsh-mcp-client": "*" } },
  ], { kernel: "2.1.0", installed: new Map([["@deepseek-ai/dsh-llm", "2.1.0"]]), communityPeers: { cordis: "4.0.4" }, satisfies });
  assert.deepEqual(found.map((row) => [row.peer, row.installed, row.satisfied]), [
    ["@deepseek-ai/dsh", "2.1.0", false],
    ["@deepseek-ai/dsh-llm", "2.1.0", false],
    ["cordis", "4.0.4", true],
    ["@deepseek-ai/dsh-mcp-client", null, null],
  ], "a peer the candidate does not install is unknown, never satisfied");
});

test("the verdict is blocked by a failed seam, an unclassified method or an unsatisfied peer, and nothing else", () => {
  const clean = { ok: true, failed: [], wire: { unclassified: [], phantom: [] } };
  assert.equal(verdictFor({ samePin: true, seams: null, peers: [], composition: null, installed: true }).verdict, "same-as-pin");
  assert.deepEqual(verdictFor({ samePin: false, seams: clean, peers: [{ bundle: "b", peer: "p", satisfied: true }], composition: null, installed: true }), { verdict: "movable", reasons: [] });
  assert.equal(verdictFor({ samePin: false, seams: clean, peers: [{ bundle: "b", peer: "p", satisfied: null }], composition: null, installed: true }).verdict, "movable",
    "an unknown peer is a line in the report, not a block");
  const blocked = verdictFor({
    samePin: false, installed: true, composition: null,
    seams: { ok: false, failed: [{ label: "cordis version matches seam-manifest" }], wire: { unclassified: ["cotTranslation/limits"], phantom: [] } },
    peers: [{ bundle: "dsh-loopx-plugin@x", peer: "@deepseek-ai/dsh", satisfied: false }],
  });
  assert.equal(blocked.verdict, "blocked");
  assert.equal(blocked.reasons.length, 3);
  assert.equal(verdictFor({ samePin: false, seams: null, peers: [], composition: null, installed: false }).verdict, "unknown");
});

test("the seam script's JSON is shaped into failures and the two wire lists", () => {
  const shaped = shapeSeams({ checks: [{ label: "a", ok: true, detail: "" }, { label: "wire surface classified (1 declared)", ok: false, detail: "1 method(s)…" }],
    wire: { unclassified: ["x/y"], phantom: [] } });
  assert.deepEqual(shaped, { ok: false, failed: [{ label: "wire surface classified (1 declared)", detail: "1 method(s)…" }], wire: { unclassified: ["x/y"], phantom: [] } });
  assert.equal(shapeSeams({}).ok, false, "no checks is not a pass");
});

test("the pins polled are the top-level packages and repositories, never a kernel subpackage's own latest tag", () => {
  const rows = pollDescriptors(pins);
  const ids = rows.map((row) => row.id);
  for (const id of ["dsh", "dsh-cite", "dsh-annotation", "dsh-mermaid", "openviking-memory-plugin", "loopx-cli", "loopx-plugin", "openviking-engine"]) assert.ok(ids.includes(id), id);
  assert.ok(rows.every((row) => row.kind !== "npm" || !/^@deepseek-ai\/dsh-/.test(row.source)), "a dsh-* subpackage's latest tag is stale (a placeholder release) and says nothing about the kernel");
  assert.equal(rows.find((row) => row.id === "dsh")?.pinned, pins.dsh.version);
  assert.equal(rows.find((row) => row.id === "dsh-cite")?.pinned, pins.dsh.citeVersion);
});
