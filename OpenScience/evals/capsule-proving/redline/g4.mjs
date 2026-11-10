#!/usr/bin/env node
// G4 "deleted memory never comes back": per trial a fresh account plants a marker (and two control markers) the way the trial
// says, checks it is really stored, deletes it through the product's own path, scans every place it could still be held or
// shown, checks the controls, and, for the relearn trials, has the person say the same thing again and records what the product
// does with it (a restatement is a new statement: the red line is a marker that comes back WITHOUT one, so the red-line scan
// is taken before the restatement).
//
//   node evals/capsule-proving/redline/g4.mjs --run-id rl-g4-smoke-1 --per-cell 1 --concurrency 3 --erase-engine-account
//   node evals/capsule-proving/redline/g4.mjs --run-id rl-g4-full-1 --shard 0 --shards 5 --engine-url http://127.0.0.1:19330 --concurrency 4
//   node evals/capsule-proving/redline/g4.mjs --run-id rl-g4-full-1 --summary-only
//
// Delete paths, each through the product's own surface:
//   forget-in-conversation  the model-facing `forget` tool of the memory gateway (MCP tools/call → NativeMemoryStore.forget), for
//                           every served memory file that holds the marker (the runner plays the model that was asked to forget it)
//   memory-page-edit        PATCH /api/memory/records/:id {value, expectedVersion} with the marker taken out of the value
//   memory-page-delete      DELETE /api/memory/records/:id
//   delete-conversation     DELETE /api/projects/:p/conversations/:id/source, then the source-deletion worker's drain
//   memory-reset            POST /api/memory/reset {confirm: "reset"}
//   delete-account          DELETE /api/account {confirm, password}
// Plant paths: `statement` (said in a conversation, learned by extraction), `explicit-remember` (said as 「请帮我记住」 in a
// conversation, and the model's `remember` tool called with the person's words, as the tool description tells a model to),
// `memory-page-add` (POST /api/memory/remember, the page's 「记住这一条」).
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { G4_DELETE_VIA, G4_PLANT_VIA } from "../synthetic/trialPlans.mjs";
import { classifyFindings, summarizeG4 } from "./classify.mjs";
import { carrierWords, gitState, intArg, loadGate, milestone, openRun, parseArgs, runPool, selectTrials, sessionIdFor, stoppedCells as openStoppedCells } from "./common.mjs";
import { capsulePreview, databaseColumnsWith, engineFilesWith, exportPaths, markerLinePrints, modelSurfaces, pageSurfaces, servedMemoryFiles,
  staleOrigins, vectorHits } from "./scan.mjs";
import { openStack } from "./stack.mjs";

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ACK = "好的，我记下了。";
const REMEMBER = (/** @type {string} */ text) => `请帮我记住：${text}`;
const DESTRUCTIVE = new Set(["memory-reset", "delete-account"]);
/** What an edit on the page writes in place of the marker. */
export const EDIT_REPLACEMENT = "（已更换）";

/** @param {Record<string, string>} files @param {string} marker */
const filesWith = (files, marker) => Object.entries(files).filter(([, text]) => text.includes(marker)).map(([rel]) => rel);

/**
 * Plant one text the trial's way. Returns what was written where (the conversation id, for a later deletion or restatement).
 * @param {any} stack @param {any} user @param {string} plantVia @param {string[]} texts @param {string} sessionId
 */
async function plantTexts(stack, user, plantVia, texts, sessionId) {
  if (plantVia === "memory-page-add") {
    const answers = [];
    for (const text of texts) {
      const answer = await stack.http(user, "POST", "/api/memory/remember", { text });
      answers.push(answer.status === 200 ? "pending" : `refused:${answer.json?.error?.code ?? answer.status}`);
    }
    return { via: "page", sessionId: null, writes: answers };
  }
  const messages = texts.flatMap((text) => [{ role: /** @type {const} */ ("user"), text: plantVia === "explicit-remember" ? REMEMBER(text) : text }, { role: /** @type {const} */ ("assistant"), text: ACK }]);
  const conversation = await stack.converse(user, "default", sessionId, messages);
  const writes = [...conversation.writes, `commit:${conversation.commit}`];
  if (plantVia === "explicit-remember") {
    const memory = stack.memory(user.id, "default");
    for (const text of texts) {
      const called = await memory.callTool("remember", { messages: [{ role: "user", content: REMEMBER(text) }] });
      writes.push(called.isError ? `remember-refused:${String(called.blocks[0] ?? "").slice(0, 60)}` : "remember");
    }
  }
  return { via: "conversation", sessionId, writes };
}

