// The composition mounts upstream packages by string. Nothing type-checks those
// strings, and upstream deletes one every few days: DSH 0.1.2-alpha.4 replaced
// the one-way `report` subagent tool with `send_message` and stopped publishing
// `@deepseek-ai/dsh-tool-subagent-report`, which our preset still mounts. These
// tests hold `verify-composition-references.mjs` to the two things that make it
// worth having — it resolves the real tree, and it goes red on a name that is
// not there.
//
// Two of them talk to the npm registry. That is deliberate and it is the whole
// point: the nineteen `config-row` packages are installed inside the runtime
// image and never in this checkout, so the registry is the only thing in reach
// that knows whether a pinned version exists. A registry that cannot be reached
// makes these tests fail with `unverified`, never pass — `pnpm ci:web` already
// requires registry.npmjs.org for `pnpm audit --prod`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SOURCE_FILES,
  collectReferences,
  extractCordisRows,
  formatReport,
  resolveRegistry,
  verifyCompositionReferences,
} from "../../../scripts/ops/verify-composition-references.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/verify-composition-references.mjs");

/** @param {{ file: string, line?: number, specifier: string }} match */
function findProblem(problems, match) {
  return problems.find(
    (problem) =>
      problem.specifier === match.specifier && problem.file === match.file && (match.line === undefined || problem.line === match.line),
  );
}

function findVerified(verified, specifier, file) {
  return verified.find((item) => item.reference.specifier === specifier && (file === undefined || item.reference.file === file));
}

/**
 * A registry that exists only in this process. Everything is published except
 * the names handed to `missing`, which answer the way npm answers for
 * `@deepseek-ai/dsh-tool-subagent-report@0.1.2-alpha.4`: 404 on the version
 * document, 200 on the packument, with the version absent from its list.
 */
function registryStub({ missing = [], published = ["0.1.2-rc.1"] } = {}) {
  const gone = new Set(missing);
  return async (url) => {
    const rest = String(url).replace("https://registry.npmjs.org/", "");
    const [encodedName, version] = rest.split("/");
    const name = decodeURIComponent(encodedName);
    if (!version) {
      return new Response(JSON.stringify({ name, versions: Object.fromEntries(published.map((v) => [v, {}])), "dist-tags": { alpha: published.at(-1) } }), {
        status: 200,
      });
    }
    if (gone.has(name)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ name, version }), { status: 200 });
  };
}

