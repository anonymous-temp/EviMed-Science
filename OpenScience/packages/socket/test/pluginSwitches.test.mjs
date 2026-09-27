/**
 * Every agent-scope plugin of ours can be switched off from the environment.
 *
 * Hidden knowledge: native DSH + DeepSeek is the control a plugin is measured
 * against (principle 11), so "off" has to mean the kernel's own composition —
 * no tool, no hook, no prompt section, no service left behind — and with every
 * switch off the preset still has to mount. The switches are read by the rows
 * of `agent.cordis.yml` with `!!js`, so this file reads the rows themselves
 * and evaluates them the way the kernel does, rather than restating which
 * variable belongs to which plugin.
 *
 * What it cannot prove is a live answer: that needs a kernel and a model, and
 * the build smoke boots one. What it does prove is that each row mounts on the
 * pinned cordis and tool registry, that off leaves nothing of ours in that
 * registry, and that each switch removes exactly its own plugin's tools.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadHarnessModule } from "@evimed/harness-port";

import { AGENT_PLUGIN_IDS, PLUGIN_SPECIFIERS } from "../index.mjs";

const PRESET = await readFile(new URL("../presets/evimed-universal/agent.cordis.yml", import.meta.url), "utf8");
const PLUGIN_PREFIX = "@evimed/dsh-socket/plugins/";

/** The rows whose `enabled: false` returns before the plugin touches its context. */
const RETURN_FIRST = ["evimed-guidance", "evimed-run-policy", "evimed-evidence", "evimed-capsule", "evimed-screening", "evimed-compaction"];

/**
 * @typedef {{ id: string, name: string, disabled: string | null, config: Record<string, { js: boolean, text: string }> }} PresetRow
 */

/**
 * The rows of the preset, read by indentation. Hand-read rather than parsed:
 * `!!js` is a tag no general YAML parser loads without being handed an
 * evaluator, and the values these rows carry are single-line scalars.
 * @param {string} text @returns {Map<string, PresetRow>}
 */
function presetRows(text) {
  const lines = text.split("\n");
  /** @type {Map<string, PresetRow>} */
  const rows = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^(\s*)- id: (\S+)\s*$/.exec(lines[index]);
    if (!head) continue;
    const keyIndent = head[1].length + 2;
    /** @type {PresetRow} */
    const row = { id: head[2], name: "", disabled: null, config: {} };
    let inConfig = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      if (indent < keyIndent) break;
      const pair = /^\s*([A-Za-z]\w*):\s*(.*)$/.exec(line);
      if (indent === keyIndent) {
        inConfig = pair?.[1] === "config" && pair[2] === "";
        if (pair?.[1] === "name") row.name = pair[2].replace(/^'|'$/g, "");
        if (pair?.[1] === "disabled") row.disabled = pair[2].replace(/^!!js /, "");
      } else if (inConfig && indent === keyIndent + 2 && pair && !line.trimStart().startsWith("#")) {
        const js = pair[2].startsWith("!!js ");
        row.config[pair[1]] = { js, text: js ? pair[2].slice(5) : pair[2] };
      }
    }
    rows.set(row.id, row);
  }
  return rows;
}

/** @param {string} expression @param {Record<string, string>} env */
function evaluate(expression, env) {
  return new Function("process", `return (${expression})`)({ env: { ...env } });
}

/** @param {{ js: boolean, text: string }} value @param {Record<string, string>} env */
function scalar(value, env) {
  if (value.js) return evaluate(value.text, env);
  if (/^-?\d+(\.\d+)?$/.test(value.text)) return Number(value.text);
  if (value.text === "true" || value.text === "false") return value.text === "true";
  return value.text.replace(/^'|'$/g, "");
}

const ROWS = [...presetRows(PRESET).values()].filter((row) => row.name.startsWith(PLUGIN_PREFIX));

/** A plugin module by row id; the specifiers are relative to the package root. @param {string} id */
function pluginModule(id) {
  return import(new URL(PLUGIN_SPECIFIERS[/** @type {keyof typeof PLUGIN_SPECIFIERS} */ (id)], new URL("../", import.meta.url)).href);
}

