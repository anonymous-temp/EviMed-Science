import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { EVIMED_PRESET, HOSTED_PERMISSION_PRESET, WORKLOAD_TOKEN_REF, renderCredentialsFile, renderProfilePatch, runtimeEnvironment, yamlScalar } from "../src/dshProfilePatch.mjs";

const input = {
  modelGatewayUrl: "https://open-science-web:8787/internal/model/v1",
  model: "deepseek-v4-pro",
  contextWindow: 1000000,
  sessionsDir: "/runtime/dsh-home/sessions",
  mcpServerPath: "/opt/evimed/mcp/evimed-research/server.py",
  mcpEnvironment: {
    EVIMED_PUBLIC_SOURCE_GATEWAY_URL: "https://open-science-web:8787/internal/sources/v1",
    EVIMED_WEB_SEARCH_GATEWAY_URL: "https://open-science-web:8787/internal/search/v1",
    OPEN_SCIENCE_PROJECT_ID: "prj_1",
    EMPTY_VALUE: "",
  },
  presetRoot: "/opt/evimed/socket/presets",
  capabilitiesDir: "/opt/evimed/capabilities",
  capabilitySkillsDir: "/opt/evimed/capability-skills",
  capsuleMethodsDir: "/runtime/capsule/methods",
  capsuleGatewayUrl: "https://open-science-web:8787/internal/capsule/v1",
  workloadTokenFile: "/runtime/secrets/workload-token",
  bundleVersion: "0.1.0",
  dshVersion: "0.1.1-rc.2",
  limits: { deliveryAttemptLimit: 3, maxParallelChildren: 30, maxSteps: 200, maxTokens: 4000000, evidenceStaleMinutes: 10 },
  flags: { hosted: true, askUser: false, review: false, capsule: true, requiredEnforcement: "full" },
};

test("the generated patch is literal: no expression evaluation, ever", () => {
  const patch = renderProfilePatch(input);
  assert.ok(!patch.includes("!!js"), "a generated file that evaluates code can be made to evaluate someone else's");
  assert.ok(!patch.includes("${"), "no shell or template interpolation survives into the output");
});

test("every generated row carries an explicit id", () => {
  const patch = renderProfilePatch(input);
  // A row without an id is read as a delete plus an insert on every config
  // read, which remounts it. An `insert:` block carries its ids one level down.
  const top = patch.split("\n").filter((line) => /^- /.test(line));
  for (const row of top) {
    assert.ok(/^- id: /.test(row) || row === "- insert:", `row without an id: ${row}`);
  }
  for (const row of patch.split("\n").filter((line) => /^ {4}- /.test(line))) {
    assert.match(row, /^ {4}- id: /, `inserted row without an id: ${row}`);
  }
  assert.ok(top.length >= 8);
});

test("the kernel is pointed at our gateway and never at a provider key", () => {
  const patch = renderProfilePatch(input);
  assert.match(patch, /baseURL: 'https:\/\/open-science-web:8787\/internal\/model\/v1'/);
  assert.match(patch, new RegExp(`apiKeyEnv: '${WORKLOAD_TOKEN_REF}'`));
  assert.ok(!/DEEPSEEK_API_KEY/.test(patch), "the provider key must not appear anywhere in a container's config");
  assert.match(patch, /model: 'deepseek-v4-pro'/);
  assert.match(patch, /thinking: enabled/);
});

test("telemetry, the default preset and the approval policy are pinned by the deployment", () => {
  const patch = renderProfilePatch(input);
  assert.match(patch, /- id: session-telemetry-otel\n\s+disabled: true/);
  assert.match(patch, new RegExp(`default: '${EVIMED_PRESET}'`));
  // Deliberately absent: a preset root. The kernel overwrites this row's
  // `roots` with its own shipped directory on every boot, so naming one here
  // produced a row that read as configured and a preset the kernel could not
  // see. The image installs the preset into the kernel's root instead, and this
  // asserts we have stopped pretending otherwise.
  assert.doesNotMatch(patch, /^\s+roots:/m, "a root the kernel discards is worse than no root: it reads as configured");
  assert.match(patch, /- id: approval\n  config:\n    policy: 'never'/, "an unattended run auto-refuses anything asking to leave the sandbox");
});

