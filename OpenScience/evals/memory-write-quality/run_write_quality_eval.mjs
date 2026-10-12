#!/usr/bin/env node
/**
 * What the extractor writes, replayed against the write-quality incidents.
 *
 * Every case in `cases/` is one class of bad memory seen on production — a
 * summary that names fields instead of facts, an internal id, a run's one-off
 * bookkeeping, a follow-up filed in the catch-all project, three keys for one
 * fact, a platform brief stored as the researcher's words. Principle 6: an
 * incident becomes a case, not a keyword, so a general fix to the extraction
 * instructions can be tried and this tells whether it regressed anything.
 *
 * Since 2026-10-12 the corpus also holds fourteen synthetic replays of what the
 * extractor must keep (a role, a standing method, a correction, the shape of a
 * project) and must never keep (a patient, a credential, one's own health, a
 * colleague's details, a mood, a pasted document). Nothing in them was ever on
 * production: they are marked `replay.synthetic`, every identifier in them is
 * invented, and `written` holds what the extractor wrote for them before the
 * 2026-10-12 change (empty when it wrote nothing).
 *
 * Two kinds of verdict, kept apart on purpose (principle 5):
 *
 * - `decided` — a structural fact code can settle: an id string appears or it
 *   does not, a record of a kind was written in a project or it was not, how
 *   many records one restated fact produced (at most, or at least, per kind),
 *   whether a tagged brief ever reached the extractor, whether the code that
 *   refuses identifier shapes sees the identifiers a replay carries.
 * - `needs-judgement` — whether a summary states a fact, whether a sentence is
 *   a run's bookkeeping. That is language. The runner prints what was written
 *   next to the case's `judge` question for a reviewer (or a model judge); it
 *   never pattern-matches prose.
 *
 *   node evals/memory-write-quality/run_write_quality_eval.mjs --offline
 *   OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE=/path/to/key \
 *     node evals/memory-write-quality/run_write_quality_eval.mjs --out evals/memory-write-quality/results/$(date +%F).json
 *
 * `--offline` runs only what needs no model: the corpus shape and the
 * pre-model checks. The live run uses the server's own configuration loader,
 * so the model, base URL and key are the ones production would use; the key
 * is never written to the results.
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const serverSrc = path.join(repoRoot, "apps/server/src");

/** Every class the corpus must hold one case of. */
export const REQUIRED_CLASSES = Object.freeze([
  "hollow-summary",
  "internal-id",
  "one-off-bookkeeping",
  "default-project-follow-up",
  "near-duplicates",
  "platform-brief-as-user-words",
  "pending-state-and-inventory",
  // The 2026-10-12 synthetic replays: what is kept, then what never is.
  "standing-role-and-focus",
  "standing-method-and-format",
  "research-tool-preferences",
  "one-off-request-condition",
  "user-correction",
  "project-shape-and-decision",
  "patient-identifiers",
  "credentials",
  "own-health",
  "third-party-details",
  "run-tool-and-field-names",
  "transient-emotion",
  "pasted-document-content",
  "patient-religion",
]);

/** The fields a decided case may use in `expect`; a misspelt one would otherwise decide nothing and read as `not-run`. */
export const EXPECT_FIELDS = Object.freeze([
  "noTextContains", "noRecordOfKinds", "atMostRecords", "requireKinds", "requireTextContains",
  "briefRefusedWhenTagged", "identifierShapes",
]);

/** @returns {Promise<any[]>} */
export async function loadCases(directory = path.join(here, "cases")) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => ({ file: name, ...JSON.parse(await readFile(path.join(directory, name), "utf8")) })));
}