/**
 * Delete the marker by the trial's path. `notDrivable` names why a path cannot apply to this plant.
 * @param {any} stack @param {any} user @param {any} trial @param {{ markerSession: string | null }} plant @param {Record<string, string>} served
 */
async function deleteMarker(stack, user, trial, plant, served) {
  const marker = trial.marker;
  switch (trial.deleteVia) {
    case "forget-in-conversation": {
      const memory = stack.memory(user.id, "default");
      const root = stack.sessions.userRoot(user.id);
      const outcomes = [];
      // The model asked to forget it looks it up and forgets every file it finds holding it.
      for (const rel of filesWith(served, marker)) {
        const answer = await memory.callTool("forget", { uri: `${root}/${rel}` });
        outcomes.push(answer.isError ? `error:${String(answer.blocks[0] ?? "").slice(0, 80)}` : /^Deleted:/.test(answer.blocks[0] ?? "") ? "deleted" : String(answer.blocks[0] ?? "").slice(0, 40));
      }
      return { deleted: outcomes.length > 0 && outcomes.every((outcome) => outcome === "deleted"), surface: "mcp tools/call forget", outcomes };
    }
    case "memory-page-edit":
    case "memory-page-delete": {
      const listed = await stack.http(user, "GET", "/api/memory/records?pageSize=500");
      const records = (Array.isArray(listed.json?.data) ? listed.json.data : []).filter((/** @type {any} */ record) => String(record?.value ?? "").includes(marker));
      const outcomes = [];
      for (const record of records) {
        const id = encodeURIComponent(record.id);
        const answer = trial.deleteVia === "memory-page-delete"
          ? await stack.http(user, "DELETE", `/api/memory/records/${id}`)
          : await stack.http(user, "PATCH", `/api/memory/records/${id}`, { value: String(record.value).split(marker).join(EDIT_REPLACEMENT), expectedVersion: record.version });
        outcomes.push(answer.status === 200 ? "ok" : `${answer.status}:${answer.json?.error?.code ?? ""}`);
      }
      return { deleted: outcomes.length > 0 && outcomes.every((outcome) => outcome === "ok"), surface: trial.deleteVia === "memory-page-delete" ? "DELETE /api/memory/records/:id" : "PATCH /api/memory/records/:id",
        outcomes, records: records.length };
    }
    case "delete-conversation": {
      if (!plant.markerSession) return { notDrivable: "a memory added on the memory page has no source conversation: the product's conversation deletion (DELETE /api/projects/:p/conversations/:id/source → NativeMemoryStore.removeConversationSource) removes only lines whose origin names a deleted dsh- conversation, so there is no conversation of this marker to delete" };
      const answer = await stack.http(user, "DELETE", `/api/projects/default/conversations/${encodeURIComponent(plant.markerSession)}/source`);
      const rows = answer.status === 200 || answer.status === 202 ? await stack.drainSourceDeletion(user.id, { timeoutMs: 90_000 }) : [];
      return { deleted: (answer.status === 200 || answer.status === 202) && rows.length > 0 && rows.every((row) => row.cleanup === "complete"), surface: "DELETE /api/projects/:p/conversations/:id/source + drain",
        outcomes: [`${answer.status}:${answer.json?.error?.code ?? answer.json?.data?.cleanup ?? ""}`, ...rows.map((row) => `${row.cleanup}:${row.reason ?? ""}${row.thrown ? ` (${row.thrown})` : ""}`)] };
    }
    case "memory-reset": {
      const answer = await stack.http(user, "POST", "/api/memory/reset", { confirm: "reset" });
      return { deleted: answer.status === 200, surface: "POST /api/memory/reset", outcomes: [`${answer.status}:${answer.json?.error?.code ?? ""}`] };
    }
    case "delete-account": {
      const outcomes = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const answer = await stack.http(user, "DELETE", "/api/account", { confirm: user.id, password: user.password });
        outcomes.push(`${answer.status}:${answer.json?.error?.code ?? ""}`);
        if (answer.status === 200) return { deleted: true, surface: "DELETE /api/account", outcomes };
        if (answer.status !== 503 && answer.status !== 409) break;
        await sleep(10_000);
      }
      return { deleted: false, surface: "DELETE /api/account", outcomes };
    }
    default:
      return { notDrivable: `unknown delete path ${trial.deleteVia}` };
  }
}

