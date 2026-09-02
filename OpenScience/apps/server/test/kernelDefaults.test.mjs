// Upstream moves a default and nothing errors: our composition text is
// byte-identical, the container boots, the run works, and one guarantee is
// gone. DSH 0.1.2-alpha.4 turned `web_fetch` on by default "for Python SDK,
// Headless, ACP and custom Profiles" - we are a custom profile - and the same
// release stopped exposing the general-purpose `workflow` tool in Web PTC mode.
// Neither would have produced a single error message here.
//
// These tests hold `check-kernel-defaults.mjs` to the three things that make it
// worth having: it reads the real composition rather than a list beside it, it
// goes red when a setting we depend on stops holding, and it says which of the
// differences between two kernels are ours. The mutations below flip
// invariants OTHER than web_fetch on purpose - the point of the mechanism is
// that the NEXT flip is caught by the same code, and a guard that only knows
// last month's incident is a keyword, not a mechanism.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PROVENANCE,
  DECLARED_INVARIANTS,
  SOURCES,
  checkKernelDefaults,
  deriveFromAbsentList,
  deriveFromPatch,
  diffConfigurations,
  formatReport,
  parseCordisDocument,
  scalarValue,
} from "../../../scripts/ops/check-kernel-defaults.mjs";
import { renderProfilePatch } from "../src/dshProfilePatch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "scripts/ops/check-kernel-defaults.mjs");

/** @param {keyof typeof SOURCES} key */
const source = (key) => path.join(repoRoot, SOURCES[key]);

/** A temp copy of a real source file with one edit applied. Returns its absolute path. */
async function mutatedCopy(name, text, edit) {
  const next = edit(text);
  assert.notEqual(next, text, `the mutation for ${name} changed nothing; the fixture edit is stale and the test below would prove nothing`);
  const dir = await mkdtemp(path.join(tmpdir(), "evimed-kernel-defaults-"));
  const file = path.join(dir, name);
  await writeFile(file, next, "utf8");
  return file;
}

function problemsOfKind(report, kind) {
  return report.problems.filter((problem) => problem.kind === kind);
}

