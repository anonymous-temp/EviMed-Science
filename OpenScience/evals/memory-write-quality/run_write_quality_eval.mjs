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
 *   many records one restated fact produced (at most, or at least, per kind), which keys they were written under,
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
 * pre-model checks. The general corpus (`cases-general/`, the work-order cases of 2026-10-23 among them) is validated here too and
 * replayed for the cases that are for this arm (`arms`); a case with a `replay.seed` first holds that conversation, and what a
 * check reads is what the case's own conversation wrote or changed. The live run uses the server's own configuration loader,
 * so the model, base URL and key are the ones production would use; the key
 * is never written to the results.
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generalCaseIssues, runsOnArm } from "./caseShape.mjs";

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
  "remembered-own-health",
  "own-health-in-passing",
  "third-party-details",
  "run-tool-and-field-names",
  "transient-emotion",
  "pasted-document-content",
  "patient-religion",
  // The project card (2026-10-12): a described study is kept under the card's own keys, a question is not read as a study.
  "project-card-slots",
  "project-card-not-guessed",
  // The card made general (2026-10-13): any kind of work is kept under the general keys, the study's elements only when stated,
  // and a task given to the assistant is not a project of the researcher's.
  "project-card-software-refactor",
  "project-card-launch-plan",
  "project-card-history-thesis",
  "project-card-market-analysis",
  "project-card-clinical-rct",
  "project-card-observational-database",
  "project-card-task-not-a-project",
]);

