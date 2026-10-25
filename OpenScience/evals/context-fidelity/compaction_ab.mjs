#!/usr/bin/env node
// Runs the compaction A/B (`compaction_ab_lib.mjs`) on a real DSH kernel and the control plane's own model gateway: the same scripted conversation under
// `basic` and `structured`, the window lowered until the kernel compacts within a few turns, at least three samples of each, the cost printed.
//
//   node evals/context-fidelity/compaction_ab.mjs --dsh <dsh executable> --dump <dump-config file> --key-file <deepseek key file> \
//     --postgres postgresql://coder@127.0.0.1:<port>/evimed_test_<name> --out <empty directory> \
//     [--home <seeded DSH_HOME> --profile evimed-runtime] [--samples 3] [--context-window 20000] [--filler-turns 8] [--model <id>]
//   node evals/context-fidelity/compaction_ab.mjs --dry-run            the whole driver against a scripted stand-in kernel: no kernel, no key, no database
//   node evals/context-fidelity/compaction_ab.mjs --print-plan ...     what each arm would run with, and nothing run
//
// What the kernel has to be. `basic` is the kernel's own compaction engine; `structured` is the EviMed engine in `@evimed/dsh-socket`
// (`packages/socket/plugins/compaction.mjs`), which exists only in a profile that has the socket installed. So a real run needs a seeded profile —
// `--home` is a DSH_HOME with `dsh-base`, `dsh-web-app` and `file:<socket>` added the way `deploy/runtime-dsh/Dockerfile` does it, `--profile` its name (the
// local real-kernel harness's `seed.sh` makes one) — and the two arms then differ in one environment variable, `EVIMED_COMPACTION_POLICY`, which the socket's
// rows read; every other switchable socket plugin is turned off for both (`SOCKET_PLUGIN_SWITCHES`), so the only thing that differs is the engine. The
// window is stated to the kernel the way the platform states it (`models[].contextWindow`), and pressure compaction fires at `EVIMED_COMPACTION_THRESHOLD_RATIO`
// of it (0.8, the platform's own). Run without `--home` the kernel is a bare one, there is no `structured` to measure, and the runner refuses.
//
// What it does not do: reach the production runtime. The conversation is synthetic (a made-up diabetes follow-up), the key stays in the control plane's gateway
// behind its usage ledger, and the kernel never holds it. Cost is read from the ledger per sample (`evimed_usage.model_requests`).
//
// Which events say a compaction happened is read from the kernel's own stream (`compactionsIn`); if a kernel version names them differently, every sample reads
// as never having compacted and says so, which is the right way for this to fail.
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ARMS, DEFAULTS, buildScenario, decide, render, runSample, scoreSample, summarizeArm } from "./compaction_ab_lib.mjs";

const OPTIONS = ["dsh", "dump", "key-file", "postgres", "out", "home", "profile", "samples", "context-window", "threshold-ratio", "filler-turns", "filler-rows", "model", "turn-timeout-ms"];

