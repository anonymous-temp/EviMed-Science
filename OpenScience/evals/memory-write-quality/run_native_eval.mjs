#!/usr/bin/env node
/**
 * The native arm of the write-quality evaluation: the same incidents and the ten general cases, replayed the way a
 * conversation reaches OpenViking's engine — one session, the messages through the memory gateway's door, one commit — and
 * judged on the files the engine's own extraction wrote under the policy templates (`deploy/web/openviking/memory-templates/`).
 *
 * The legacy arm (`run_write_quality_eval.mjs`) scores the platform's extractor on record kinds. The engine writes files, so a
 * kind is counted as bullets in the place that kind now lives:
 *
 *   profile       bullets of profile.md
 *   preference    bullets under preferences/
 *   correction    bullets under corrections/
 *   decision      bullets under 已定事项 of a project card + bullets under decisions/
 *   follow_up     bullets under 阶段 of a project card + bullets under follow_ups/
 *   project_fact  every other bullet, and the 领域 line, of a project card + bullets under project_facts/
 *   entity        files under entities/ (no old kind; listed so a case can refuse it)
 *
 * The decided checks are the corpus's own (`expect`, read by `scoreNative`); the cases that need a reading print what was
 * written beside their `judge` question and are counted apart. Nothing here matches prose for meaning.
 *
 *   node evals/memory-write-quality/run_native_eval.mjs --offline
 *   node evals/memory-write-quality/run_native_eval.mjs --url http://127.0.0.1:19330 --key-file <root key file> \
 *     [--account evimed] [--only g04,credentials] [--out evals/memory-write-quality/results/native-<date>.json]
 *
 * The engine is the one named by `--url` (a lab instance with the templates mounted, or a staging one); its root key is read
 * from `--key-file` and never printed or written. Every case runs as its own throwaway account (`evmq-<run>-<case>`), deleted
 * at the end unless `--keep`. A live run is one extraction per case, on the model the engine is configured with.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "../../apps/server/src");

/** The directories whose cases this arm replays: the production incidents and the general cases. */
export const NATIVE_CASE_DIRECTORIES = Object.freeze(["cases", "cases-general"]);

/** The tag a platform-started brief wears; the gateway's door must drop a message that carries it. */
const PLATFORM_TAG = "<evimed-geo-run>geo_eval_run</evimed-geo-run>";

const FIELD_EXPECTATIONS = Object.freeze([
  "noTextContains", "noRecordOfKinds", "atMostRecords", "atLeastRecords", "requireKinds", "requireTextContains",
  "briefRefusedWhenTagged", "identifierShapes", "requireKeys", "keyValues",
]);

/** What a project-card key looks like in the card's text. */
export const CARD_PATTERNS = Object.freeze(/** @type {Record<string, RegExp>} */ ({
  "project.field": /^领域[：:]\s*\S/m,
  "project.goal": /##\s*目标\s*\n\s*[-*]\s+\S/,
  "project.subject": /##\s*范围或对象\s*\n\s*[-*]\s+\S/,
  "project.data_source": /##\s*材料与数据\s*\n\s*[-*]\s+\S/,
  "project.stage": /##\s*阶段\s*\n\s*[-*]\s+\S/,
  "project.constraints": /##\s*约束\s*\n\s*[-*]\s+\S/,
  "project.population": /人群[：:]\s*\S/,
  "project.intervention": /干预(?:或暴露)?[：:]\s*\S/,
  "project.comparator": /对照[：:]\s*\S/,
  "project.outcome": /结局[：:]\s*\S/,
  "project.design": /设计[：:]\s*\S/,
}));

const body = (/** @type {unknown} */ raw) => String(raw ?? "").replace(/<!-- MEMORY_FIELDS[\s\S]*?-->/g, "").trim();
const bullets = (/** @type {string} */ text) => text.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line));

/**
 * The memory files an extraction wrote, counted as the kinds the corpus speaks of.
 * @param {Record<string, string>} files relative path under `memories/` → text
 */