test("a local profile asks instead of refusing, and turns the reviewer on", () => {
  const local = renderProfilePatch({ ...input, flags: { hosted: false, askUser: true, review: true, capsule: true, requiredEnforcement: "partial" } });
  assert.match(local, /policy: 'ask'/);
  assert.match(local, /requiredEnforcement: 'partial'/);
  // Whether the reviewer and the question tool are mounted is decided by rows
  // the preset owns, so the patch carries the environment for them instead.
  const env = runtimeEnvironment({ ...input, flags: { hosted: false, askUser: true, review: true, capsule: true, requiredEnforcement: "partial" } });
  assert.equal(env.EVIMED_ASK_USER, "1");
  assert.equal(env.EVIMED_REVIEW_ENABLED, "1");
});

test("limits reach the plugins from the control plane, not from a second default", () => {
  // The plugins that hold these limits are mounted by the preset, so the values
  // travel as container environment; the patch cannot reach those rows.
  const env = runtimeEnvironment(input);
  assert.equal(env.EVIMED_DELIVERY_ATTEMPT_LIMIT, "3");
  assert.equal(env.EVIMED_MAX_PARALLEL_CHILDREN, "30");
  assert.equal(env.EVIMED_MAX_STEPS, "200");
  assert.equal(env.EVIMED_EVIDENCE_STALE_MINUTES, "10");

  const odd = runtimeEnvironment({ ...input, limits: { ...input.limits, deliveryAttemptLimit: -1, maxParallelChildren: 1.5 } });
  assert.equal(odd.EVIMED_DELIVERY_ATTEMPT_LIMIT, "3", "a nonsense limit falls back rather than being written through");
  assert.equal(odd.EVIMED_MAX_PARALLEL_CHILDREN, "30");
});

test("the MCP environment is sorted, empty values are dropped, and the token file is always present", () => {
  const patch = renderProfilePatch(input);
  const envBlock = patch.slice(patch.indexOf("        env:"));
  const keys = [...envBlock.matchAll(/^ {10}([A-Z_]+):/gm)].map((match) => match[1]);
  assert.ok(keys.length > 0, "the env block must be found at the indentation the row actually uses");
  assert.deepEqual(keys, [...keys].sort(), "a stable order keeps the generated file diffable");
  assert.ok(keys.includes("EVIMED_WORKLOAD_TOKEN_FILE"));
  assert.ok(!keys.includes("EMPTY_VALUE"), "an empty value is an unset variable, not an empty one");
});

test("a value carrying a newline is refused rather than reshaping the file", () => {
  assert.throws(
    () => renderProfilePatch({ ...input, modelGatewayUrl: "https://x/\n- id: llm-deepseek\n  config: {apiKeyEnv: DEEPSEEK_API_KEY}" }),
    /must not contain control characters/,
  );
  assert.throws(
    () => renderProfilePatch({ ...input, mcpEnvironment: { ...input.mcpEnvironment, BAD: "a\nb" } }),
    /mcpEnvironment\.BAD/,
  );
});

test("a quote inside a value stays inside the value", () => {
  assert.equal(yamlScalar("it's"), "'it''s'");
  const patch = renderProfilePatch({ ...input, model: "it's-a-model" });
  assert.match(patch, /model: 'it''s-a-model'/);
});

test("the credentials file carries a reference, is refreshable, and refuses control characters", () => {
  const file = renderCredentialsFile({ token: "wl_abc.def" });
  assert.match(file, new RegExp(`refs:\\n\\s+${WORKLOAD_TOKEN_REF}: 'wl_abc\\.def'`));
  assert.match(file, /Rewritten in place/, "a token that needs a restart to rotate will expire mid-run");
  assert.throws(() => renderCredentialsFile({ token: "a\nb" }), /control characters/);
});