/**
 * Every place, scanned for the marker after the deletion. Places of an account that no longer exists are `null` (not applicable)
 * where the account is the only way in; the engine's own listing decides whether its engine user is still there.
 * @param {any} stack @param {any} user @param {any} trial @param {string[]} prints
 */
async function scanAll(stack, user, trial, prints) {
  const marker = trial.marker;
  const accountHeld = Boolean(await stack.app.store.userById(user.id));
  const engineHeld = (await stack.engineUsers()).has(stack.sessions.engineUser(user.id));
  /** @type {Record<string, string[] | null>} */
  const findings = {};
  const engine = engineHeld ? await engineFilesWith(stack.sessions, user.id, marker) : { files: 0, byPlace: {} };
  for (const place of ["engine-files", "engine-summaries", "archive", "raw-history", "privacy-tree", "engine-other"]) findings[place] = engine.byPlace[place] ?? [];
  findings.vectors = engineHeld ? await vectorHits(stack.sessions, user.id, marker).catch(() => []) : [];
  findings.ledger = Object.keys(await databaseColumnsWith(stack.database, marker));
  findings["line-origin-index"] = (await staleOrigins(stack.database, user.id, prints)) > 0 ? ["evimed_memory.native_line_origins.fingerprint"] : [];
  if (accountHeld) {
    const [page, model, exported, capsule] = await Promise.all([
      pageSurfaces(stack, user, marker),
      modelSurfaces(stack, { userId: user.id, projectId: "default" }, marker, [marker, carrierWords(trial.plantText, marker)]),
      exportPaths(stack, user, marker),
      capsulePreview(stack, user, marker).catch(() => ({ status: 0, entries: null })),
    ]);
    findings.page = page.page; findings["page-history"] = page.pageHistory;
    findings["model-search"] = model.search; findings["model-list-read"] = model.listRead; findings["plugin-recall"] = model.pluginRecall; findings.resident = model.resident ? ["resident-block"] : [];
    findings.export = exported.paths; findings["capsule-entries"] = capsule.entries;
    return { findings, accountHeld, engineHeld, engineFiles: engine.files, refused: model.refused, exportStatus: exported.status, capsuleStatus: capsule.status };
  }
  // The account is gone: its old workload must be refused; anything it still hands back is a finding.
  const model = await modelSurfaces(stack, { userId: user.id, projectId: "default" }, marker, [marker]).catch(() => ({ search: [], listRead: [], pluginRecall: [], resident: false, refused: ["unreachable"] }));
  findings["model-search"] = model.search; findings["model-list-read"] = model.listRead; findings["plugin-recall"] = model.pluginRecall; findings.resident = model.resident ? ["resident-block"] : [];
  for (const place of ["page", "page-history", "export", "capsule-entries"]) findings[place] = null;
  return { findings, accountHeld, engineHeld, engineFiles: engine.files, refused: model.refused };
}

/** The person says the same marker again after the delete; what the product keeps of it. @param {any} stack @param {any} user @param {any} trial @param {{ markerSession: string | null }} plant */
async function relearn(stack, user, trial, plant) {
  if (!(await stack.app.store.userById(user.id))) return { outcome: "not-applicable", reason: "the account was deleted" };
  const sameConversation = trial.relearn === "restate-same-conversation";
  const sessionId = sameConversation && plant.markerSession ? plant.markerSession : sessionIdFor(trial.trialId, "r");
  let written;
  try {
    written = await plantTexts(stack, user, trial.plantVia, [trial.plantText], sessionId);
  } catch (error) {
    return { outcome: "refused", code: String(/** @type {any} */ (error)?.code ?? stack.errorLine(error)).slice(0, 80), path: sameConversation ? "same-conversation" : "new-conversation" };
  }
  const settled = await stack.settle(user.id, { timeoutMs: 300_000 });
  const files = filesWith(await servedMemoryFiles(stack.sessions, user.id), trial.marker);
  const refusedWrites = written.writes.filter((write) => /refused/.test(write));
  return { outcome: files.length ? "stored" : refusedWrites.length ? "refused" : "not-stored", path: trial.plantVia === "memory-page-add" ? "page" : sameConversation && plant.markerSession ? "same-conversation" : "new-conversation",
    writes: written.writes, files, open: settled.open };
}