/** @param {string[]} argv */
export function parseArguments(argv) {
  const { values } = parseArgs({ args: argv, options: { ...Object.fromEntries(OPTIONS.map((name) => [name, { type: "string" }])), "dry-run": { type: "boolean" }, "print-plan": { type: "boolean" } } });
  const number = (/** @type {string} */ name, /** @type {number} */ fallback) => {
    const value = values[name] === undefined ? fallback : Number(values[name]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
    return value;
  };
  const samples = Math.trunc(number("samples", DEFAULTS.samples));
  if (samples < 1 || samples > 12) throw new Error("--samples is between 1 and 12");
  return {
    values, samples, contextWindow: Math.trunc(number("context-window", DEFAULTS.contextWindow)), thresholdRatio: number("threshold-ratio", DEFAULTS.thresholdRatio),
    fillerTurns: Math.trunc(number("filler-turns", DEFAULTS.fillerTurns)), fillerRows: Math.trunc(number("filler-rows", DEFAULTS.fillerRows)),
    turnTimeoutMs: Math.trunc(number("turn-timeout-ms", 240_000)), dryRun: values["dry-run"] === true, printPlan: values["print-plan"] === true,
  };
}

/**
 * What the kernel of one arm is started with: the compaction policy, the threshold, and every other switchable socket plugin off.
 * @param {string} arm @param {{ thresholdRatio: number }} setup @param {Readonly<Record<string, string>>} switches `SOCKET_PLUGIN_SWITCHES`
 * @returns {Record<string, string>}
 */
export function armEnvironment(arm, { thresholdRatio }, switches) {
  if (!ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`);
  return {
    ...Object.fromEntries(Object.entries(switches).filter(([plugin]) => plugin !== "evimed-compaction").map(([, variable]) => [variable, "0"])),
    EVIMED_COMPACTION_ENABLED: "1",
    EVIMED_COMPACTION_POLICY: arm,
    EVIMED_COMPACTION_THRESHOLD_RATIO: String(thresholdRatio),
    EVIMED_COMPACTION_RETAIN_RATIO: "0.16",
    EVIMED_COMPACTION_MAX_TOKENS: "4096",
    EVIMED_COMPACTION_MAX_REQUEST_BYTES: "0",
  };
}

/**
 * A kernel that is not one: the conversation answered from what it was told, folding its history when it grows past a threshold, and — as `structured`
 * promises and `basic` does not — keeping the facts across the fold in one arm only. For the driver's own test and for `--dry-run`, which prove the loop, the
 * scoring and the report without a kernel, a key or a database; its numbers say nothing about either policy.
 * @param {string} arm @param {{ contextWindow: number, thresholdRatio: number }} setup @returns {import("./compaction_ab_lib.mjs").Native}
 */
export function scriptedKernel(arm, { contextWindow, thresholdRatio }) {
  let tokens = 0;
  let folded = false;
  const said = new Set();
  return async ({ prompt, sessionId }) => {
    // A pasted table of numbers and short words is about 0.7 tokens a character.
    tokens += Math.ceil(prompt.length * 0.7);
    /** @type {any[]} */
    const events = [{ type: "session", sessionId: sessionId ?? "scripted" }];
    if (tokens > contextWindow * thresholdRatio) { folded = true; tokens = Math.ceil(tokens * 0.2); events.push({ type: "compaction/end", data: { tokens } }); }
    for (const fact of ["mmol/L", "每一节最多三条要点", "out/q3-summary.md", "CASE-4471", "BATCH-20261025-B", "12 条记录对不上"]) if (prompt.includes(fact)) said.add(fact);
    const remembered = [...said].filter((fact) => !folded || arm === "structured" || fact === "mmol/L");
    const text = /停一下/.test(prompt) ? remembered.join("\n") : /126 mg\/dL/.test(prompt) ? `6.99 mmol/L，存到 ${remembered.includes("out/q3-summary.md") ? "out/q3-summary.md" : "报告文件"}` : "收到";
    return { code: 0, events: [...events, { type: "final", text }], latencyMs: 1200, sessionId: sessionId ?? "scripted", text };
  };
}

/** @param {string[]} argv */
export async function main(argv) {
  const args = parseArguments(argv);
  const { values } = args;
  const scenario = buildScenario({ fillerTurns: args.fillerTurns, fillerRows: args.fillerRows });
  const setup = { contextWindow: args.contextWindow, thresholdRatio: args.thresholdRatio, samples: args.samples };
  /** @type {Record<string, any[]>} */
  const samples = Object.fromEntries(ARMS.map((arm) => [arm, []]));
  let cleanup = async () => {};
  /** @param {string} arm @returns {Promise<{ native: import("./compaction_ab_lib.mjs").Native, meter: any }>} */
  let kernelFor = async (arm) => ({ native: scriptedKernel(arm, setup), meter: null });
  let out = null;
  if (!args.dryRun) {
    for (const name of ["dsh", "dump", "key-file", "postgres", "out"]) if (!values[name]) throw new Error(`Required: --${name} (or --dry-run)`);
    if (!values.home || !values.profile) throw new Error("A seeded profile is required (--home <DSH_HOME> --profile <name>): `structured` exists only where the socket is installed");
    out = path.resolve(/** @type {string} */ (values.out));
    const { SOCKET_PLUGIN_SWITCHES } = await import("../../apps/server/src/dshProfilePatch.mjs");
    const { loadConfig } = await import("../../apps/server/src/config.mjs");
    const config = loadConfig({ localAutoConfig: false, dataDir: path.join(out, "control"), deepseekApiKeyFile: path.resolve(/** @type {string} */ (values["key-file"])), deepseekProviderEnabled: true, production: false,
      modelGatewayTimeoutMs: 180_000, userDailySpendLimit: 5, userWeeklySpendLimit: 5, userRunSpendLimit: 1, modelGatewayMaxOutputTokens: 4000 });
    const model = values.model ?? config.deepseekModel;
    if (args.printPlan) {
      for (const arm of ARMS) console.log(JSON.stringify({ arm, model, contextWindow: args.contextWindow, profile: values.profile, home: values.home, env: armEnvironment(arm, setup, SOCKET_PLUGIN_SWITCHES) }, null, 2));
      return { printed: true };
    }
    const parsed = new URL(/** @type {string} */ (values.postgres));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !/evimed_test/.test(parsed.pathname)) throw new Error("--postgres must be a local evimed_test database");
    await fs.mkdir(out, { recursive: true, mode: 0o700 });
    if ((await fs.readdir(out)).some((name) => name !== "control")) throw new Error("--out must be an empty directory: a sample is never mixed with an older one");
    const [{ ControlPlaneDatabase }, { UsageLedger }, { createModelGatewayHandler }, { createNativeDsh }] = await Promise.all([
      import("../../apps/server/src/controlPlaneDatabase.mjs"), import("../../apps/server/src/usageLedger.mjs"), import("../../apps/server/src/modelGateway.mjs"), import("../method-quality/native_dsh.mjs"),
    ]);
    const database = new ControlPlaneDatabase({ databaseUrl: /** @type {string} */ (values.postgres), databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
    await database.migrate();
    const ledger = new UsageLedger(database);
    await ledger.health();
    const userId = `compaction-ab-${randomUUID()}`;
    const projectId = `ab-${randomUUID()}`;
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Synthetic compaction A/B','development') ON CONFLICT DO NOTHING", [userId]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Synthetic compaction A/B',10485760)", [userId, projectId]);
    const token = randomUUID();
    /** @type {string | null} */
    let active = null;
    let checks = 0;
    const runtimeManager = { assertActiveModelGatewayToken(/** @type {string} */ value) { if (value !== token || !active) throw new Error("Invalid evaluation workload"); return { userId, projectId, runId: active, runLimit: 1 }; } };
    const handler = createModelGatewayHandler(config, runtimeManager, { usageLedger: ledger, attributeRun: async () => active,
      assertModelAccess: async () => { if (++checks > 400) throw new Error("Evaluation request limit"); } });
    const server = createServer((req, res) => handler(req, res, () => {}));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(null)));
    const gateway = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/internal/model/v1`;
    const dump = await fs.readFile(/** @type {string} */ (values.dump), "utf8");
    await fs.writeFile(path.join(out, "manifest.json"), `${JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), setup, model, profile: values.profile, dataClass: "synthetic", arms: ARMS }, null, 2)}\n`, { mode: 0o600 });
    cleanup = async () => { await new Promise((resolve) => server.close(resolve)); await database.close(); };
    kernelFor = async (arm) => {
      const root = path.join(/** @type {string} */ (out), arm);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const native = await createNativeDsh({ root, executable: /** @type {string} */ (values.dsh), dump, gateway, token, maxTokens: 4000, model, contextWindow: args.contextWindow,
        dshHome: path.resolve(/** @type {string} */ (values.home)), profile: values.profile, env: armEnvironment(arm, setup, SOCKET_PLUGIN_SWITCHES), timeoutMs: args.turnTimeoutMs });
      const meter = {
        begin: (/** @type {string} */ id) => { active = id; },
        end: async (/** @type {string} */ id) => {
          active = null;
          const { rows } = await database.query("SELECT coalesce(sum(actual_cost),0) AS cost, count(*)::integer AS requests FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=$2", [userId, id]);
          return { cost: Number(rows[0]?.cost ?? 0), requests: Number(rows[0]?.requests ?? 0) };
        },
      };
      return { native, meter };
    };
  }
  try {
    // Interleaved, so a drift in the provider's behaviour over the run falls on both arms alike.
    for (let index = 1; index <= args.samples; index += 1) {
      for (const arm of ARMS) {
        const { native, meter } = await kernelFor(arm);
        const sample = await runSample({ native, scenario, arm, id: `${arm}-${index}`, meter, log: (line) => console.error(line) });
        samples[arm].push(sample);
        if (out) await fs.writeFile(path.join(out, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`, { mode: 0o600 });
      }
    }
  } finally {
    await cleanup();
  }
  const scored = Object.fromEntries(ARMS.map((arm) => [arm, samples[arm].map(scoreSample)]));
  const arms = { basic: summarizeArm(scored.basic), structured: summarizeArm(scored.structured) };
  const decision = decide(arms);
  const report = render(arms, decision, setup);
  if (out) await fs.writeFile(path.join(out, "report.json"), `${JSON.stringify({ setup, arms, decision, scored }, null, 2)}\n`, { mode: 0o600 });
  console.log(report);
  return { arms, decision, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error?.message ?? error); process.exit(1); });
}