/** The fields a decided case may use in `expect`; a misspelt one would otherwise decide nothing and read as `not-run`. */
export const EXPECT_FIELDS = Object.freeze([
  "noTextContains", "noRecordOfKinds", "atMostRecords", "requireKinds", "requireTextContains",
  "briefRefusedWhenTagged", "identifierShapes", "requireKeys", "keyValues", "noKeys",
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
  const keys = item.expect?.requireKeys;
  if (keys !== undefined && !(Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === "string" && key))) {
    issues.push(`${item.file}: expect.requireKeys is not a list of memory keys`);
  }
  const forbidden = item.expect?.noKeys;
  if (forbidden !== undefined && !(Array.isArray(forbidden) && forbidden.length > 0 && forbidden.every((key) => typeof key === "string" && key))) {
    issues.push(`${item.file}: expect.noKeys is not a list of memory keys`);
  }
  const values = item.expect?.keyValues;
  if (values !== undefined && !(values && typeof values === "object" && !Array.isArray(values)
    && Object.values(values).every((allowed) => Array.isArray(allowed) && allowed.length > 0 && allowed.every((value) => typeof value === "string")))) {
    issues.push(`${item.file}: expect.keyValues is not a map from a memory key to the values it may hold`);
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
 * @param {any} item @param {any[]} written the records the extractor stored, run summary excluded (after a seed: the ones the case's
 *   own conversation wrote or changed)
 * @param {{ inForce?: any[], conflicts?: { key: string, otherKey: string }[], seed?: { kept: any[], unchanged: boolean } }} [extras]
 *   `inForce`: every record in force after a case with a seed; `conflicts`: the disagreements the extractor named;
 *   `seed`: what the seed conversation stored, and whether the case's own left it as it was.
 * @returns {{ check: string, passed: boolean, detail: string }[]}
 */
export function decidedVerdicts(item, written, extras = /** @type {{ inForce?: any[], conflicts?: { key: string, otherKey: string }[], seed?: { kept: any[], unchanged: boolean } }} */ ({})) {
  const expect = item.expect ?? {};
  const verdicts = [];
  if (Array.isArray(expect.noTextContains)) {
    // After a seed, what must not be there is looked for in everything in force, the seed's own records included.
    const searched = extras.inForce ?? written;
    for (const needle of expect.noTextContains) {
      const carriers = searched.filter((record) => `${record.value}\n${record.summary}`.includes(needle));
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
  if (Number.isInteger(expect.atLeastRecords)) {
    verdicts.push({ check: `at least ${expect.atLeastRecords} record(s)`, passed: written.length >= expect.atLeastRecords, detail: `${written.length} written` });
  }
  if (Array.isArray(expect.requireAnyKind)) {
    const found = written.filter((record) => expect.requireAnyKind.includes(record.kind));
    verdicts.push({ check: `at least one ${expect.requireAnyKind.join("/")} record`, passed: found.length > 0, detail: written.map((record) => `${record.kind}:${record.key}`).join(", ") });
  }
  if (Array.isArray(expect.requireConflictWith)) {
    for (const key of expect.requireConflictWith) {
      const named = (extras.conflicts ?? []).filter((conflict) => conflict.otherKey === key);
      verdicts.push({ check: `a statement is marked as disagreeing with ${key}`, passed: named.length > 0, detail: named.map((conflict) => conflict.key).join(", ") || written.map((record) => record.key).join(", ") });
    }
  }
  if (extras.seed) {
    for (const needle of expect.seedKeeps ?? []) {
      verdicts.push({ check: `the seed stored ${needle}`, passed: extras.seed.kept.some((record) => `${record.value}\n${record.summary}`.includes(needle)), detail: extras.seed.kept.map((record) => record.key).join(", ") });
    }
    if (expect.unchangedSinceSeed === true) verdicts.push({ check: "the case's conversation left what the seed wrote as it was", passed: extras.seed.unchanged && written.length === 0, detail: written.map((record) => record.key).join(", ") });
  }
  // The other direction: something that must be kept was kept. A kind is counted, never read for what it says.
  if (expect.requireKinds && typeof expect.requireKinds === "object") {
    for (const [kind, least] of Object.entries(expect.requireKinds)) {
      const found = written.filter((record) => record.kind === kind);
      verdicts.push({ check: `at least ${least} ${kind} record(s)`, passed: found.length >= least, detail: `${found.length} written` });
    }
  }
  // Which keys the records were written under, and what a key holds when it closes its values: both are read off the record,
  // never off its prose.
  if (Array.isArray(expect.requireKeys)) {
    for (const key of expect.requireKeys) {
      verdicts.push({ check: `some record is written under ${key}`, passed: written.some((record) => record.key === key), detail: written.map((record) => record.key).join(", ") });
    }
  }
  // The keys a record must not be written under: a key of the card that the work described has no use of (the study's elements for
  // a software refactor, a data source nobody stated).
  if (Array.isArray(expect.noKeys)) {
    for (const key of expect.noKeys) {
      const found = written.filter((record) => record.key === key);
      verdicts.push({ check: `no record is written under ${key}`, passed: found.length === 0, detail: found.map((record) => record.value).join(" | ") });
    }
  }
  if (expect.keyValues && typeof expect.keyValues === "object") {
    for (const [key, allowed] of Object.entries(expect.keyValues)) {
      const held = written.filter((record) => record.key === key);
      verdicts.push({ check: `${key} holds only ${allowed.join(" / ")}`, passed: held.every((record) => allowed.includes(record.value)), detail: held.map((record) => record.value).join(" | ") });
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
export class ReplayStore {
  constructor(existing = []) {
    this.configured = false;
    /** @type {Map<string, any>} */
    this.records = new Map();
    /** The disagreements the extractor named: the key it wrote and the stored key it disagrees with. @type {{ key: string, otherKey: string }[]} */
    this.conflicts = [];
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
  async markConflict(_userId, id, otherId) { this.conflicts.push({ key: String(id), otherKey: String(otherId) }); }
  /** What the store holds now, by record: the value and whether it is in force. */
  snapshot() {
    return new Map([...this.records.entries()].filter(([, record]) => record.kind !== "run_summary")
      .map(([key, record]) => [key, `${record.status}\u0000${record.value}`]));
  }
}

/** The records a conversation wrote or changed, between two snapshots of one store. @param {ReplayStore} store @param {Map<string, string>} before */
function changedSince(store, before) {
  const now = store.snapshot();
  return [...store.records.entries()].filter(([key, record]) => record.kind !== "run_summary" && now.get(key) !== before.get(key))
    .map(([, record]) => ({ kind: record.kind, scope: record.scope, key: record.key, summary: record.summary, value: record.value }));
}

/**
 * The pre-model check of the platform-tag cases: a message that wears a platform tag (or the kernel's) never becomes a source.
 * @param {any} item @param {{ conversationMemorySources: Function }} tools
 */
export function doorVerdicts(item, { conversationMemorySources }) {
  const dropped = item.expect?.droppedAtTheDoor;
  if (!Array.isArray(dropped)) return [];
  const { sources } = conversationMemorySources(replayMessages(item), "eval-session");
  return dropped.map((/** @type {string} */ id) => ({
    check: `message ${id} is not a source of memory`, passed: !sources.some((/** @type {any} */ source) => String(source.sourceRef).endsWith(`/messages/${id}`)), detail: "",
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : "";
  const repeatIndex = argv.indexOf("--repeat");
  const repeat = repeatIndex >= 0 ? Number(argv[repeatIndex + 1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat is a whole number from 1 to 10");
  const cases = await loadCases();
  const general = await loadCases(path.join(here, "cases-general"));
  const shape = [...cases.flatMap(caseIssues), ...general.flatMap(generalCaseIssues)];
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
  // The incident cases, then the general corpus's cases that are for this arm. The rest of the general corpus is validated above and
  // belongs to the native arm.
  const all = [...cases.map((item) => ({ item, general: false })), ...general.map((item) => ({ item, general: true }))];
  for (const { item, general: isGeneral } of all) {
    // A general case that is for the other arm is shape-checked only; its offline checks (shapes, the door) still run.
    const live = !offline && item.class !== "platform-brief-as-user-words" && (!isGeneral || runsOnArm(item, "legacy"));
    const offlineVerdicts = [
      ...briefVerdicts(item, { conversationMemorySources, tags: PLATFORM_CONTEXT_TAGS }),
      ...shapeVerdicts(item, { identifierShapesIn }),
      ...doorVerdicts(item, { conversationMemorySources }),
    ];
    // Offline, a general case with nothing to check without a model has nothing to report.
    if (isGeneral && !live && !offlineVerdicts.length) continue;
    for (let sample = 0; sample < (live ? repeat : 1); sample += 1) {
      const verdicts = [...offlineVerdicts];
      /** @type {any[] | null} */
      let written = null;
      if (live) {
        const { loadConfig } = await import(pathToFileURL(path.join(serverSrc, "config.mjs")).href);
        const config = loadConfig({ memoryExtractionEnabled: true });
        if (!config.deepseekApiKey) throw new Error("no DeepSeek key: set OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE, or run --offline");
        model = config.memoryExtractionModel || config.deepseekModel || null;
        const store = new ReplayStore(item.replay.existingKeys ?? []);
        const intelligence = new MemoryIntelligence(config, store);
        const project = { id: item.replay.projectId, userId: "eval-write-quality" };
        const stamp = () => new Date().toISOString();
        const plain = (/** @type {any} */ record) => ({ kind: record.kind, scope: record.scope, key: record.key, summary: record.summary, value: record.value });
        /** @type {{ kept: any[], unchanged: boolean } | undefined} */
        let seed;
        if (item.replay.seed?.messages?.length) {
          // The memory the case starts from is written by the extractor itself, in a conversation of its own.
          await intelligence.recordRun(project, { id: `run_${item.id}_seed`, sessionId: "eval-seed-session", status: "succeeded", finishedAt: stamp() },
            replayMessages({ replay: item.replay.seed }));
          seed = { kept: [...store.records.values()].filter((record) => record.kind !== "run_summary").map(plain), unchanged: true };
        }
        const beforeSnapshot = store.snapshot();
        const before = new Set(store.records.keys());
        await intelligence.recordRun(project, { id: `run_${item.id}`, sessionId: "eval-session", status: "succeeded", finishedAt: stamp() }, replayMessages(item));
        // Without a seed: the records the replay made new. With one: what the case's own conversation wrote or changed.
        written = seed ? changedSince(store, beforeSnapshot)
          : [...store.records.entries()].filter(([key, record]) => !before.has(key) && record.kind !== "run_summary").map(([, record]) => plain(record));
        if (seed) seed.unchanged = written.length === 0;
        const inForce = seed ? [...store.records.values()].filter((record) => record.kind !== "run_summary" && record.status === "active").map(plain) : undefined;
        verdicts.push(...decidedVerdicts(item, written, { ...(inForce ? { inForce } : {}), conflicts: store.conflicts, ...(seed ? { seed } : {}) }));
      }
      results.push({
        id: repeat > 1 && live ? `${item.id}#${sample + 1}` : item.id, class: item.class,
        verdict: !item.decidable ? "needs-judgement" : verdicts.length === 0 ? "not-run" : verdicts.every((entry) => entry.passed) ? "passed" : "failed",
        verdicts, ...(written ? { written } : {}), ...(item.judge ? { judge: item.judge } : {}),
      });
    }
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