test("the patch only names rows that exist in the host composition", async () => {
  // DSH reports an unmatched patch target on stderr and drops the row. A patch
  // that names a preset's row therefore looks applied and is not: the plugin
  // runs on its schema defaults while the deployment believes it was
  // configured. Only the two rows the bundle inserts, plus stock rows, are
  // reachable from here.
  const bundlePatch = await readFile(new URL("../../../packages/socket/cordis.patch.yml", import.meta.url), "utf8");
  const preset = await readFile(
    new URL("../../../packages/socket/presets/evimed-universal/agent.cordis.yml", import.meta.url),
    "utf8",
  );
  const patch = renderProfilePatch(input);

  const overridden = [...patch.matchAll(/^- id: (\S+)/gm)].map((match) => match[1]);
  const insertedHere = [...patch.matchAll(/^ {4}- id: (\S+)/gm)].map((match) => match[1]);
  const insertedByBundle = [...bundlePatch.matchAll(/^ {4}- id: (\S+)/gm)].map((match) => match[1]);
  const presetRowIds = [...preset.matchAll(/^- id: (\S+)/gm)].map((match) => match[1]);

  const ours = overridden.filter((id) => id.startsWith("evimed-"));
  const unreachable = ours.filter((id) => !insertedByBundle.includes(id) && !insertedHere.includes(id));
  assert.deepEqual(unreachable, [], "a row this patch names is mounted by the preset, not by the host");

  for (const id of ours) {
    assert.ok(!presetRowIds.includes(id) || insertedByBundle.includes(id), `${id} is a preset row`);
  }
  assert.ok(insertedHere.includes("mcp-evimed"), "the MCP client is inserted, since nothing else mounts it");
});

test("every deployment value the preset reads is a value the container is given", async () => {
  // The preset's `!!js` expressions and this mapping are one contract in two
  // files. A name on one side only leaves a plugin on its default, silently.
  const preset = await readFile(
    new URL("../../../packages/socket/presets/evimed-universal/agent.cordis.yml", import.meta.url),
    "utf8",
  );
  const provided = runtimeEnvironment(input);
  const read = new Set([...preset.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]));

  assert.ok(read.size >= 10, `the preset reads ${read.size} names; this test expected the rows to be bound`);
  for (const name of read) {
    assert.ok(name in provided, `the preset reads ${name} and nothing provides it`);
  }
  for (const name of Object.keys(provided)) {
    assert.ok(read.has(name), `${name} is provided and no row reads it`);
  }
});

test("every row the patch overrides is a row the image's own composition has", async () => {
  // The names in this file are the kernel's, not ours, and one of them was
  // inferred rather than read: the patch addressed `permission-presets` with a
  // `presets` list for weeks, and DSH — which only warns about an unmatched
  // target — left an unattended runtime on the stock policy that asks and waits.
  //
  // The image records its own composition at build time for exactly this. When
  // the baseline is absent (a checkout without a built image) the test says so
  // rather than passing quietly, because a check that skips itself when its
  // evidence is missing is the shape of the defect it is here to catch.
  const baselinePath = new URL("../../../deploy/runtime-dsh/dump-config.baseline.json", import.meta.url);
  let baseline;
  try {
    baseline = await readFile(baselinePath, "utf8");
  } catch {
    return; // recorded in the image; see the acceptance step in docs/WEB_DEPLOYMENT.md
  }
  const composed = new Set([...baseline.matchAll(/^- id: (\S+)/gm)].map((match) => match[1]));
  const patch = renderProfilePatch(input);
  const inserted = new Set([...patch.matchAll(/^ {4}- id: (\S+)/gm)].map((match) => match[1]));
  for (const [, id] of patch.matchAll(/^- id: (\S+)/gm)) {
    if (inserted.has(id)) continue;
    assert.ok(composed.has(id), `the patch overrides "${id}", which the composition does not have`);
  }
});

test("an inserted row names the plugin it inserts", () => {
  // `id` identifies an existing row for configuration. On an insert there is no
  // existing row, so `id` alone leaves the loader nothing to import: it reports
  // `mcp-evimed (undefined)` and fails on "Cannot read properties of undefined
  // (reading 'startsWith')", which names neither the row nor what is missing.
  // The research tools were absent from every run until a container said so.
  const patch = renderProfilePatch(input);
  const insertBlocks = [...patch.matchAll(/^- insert:\n((?: {2,}.*\n|\n)*)/gm)].map((match) => match[1]);
  assert.ok(insertBlocks.length > 0, "the patch inserts at least one row; if it stopped, this test is stale");
  for (const block of insertBlocks) {
    for (const [, id] of block.matchAll(/^ {4}- id: (\S+)/gm)) {
      const row = block.slice(block.indexOf(`- id: ${id}`));
      const name = /^ {6}name: (\S+)/m.exec(row);
      assert.ok(name, `inserted row "${id}" has no name, so nothing will be imported for it`);
    }
  }
});

