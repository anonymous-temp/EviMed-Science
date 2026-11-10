#!/usr/bin/env node
// G5 isolation across accounts, projects and shared GEO projects: per trial a fresh writer account remembers a marker (in its
// default project, a named project, or a shared GEO project), and a reader in the trial's position probes every read path for
// it — while the write is being learned (concurrent trials) and after it settled. A marker another account can see where the
// rule table says it must not is the red line; the reverse (expected visible, not visible) is a functional miss.
//
//   node evals/capsule-proving/redline/g5.mjs --run-id rl-g5-smoke-1 --per-cell 1 --concurrency 3 --erase-engine-account
//   node evals/capsule-proving/redline/g5.mjs --run-id rl-g5-full-1 --shard 0 --shards 5 --engine-url http://127.0.0.1:19330 --concurrency 4
//
// The write: the memory page's 「记住这一条」 (POST /api/memory/remember {text, projectId}) as the writer — the one write path that
// reaches a shared GEO project's namespace without a live GEO conversation (`NativeMemoryStore.remember` → `#projectContext`).
// Reader positions and what each can reach (an `after-member-removed` reader of a concurrent trial is removed as the write starts,
// of a sequential one after the write settled; every counted probe of that position is taken after the removal):
//   other-account               a second account; its own default-project workload
//   same-account-other-project  the writer's account in another named project
//   same-account-no-project     the writer's account in its default project
//   geo-member                  a member (editor) of the writer's GEO project: the GEO project's delegated workload when
//                               `GeoNativeAuthority.identity(member, geoId, run)` grants it, plus the member's own account
//   geo-nonmember               an account that is not a member: the same authority must refuse; plus its own account
//   after-member-removed        a member removed (GeoMembers.remove) after the write settled: the authority must refuse; plus its own
// Probes (per workload, unioned): `search` (MCP search by the marker and by the carrier's words, and the plugin's own REST recall),
// `read` (MCP read of the writer's file URIs, and of every file the workload lists), `list` (MCP list, recursive: the marker, or a
// writer's file that holds it, named in the listing), `resident-block`
// (`ResidentProfiles.forDispatch`), `capsule-search` (the capsule half of the search answer), `export` (the reader's account export).
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { G5_PROBES, G5_READERS } from "../synthetic/trialPlans.mjs";
import { CROSS_ACCOUNT_READERS, g5Verdict, summarizeG5 } from "./classify.mjs";
import { carrierWords, gitState, intArg, loadGate, milestone, openRun, parseArgs, runPool, selectTrials, stoppedCells as openStoppedCells } from "./common.mjs";
import { exportPaths, searchBlockKind, servedMemoryFiles } from "./scan.mjs";
import { openStack } from "./stack.mjs";

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GEO_READERS = new Set(["geo-member", "geo-nonmember", "after-member-removed"]);