test("every reference the real composition makes resolves at the pin", async () => {
  const run = spawnSync(process.execPath, [script, "--json"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.error, undefined);
  const report = JSON.parse(run.stdout);

  // The verdict, then the evidence behind it. A report that says `ok` because
  // it walked nothing is the failure this file is guarding, so the assertions
  // below name specific references and the tier that answered for each.
  assert.deepEqual(
    report.problems,
    [],
    `unresolved references against the pin:\n${report.problems.map((problem) => `${problem.file}:${problem.line} ${problem.specifier} — ${problem.detail}`).join("\n")}`,
  );
  assert.equal(run.status, 0);

  const depsVersion = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  assert.equal(report.pins.dsh, depsVersion.dsh.version);
  assert.equal(report.pins.cordis, depsVersion.dsh.cordis);

  // The live instance this whole mechanism exists for: the preset still mounts
  // the package alpha.4 deleted, and today it is still published at alpha.3.
  // The canary was `dsh-tool-subagent-report` until alpha.4 deleted it and the
  // row went with it. `dsh-tool-subagent-control` is what took over the job
  // (it publishes send_message), so it is both present and the row worth
  // proving is reached.
  const subagentReport = findVerified(report.verified, "@deepseek-ai/dsh-tool-subagent-control", SOURCE_FILES.preset);
  assert.ok(subagentReport, "the preset row for @deepseek-ai/dsh-tool-subagent-control was never checked");
  assert.equal(subagentReport.tier, "registry");
  const presetText = await readFile(path.join(repoRoot, SOURCE_FILES.preset), "utf8");
  assert.match(presetText.split("\n")[subagentReport.reference.line - 1], /dsh-tool-subagent-control/);

  // One reference from each tier, so a tier that quietly stopped answering
  // cannot hide behind the other three.
  assert.equal(findVerified(report.verified, "@deepseek-ai/cordis")?.tier, "installed");
  assert.equal(findVerified(report.verified, "@evimed/dsh-socket/plugins/seam-probe", SOURCE_FILES.patch)?.tier, "workspace");
  assert.equal(findVerified(report.verified, "web-fetch-http", SOURCE_FILES.patch)?.tier, "host-row");
  assert.equal(findVerified(report.verified, "cordis:group", SOURCE_FILES.preset)?.tier, "kernel-builtin");

  // Every one of the four sources contributed. Counted per file rather than in
  // total, because a total stays plausible while one source reads as empty.
  const perFile = new Map();
  for (const item of report.verified) perFile.set(item.reference.file, (perFile.get(item.reference.file) ?? 0) + 1);
  assert.ok(perFile.get(SOURCE_FILES.preset) >= 16, `preset contributed ${perFile.get(SOURCE_FILES.preset)} references`);
  assert.ok(perFile.get(SOURCE_FILES.patch) >= 4, `patch contributed ${perFile.get(SOURCE_FILES.patch)} references`);
  assert.ok(perFile.get(SOURCE_FILES.seamManifest) >= 16, `seam manifest contributed ${perFile.get(SOURCE_FILES.seamManifest)} references`);
  assert.equal(report.verified.length, report.checked);
});

test("a row mounting a package upstream deleted is named, and only that row", async (t) => {
  // This began as the live alpha.4 instance: the preset mounted
  // `@deepseek-ai/dsh-tool-subagent-report`, upstream stopped publishing it at
  // alpha.4, and the guard named both of its sites. The migration removed the
  // row, so the instance is gone from the tree — but the registry fact is
  // permanent (that package has no build after alpha.3), which makes it the
  // one canary that cannot rot. The row goes back for the length of this test.
  const presetPath = path.join(repoRoot, SOURCE_FILES.preset);
  const preset = await readFile(presetPath, "utf8");
  t.after(async () => { await writeFile(presetPath, preset, "utf8"); });
  const anchor = "    - id: tool-subagent-control\n";
  assert.ok(preset.includes(anchor), "the row this test inserts beside has moved");
  await writeFile(
    presetPath,
    preset.replace(anchor, "    - id: tool-subagent-report\n      name: '@deepseek-ai/dsh-tool-subagent-report'\n" + anchor),
    "utf8",
  );

  const report = await verifyCompositionReferences({});
  assert.equal(report.ok, false);

  // Two problems, not one, and both are right: the package is unpublished at
  // the pin *and* the row mounts something the seam manifest does not list.
  // The manifest omission is the cheaper signal — it needs no registry — so a
  // guard that reported only the first would still be useful offline.
  const raised = report.problems.filter((problem) => problem.specifier === "@deepseek-ai/dsh-tool-subagent-report");
  assert.deepEqual(
    [...new Set(raised.map((problem) => problem.kind))].sort(),
    ["manifest-omission", "unresolved-package"],
    `the reinstated row was not named twice over:\n${formatReport(report)}`,
  );
  const named = raised.find((problem) => problem.kind === "unresolved-package");
  assert.ok(named);
  assert.match(named.detail, /newest published 0\.1\.2-alpha\.3/);

  // A checker that failed everything would also have named this one. The rest
  // of the composition is published at the pin, so the rest has to be green.
  for (const specifier of ["@deepseek-ai/dsh-tool-bash", "@deepseek-ai/dsh-tool-subagent", "@deepseek-ai/dsh-persona"]) {
    assert.ok(findVerified(report.verified, specifier, SOURCE_FILES.preset), specifier);
  }
  assert.deepEqual(
    [...new Set(report.problems.map((problem) => problem.specifier))],
    ["@deepseek-ai/dsh-tool-subagent-report"],
    "the reinstated row must be the only thing reported",
  );
});

test("a dangling reference is named with its file and line, and its neighbours still resolve", async (t) => {
  // Fixture, no network: the three reference kinds that resolve locally, each
  // with one broken row planted next to the real ones so the report has to
  // discriminate rather than condemn the file.
  const presetText = await readFile(path.join(repoRoot, SOURCE_FILES.preset), "utf8");
  const patchText = await readFile(path.join(repoRoot, SOURCE_FILES.patch), "utf8");
  const seamManifestText = await readFile(path.join(repoRoot, SOURCE_FILES.seamManifest), "utf8");
  const seamManifest = JSON.parse(seamManifestText);
  seamManifest.packages["@deepseek-ai/dsh-tool-vanished"] = "config-row";

  const brokenPreset = `${presetText}\n- id: tool-vanished\n  name: '@deepseek-ai/dsh-tool-vanished'\n- id: evimed-ghost\n  name: '@evimed/dsh-socket/plugins/not-a-plugin'\n`;
  const brokenPatch = `${patchText}\n- id: web-fetch-htp\n  disabled: true\n`;

  const fixture = await writeFixture(t, {
    preset: brokenPreset,
    patch: brokenPatch,
    seamManifest: JSON.stringify(seamManifest, null, 2),
  });

  const report = await verifyCompositionReferences({
    overrideFiles: fixture,
    fetchImpl: registryStub({ missing: ["@deepseek-ai/dsh-tool-vanished"] }),
  });
  assert.equal(report.ok, false);

  const vanished = findProblem(report.problems, { file: SOURCE_FILES.preset, specifier: "@deepseek-ai/dsh-tool-vanished" });
  assert.ok(vanished, `no report for the unpublished package:\n${formatReport(report)}`);
  assert.equal(vanished.kind, "unresolved-package");
  assert.equal(brokenPreset.split("\n")[vanished.line - 1].trim(), "name: '@deepseek-ai/dsh-tool-vanished'");

  const ghost = findProblem(report.problems, { file: SOURCE_FILES.preset, specifier: "@evimed/dsh-socket/plugins/not-a-plugin" });
  assert.ok(ghost, "a plugin subpath that maps to no file was not reported");
  assert.equal(ghost.kind, "unresolved-workspace-subpath");
  assert.match(ghost.detail, /plugins\/not-a-plugin\.mjs, which does not exist/);

  const typo = findProblem(report.problems, { file: SOURCE_FILES.patch, specifier: "web-fetch-htp" });
  assert.ok(typo, "a patch override addressing an id no host row carries was not reported");
  assert.equal(typo.kind, "unresolved-host-row");
  assert.match(typo.detail, /only warns on stderr and is dropped/);

  // Discrimination: the correctly spelled row one line above the typo, and the
  // eight real plugin subpaths, all still resolve.
  assert.equal(findVerified(report.verified, "web-fetch-http", SOURCE_FILES.patch)?.tier, "host-row");
  assert.equal(findVerified(report.verified, "@evimed/dsh-socket/plugins/review", SOURCE_FILES.preset)?.tier, "workspace");
  assert.deepEqual(
    report.problems.map((problem) => problem.specifier).sort(),
    ["@deepseek-ai/dsh-tool-vanished", "@deepseek-ai/dsh-tool-vanished", "@evimed/dsh-socket/plugins/not-a-plugin", "web-fetch-htp"],
    "the fixture's three planted breaks are not the only thing reported",
  );
});

test("a source the checker cannot read is an error, never an empty walk", async () => {
  await assert.rejects(
    () => verifyCompositionReferences({ overrideFiles: { preset: path.join(repoRoot, "packages/socket/presets/no-such-preset.yml") } }),
    /cannot read preset .*no-such-preset\.yml/,
  );
});

test("an extractor that stops matching fails instead of reporting nothing wrong", async (t) => {
  // The repeated defect this repo keeps hitting: a walk that reads nothing
  // produces an empty problem list, and an empty problem list is exactly what
  // success looks like. The floors are the only thing between those two states.
  const fixture = await writeFixture(t, { preset: "# every row commented out\n" });
  const report = await verifyCompositionReferences({ overrideFiles: fixture, fetchImpl: registryStub() });
  assert.equal(report.ok, false);
  const drift = report.problems.filter((problem) => problem.kind === "extraction-drift");
  assert.ok(drift.length > 0, `an empty preset produced no extraction-drift problem:\n${formatReport(report)}`);
  assert.ok(
    drift.some((problem) => problem.specifier === "preset.upstreamReferences"),
    "the upstream-reference count did not notice that it read zero rows",
  );
  assert.match(drift[0].detail, /floor is/);
});

test("a preset row whose name went missing is named by id and line", async (t) => {
  // What defeating the row scan actually looks like: every row still parses,
  // every id is still there, and not one of them carries a package any more.
  // The counts alone let this through — `preset.rows` was still 24 — so the
  // report has to be per row, not per total.
  const presetText = await readFile(path.join(repoRoot, SOURCE_FILES.preset), "utf8");
  const stripped = presetText
    .split("\n")
    .filter((line) => !/^\s*name:/.test(line))
    .join("\n");
  const fixture = await writeFixture(t, { preset: stripped });
  const report = await verifyCompositionReferences({ overrideFiles: fixture, fetchImpl: registryStub() });
  assert.equal(report.ok, false);
  const orphan = report.problems.find((problem) => problem.specifier === "tool-subagent-control");
  assert.ok(orphan, `a preset row with an id and no name was not reported:\n${formatReport(report)}`);
  assert.equal(orphan.kind, "extraction-drift");
  assert.equal(stripped.split("\n")[orphan.line - 1].trim(), "- id: tool-subagent-control");
});

test("a package mounted by the composition but missing from the seam manifest is reported", async (t) => {
  const presetText = await readFile(path.join(repoRoot, SOURCE_FILES.preset), "utf8");
  const fixture = await writeFixture(t, {
    preset: `${presetText}\n- id: tool-unlisted\n  name: '@deepseek-ai/dsh-tool-unlisted'\n`,
  });
  const report = await verifyCompositionReferences({ overrideFiles: fixture, fetchImpl: registryStub() });
  const omission = report.problems.find((problem) => problem.kind === "manifest-omission");
  assert.ok(omission, `a package absent from the seam manifest was not reported:\n${formatReport(report)}`);
  assert.equal(omission.specifier, "@deepseek-ai/dsh-tool-unlisted");
  assert.equal(omission.file, SOURCE_FILES.preset);
});

test("a registry answering 200 with something else does not certify a package", async () => {
  // A mirror serving an HTML index, or a proxy rewriting scoped names, both
  // answer 200. The status code is not the evidence; the body is.
  const wrongBody = await resolveRegistry("@deepseek-ai/dsh-tool-bash", "0.1.2-rc.1", {
    registry: "https://registry.npmjs.org",
    fetchImpl: async () => new Response(JSON.stringify({ name: "@deepseek-ai/dsh-tool-fs", version: "0.1.2-rc.1" }), { status: 200 }),
  });
  assert.equal(wrongBody.status, "unverified");
  assert.match(wrongBody.detail, /answered 200 .* with @deepseek-ai\/dsh-tool-fs/);

  const unreachable = await resolveRegistry("@deepseek-ai/dsh-tool-bash", "0.1.2-rc.1", {
    registry: "https://registry.npmjs.org",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(unreachable.status, "unverified");
  assert.match(unreachable.detail, /unreachable: ECONNREFUSED/);

  const serverError = await resolveRegistry("@deepseek-ai/dsh-tool-bash", "0.1.2-rc.1", {
    registry: "https://registry.npmjs.org",
    fetchImpl: async () => new Response("", { status: 503 }),
  });
  assert.equal(serverError.status, "unverified");
});

test("a `name:` inside a config block is not read as the row's plugin name", () => {
  // The reason the row scan matches on an exact column instead of a loose
  // regex: a config key called `name` sits two columns deeper than the row's
  // own keys, and a regex over `name:` would mount it.
  const rows = extractCordisRows(
    [
      "- id: tool-subagent",
      "  name: '@deepseek-ai/dsh-tool-subagent'",
      "  config:",
      "    name: not-a-package",
      "    nested:",
      "      - id: inner",
      "        name: '@deepseek-ai/dsh-inner'",
      "- insert:",
      "    - id: added",
      "      name: '@evimed/dsh-socket/plugins/seam-probe'",
      "- id: override-only",
      "  disabled: true",
    ].join("\n"),
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.name, row.nameLine, row.insert]),
    [
      ["tool-subagent", "@deepseek-ai/dsh-tool-subagent", 2, false],
      ["inner", "@deepseek-ai/dsh-inner", 7, false],
      ["added", "@evimed/dsh-socket/plugins/seam-probe", 10, true],
      ["override-only", undefined, 0, false],
    ],
  );
});

test("the patch's override rows are collected as host-row references, not lost", async () => {
  // cordis.patch.yml names zero @deepseek-ai packages, so a checker that only
  // looked for those would read the file, find nothing, and report success —
  // the shape of every silent pass in this repository. Its four override rows
  // are the references it does make.
  const collected = collectReferences({
    presetText: await readFile(path.join(repoRoot, SOURCE_FILES.preset), "utf8"),
    patchText: await readFile(path.join(repoRoot, SOURCE_FILES.patch), "utf8"),
    seamManifestText: await readFile(path.join(repoRoot, SOURCE_FILES.seamManifest), "utf8"),
    hostBaselineText: await readFile(path.join(repoRoot, SOURCE_FILES.hostBaseline), "utf8"),
  });
  const patchReferences = collected.references.filter((reference) => reference.file === SOURCE_FILES.patch);
  const hostRows = patchReferences.filter((reference) => reference.kind === "host-row-id").map((reference) => reference.specifier);
  assert.deepEqual(hostRows.sort(), ["hmr", "plugin-package-inventory-deepseek", "session-telemetry-otel", "tool-web", "web-fetch-http"]);
  assert.ok(collected.hostRowIds.size > 40, `the dumped host composition read as only ${collected.hostRowIds.size} rows`);
});

/**
 * Fixture sources on disk, defaulting to the real files so a test only has to
 * write the one it is breaking.
 * @param {import("node:test").TestContext} t
 * @param {Partial<Record<keyof typeof SOURCE_FILES, string>>} sources
 */
async function writeFixture(t, sources) {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "composition-references-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const key of Object.keys(SOURCE_FILES)) {
    const file = path.join(dir, `${key}${path.extname(SOURCE_FILES[key])}`);
    await writeFile(file, sources[key] ?? (await readFile(path.join(repoRoot, SOURCE_FILES[key]), "utf8")));
    overrides[key] = file;
  }
  return overrides;
}