/** @param {string} id */
function rowOf(id) {
  const row = ROWS.find((candidate) => candidate.id === id);
  assert.ok(row, `the preset has no row ${id}`);
  return row;
}

/** The one switch a row carries: its own `disabled:`, or an `enabled` config. @param {PresetRow} row */
function switchOf(row) {
  const expression = row.disabled ?? (row.config.enabled?.js ? row.config.enabled.text : null);
  assert.ok(expression && !(row.disabled && row.config.enabled), `${row.id} must carry exactly one switch`);
  const variable = /process\.env\.([A-Z0-9_]+)/.exec(expression)?.[1];
  assert.ok(variable, `${row.id}'s switch reads no environment variable: ${expression}`);
  return { kind: row.disabled ? "disabled" : "enabled", expression, variable };
}

/** Would the kernel mount this row, and would the plugin then do anything? @param {PresetRow} row @param {Record<string, string>} env */
function isOn(row, env) {
  if (row.disabled && evaluate(row.disabled, env) === true) return false;
  return !row.config.enabled || scalar(row.config.enabled, env) !== false;
}

/** @param {PresetRow} row @param {Record<string, string>} env */
function configOf(row, env) {
  return Object.fromEntries(Object.entries(row.config).map(([key, value]) => [key, scalar(value, env)]));
}

/** Every switch, set to its off value. */
const ALL_OFF = Object.fromEntries(ROWS.map((row) => [switchOf(row).variable, "0"]));

/**
 * What a production runtime is given, as far as these rows read it: the
 * review module on, the citation plugin on, the request-size guard armed at
 * three quarters of the gateway's default body limit.
 */
const PRODUCTION = {
  EVIMED_REVIEW_ENABLED: "1",
  EVIMED_CITE_ENABLED: "1",
  EVIMED_CITE_TIMEOUT_MS: "15000",
  EVIMED_COMPACTION_POLICY: "basic",
  EVIMED_COMPACTION_MAX_REQUEST_BYTES: "1572864",
};

test("every agent-scope plugin of ours carries one off switch, read from its own environment variable", () => {
  assert.deepEqual(ROWS.map((row) => row.id).sort(), [...AGENT_PLUGIN_IDS].sort(), "the preset's rows are the plugins the bundle declares");
  const variables = ROWS.map((row) => switchOf(row).variable);
  assert.equal(new Set(variables).size, variables.length, `two rows share a switch: ${variables.join(", ")}`);

  // All off: nothing of ours is mounted, or what is mounted is told it is off.
  for (const row of ROWS) assert.equal(isOn(row, ALL_OFF), false, `${row.id} stays on with ${switchOf(row).variable}=0`);

  // Unset: the six new switches default on; review follows the control
  // plane's module, which is off unless the deployment says 1.
  for (const id of RETURN_FIRST) {
    assert.equal(switchOf(rowOf(id)).kind, "enabled");
    assert.equal(isOn(rowOf(id), {}), true, `${id} must default on`);
  }
  assert.equal(isOn(rowOf("evimed-citation-bridge"), {}), true);
  assert.equal(isOn(rowOf("evimed-review"), {}), false);

  // Negative control: one switch moves one row, so the evaluation really reads it.
  const screeningOff = { EVIMED_SCREENING_ENABLED: "0" };
  assert.deepEqual(ROWS.filter((row) => !isOn(row, screeningOff)).map((row) => row.id).sort(), ["evimed-review", "evimed-screening"]);
});

/**
 * A context that records every property read and every registration. A plugin
 * that returns first reads nothing from it at all.
 */
function recordingContext() {
  /** @type {string[]} */
  const reads = [];
  /** @type {string[]} */
  const registered = [];
  /** @type {Map<string, any>} */
  const services = new Map();
  const tools = {
    register: (/** @type {any} */ tool) => { registered.push(`tool:${tool.name}`); return () => {}; },
    guard: () => { registered.push("guard"); return () => {}; },
    schemas: () => [],
  };
  const target = {
    tools,
    systemPrompt: { section: (/** @type {any} */ section) => { registered.push(`section:${section.name}`); return () => {}; } },
    get: (/** @type {string} */ key) => (key === "tools" ? tools : services.get(key)),
    provide: (/** @type {string} */ key, /** @type {any} */ value) => { registered.push(`service:${key}`); services.set(key, value); },
    on: (/** @type {string} */ event) => { registered.push(`hook:${event}`); return () => {}; },
    effect: (/** @type {() => any} */ fn) => fn(),
    plugin: () => { registered.push("plugin"); },
    emit: () => {},
  };
  const ctx = new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(object, key, receiver);
    },
  });
  return { ctx, reads, registered };
}