/** What is wrong with one case's shape, or []. @param {any} item */
export function caseIssues(item) {
  const issues = [];
  for (const field of ["id", "class", "observedIn", "whyItIsWrong", "expected"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) issues.push(`${item.file}: ${field} is missing`);
  }
  if (`${item.id}.json` !== item.file) issues.push(`${item.file}: the file is not named after its id`);
  // A synthetic replay was never on production: its `written` is what the extractor wrote for it, and may be nothing.
  if (!Array.isArray(item.written) || (item.written.length === 0 && item.replay?.synthetic !== true)) issues.push(`${item.file}: written holds no observed record`);
  if (!Array.isArray(item.replay?.messages) || item.replay.messages.length === 0) issues.push(`${item.file}: replay holds no message`);
  if (typeof item.decidable !== "boolean") issues.push(`${item.file}: decidable is not a boolean`);
  // Whether the extractor of the time passed the case's own checks on everything it wrote for the replay (every sample).
  if (item.replay?.synthetic === true && !["held", "failed"].includes(item.preChange)) issues.push(`${item.file}: a synthetic replay says whether the earlier extractor held (preChange: held | failed)`);
  if (item.decidable && !item.expect) issues.push(`${item.file}: a decidable case names no expectation`);
  for (const field of Object.keys(item.expect ?? {})) {
    if (!EXPECT_FIELDS.includes(field)) issues.push(`${item.file}: expect.${field} is not a check the runner decides`);
  }
  const required = item.expect?.requireKinds;
  if (required !== undefined && !(required && typeof required === "object" && !Array.isArray(required)
    && Object.values(required).every((count) => Number.isInteger(count) && count > 0))) {
    issues.push(`${item.file}: expect.requireKinds is not a map from a record kind to a positive count`);
  }
  if (!item.decidable && typeof item.judge !== "string") issues.push(`${item.file}: an undecidable case names no judge question`);
  return issues;
}

/** The replay as the transcript shape the extractor reads. @param {any} item */
export function replayMessages(item) {
  return item.replay.messages.map((message) => ({
    info: { id: message.id, role: message.role, ...(message.source ? { source: message.source } : {}) },
    parts: [{ type: "text", text: message.text }],
  }));
}

/**
 * The verdicts code can reach about what one replay wrote.
 * @param {any} item @param {any[]} written the records the extractor stored, run summary excluded
 * @returns {{ check: string, passed: boolean, detail: string }[]}
 */
export function decidedVerdicts(item, written) {
  const expect = item.expect ?? {};
  const verdicts = [];
  if (Array.isArray(expect.noTextContains)) {
    for (const needle of expect.noTextContains) {
      const carriers = written.filter((record) => `${record.value}\n${record.summary}`.includes(needle));
      verdicts.push({ check: `no record carries ${needle}`, passed: carriers.length === 0, detail: carriers.map((record) => record.key).join(", ") });
    }
  }
  if (Array.isArray(expect.noRecordOfKinds)) {
    const found = written.filter((record) => expect.noRecordOfKinds.includes(record.kind));
    verdicts.push({ check: `no ${expect.noRecordOfKinds.join("/")} record in ${item.replay.projectId}`, passed: found.length === 0,
      detail: found.map((record) => `${record.kind}:${record.key}`).join(", ") });
  }
  if (Number.isInteger(expect.atMostRecords)) {
    verdicts.push({ check: `at most ${expect.atMostRecords} record(s)`, passed: written.length <= expect.atMostRecords,
      detail: written.map((record) => record.key).join(", ") });
  }
  // The other direction: something that must be kept was kept. A kind is counted, never read for what it says.
  if (expect.requireKinds && typeof expect.requireKinds === "object") {
    for (const [kind, least] of Object.entries(expect.requireKinds)) {
      const found = written.filter((record) => record.kind === kind);
      verdicts.push({ check: `at least ${least} ${kind} record(s)`, passed: found.length >= least, detail: `${found.length} written` });
    }
  }
  if (Array.isArray(expect.requireTextContains)) {
    for (const needle of expect.requireTextContains) {
      const carriers = written.filter((record) => `${record.value}\n${record.summary}`.includes(needle));
      verdicts.push({ check: `some record carries ${needle}`, passed: carriers.length > 0, detail: carriers.map((record) => record.key).join(", ") });
    }
  }
  return verdicts;
}

/**
 * The pre-model check of the platform-brief class: the brief, carrying any
 * registered platform tag, never reaches the extractor.
 * @param {any} item @param {{ conversationMemorySources: Function, tags: readonly { tag: string, role: string }[] }} tools
 */
export function briefVerdicts(item, { conversationMemorySources, tags }) {
  if (!item.expect?.briefRefusedWhenTagged) return [];
  const brief = item.replay.messages[0];
  return tags.filter((entry) => entry.role === "injected").map((entry) => {
    const text = `${brief.text}\n\n<${entry.tag}>eval-dispatch</${entry.tag}>`;
    const result = conversationMemorySources([{ info: { id: brief.id, role: "user", source: "user" }, parts: [{ type: "text", text }] }], "eval-session");
    return { check: `a brief tagged ${entry.tag} is not a source`, passed: result.sources.length === 0, detail: "" };
  });
}