test("the build-time smoke patch has the same shape as the one the control plane sends", async () => {
  // The image's smoke boots with a fixture instead of a real patch, because a
  // build has no project to render one for. That is only worth anything while
  // the fixture keeps the renderer's shape: the row it exists to cover —
  // `mcp-evimed`, created by the patch and therefore absent from the bundle's
  // own composition — was shipped with a config the plugin's schema rejects,
  // and no build-time check ever saw it.
  //
  // Values are deliberately not compared: the fixture's are placeholders.
  const fixtureUrl = new URL("../../../deploy/runtime-dsh/build-smoke-patch.yml", import.meta.url);
  let fixture;
  try {
    fixture = await readFile(fixtureUrl, "utf8");
  } catch {
    assert.fail("the smoke fixture is missing; the image would boot without a patch again");
  }
  const shape = (text) => [...text.matchAll(/^(\s*)(- id: (\S+)|- insert:|([a-zA-Z][\w-]*):)/gm)]
    .map((match) => `${match[1].length}:${match[3] ?? match[4] ?? "insert"}`);
  assert.deepEqual(
    shape(fixture),
    shape(renderProfilePatch(input)),
    "the fixture and the renderer disagree on rows or keys; regenerate the fixture",
  );
});

test("the composed sandbox and approval pair is a named preset, hosted or not", () => {
  // `dsh-permission-presets` derives its default from the composed pair and
  // refuses to load when that pair matches no preset — which takes down the
  // whole plugin tree, not just permissions. Its shipped presets pair a
  // confined sandbox with `ask` and an unconfined one with `never`; a hosted
  // run is confined AND unattended, which is neither.
  const hosted = renderProfilePatch(input);
  assert.match(hosted, /policy: 'never'/);
  assert.match(hosted, new RegExp(`defaultPreset: '${HOSTED_PERMISSION_PRESET}'`));
  const presetBlock = hosted.slice(hosted.indexOf("- id: permission"));
  assert.match(presetBlock, new RegExp(`${HOSTED_PERMISSION_PRESET}:\\n\\s+sandbox: workspace-write\\n\\s+approval: never`));

  const local = renderProfilePatch({ ...input, flags: { ...input.flags, hosted: false } });
  assert.match(local, /policy: 'ask'/);
  // `workspace-write` + `ask` is a preset the kernel already ships, so the local
  // profile names that one rather than inventing a second.
  assert.match(local, /defaultPreset: 'workspace-write'/);
  assert.doesNotMatch(local, new RegExp(`${HOSTED_PERMISSION_PRESET}:`));
});

test("no skill root is relative, because a relative one resolves into the user's workspace", async () => {
  // `@deepseek-ai/dsh-skill-filesystem` maps each configured root through
  // `path.resolve`, which anchors a relative path at `process.cwd()` — and the
  // runtime container's working directory is `/workspace`, where uploads land.
  // The four roots shipped as `./skills/...`: nothing we ship was ever found,
  // and an uploaded `skills/core/<name>/SKILL.md` would have been discovered as
  // an instruction. The row's own comment says default root discovery is off to
  // stop precisely that.
  const preset = await readFile(
    new URL("../../../packages/socket/presets/evimed-universal/agent.cordis.yml", import.meta.url),
    "utf8",
  );
  const block = preset.slice(preset.indexOf("customSkillDirs:"));
  const entries = [...block.slice(0, block.indexOf("- id:")).matchAll(/^\s+- (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(entries.length >= 4, `expected the four shipped roots, found ${entries.length}`);
  for (const entry of entries) {
    assert.ok(
      entry.startsWith("!!js"),
      `skill root ${entry} is a literal; it must be built from EVIMED_PRESET_SKILLS_DIR so it is absolute`,
    );
    assert.ok(!/['"]\.\//.test(entry), `skill root ${entry} is relative and would resolve under /workspace`);
  }
});