test("every setting the runtime depends on still holds in the composition the image recorded", async () => {
  const run = spawnSync(process.execPath, [script, "--json"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.error, undefined);
  const report = JSON.parse(run.stdout);

  assert.deepEqual(
    report.problems,
    [],
    `settings we depend on no longer hold:\n${report.problems.map((problem) => `  [${problem.kind}] ${problem.detail}`).join("\n")}`,
  );
  assert.equal(run.status, 0);

  // The verdict, then the evidence behind it: `ok` on a checker that walked
  // nothing looks exactly like `ok` on one that walked everything, and this
  // repository has shipped the first kind before.
  // Exact, not a floor: the digest pins the baseline's bytes, so the number of
  // rows read out of them is fixed too, and a parser that thinned out silently
  // is the way a checker starts reporting nothing wrong. Re-recording the image
  // moves BASELINE_PROVENANCE and this number in the same edit.
  assert.equal(report.counts.baselineRows, 147, "the image's recorded composition, all of it");
  assert.equal(report.counts.presetRows, 23, "the preset's rows, counting the eight our groups mount");
  assert.ok(report.invariants.length >= 20, `only ${report.invariants.length} invariants were derived`);

  // Every invariant the review named, present by address rather than by count.
  const address = (scope, row, key) =>
    report.invariants.find((invariant) => invariant.scope === scope && invariant.row === row && (key === undefined || invariant.key === key));
  assert.ok(address("host", "web-fetch-http", "disabled"), "web_fetch: the direct HTTP fetch provider must stay off");
  assert.ok(address("agent", "tool-web"), "web_fetch: the model must have no fetch tool to reach a provider with");
  assert.ok(address("host", "session-telemetry-otel", "disabled"), "telemetry off");
  assert.ok(address("host", "hmr", "disabled"), "hot reload off");
  assert.ok(address("host", "approval", "config.policy"), "the approval policy has an address the profile patch can write to");
  assert.ok(address("agent", "skill-filesystem", "config.includeDefaultRoots"), "skill root discovery off");
  assert.ok(address("host", "plugin-package-inventory-deepseek", "disabled"), "the plugin inventory is not the model provider's business");
  assert.ok(address("host", "sandbox-policy", "config.mode"), "the sandbox mode lever still reaches the row that reads it");

  // Every invariant carries a reason. A rule nobody can read the reason for is
  // a rule the next person deletes to make a build go green.
  for (const invariant of report.invariants) {
    assert.ok(invariant.why && invariant.why.length > 20, `invariant ${invariant.scope}/${invariant.row} carries no reason`);
    assert.ok(invariant.source, `invariant ${invariant.scope}/${invariant.row} names no source`);
  }

  // No fresh dump in a checkout, and the report must say that rather than
  // printing an empty difference list, which reads as "nothing drifted".
  assert.equal(report.current.mode, "baseline");
  assert.match(formatReport(report), /No fresh --dump-config was supplied, so NO upstream drift was compared/);
});

test("the invariant list is read out of the composition, not retyped beside it", async () => {
  const patchText = await readFile(source("patch"), "utf8");
  const presetText = await readFile(source("preset"), "utf8");

  const fromPatch = deriveFromPatch(patchText);
  assert.deepEqual(
    fromPatch.map((invariant) => `${invariant.row}.${invariant.key}=${invariant.value}`).sort(),
    [
      "hmr.disabled=true",
      "plugin-package-inventory-deepseek.disabled=true",
      "session-telemetry-otel.disabled=true",
      // Pinned when 0.1.2-alpha.4 flipped `fetch` on by default for custom
      // profiles: an inherited value that changed once can change again, and
      // the two older defences (the tool is absent, the provider is disabled)
      // are the ones a single edit can undo. `searchTimeoutMs` comes with it
      // because a patch row replaces a `config` value whole rather than
      // merging keys — dropping it would silently reset the timeout.
      "tool-web.config.fetch=false",
      "tool-web.config.searchTimeoutMs=60000",
      "web-fetch-http.disabled=true",
    ],
    "every host-scope override the bundle patch makes should become an invariant",
  );
  // Derived means derived: the reason is the patch's own prose, and the line
  // number points at the row a reader has to open. A reason typed here instead
  // would be a second copy, and second copies drift.
  const webFetch = fromPatch.find((invariant) => invariant.row === "web-fetch-http");
  assert.match(webFetch.source, /^packages\/socket\/cordis\.patch\.yml:\d+$/);
  assert.equal(patchText.split("\n")[Number(webFetch.source.split(":")[1]) - 1], "- id: web-fetch-http");
  assert.ok(
    patchText.replace(/^#\s?/gm, "").replace(/\s+/g, " ").includes(webFetch.why.slice(0, 120)),
    "the reason must come out of the patch file, not out of this checker",
  );

  const absent = deriveFromAbsentList(presetText);
  const names = absent.map((invariant) => invariant.row);
  assert.deepEqual(
    names,
    ["tool-todo", "agent-instructions", "str_replace_editor", "tool-web", "plan-mode", "tool-ralph", "tool-lsp", "code-runtime", "tool-goal"],
    "the preset's deliberately-absent block is the list; if it changed, this is where you notice",
  );
  // A reason that spans three comment lines has to arrive whole, or the entry
  // reads as an unexplained ban.
  const toolWeb = absent.find((invariant) => invariant.row === "tool-web");
  assert.match(toolWeb.why, /web_fetch is an SSRF surface/);
  assert.match(toolWeb.why, /retrieval goes through MCP so the runtime never names a host/);
});

test("an upstream default flipping back on is caught - a different one from the incident that prompted this", async () => {
  // Not web_fetch. `plugin-package-inventory-deepseek` reports the deployment's
  // enabled plugin list - which capability packages exist, which gates are
  // mounted - to the model provider on every request, and it arrived as a new
  // default in 0.1.2. Upstream re-registering it, or moving it out from under
  // our patch, is the same class of change as the alpha.4 web_fetch flip and
  // has to be caught by the same code, not by a second rule about fetching.
  const dump = await mutatedCopy("alpha5-dump.json", await readFile(source("baseline"), "utf8"), (text) =>
    text.replace(
      "- id: plugin-package-inventory-deepseek\n  name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'\n  disabled: true\n",
      "- id: plugin-package-inventory-deepseek\n  name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'\n",
    ),
  );

  const report = await checkKernelDefaults({ dump });
  assert.equal(report.ok, false);
  const [problem, ...rest] = problemsOfKind(report, "value-missing");
  assert.deepEqual(rest, [], "exactly one invariant should have moved; more means the fixture edited more than it meant to");
  assert.equal(problem.row, "plugin-package-inventory-deepseek");
  assert.equal(problem.required, "true");
  assert.equal(problem.found, "(key absent)");
  assert.match(problem.why, /not the provider's business/);
  // The difference is classified as ours, not filed away as an upstream notice.
  const difference = report.differences.find((entry) => entry.row === "plugin-package-inventory-deepseek");
  assert.equal(difference.klass, "pinned");
  // The operator has to be able to read all of that off the output.
  const text = formatReport(report);
  assert.match(text, /plugin-package-inventory-deepseek/);
  assert.match(text, /required: true/);
});

test("an upstream default we depend on but do not set is caught the same way", async () => {
  // `tool-web` is disabled by upstream's own web-app patch, not by ours. We
  // depend on it and pin nothing, which is precisely the alpha.4 shape: the
  // day that patch stops disabling it, nothing of ours changes.
  const dump = await mutatedCopy("alpha5-dump.json", await readFile(source("baseline"), "utf8"), (text) =>
    text.replace("  config:\n    fetch: false\n    searchTimeoutMs: 60000\n  disabled: true\n", "  config:\n    fetch: true\n    searchTimeoutMs: 60000\n"),
  );

  const report = await checkKernelDefaults({ dump });
  assert.equal(report.ok, false);
  const drifted = problemsOfKind(report, "value-drifted").find((problem) => problem.key === "config.fetch");
  assert.ok(drifted, "the web tool offering fetch again must be a failure, not a notice");
  assert.equal(drifted.required, "false");
  assert.equal(drifted.found, "true");
  assert.ok(
    problemsOfKind(report, "value-missing").some((problem) => problem.row === "tool-web" && problem.key === "disabled"),
    "and the row being mounted at all is the other half of the same invariant",
  );
});

test("a difference is classified before it is reported: ours fails, theirs is a notice, unseen keys still print", async () => {
  const baselineText = await readFile(source("baseline"), "utf8");
  const dump = await mutatedCopy("alpha5-dump.json", baselineText, (text) =>
    text
      // (b) an upstream default we hold no opinion about
      .replace("    fetchProvider: http\n", "    fetchProvider: builtin\n")
      // (c) a row the baseline has never seen
      .replace("- id: tools\n", "- id: tool-web-fetch\n  name: '@deepseek-ai/dsh-tool-web-fetch'\n  config:\n    enabled: true\n- id: tools\n")
      // (c) a key the baseline has never seen, on a row it has
      .replace("    searchTimeoutMs: 60000\n", "    searchTimeoutMs: 60000\n    fetchTimeoutMs: 30000\n"),
  );

  const report = await checkKernelDefaults({ dump });
  const byAddress = new Map(report.differences.map((entry) => [entry.key ? `${entry.row}.${entry.key}` : entry.row, entry]));

  assert.equal(byAddress.get("web.config.fetchProvider")?.klass, "upstream-default");
  assert.equal(byAddress.get("web.config.fetchProvider")?.before, "http");
  assert.equal(byAddress.get("web.config.fetchProvider")?.after, "builtin");
  assert.equal(byAddress.get("tool-web-fetch")?.klass, "unknown");
  assert.equal(byAddress.get("tool-web.config.fetchTimeoutMs")?.klass, "unknown");

  // A notice is a notice: none of the three may fail the run on their own.
  assert.deepEqual(report.problems, [], "classification (b) and (c) are reports, not gates");
  assert.equal(report.ok, true);

  // But they must reach a human. A silently classified difference is the same
  // as a dropped one.
  const text = formatReport(report);
  assert.match(text, /upstream default moved/);
  assert.match(text, /web\.config\.fetchProvider: http -> builtin/);
  assert.match(text, /the baseline has never seen/);
  assert.match(text, /tool-web-fetch/);
});

test("adding a deliberately-absent tool back to the preset is caught with the preset's own reason", async () => {
  // Third invariant class, third mutation: the model-visible surface. The
  // absent list is the composition's statement of what the model may not see,
  // and until now it was a comment - it protected exactly as much as whoever
  // happened to read it.
  const preset = await mutatedCopy("agent.cordis.yml", await readFile(source("preset"), "utf8"), (text) =>
    text.replace("- id: tool-skill\n", "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n- id: tool-skill\n"),
  );

  const report = await checkKernelDefaults({ overrideFiles: { preset } });
  assert.equal(report.ok, false);
  const [problem, ...rest] = problemsOfKind(report, "absent-row-present");
  assert.deepEqual(rest, []);
  assert.equal(problem.row, "tool-web");
  assert.match(problem.found, /tool-web/);
  assert.match(problem.why, /SSRF surface/);
});

test("a row that upstream renamed takes its invariant with it, loudly", async () => {
  // The failure mode that has actually happened here: a patch id that matches
  // nothing only warns on stderr and is dropped, so the override stops applying
  // and the composition still looks configured. `verify-composition-references`
  // catches an id our patch names; this catches the value going unenforced.
  const dump = await mutatedCopy("alpha5-dump.json", await readFile(source("baseline"), "utf8"), (text) =>
    text.replace("- id: web-fetch-http\n", "- id: web-fetch-undici\n"),
  );

  const report = await checkKernelDefaults({ dump });
  const [problem] = problemsOfKind(report, "row-missing");
  assert.equal(problem.row, "web-fetch-http");
  assert.match(problem.detail, /only warns on stderr and is dropped/);
});

test("a baseline recorded by a different kernel is never quietly compared", async () => {
  // A version the pin is not, whatever the pin becomes. Written as a literal
  // this fixture went stale the moment the tree moved onto it: the mutation
  // replaced the version with itself, changed nothing, and `mutatedCopy` said
  // so rather than letting the assertion below pass on an unmutated file.
  const nextRelease = `${BASELINE_PROVENANCE.dshVersion}-not-the-recorded-one`;
  const pins = await mutatedCopy("deps-version.json", await readFile(source("pins"), "utf8"), (text) =>
    text.replace(`"version": "${BASELINE_PROVENANCE.dshVersion}"`, `"version": "${nextRelease}"`),
  );

  const report = await checkKernelDefaults({ overrideFiles: { pins } });
  assert.equal(report.ok, false);
  const [problem] = problemsOfKind(report, "baseline-version-mismatch");
  assert.ok(problem, "moving the pin without re-recording the baseline must fail");
  assert.equal(problem.required, nextRelease);
  assert.equal(problem.found, BASELINE_PROVENANCE.dshVersion);
  assert.match(problem.detail, /certifies these invariants against a kernel we do not ship/);
});

test("a baseline whose bytes nobody attested to is not evidence", async () => {
  // The laundering path this closes: the build's `diff -u` refuses when the
  // image's dump differs from the committed baseline, and the obvious remedy is
  // to copy the new dump over the old one - which accepts every default that
  // moved, including a security-relevant one, with no reviewer ever seeing it.
  const baseline = await mutatedCopy("dump-config.baseline.json", await readFile(source("baseline"), "utf8"), (text) =>
    text.replace("- id: web-fetch-http\n  name: '@deepseek-ai/dsh-web-fetch-http'\n  disabled: true\n", "- id: web-fetch-http\n  name: '@deepseek-ai/dsh-web-fetch-http'\n"),
  );

  const report = await checkKernelDefaults({ overrideFiles: { baseline } });
  assert.equal(report.ok, false);
  assert.ok(problemsOfKind(report, "baseline-bytes-unattested").length === 1, "a re-recorded baseline has to be attested before it is believed");
  // And the invariant itself still fails on top of it, so the reason the
  // re-record was wrong is in the same report as the fact that it happened.
  assert.ok(problemsOfKind(report, "value-missing").some((problem) => problem.row === "web-fetch-http"));
});

test("an input this cannot read is an error, never a skip", async () => {
  // Absent evidence is not passing evidence. The nearest existing check
  // (dshProfilePatch.test.mjs, "every row the patch overrides is a row the
  // image's composition has") returns quietly when the baseline is missing,
  // which is the shape of the defect it is there to catch.
  await assert.rejects(
    () => checkKernelDefaults({ overrideFiles: { baseline: path.join(tmpdir(), "no-such-dump-config.json") } }),
    /cannot read baseline .*no-such-dump-config\.json/,
  );
  await assert.rejects(() => checkKernelDefaults({ dump: path.join(tmpdir(), "no-such-candidate.json") }), /cannot read the --dump configuration/);
});

test("the checker stops rather than guessing when the composition stops parsing", async () => {
  // A parser that shrugs at a line it does not understand produces a short row
  // list, and a short row list produces zero findings. Both halves are checked:
  // the throw, and the floor that catches a scan which merely thinned out.
  assert.throws(() => parseCordisDocument("- id: a\n  name: x\n    stray: 1\n"), /the row scan is wrong/);
  assert.throws(() => parseCordisDocument("- id: a\n- id: a\n"), /two rows share the id/);

  const baseline = await mutatedCopy("dump-config.baseline.json", await readFile(source("baseline"), "utf8"), (text) =>
    text.split("\n").slice(0, 60).join("\n"),
  );
  const report = await checkKernelDefaults({ overrideFiles: { baseline } });
  assert.ok(
    problemsOfKind(report, "extraction-drift").some((problem) => problem.detail.startsWith("baselineRows:")),
    "a composition that suddenly has a handful of rows is a broken read, not a small composition",
  );
});

test("an expression and a literal that read alike are not the same setting", () => {
  // `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` and
  // `mode: workspace-write` behave identically today and differently the moment
  // the environment stops being set. Comparing them equal would hide a row that
  // stopped reading the container's environment - the class the memory note
  // "an env lever must reach the container" is about.
  assert.notEqual(scalarValue("!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'"), scalarValue("'workspace-write'"));
  assert.equal(scalarValue("':memory:'"), ":memory:");
  assert.equal(scalarValue("!!js  process.cwd()"), "!!js process.cwd()");
});

test("every row the control plane's generated patch writes to is a row the image composed", async () => {
  // The addresses in the generated patch are the kernel's names, not ours, and
  // one of them was once inferred rather than read: the patch addressed
  // `permission-presets` with a `presets` list for weeks, DSH warned on stderr
  // and dropped it, and an unattended runtime sat on the stock policy that asks
  // and then waits. Nothing in the patch's own tests fails when the baseline is
  // unreadable - this one does, because a missing baseline is exactly when a
  // renamed row would go unnoticed.
  const baselineText = await readFile(source("baseline"), "utf8");
  const { byId } = parseCordisDocument(baselineText);
  assert.ok(byId.size > 100, `the recorded composition parsed to ${byId.size} rows; nothing below would mean anything`);

  const patch = renderProfilePatch({
    modelGatewayUrl: "https://open-science-web:8787/internal/model/v1",
    model: "deepseek-v4-pro",
    contextWindow: 1000000,
    sessionsDir: "/runtime/dsh-home/sessions",
    mcpServerPath: "/opt/evimed/mcp/evimed-research/server.py",
    mcpEnvironment: { OPEN_SCIENCE_PROJECT_ID: "prj_1" },
    presetRoot: "/opt/evimed/socket/presets",
    presetSkillsDir: "/opt/evimed/skills",
    capabilitiesDir: "/opt/evimed/capabilities",
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    capsuleMethodsDir: "/runtime/capsule/methods",
    capsuleGatewayUrl: "https://open-science-web:8787/internal/capsule/v1",
    workloadTokenFile: "/runtime/secrets/workload-token",
    bundleVersion: "0.1.0",
    dshVersion: BASELINE_PROVENANCE.dshVersion,
    limits: { deliveryAttemptLimit: 3, maxParallelChildren: 30, maxSteps: 200, maxTokens: 400000, evidenceStaleMinutes: 10, screeningBatchSize: 50 },
    flags: { hosted: true, askUser: false, review: false, capsule: true, requiredEnforcement: "full" },
  });

  const { rows } = parseCordisDocument(patch);
  const overrides = rows.filter((row) => !row.inserted);
  assert.ok(overrides.length >= 8, `the generated patch overrode ${overrides.length} rows; the scan lost them`);
  for (const row of overrides) {
    assert.ok(byId.get(row.id), `the control plane writes to \`${row.id}\`, which ${SOURCES.baseline} does not have`);
  }
  // Row level only, and deliberately: a patch legitimately writes keys the dump
  // does not print, because the dump shows a row's configured values and not
  // its schema defaults - `llm-deepseek.baseURL` and `permission.defaultPreset`
  // are both absent from the recorded composition and both land. Key-level
  // existence is therefore not decidable from a dump; the keys that must exist
  // are the ones DECLARED_INVARIANTS anchors, checked against the composition
  // itself rather than inferred from here.

  // The two addresses the incident was about, anchored rather than assumed.
  const anchored = DECLARED_INVARIANTS.filter((invariant) => invariant.assert === "present").map((invariant) => `${invariant.row}.${invariant.key}`);
  assert.deepEqual(anchored.sort(), ["approval.config.policy", "permission.config.presets"]);
  for (const row of ["approval", "permission"]) {
    assert.ok(
      overrides.some((entry) => entry.id === row),
      `${row} is anchored as an address the profile patch writes to, and the patch no longer writes to it`,
    );
  }
});

test("two identical configurations differ in nothing, and that is asserted rather than assumed", async () => {
  // The control that keeps every diff assertion above honest: if
  // `diffConfigurations` returned an empty list for any pair of inputs, every
  // classification test would still pass. Same bytes in, nothing out; one byte
  // changed, exactly one difference out.
  const baselineText = await readFile(source("baseline"), "utf8");
  const document = parseCordisDocument(baselineText);
  assert.deepEqual(diffConfigurations(document, parseCordisDocument(baselineText), []), []);

  const nudged = parseCordisDocument(baselineText.replace("    maxInlineBytes: 50000\n", "    maxInlineBytes: 60000\n"));
  assert.deepEqual(diffConfigurations(document, nudged, []), [
    { row: "spill-policy", key: "config.maxInlineBytes", before: "50000", after: "60000", klass: "upstream-default" },
  ]);
});

test("losing one entry from the ban list is caught, not absorbed", async (t) => {
  // Found by an adversarial pass. The deliberately-absent block is parsed with
  // whitespace-sensitive patterns — an entry is `#` + 2-3 spaces, a
  // continuation is `#` + 4 or more — so re-indenting one entry line by a
  // single space demotes a ban to prose. With a floor of six against nine
  // entries, three bans could vanish and every run stayed green. The count is
  // pinned exactly now: changing it is how a reviewer says the composition's
  // ban list changed on purpose.
  const presetPath = path.join(repoRoot, SOURCES.preset);
  const preset = await readFile(presetPath, "utf8");
  t.after(async () => { await writeFile(presetPath, preset, "utf8"); });

  const lines = preset.split("\n");
  const header = lines.findIndex((line) => /^#\s*Deliberately absent/i.test(line));
  assert.ok(header >= 0, "the preset must still carry the deliberately-absent block");
  const entry = lines.findIndex((line, index) => index > header && /^#\s{2,3}\S/.test(line));
  assert.ok(entry > header, "the block must still hold at least one entry");
  lines[entry] = lines[entry].replace(/^#\s{2,3}/, (match) => `${match} `);
  await writeFile(presetPath, lines.join("\n"), "utf8");

  const report = await checkKernelDefaults({});
  const drift = report.problems.filter((problem) => problem.kind === "extraction-drift");
  assert.equal(drift.length, 1, "one demoted entry must be reported");
  assert.match(drift[0].detail, /found 8, expected exactly 9/);
});

test("a row form the parser cannot read stops it, rather than shrinking the list", () => {
  // The other half of the same lesson. This parser refuses YAML flow rows
  // instead of skipping them — loud, which is right — and this pins that,
  // because the day the preset adopts flow form the failure must be a visible
  // red rather than a quietly shorter invariant list.
  assert.throws(
    () => parseCordisDocument("- { id: a, name: '@x/flow' }"),
    /not a mapping key/,
  );
});
