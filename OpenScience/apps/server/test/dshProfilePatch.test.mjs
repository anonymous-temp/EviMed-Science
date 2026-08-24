import assert from "node:assert/strict";
import test from "node:test";

import { EVIMED_PRESET, WORKLOAD_TOKEN_REF, renderCredentialsFile, renderProfilePatch, yamlScalar } from "../src/dshProfilePatch.mjs";

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
  const rows = patch.split("\n").filter((line) => /^- /.test(line));
  for (const row of rows) {
    assert.match(row, /^- id: /, `row without an id: ${row}`);
  }
  assert.ok(rows.length >= 10);
});

test("the kernel is pointed at our gateway and never at a provider key", () => {
  const patch = renderProfilePatch(input);
  assert.match(patch, /baseURL: 'https:\/\/open-science-web:8787\/internal\/model\/v1'/);
  assert.match(patch, new RegExp(`apiKeyEnv: '${WORKLOAD_TOKEN_REF}'`));
  assert.ok(!/DEEPSEEK_API_KEY/.test(patch), "the provider key must not appear anywhere in a container's config");
  assert.match(patch, /model: 'deepseek-v4-pro'/);
  assert.match(patch, /thinking: enabled/);
});

test("telemetry, the preset root and the approval policy are pinned by the deployment", () => {
  const patch = renderProfilePatch(input);
  assert.match(patch, /- id: session-telemetry-otel\n\s+disabled: true/);
  assert.match(patch, /trust: system/, "our preset must not be shadowable by a user copy");
  assert.match(patch, new RegExp(`default: '${EVIMED_PRESET}'`));
  assert.match(patch, /approval: never/, "an unattended run auto-refuses anything asking to leave the sandbox");
  assert.match(patch, /- id: tool-ask-user\n\s+disabled: true/);
});

test("a local profile asks instead of refusing, and turns the reviewer on", () => {
  const local = renderProfilePatch({ ...input, flags: { hosted: false, askUser: true, review: true, capsule: true, requiredEnforcement: "partial" } });
  assert.match(local, /approval: ask/);
  assert.match(local, /- id: tool-ask-user\n\s+disabled: false/);
  assert.match(local, /- id: evimed-review\n\s+disabled: false/);
  assert.match(local, /requiredEnforcement: 'partial'/);
  assert.match(local, /askUserEnabled: true/);
});

test("limits reach the plugins from the control plane, not from a second default", () => {
  const patch = renderProfilePatch(input);
  assert.match(patch, /deliveryAttemptLimit: 3/);
  assert.match(patch, /maxParallelChildren: 30/);
  assert.match(patch, /maxSteps: 200/);
  assert.match(patch, /evidenceStaleMinutes: 10/);
  const odd = renderProfilePatch({ ...input, limits: { ...input.limits, deliveryAttemptLimit: -1, maxParallelChildren: 1.5 } });
  assert.match(odd, /deliveryAttemptLimit: 3/, "a nonsense limit falls back rather than being written through");
  assert.match(odd, /maxParallelChildren: 30/);
});

test("the MCP environment is sorted, empty values are dropped, and the token file is always present", () => {
  const patch = renderProfilePatch(input);
  const envBlock = patch.slice(patch.indexOf("      env:"));
  const keys = [...envBlock.matchAll(/^ {8}([A-Z_]+):/gm)].map((match) => match[1]);
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