export function kindsOf(files) {
  /** @type {Record<string, string[]>} */
  const out = { profile: [], preference: [], correction: [], decision: [], follow_up: [], project_fact: [], entity: [], other: [] };
  for (const [rel, raw] of Object.entries(files)) {
    const text = body(raw);
    if (rel === "profile.md") out.profile.push(...bullets(text));
    else if (rel.startsWith("preferences/")) out.preference.push(...bullets(text));
    else if (rel.startsWith("corrections/")) out.correction.push(...bullets(text));
    else if (rel.startsWith("decisions/")) out.decision.push(...bullets(text));
    else if (rel.startsWith("follow_ups/")) out.follow_up.push(...bullets(text));
    else if (rel.startsWith("project_facts/")) out.project_fact.push(...bullets(text));
    else if (rel.startsWith("entities/")) out.entity.push(rel);
    else if (rel.startsWith("projects/")) {
      let section = "";
      for (const line of text.split("\n")) {
        const heading = line.match(/^##\s+(.+)$/);
        if (heading) { section = heading[1].trim(); continue; }
        if (/^领域[：:]/.test(line.trim())) { out.project_fact.push(line.trim()); continue; }
        if (!/^\s*[-*]\s+\S/.test(line)) continue;
        if (section.startsWith("已定事项")) out.decision.push(line);
        else if (section.startsWith("阶段")) out.follow_up.push(line);
        else out.project_fact.push(line);
      }
    } else out.other.push(rel);
  }
  return out;
}

/**
 * What a case's decided checks say about the files one replay left. [] is a pass.
 * @param {any} item @param {Record<string, string>} files @param {number} operations the extraction's adds, updates and deletes
 */
export function scoreNative(item, files, operations) {
  const expect = item.expect ?? {};
  const written = kindsOf(files);
  const counts = Object.fromEntries(Object.entries(written).map(([kind, list]) => [kind, list.length]));
  const text = Object.values(files).map(body).join("\n");
  /** @type {string[]} */
  const failures = [];
  for (const needle of expect.noTextContains ?? []) if (text.includes(needle)) failures.push(`carries "${needle}"`);
  for (const kind of expect.noRecordOfKinds ?? []) if ((counts[kind] ?? 0) > 0) failures.push(`${counts[kind]} ${kind}`);
  for (const [kind, least] of Object.entries(expect.requireKinds ?? {})) if ((counts[kind] ?? 0) < Number(least)) failures.push(`${kind} ${counts[kind] ?? 0} < ${least}`);
  for (const needle of expect.requireTextContains ?? []) if (!text.includes(needle)) failures.push(`lacks "${needle}"`);
  if (expect.atMostRecords !== undefined && operations > expect.atMostRecords) failures.push(`${operations} memory operations > ${expect.atMostRecords}`);
  if (expect.atLeastRecords !== undefined && operations < expect.atLeastRecords) failures.push(`${operations} memory operations < ${expect.atLeastRecords}`);
  for (const key of expect.requireKeys ?? []) if (!CARD_PATTERNS[key]?.test(text)) failures.push(`the card lacks ${key}`);
  for (const [key, allowed] of Object.entries(expect.keyValues ?? {})) {
    const held = CARD_PATTERNS[key] && text.match(new RegExp(`${CARD_PATTERNS[key].source}.*`, CARD_PATTERNS[key].flags.replace("g", "")))?.[0];
    if (held && !(/** @type {string[]} */ (allowed)).some((value) => held.includes(value))) failures.push(`${key} holds "${held.slice(0, 60)}", none of ${JSON.stringify(allowed)}`);
  }
  return failures;
}

/** @param {string} directory */
async function loadDirectory(directory) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => ({ file: name, ...JSON.parse(await readFile(path.join(directory, name), "utf8")) })));
}