test("a row written in YAML flow form is a row, not a blind spot", () => {
  // Found by an adversarial pass, and it was a false green of the worst kind:
  // one real preset row rewritten as `- { id: …, name: '@…/does-not-exist' }`
  // mounted a package that has never been published at any version, and the
  // checker printed "every reference resolves" at exit 0. The loader reads the
  // two forms identically — yaml@2.8.3 parses block and flow to the same row —
  // so a scan that sees only one of them certifies a composition that cannot
  // boot.
  const rows = extractCordisRows(
    [
      "- { id: flow-plain, name: '@deepseek-ai/dsh-tool-bash' }",
      "- id: block-form",
      "  name: '@deepseek-ai/dsh-tool-fs'",
      "- insert:",
      "    - { id: flow-inserted, name: '@evimed/dsh-socket/plugins/guidance' }",
      "- { id: flow-no-name, disabled: true }",
    ].join("\n"),
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.name, row.nameLine, row.insert]),
    [
      ["flow-plain", "@deepseek-ai/dsh-tool-bash", 1, false],
      ["block-form", "@deepseek-ai/dsh-tool-fs", 3, false],
      ["flow-inserted", "@evimed/dsh-socket/plugins/guidance", 5, true],
      // Reported as a row with no name rather than dropped: the per-row check
      // then names it, which is what a defeated scan should look like.
      ["flow-no-name", undefined, 6, false],
    ],
  );
});

test("a loader built-in nobody has reviewed is reported, not waved through", async (t) => {
  // `cordis:group` resolves through no registry and no filesystem, and the
  // tier used to treat "nothing can answer" as "fine" — so
  // `cordis:this-was-renamed-upstream` verified clean. An upstream rename is
  // exactly the class this guard exists for, so an unrecognised built-in is a
  // problem a human closes by reviewing it, not a silence.
  const preset = await readFile(path.join(repoRoot, SOURCE_FILES.preset), "utf8");
  t.after(async () => { await writeFile(path.join(repoRoot, SOURCE_FILES.preset), preset, "utf8"); });
  await writeFile(
    path.join(repoRoot, SOURCE_FILES.preset),
    preset.replace(/name: cordis:group/g, "name: cordis:renamed-upstream"),
    "utf8",
  );
  const verdict = await verifyCompositionReferences({ offline: true });
  const unreviewed = verdict.problems.filter((problem) => problem.kind === "unreviewed-kernel-builtin");
  assert.ok(unreviewed.length > 0, "a renamed built-in must be reported");
  assert.equal(unreviewed[0].specifier, "cordis:renamed-upstream");
  assert.match(unreviewed[0].detail, /cordis:group/, "the message must name what has been reviewed");
});