/** One G4 trial, start to finish. @param {any} stack @param {any} trial */
export async function runG4Trial(stack, trial) {
  const started = Date.now();
  /** @type {Record<string, any>} */
  const row = { trialId: trial.trialId, plantVia: trial.plantVia, deleteVia: trial.deleteVia, relearn: trial.relearn, marker: trial.marker,
    planted: false, deleted: false, places: {}, reappeared: false, controlsSurvived: null, ms: 0, error: null };
  try {
    if (trial.plantVia === "memory-page-add" && trial.deleteVia === "delete-conversation") {
      // Decided by the plant path alone, so nothing is planted for it.
      row.notDrivable = (await deleteMarker(stack, null, trial, { markerSession: null }, {})).notDrivable;
      row.ms = Date.now() - started;
      return row;
    }
    const user = await stack.newUser(trial.trialId);
    row.userId = user.id;
    const markerSession = sessionIdFor(trial.trialId, "m");
    const plantMain = await plantTexts(stack, user, trial.plantVia, [trial.plantText], markerSession);
    const plantControls = await plantTexts(stack, user, trial.plantVia, trial.controls.map((/** @type {any} */ control) => control.plantText), sessionIdFor(trial.trialId, "c"));
    row.plant = { writes: plantMain.writes, controlWrites: plantControls.writes };
    row.plantSettle = await stack.settle(user.id, { timeoutMs: 300_000 });
    const served = await servedMemoryFiles(stack.sessions, user.id);
    const plantFiles = filesWith(served, trial.marker);
    row.plantFiles = plantFiles;
    const controlsPlanted = trial.controls.map((/** @type {any} */ control) => filesWith(served, control.marker).length > 0);
    row.controlsPlanted = controlsPlanted;
    row.planted = plantFiles.length > 0;
    if (!row.planted) { row.ms = Date.now() - started; return row; }
    const prints = plantFiles.flatMap((rel) => markerLinePrints(served[rel], trial.marker));
    const plant = { markerSession: plantMain.sessionId };
    const deletion = await deleteMarker(stack, user, trial, plant, served);
    if (deletion.notDrivable) { row.notDrivable = deletion.notDrivable; row.ms = Date.now() - started; return row; }
    row.deleted = deletion.deleted === true;
    row.deletion = { surface: deletion.surface, outcomes: deletion.outcomes };
    if (await stack.app.store.userById(user.id)) row.deleteSettle = await stack.settle(user.id, { timeoutMs: 240_000 });
    // The engine indexes and summarises asynchronously: a short quiet before the scan.
    await sleep(3_000);
    const scan = await scanAll(stack, user, trial, prints);
    const verdict = classifyFindings(scan.findings, trial);
    row.places = verdict.places;
    row.reappeared = verdict.reappeared;
    // Accepted by the product (it answered 2xx and holds the request) but not finished, and the marker still reaches an answer.
    row.unfinishedDelete = !row.deleted && verdict.reappeared && /^20[02]:/.test(String(deletion.outcomes?.[0] ?? ""));
    row.scan = { accountHeld: scan.accountHeld, engineHeld: scan.engineHeld, engineFiles: scan.engineFiles, refused: scan.refused, exportStatus: scan.exportStatus ?? null, capsuleStatus: scan.capsuleStatus ?? null };
    const after = scan.engineHeld ? await servedMemoryFiles(stack.sessions, user.id).catch(() => ({})) : {};
    const controlsNow = trial.controls.map((/** @type {any} */ control) => filesWith(after, control.marker).length > 0);
    if (DESTRUCTIVE.has(trial.deleteVia)) {
      row.controlsSurvived = null;
      row.controlsGone = controlsNow.every((present) => !present);
    } else if (controlsPlanted.some(Boolean)) {
      row.controlsSurvived = controlsPlanted.every((planted, index) => !planted || controlsNow[index]);
    }
    if (trial.relearn !== "none") row.relearnOutcome = await relearn(stack, user, trial, plant);
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
    trials: String(args.trials ?? "/srv/evimed/data/memdata-data/redline/g4-trials.json"), databaseName: String(args["database-name"] ?? `evimed_redline_${new URL(engineUrl).port || "x"}`) };
  const plan = JSON.parse(await readFile(options.trials, "utf8"));
  const runner = await openRun({ runDir, meta: { runId, kind: "g4", ...gitState(path.resolve(import.meta.dirname, "../../..")), automated: true,
    plan: { schema: plan.schema, seed: plan.seed, count: plan.count }, options } });
  if (args["summary-only"]) { const summary = await runner.writeSummary(summarizeG4); process.stdout.write(`${JSON.stringify(summary.totals)}\n`); return; }

  const stoppedCells = openStoppedCells(path.join(runDir, "stopped-cells.json"), { ignore: Boolean(args["resume-stopped"]) });
  const cellOf = (/** @type {any} */ trial) => `${trial.plantVia}×${trial.deleteVia}`;
  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  const cells = typeof args.cells === "string" ? new Set(args.cells.split(",")) : null;
  const selected = selectTrials(plan.trials.filter((/** @type {any} */ trial) => !cells || cells.has(cellOf(trial))),
    { shard, shards, only, perCell: options.perCell, cellOf, done: runner.status.done, limit: options.limit });
  for (const trial of selected) if (!G4_PLANT_VIA.includes(trial.plantVia) || !G4_DELETE_VIA.includes(trial.deleteVia)) throw new Error(`unknown trial shape ${trial.trialId}`);

  const account = `evlab-${runId}`.slice(0, 106);
  const stack = await openStack({ engineUrl, engineKeyFile: String(args["engine-key-file"] ?? "/srv/evimed/ovlab/root.key"),
    databaseUrlFile: String(args["database-url-file"] ?? "/srv/evimed/ovlab/database.url"), databaseName: options.databaseName, account,
    deepseekKeyFile: args["no-judge"] ? null : String(args["deepseek-key-file"] ?? "/srv/evimed/secrets/deepseek.api-key"),
    dataDir: path.join(runDir, `data-s${shard}`) });
  await milestone(`g4 ${runId} shard ${shard}/${shards}: start ${selected.length} trials (concurrency ${options.concurrency}, engine ${engineUrl})`);
  let finished = 0, reappeared = 0, failed = 0;
  try {
    await runPool(selected, options.concurrency, async (trial) => {
      if (await stoppedCells.has(cellOf(trial))) { await runner.fail(trial.trialId, `cell-stopped ${cellOf(trial)}`); return; }
      const row = await runG4Trial(stack, trial);
      await runner.writeRow(row);
      finished += 1;
      if (row.error) { failed += 1; await runner.fail(trial.trialId, `error ${row.error}`); }
      else {
        await runner.status.markDone(trial.trialId, `${cellOf(trial)} planted=${row.planted} deleted=${row.deleted} reappeared=${row.reappeared}${row.notDrivable ? " not-drivable" : ""} ms=${row.ms}`);
      }
      process.stderr.write(`${new Date().toISOString()} ${trial.trialId} ${cellOf(trial)} ${row.error ? `ERROR ${row.error}` : `planted=${row.planted} deleted=${row.deleted} reappeared=${row.reappeared}`} ${row.ms}ms\n`);
      // Only a finished deletion can be a reappearance. A deletion the product accepted and never finished, while the marker still
      // reaches an answer, is reported with the red lines as an unfinished delete (and stops its cell too).
      if (row.unfinishedDelete) {
        await stoppedCells.add(cellOf(trial));
        await milestone(`g4 ${runId} RED LINE (unfinished delete) ${trial.trialId} ${cellOf(trial)}: accepted, never completed (${(row.deletion?.outcomes ?? []).slice(-1)[0] ?? ""}), still reachable via ${Object.entries(row.places).filter(([, value]) => /** @type {any} */ (value).class === "redline").map(([place]) => place).join(",")} — cell stopped`);
      }
      if (row.reappeared && row.deleted) {
        reappeared += 1;
        await stoppedCells.add(cellOf(trial));
        await milestone(`g4 ${runId} RED LINE ${trial.trialId} ${cellOf(trial)}: ${Object.entries(row.places).filter(([, value]) => /** @type {any} */ (value).class === "redline").map(([place]) => place).join(",")} — cell stopped`);
      }
      if (finished % 25 === 0) await milestone(`g4 ${runId} shard ${shard}: ${finished}/${selected.length} done, ${reappeared} red lines, ${failed} errors`);
    }, { gate: loadGate({ maxLoad: Number(args["max-load"] ?? 16), keep: intArg(args["keep-lanes"], 2) }) });
  } finally {
    const summary = await runner.writeSummary(summarizeG4);
    await milestone(`g4 ${runId} shard ${shard}: finished pass, ${finished} trials this pass; run totals ${JSON.stringify(summary.totals)}`);
    if (args["erase-engine-account"]) await milestone(`g4 ${runId}: engine account ${account} erase ${await stack.eraseEngineAccount()}`);
    await stack.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(() => process.exit(0), (error) => { process.stderr.write(`g4 failed: ${String(error?.message ?? error).split("\n")[0]}\n`); process.exit(1); });
}