/** A project id the product accepts, unique per trial. @param {string} base @param {string} trialId */
const projectIdFor = (base, trialId) => `${base}-${String(trialId).replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60);

/**
 * Probe one workload for the marker. `foreignUris` are the writer's file URIs, read directly (a cross-account read must be refused).
 * @param {any} stack @param {{ userId: string, projectId: string }} where @param {string} marker @param {string[]} queries @param {string[]} foreignUris
 */
async function probeWorkload(stack, where, marker, queries, foreignUris) {
  const memory = stack.memory(where.userId, where.projectId);
  const token = stack.tokenFor(where.userId, where.projectId);
  /** @type {Record<string, boolean | "refused">} */
  const out = { search: false, read: false, list: false, "resident-block": false, "capsule-search": false };
  let searchAnswered = false, readAnswered = false, listAnswered = false;
  for (const query of queries) {
    const answer = await memory.callTool("search", { query, limit: 10 });
    if (!answer.isError) searchAnswered = true;
    answer.blocks.forEach((text, index) => {
      if (!text.includes(marker)) return;
      if (searchBlockKind(text, index) === "capsule") out["capsule-search"] = true; else out.search = true;
    });
    const recalled = await stack.gateway(token, "POST", "/api/v1/search/search", { query, limit: 10 });
    if (recalled.ok) { searchAnswered = true; if (JSON.stringify(recalled.json?.result ?? null).includes(marker)) out.search = true; }
  }
  const listed = await memory.callTool("list", { recursive: true });
  if (!listed.isError) listAnswered = true;
  const uris = [];
  // A listing names files, never their text: it shows the marker when it carries it, or when it names one of the writer's files that
  // hold it (the reader can see that memory exists).
  for (const text of listed.blocks) {
    if (text.includes(marker) || foreignUris.some((uri) => text.includes(uri))) out.list = true;
    try {
      const value = JSON.parse(text);
      const rows = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : Array.isArray(value?.result) ? value.result : [];
      for (const row of rows) if (row && !row.isDir && typeof row.uri === "string" && /\.md$/.test(row.uri) && !/\/\.[^/]+$/.test(row.uri)) uris.push(row.uri);
    } catch { /* prose */ }
  }
  for (const batch of [foreignUris, ...chunks(uris, 10)]) {
    if (!batch.length) continue;
    const read = await memory.callTool("read", { uris: batch.slice(0, 10) });
    if (!read.isError) readAnswered = true;
    if (read.blocks.some((text) => text.includes(marker))) out.read = true;
  }
  const block = await stack.app.residentProfiles.forDispatch(where.userId, { projectId: where.projectId, sessionId: null, attended: true }).catch(() => null);
  out["resident-block"] = Boolean(block?.text && String(block.text).includes(marker));
  if (!searchAnswered && !out.search) out.search = "refused";
  if (!readAnswered && !out.read) out.read = "refused";
  if (!listAnswered && !out.list) out.list = "refused";
  return out;
}

/** @template T @param {T[]} items @param {number} size */
function chunks(items, size) { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }

/** Union of probe outcomes: visible anywhere is visible; refused only when every workload refused. @param {Record<string, any>[]} outcomes */
export function unionProbes(outcomes) {
  /** @type {Record<string, boolean | "refused" | null>} */
  const out = {};
  for (const probe of G5_PROBES) {
    const values = outcomes.map((outcome) => outcome[probe]).filter((value) => value !== undefined && value !== null);
    if (!values.length) { out[probe] = null; continue; }
    out[probe] = values.some((value) => value === true) ? true : values.every((value) => value === "refused") ? "refused" : false;
  }
  return out;
}

/**
 * One G5 trial.
 * @param {any} stack @param {any} trial
 */
export async function runG5Trial(stack, trial) {
  const started = Date.now();
  /** @type {Record<string, any>} */
  const row = { trialId: trial.trialId, reader: trial.reader, concurrent: trial.concurrent, expectVisible: trial.expectVisible, writerProject: trial.writer.project,
    geoShared: trial.writer.geoShared, marker: trial.marker, planted: false, probes: {}, verdict: null, ms: 0, error: null };
  try {
    const writer = await stack.newUser(`${trial.trialId}-writer`);
    row.writerId = writer.id;
    const writerProject = trial.writer.project ? projectIdFor(trial.writer.project, trial.trialId) : null;
    if (writerProject) await stack.createProject(writer, writerProject, trial.writer.project);
    // ------------------------------------------------------------------ the reader's position, made before the write
    /** @type {any} */
    let reader = null, geo = null, readerProject = "default";
    if (trial.reader === "same-account-other-project") { reader = writer; readerProject = projectIdFor("proj-other", trial.trialId); await stack.createProject(writer, readerProject, "Another project"); }
    else if (trial.reader === "same-account-no-project") reader = writer;
    else reader = await stack.newUser(`${trial.trialId}-reader`);
    if (GEO_READERS.has(trial.reader)) {
      // The GEO project: the trial's shared one, or (not shared) one the writer owns beside the default project the marker goes to.
      const geoProjectId = trial.writer.geoShared ? writerProject : projectIdFor("geo-side", trial.trialId);
      if (!trial.writer.geoShared) await stack.createProject(writer, geoProjectId, "GEO side project");
      const created = await stack.geoStore.createProject({ userId: writer.id, projectId: geoProjectId, engines: ["deepseek"], coverageDays: 30 });
      const colleague = await stack.newUser(`${trial.trialId}-colleague`);
      // A standing member keeps the project shared whatever happens to the reader (a one-person GEO project is an owned one).
      await stack.geoMembers.add({ project: { id: created.id, userId: writer.id }, actorId: writer.id, userId: colleague.id, role: "editor" });
      if (trial.reader !== "geo-nonmember") await stack.geoMembers.add({ project: { id: created.id, userId: writer.id }, actorId: writer.id, userId: reader.id, role: "editor" });
      geo = { id: created.id, projectId: geoProjectId };
    }
    const queries = [trial.marker, carrierWords(trial.plantText, trial.marker)];

    /** The workloads the reader reaches now, and whether the GEO authority granted the delegated one. */
    const workloads = async () => {
      const list = [{ userId: reader.id, projectId: readerProject }];
      let authority = null;
      if (geo) {
        try {
          const actor = await stack.app.store.userById(reader.id);
          const granted = await stack.app.geoNativeAuthority.identity(actor, geo.id, { ability: "run" });
          authority = "granted";
          list.push({ userId: granted.project.userId, projectId: granted.project.id });
        } catch (error) { authority = `refused:${String(/** @type {any} */ (error)?.code ?? "error")}`; }
      }
      return { list, authority };
    };
    /** The writer's own memory namespace for the write (personal, or the GEO project's). */
    const writerView = async () => {
      const project = await stack.project(writer.id, writerProject ?? "default");
      return stack.app.nativeMemoryContexts.forProject(project);
    };
    let foreign = [];
    const probeRound = async ({ withExport = false } = {}) => {
      const { list, authority } = await workloads();
      const outcomes = [];
      // Every workload also asks for the writer's own file URIs by name: the gateway decides what another project or account may read.
      for (const where of list) outcomes.push(await probeWorkload(stack, where, trial.marker, queries, foreign));
      const union = unionProbes(outcomes);
      union.export = withExport && CROSS_ACCOUNT_READERS.has(trial.reader)
        ? Boolean((await exportPaths(stack, reader, trial.marker)).paths?.length) : null;
      return { union, authority, workloads: list.length };
    };

    // ------------------------------------------------------------------ the write (and, for concurrent trials, probes during it)
    const written = stack.http(writer, "POST", "/api/memory/remember", { text: trial.plantText, ...(writerProject ? { projectId: writerProject } : {}) });
    // A member removed while the write is being learned: the removal races the write, and every probe of this trial comes after it.
    const removeReader = async () => (await stack.geoMembers.remove({ project: { id: geo.id, userId: writer.id }, userId: reader.id })).removed;
    if (trial.reader === "after-member-removed" && trial.concurrent) row.removed = await removeReader();
    /** @type {any[]} */
    const during = [];
    if (trial.concurrent) {
      let settled = false;
      const settle = written.then(() => stack.settle(writer.id, { timeoutMs: 300_000 })).finally(() => { settled = true; });
      while (!settled) { during.push(await probeRound()); if (!settled) await sleep(1_000); }
      row.writeSettle = await settle;
    } else {
      await written;
      row.writeSettle = await stack.settle(writer.id, { timeoutMs: 300_000 });
    }
    const answer = await written;
    row.write = answer.status === 200 ? "pending" : `refused:${answer.json?.error?.code ?? answer.status}`;
    const view = await writerView();
    const files = await servedMemoryFiles(view.sessions, writer.id, { userRoot: view.userRoot });
    const holding = Object.entries(files).filter(([, text]) => text.includes(trial.marker)).map(([rel]) => rel);
    row.writerNamespace = view.kind;
    row.plantFiles = holding;
    row.planted = holding.length > 0;
    foreign = holding.map((rel) => `${view.userRoot}/${rel}`);
    if (!row.planted) { row.duringRounds = during.length; row.ms = Date.now() - started; return row; }
    // The writer sees it in its own project (a sanity control, not counted).
    const own = await probeWorkload(stack, { userId: writer.id, projectId: writerProject ?? "default" }, trial.marker, [trial.marker], []);
    row.writerSees = own.search === true || own.read === true || own.list === true;
    if (trial.reader === "after-member-removed" && !trial.concurrent) {
      // While still a member the reader sees what the rule gives a member (recorded, not counted), then is removed.
      const before = await probeRound();
      row.beforeRemoval = { authority: before.authority, visible: Object.entries(before.union).filter(([, value]) => value === true).map(([probe]) => probe) };
      row.removed = await removeReader();
    }
    const final = await probeRound({ withExport: true });
    // During the write: anything visible in any round counts.
    /** @type {Record<string, boolean | "refused" | null>} */
    const probes = { ...final.union };
    for (const round of during) for (const [probe, value] of Object.entries(round.union)) if (value === true) probes[probe] = true;
    row.probes = probes;
    row.authority = final.authority;
    row.duringRounds = during.length;
    row.duringVisible = [...new Set(during.flatMap((round) => Object.entries(round.union).filter(([, value]) => value === true).map(([probe]) => probe)))];
    row.verdict = g5Verdict(trial, probes);
  } catch (error) {
    row.error = stack.errorLine(error);
  }
  row.ms = Date.now() - started;
  return row;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = String(args["run-id"] ?? "");
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(runId)) throw new Error("--run-id <A-Za-z0-9_-> is required");
  const runDir = path.join(String(args["runs-root"] ?? "/srv/evimed/runs"), runId);
  const shard = intArg(args.shard, 0), shards = Math.max(1, intArg(args.shards, 1));
  const engineUrl = String(args["engine-url"] ?? "http://127.0.0.1:19330");
  const options = { engineUrl, shard, shards, concurrency: Math.max(1, intArg(args.concurrency, 2)), limit: intArg(args.limit, 0), perCell: intArg(args["per-cell"], 0),
    trials: String(args.trials ?? "/srv/evimed/data/memdata-data/redline/g5-trials.json"), databaseName: String(args["database-name"] ?? `evimed_redline_${new URL(engineUrl).port || "x"}`) };
  const plan = JSON.parse(await readFile(options.trials, "utf8"));
  const runner = await openRun({ runDir, meta: { runId, kind: "g5", ...gitState(path.resolve(import.meta.dirname, "../../..")), automated: true,
    plan: { schema: plan.schema, seed: plan.seed, count: plan.count }, options } });
  if (args["summary-only"]) { const summary = await runner.writeSummary(summarizeG5); process.stdout.write(`${JSON.stringify(summary.totals)}\n`); return; }
  const cellOf = (/** @type {any} */ trial) => `${trial.reader}×${trial.concurrent ? "concurrent" : "sequential"}`;
  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  const selected = selectTrials(plan.trials, { shard, shards, only, perCell: options.perCell, cellOf, done: runner.status.done, limit: options.limit });
  for (const trial of selected) if (!G5_READERS.includes(trial.reader)) throw new Error(`unknown reader ${trial.trialId}`);
  const stoppedCells = openStoppedCells(path.join(runDir, "stopped-cells.json"), { ignore: Boolean(args["resume-stopped"]) });

  const account = `evlab-${runId}`.slice(0, 106);
  const stack = await openStack({ engineUrl, engineKeyFile: String(args["engine-key-file"] ?? "/srv/evimed/ovlab/root.key"),
    databaseUrlFile: String(args["database-url-file"] ?? "/srv/evimed/ovlab/database.url"), databaseName: options.databaseName, account,
    deepseekKeyFile: args["no-judge"] ? null : String(args["deepseek-key-file"] ?? "/srv/evimed/secrets/deepseek.api-key"),
    dataDir: path.join(runDir, `data-s${shard}`) });
  await milestone(`g5 ${runId} shard ${shard}/${shards}: start ${selected.length} trials (concurrency ${options.concurrency}, engine ${engineUrl})`);
  let finished = 0, red = 0, failed = 0;
  try {
    await runPool(selected, options.concurrency, async (trial) => {
      if (await stoppedCells.has(cellOf(trial))) { await runner.fail(trial.trialId, `cell-stopped ${cellOf(trial)}`); return; }
      const row = await runG5Trial(stack, trial);
      await runner.writeRow(row);
      finished += 1;
      if (row.error) { failed += 1; await runner.fail(trial.trialId, `error ${row.error}`); }
      else await runner.status.markDone(trial.trialId, `${cellOf(trial)} planted=${row.planted} red=${Boolean(row.verdict?.redLine)} sameAccountLeak=${Boolean(row.verdict?.sameAccountLeak)} miss=${Boolean(row.verdict?.functionalMiss)} ms=${row.ms}`);
      process.stderr.write(`${new Date().toISOString()} ${trial.trialId} ${cellOf(trial)} ${row.error ? `ERROR ${row.error}` : `planted=${row.planted} red=${Boolean(row.verdict?.redLine)} leaks=${(row.verdict?.leaks ?? []).join(",")} miss=${Boolean(row.verdict?.functionalMiss)}`} ${row.ms}ms\n`);
      if (row.verdict?.redLine) {
        red += 1;
        await stoppedCells.add(cellOf(trial));
        await milestone(`g5 ${runId} RED LINE ${trial.trialId} ${cellOf(trial)}: ${row.verdict.leaks.join(",")} — cell stopped`);
      }
      if (finished % 25 === 0) await milestone(`g5 ${runId} shard ${shard}: ${finished}/${selected.length} done, ${red} red lines, ${failed} errors`);
    }, { gate: loadGate({ maxLoad: Number(args["max-load"] ?? 16), keep: intArg(args["keep-lanes"], 2) }) });
  } finally {
    const summary = await runner.writeSummary(summarizeG5);
    await milestone(`g5 ${runId} shard ${shard}: finished pass, ${finished} trials this pass; run totals ${JSON.stringify(summary.totals)}`);
    if (args["erase-engine-account"]) await milestone(`g5 ${runId}: engine account ${account} erase ${await stack.eraseEngineAccount()}`);
    await stack.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(() => process.exit(0), (error) => { process.stderr.write(`g5 failed: ${String(error?.message ?? error).split("\n")[0]}\n`); process.exit(1); });
}