test("a switched-off plugin returns before it touches its context; switched on, the same row registers", async () => {
  for (const id of RETURN_FIRST) {
    const row = rowOf(id);
    const plugin = await pluginModule(id);

    const off = recordingContext();
    await plugin.apply(off.ctx, plugin.Config(configOf(row, { ...PRODUCTION, ...ALL_OFF })));
    assert.deepEqual(off.reads, [], `${id} is off and still read ${off.reads.join(", ")}`);
    assert.deepEqual(off.registered, []);

    // The control: the same row under the same environment with only its
    // switch on does register something, so "nothing" above is not a plugin
    // that never registers.
    const on = recordingContext();
    await plugin.apply(on.ctx, plugin.Config(configOf(row, PRODUCTION)));
    assert.ok(on.registered.length > 0, `${id} switched on registered nothing; the control is vacuous`);
  }

  // The citation row records its configuration for the plugin probe before it
  // looks at the switch, so it is held to the weaker, still exact claim.
  const cite = await pluginModule("evimed-citation-bridge");
  const off = recordingContext();
  await cite.apply(off.ctx, cite.Config(configOf(rowOf("evimed-citation-bridge"), ALL_OFF)));
  assert.deepEqual(off.registered, []);
});

/**
 * The agent preset's own rows mounted through the pinned cordis onto the
 * pinned tool registry, with the services a session provides stubbed. A row
 * the environment disables is not mounted, as the kernel does not mount it.
 * @param {Record<string, string>} env @param {readonly string[]} [only]
 */
async function mountComposition(env, only = AGENT_PLUGIN_IDS) {
  const { Context } = await loadHarnessModule("@deepseek-ai/cordis");
  const { ToolRuntime } = await loadHarnessModule("@deepseek-ai/dsh-tools");
  const ctx = new Context();
  /** @type {string[]} */
  const sections = [];
  ctx.provide("systemPrompt", { tools: () => () => {}, section: (/** @type {any} */ section) => { sections.push(section.name); return () => {}; } });
  ctx.provide("agents", { get: () => undefined, list: () => [] });
  ctx.provide("sessions", {});
  ctx.provide("subagents", {});
  ctx.provide("storageDomain", { open: async () => ({ table: () => ({}) }) });
  const runtime = new ToolRuntime(ctx);
  for (const row of ROWS.filter((candidate) => only.includes(candidate.id))) {
    if (row.disabled && evaluate(row.disabled, env) === true) continue;
    // Raw row config: cordis resolves it against the plugin's own schema and
    // refuses one that does not fit, as it would at session creation.
    await ctx.plugin(await pluginModule(row.id), configOf(row, env));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const tools = [...runtime.view().visible.keys()].sort();
  await ctx.fiber.dispose();
  return { tools, sections };
}

test("with every switch off the agent composition mounts and adds nothing; each switch removes exactly its own tools", async () => {
  const off = await mountComposition({ ...PRODUCTION, ...ALL_OFF });
  assert.deepEqual(off.tools, [], "a switched-off composition must leave the kernel's own tool surface");
  assert.deepEqual(off.sections, [], "and its own system prompt");

  const on = await mountComposition(PRODUCTION);
  assert.ok(on.tools.includes("evimed_plan") && on.tools.includes("evimed_review_run") && on.tools.includes("cite_lookup"),
    `the composition switched on did not mount: ${on.tools.join(", ")}`);
  assert.ok(on.sections.length > 0);

  for (const row of ROWS) {
    const own = (await mountComposition(PRODUCTION, [row.id])).tools;
    const without = await mountComposition({ ...PRODUCTION, [switchOf(row).variable]: "0" });
    assert.deepEqual(without.tools, on.tools.filter((tool) => !own.includes(tool)), `${switchOf(row).variable}=0 must remove ${row.id}'s tools and nothing else`);
  }
});