/** What is wrong with one case for this arm, or []. @param {any} item */
export function nativeCaseIssues(item) {
  const issues = [];
  if (typeof item.id !== "string" || `${item.id}.json` !== item.file) issues.push(`${item.file}: the file is not named after its id`);
  if (!Array.isArray(item.replay?.messages) || !item.replay.messages.length) issues.push(`${item.file}: replay holds no message`);
  if (item.decidable !== false && !item.expect) issues.push(`${item.file}: a decidable case names no expectation`);
  for (const field of Object.keys(item.expect ?? {})) if (!FIELD_EXPECTATIONS.includes(field)) issues.push(`${item.file}: expect.${field} is not a check this arm decides`);
  if (item.decidable === false && typeof item.judge !== "string") issues.push(`${item.file}: an undecidable case names no judge question`);
  return issues;
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  const options = { offline: false, keep: false, url: "", keyFile: "", account: "evimed", only: "", out: "", waitMs: 300_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--offline") { options.offline = true; continue; }
    if (argument === "--keep") { options.keep = true; continue; }
    const field = { "--url": "url", "--key-file": "keyFile", "--account": "account", "--only": "only", "--out": "out", "--wait-ms": "waitMs" }[argument];
    if (!field) throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    /** @type {any} */ (options)[field] = field === "waitMs" ? Number(value) : value;
    index += 1;
  }
  if (!options.offline && (!options.url || !options.keyFile)) throw new Error("give --url and --key-file (or --offline)");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map((name) => loadDirectory(path.join(here, name))))).flat()
    .filter((item) => !options.only || options.only.split(",").some((part) => item.id.includes(part)));
  const issues = cases.flatMap(nativeCaseIssues);
  if (issues.length) throw new Error(`the corpus has ${issues.length} shape problem(s):\n${issues.join("\n")}`);
  if (options.offline) {
    process.stdout.write(`${cases.length} cases, ${cases.filter((item) => item.decidable !== false).length} decidable; shapes ok\n`);
    return;
  }
  const [{ OpenVikingClient }, { OpenVikingSessions }, { filterCapturedMessage }] = await Promise.all([
    import(pathToFileURL(path.join(serverSrc, "openVikingClient.mjs")).href),
    import(pathToFileURL(path.join(serverSrc, "openVikingSessions.mjs")).href),
    import(pathToFileURL(path.join(serverSrc, "memoryGateway.mjs")).href),
  ]);
  const key = (await readFile(options.keyFile, "utf8")).trim();
  const client = new OpenVikingClient({ openVikingUrl: options.url, openVikingApiKey: key, openVikingAccount: options.account, openVikingRequestTimeoutMs: 60_000 });
  const sessions = new OpenVikingSessions(client, { timeoutMs: 60_000, fastTimeoutMs: 20_000 });
  const run = randomBytes(3).toString("hex");
  /** One conversation: a session, its messages, a commit, and the extraction awaited. */
  const converse = async (/** @type {string} */ userId, /** @type {string} */ name, /** @type {any[]} */ forwarded) => {
    const sessionId = name.slice(0, 120).replace(/[^A-Za-z0-9_.@-]/g, "_");
    await sessions.createSession(userId, sessionId, { timeoutMs: 60_000 });
    for (const message of forwarded) await sessions.addMessage(userId, sessionId, message);
    const committed = (await sessions.commit(userId, sessionId, { timeoutMs: 60_000 }))?.result ?? {};
    let operations = 0;
    /** @type {Record<string, any> | null} */
    let task = null;
    if (committed.status === "accepted" && committed.task_id) {
      const deadline = Date.now() + options.waitMs;
      for (;;) {
        task = await sessions.task(userId, committed.task_id);
        if (task && ["completed", "failed", "cancelled"].includes(String(task.status))) break;
        if (Date.now() > deadline) { task = { status: "timeout" }; break; }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const diffText = task?.result?.memory_diff_uri ? await sessions.read(userId, task.result.memory_diff_uri) : null;
      try { const diff = diffText ? JSON.parse(diffText) : null; operations = (diff?.summary?.total_adds ?? 0) + (diff?.summary?.total_updates ?? 0) + (diff?.summary?.total_deletes ?? 0); } catch { operations = 0; }
    }
    return { operations, task, status: committed.status };
  };
  const rows = [];
  // A case about a platform brief runs twice: bare (what the engine does with the words alone) and tagged (what the gateway's door
  // leaves of a started turn's text wrapped in the platform's tag — nothing).
  const runs = cases.flatMap((item) => (item.expect?.briefRefusedWhenTagged === true ? [{ item, variant: "bare" }, { item, variant: "tagged" }] : [{ item, variant: "" }]));
  for (const { item, variant } of runs) {
    const userId = `evmq-${run}-${createHash("sha256").update(`${item.id}${variant}`).digest("hex").slice(0, 8)}`;
    const incoming = item.replay.messages.map((message) => ({ role: message.role, content: variant === "tagged" ? `${message.text}\n${PLATFORM_TAG}` : message.text }));
    /** @type {{ role: string, parts: { type: string, text: string }[] }[]} */
    const forwarded = [];
    let dropped = 0;
    for (const message of incoming) {
      const decision = filterCapturedMessage(message);
      if ("forward" in decision) forwarded.push(decision.forward); else dropped += 1;
    }
    const row = /** @type {Record<string, any>} */ ({ id: variant ? `${item.id}:${variant}` : item.id, class: item.class, decidable: item.decidable !== false, messages: incoming.length, forwarded: forwarded.length, dropped });
    try {
      await sessions.register(userId).catch(() => false);
      // A case that restates a fact the account already holds stores it first, through a conversation of its own.
      if (item.replay.existingKeys?.length) {
        await converse(userId, `evmq-${run}-${item.id}${variant}-seed`, [
          { role: "user", parts: [{ type: "text", text: "我们这个 GEO 项目里，说明书那一块目前核对的是转载页，不是官方原件；等拿到官方原件，要替换引用并把文章升版。" }] },
          { role: "assistant", parts: [{ type: "text", text: "明白，说明书目前按转载页核对，拿到官方原件后替换引用并升版。" }] }]);
      }
      const { operations, task, status } = await converse(userId, `evmq-${run}-${item.id}${variant}`, forwarded);
      const committed = { status };
      const root = sessions.memoryRoot(userId);
      /** @type {Record<string, string>} */
      const files = {};
      for (const node of await sessions.tree(userId, root, { levelLimit: 8 })) {
        if (node.isDir) continue;
        const rel = node.uri.slice(root.length + 1);
        if (!rel.endsWith(".md") || rel.split("/").some((segment) => segment.startsWith(".")) || /^(identity|soul)\.md$/.test(rel)) continue;
        files[rel] = (await sessions.read(userId, node.uri)) ?? "";
      }
      const failed = task && task.status !== "completed";
      const failures = failed ? [`extraction ${task?.status}: ${String(task?.error ?? "").slice(0, 120)}`] : scoreNative(item, files, operations);
      Object.assign(row, { operations, taskStatus: task?.status ?? (committed.status === "accepted" ? "unknown" : String(committed.status ?? "no commit")),
        counts: Object.fromEntries(Object.entries(kindsOf(files)).filter(([, list]) => list.length).map(([kind, list]) => [kind, list.length])), files,
        failures, verdict: row.decidable ? (failures.length ? "FAIL" : "pass") : "needs-reading", expected: item.expected, judge: item.judge ?? null });
    } catch (error) {
      Object.assign(row, { failures: [`error ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 160)}`], verdict: row.decidable ? "FAIL" : "needs-reading" });
    } finally {
      if (!options.keep) await sessions.eraseUser(userId, { waitMs: 20_000 }).catch(() => null);
    }
    rows.push(row);
    process.stdout.write(`${JSON.stringify({ id: row.id, verdict: row.verdict, failures: row.failures, operations: row.operations, counts: row.counts })}\n`);
  }
  const decided = rows.filter((row) => row.decidable);
  const summary = { run, engineUrl: new URL(options.url).origin, at: new Date().toISOString(), decidable: decided.length, passed: decided.filter((row) => row.verdict === "pass").length,
    needReading: rows.length - decided.length, failed: decided.filter((row) => row.verdict === "FAIL").map((row) => row.id) };
  process.stdout.write(`\n${summary.passed}/${summary.decidable} decidable cases pass; ${summary.needReading} need reading${summary.failed.length ? `; failed: ${summary.failed.join(", ")}` : ""}\n`);
  if (options.out) {
    await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await writeFile(options.out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  }
  if (summary.failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`native_eval_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