/**
 * The pre-model check of the identifier classes: the code that refuses a
 * credential or a personal identifier by its shape sees each kind the replay
 * carries, in the researcher's own message. If a pattern were loosened until it
 * missed the ID number, the phone or the key, the case would still read as
 * handled by the model while nothing stood behind it.
 * @param {any} item @param {{ identifierShapesIn: (text: unknown) => string[] }} tools
 */
export function shapeVerdicts(item, { identifierShapesIn }) {
  const expected = item.expect?.identifierShapes;
  if (!Array.isArray(expected)) return [];
  const seen = new Set(item.replay.messages.filter((message) => message.role === "user").flatMap((message) => identifierShapesIn(message.text)));
  return expected.map((kind) => ({ check: `the researcher's message carries a ${kind} shape the code refuses`, passed: seen.has(kind), detail: [...seen].join(", ") }));
}

/** An in-memory store with the extractor's read/write surface. */
class ReplayStore {
  constructor(existing = []) {
    this.configured = false;
    /** @type {Map<string, any>} */
    this.records = new Map();
    for (const record of existing) this.#put({ ...record, value: record.value ?? record.key, summary: record.summary ?? "", status: "active", origin: "system" });
  }
  #put(record) {
    const stored = { id: record.key, version: 1, revisions: [], evidence: [], evidenceCount: 0, scopeId: record.scopeId ?? "", ...record };
    this.records.set([stored.scope, stored.scopeId, stored.kind, stored.key].join("\u0000"), stored);
    return stored;
  }
  async listRecords() { return [...this.records.values()]; }
  async upsertRecord(_userId, input) { return this.#put(input); }
  async getRecord() { throw Object.assign(new Error("not found"), { code: "memory_not_found" }); }
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : "";
  const cases = await loadCases();
  const shape = cases.flatMap(caseIssues);
  const missing = REQUIRED_CLASSES.filter((name) => !cases.some((item) => item.class === name));
  if (shape.length || missing.length) {
    process.stderr.write(`${[...shape, ...missing.map((name) => `no case of class ${name}`)].join("\n")}\n`);
    process.exitCode = 2;
    return;
  }
  const { conversationMemorySources, MemoryIntelligence } = await import(pathToFileURL(path.join(serverSrc, "memoryIntelligence.mjs")).href);
  const { PLATFORM_CONTEXT_TAGS, identifierShapesIn } = await import(pathToFileURL(path.join(repoRoot, "packages/domain/index.mjs")).href);
  const results = [];
  /** The model the live replay ran on, so a result names what was measured. */
  let model = null;
  for (const item of cases) {
    const verdicts = [
      ...briefVerdicts(item, { conversationMemorySources, tags: PLATFORM_CONTEXT_TAGS }),
      ...shapeVerdicts(item, { identifierShapesIn }),
    ];
    /** @type {any[] | null} */
    let written = null;
    if (!offline && item.class !== "platform-brief-as-user-words") {
      const { loadConfig } = await import(pathToFileURL(path.join(serverSrc, "config.mjs")).href);
      const config = loadConfig({ memoryExtractionEnabled: true });
      if (!config.deepseekApiKey) throw new Error("no DeepSeek key: set OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE, or run --offline");
      model = config.memoryExtractionModel || config.deepseekModel || null;
      const store = new ReplayStore(item.replay.existingKeys ?? []);
      const before = new Set(store.records.keys());
      await new MemoryIntelligence(config, store).recordRun({ id: item.replay.projectId, userId: "eval-write-quality" },
        { id: `run_${item.id}`, sessionId: "eval-session", status: "succeeded", finishedAt: new Date().toISOString() },
        replayMessages(item));
      written = [...store.records.entries()].filter(([key, record]) => !before.has(key) && record.kind !== "run_summary")
        .map(([, record]) => ({ kind: record.kind, scope: record.scope, key: record.key, summary: record.summary, value: record.value }));
      verdicts.push(...decidedVerdicts(item, written));
    }
    results.push({
      id: item.id, class: item.class,
      verdict: !item.decidable ? "needs-judgement" : verdicts.length === 0 ? "not-run" : verdicts.every((entry) => entry.passed) ? "passed" : "failed",
      verdicts, ...(written ? { written } : {}), ...(item.judge ? { judge: item.judge } : {}),
    });
  }
  const report = { ranAt: new Date().toISOString(), offline, model, cases: results };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, text);
  }
  process.stdout.write(text);
  if (results.some((result) => result.verdict === "failed")) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`memory write-quality eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
