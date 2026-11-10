#!/usr/bin/env node
/**
 * The product's learning loop without a control-plane server or a kernel (plan 2026-11-04 §5.5 C1).
 *
 * The product's own code does the work:
 *  - the library is `LearningService` over an in-memory documents store (`documents.mjs`, the server tests' double plus persistence),
 *    saved to `<dir>/library.json` after every step;
 *  - `distill` is `MethodDistillationRuns.execute` itself — `buildDistillationInput`, the related pool by `MethodSimilarity.nearest`
 *    over the library (and, with `officialInLoop`, the given official set as read-only documents), the dispatch `question`, and
 *    `applyCandidate` with `evidenceCorpus` / `reactionCorpus` — over the episode stored as a run transcript (`gameTranscript.mjs`);
 *  - `consolidate` is `MethodConsolidation.sleep` (approve, shortlist by similarity, SCREEN, DECIDE, BUILD, retirements, levels), and each
 *    write's queued `integrate` job is `MethodConsolidation.integrate`, as the product's worker runs them; SCREEN is the similarity shortlist
 *    with no judge, as in production since J1 was switched off;
 *  - `select` is `selectMethodsForTask` (`learnedMethodMount.mjs`), "flat" = every switch off, "pyramid" = `options.pyramid`.
 *
 * Stand-ins (ours): the two model steps are answered by `modelSteps.mjs` (direct DeepSeek, the capability's SKILL.md, the contract gate);
 * the job queue is a list this loop drains (`integrate` at once, `sleep` when the caller consolidates, `replay` recorded and not run — no
 * replay is composed offline); the clock advances one minute per step.
 *
 * CLI:
 *   node offlineLoop.mjs select  --library <library.json|export.json> --task "<text>" [--mode flat|pyramid] [--embed-key-file F]
 *   node offlineLoop.mjs serve   --library <file> [--embed-key-file F]          # stdio JSON lines: {"taskText","mode","removeRoles"}
 *   node offlineLoop.mjs stats   --dir <variant dir>
 * The library builds are driven by `c1/build_library.mjs`.
 * @module offlineLoop
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { METHOD_SIMILARITY_PAIR_FLOOR, toolchainFingerprint, toolchainsMatch } from "@evimed/domain";
import { LearningService } from "../../../apps/server/src/learningService.mjs";
import { MethodConsolidation } from "../../../apps/server/src/methodConsolidation.mjs";
import { MethodDistillationRuns } from "../../../apps/server/src/methodDistillationRuns.mjs";
import { createMethodSimilarity } from "../../../apps/server/src/methodSimilarity.mjs";
import { selectMethodsForTask } from "../../../apps/server/src/learnedMethodMount.mjs";
import { routineLessonFor } from "../../../apps/server/src/learningTriggers.mjs";
import { persistentDocuments } from "./documents.mjs";
import { episodeAsRun, episodeRunId, requestText, storeTranscript, toolNameOf } from "./gameTranscript.mjs";
import { createModelSteps, fakeLearningModel } from "./modelSteps.mjs";
import { createDeepSeekClient } from "../run/deepseek.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const OFFLINE_USER = "c1-offline";
const STEP_MS = 60_000;

/** Which lesson policies exist: every successful episode as a routine lesson, or the product's routine gate (τ = 3, toolchain switch on). */
export const LESSON_GATES = Object.freeze(["every-success", "product"]);

/**
 * @typedef {object} LoopPolicy
 * @property {"library" | "empty"} related  what a lesson is shown as related methods: the library (the product) or nothing ("from zero")
 * @property {"integrate+sleep" | "none"} consolidate  the product's passes, or none (add-only)
 * @property {boolean} pyramid  `OPEN_SCIENCE_METHOD_PYRAMID_ENABLED` for the consolidation's stored levels
 * @property {"immediate" | "after-consolidation"} approve  immediate = the product (a method takes effect when written unless it conflicts);
 *   after-consolidation = selection sees only methods written before the last consolidation pass
 * @property {boolean} officialInLoop  `OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED`, with `officialSet` as the account's official methods
 */

/** @type {LoopPolicy} */
export const DEFAULT_POLICY = Object.freeze({ related: "library", consolidate: "integrate+sleep", pyramid: true, approve: "immediate", officialInLoop: false });

/** The knowledge base's embedder from a key file and the pin in deps-version.json, as `evals/follow-up-judge/run.mjs` builds it. @param {string} keyFile */
export async function embedderFrom(keyFile) {
  const { KbEmbedder } = await import(pathToFileURL(path.resolve(here, "../../../apps/server/src/kbEmbedding.mjs")).href);
  const pin = JSON.parse(await readFile(path.resolve(here, "../../../deps-version.json"), "utf8")).openviking?.embedding ?? {};
  const embedder = new KbEmbedder({ apiKey: (await readFile(keyFile, "utf8")).trim(), model: String(pin.model ?? ""), dimension: Number(pin.dimension ?? 1024), apiBase: String(pin.apiBase ?? ""), timeoutMs: 30_000 });
  return { embed: (/** @type {string[]} */ texts) => embedder.embedDocuments(texts), model: String(pin.model ?? "") };
}

/** @param {string} file @param {any} value */
async function writeJson(file, value) {
  await writeFile(`${file}.tmp`, `${JSON.stringify(value)}\n`);
  await rename(`${file}.tmp`, file);
}

/** The learned-method documents a saved library holds (a `library.json` state or an export). @param {any} saved */
export function libraryDocuments(saved) {
  if (Array.isArray(saved?.methods)) return saved.methods;
  return (saved?.documents?.rows ?? [])
    .filter((/** @type {any} */ row) => row.kind === "method" && !row.deletedAt && row.payload?.recordType === "learned-method")
    .map((/** @type {any} */ row) => ({ id: row.id, revision: row.revision, createdAt: row.createdAt, payload: row.payload }));
}

/**
 * The cards a C1 episode is given, by the product's selection, in the shape `c1/loop.py` reads (`JsonSkillProvider`: name, level, when,
 * body, depends_on) plus why each was mounted. `level` is `abstract` for an abstract method (role, or level 2 and above) and `atomic`
 * otherwise; `role` and `levelNumber` are the product's own.
 * @param {{ library: readonly any[], taskText: string, mode: "flat" | "pyramid", similarity: any, removeRoles?: readonly string[],
 *   visibleBefore?: string | null, minSimilarity?: number, cardEvidence?: boolean }} input
 */
export async function selectCards({ library, taskText, mode, similarity, removeRoles = [], visibleBefore = null, minSimilarity = 0, cardEvidence = false }) {
  const removed = new Set(removeRoles);
  const documents = library.filter((document) => !removed.has(String(document.payload?.frontmatter?.metadata?.role ?? ""))
    && (!visibleBefore || String(document.payload?.bodyUpdatedAt ?? document.payload?.createdAt ?? "") <= visibleBefore));
  const selected = await selectMethodsForTask({ library: documents, taskText,
    options: { similarity, pyramid: mode === "pyramid", minSimilarity, cardEvidence } });
  const byId = new Map(documents.map((document) => [String(document.id), document]));
  return {
    mode: selected.mode,
    topScore: selected.topScore,
    libraryMethods: documents.filter((document) => (document.payload?.status ?? "approved") === "approved").length,
    skills: selected.cards.map((card) => {
      const payload = byId.get(card.id)?.payload ?? {};
      const role = String(payload.frontmatter?.metadata?.role ?? "functional");
      return {
        name: card.name, level: role === "abstract" || card.level >= 2 ? "abstract" : "atomic", role, levelNumber: card.level,
        when: String(payload.frontmatter?.whenToUse ?? ""), description: String(payload.frontmatter?.description ?? ""),
        body: String(payload.body ?? ""), depends_on: (payload.dependencies ?? []).map((/** @type {any} */ dependency) => String(dependency.name)),
        reason: card.reason, digest: card.digest,
      };
    }),
  };
}

export class OfflineLoop {
  /**
   * @param {{ dir: string, env: string, variant?: string, policy?: Partial<LoopPolicy>, model: any, embed?: ((texts: string[]) => Promise<number[][]>) | null,
   *   embedModel?: string | null, cacheDir?: string | null, officialSet?: readonly any[], maxAttempts?: number }} options
   */
  static async open(options) {
    const loop = new OfflineLoop(options);
    await loop.#load();
    return loop;
  }

  /** @param {Parameters<typeof OfflineLoop.open>[0]} options */
  constructor({ dir, env, variant = "", policy = {}, model, embed = null, embedModel = null, cacheDir = null, officialSet = [], maxAttempts = 3 }) {
    this.dir = dir;
    this.env = env;
    this.variant = variant;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.model = model;
    this.embed = embed;
    this.embedModel = embedModel;
    this.cacheDir = cacheDir ?? path.join(dir, "cache");
    this.officialSet = officialSet;
    this.maxAttempts = maxAttempts;
    this.statePath = path.join(dir, "library.json");
    this.statusPath = path.join(dir, "STATUS");
    /** @type {any[]} jobs the product's code queued and this loop drains */
    this.queue = [];
  }

  async #load() {
    await mkdir(this.dir, { recursive: true });
    const saved = await readFile(this.statePath, "utf8").then(JSON.parse).catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
    if (saved && (saved.env !== this.env || JSON.stringify(saved.policy) !== JSON.stringify(this.policy))) {
      throw new Error(`The library at ${this.statePath} was built for another environment or policy; use a new directory.`);
    }
    this.state = saved ?? { schema: "c1-offline-library/1", env: this.env, variant: this.variant, policy: this.policy, clock: Date.parse("2026-11-10T00:00:00.000Z"),
      steps: {}, runs: {}, lastConsolidatedAt: null, counters: {}, similarity: { requested: this.embed ? "embedding" : "lexical", embedModel: this.embedModel } };
    this.documents = persistentDocuments(saved?.documents ?? null);
    /** @type {Record<string, number>} */
    this.usageBase = { ...(saved?.modelUsage ?? {}) };
    const now = () => new Date(this.state.clock);
    this.learning = new LearningService({ documents: this.documents, now });
    const official = this.policy.officialInLoop ? async () => this.officialSet : null;
    if (official) this.learning.officialMethods = official;
    this.similarity = createMethodSimilarity({ embed: this.embed, logger: { warn: (message) => process.stderr.write(`${message}\n`) } });
    this.steps = createModelSteps({ model: this.model, cacheDir: this.cacheDir, callsLog: path.join(this.dir, "calls.jsonl"), label: `${this.env}/${this.variant}`, maxAttempts: this.maxAttempts });
    const jobs = { enqueue: async (/** @type {string} */ userId, /** @type {string} */ kind, /** @type {any} */ payload, /** @type {any} */ opts = {}) => {
      this.queue.push({ userId, kind, payload, idempotencyKey: opts.idempotencyKey ?? null });
      return { id: `job-${this.queue.length}` };
    } };
    // "From zero": the lesson is shown no related method; every other read and write goes to the real library.
    const learning = this.learning;
    const distillerLearning = this.policy.related === "empty"
      ? new Proxy(learning, { get: (target, key) => (key === "listMethods" ? async () => ({ items: [], nextCursor: null }) : (typeof target[key] === "function" ? target[key].bind(target) : target[key])) })
      : learning;
    this.distillation = new MethodDistillationRuns({
      dispatch: this.steps.dispatch, readResult: this.steps.readResult, learning: distillerLearning, jobs, similarity: this.similarity,
      resolveRun: async (_project, runId) => this.state.runs[runId] ?? null,
      officialMethods: this.policy.related === "empty" ? null : official,
    });
    this.consolidation = new MethodConsolidation({
      dispatch: this.steps.dispatch, readResult: this.steps.readResult, learning, jobs, similarity: this.similarity, now,
      wait: async () => {}, pyramid: this.policy.pyramid === true, officialMethods: official,
    });
    this.project = { id: `c1-${this.env}`, userId: OFFLINE_USER, rootDir: path.join(this.dir, "project"),
      metaDir: path.join(this.dir, "project", ".openscience"), workspaceDir: path.join(this.dir, "project", "workspace") };
    await mkdir(this.project.metaDir, { recursive: true });
  }

  /** @param {string} key @param {number} [by] */
  #count(key, by = 1) { this.state.counters[key] = (this.state.counters[key] ?? 0) + by; }

  async #save(stepId, summary) {
    this.state.steps[stepId] = summary;
    this.state.documents = this.documents.snapshot();
    // What this process spent, on top of what the saved library had already spent before a restart.
    this.state.modelUsage = Object.fromEntries(Object.entries(this.steps.usage).map(([key, value]) => [key, (this.usageBase[key] ?? 0) + value]));
    this.state.similarityStats = this.similarity.stats();
    await writeJson(this.statePath, this.state);
    await appendFile(this.statusPath, `${new Date().toISOString()} ${stepId} ${JSON.stringify(summary)}\n`);
  }

  /** Whether a step is already in the saved library. @param {string} stepId */
  done(stepId) { return Object.hasOwn(this.state.steps, stepId); }

  /** Register an episode as a run of this offline project, with its transcript on disk. @param {any} record */
  async registerEpisode(record) {
    const { run, transcript } = episodeAsRun(record, { finishedAt: new Date(this.state.clock).toISOString() });
    await storeTranscript(this.project, transcript);
    this.state.runs[run.id] = this.state.runs[run.id] ?? run;
    return this.state.runs[run.id];
  }

  /**
   * One lesson: the product's `execute` for a `routine` job over `record` and its `peers`, then the queued integrate jobs.
   * A failure of the step (the contract never passed, the store refused the method) is recorded and not retried.
   * @param {{ record: any, peers?: readonly any[], stepId: string }} input
   */
  async distill({ record, peers = [], stepId }) {
    if (this.done(stepId)) return this.state.steps[stepId];
    this.state.clock += STEP_MS;
    const run = await this.registerEpisode(record);
    const peerRuns = [];
    for (const peer of peers) peerRuns.push(await this.registerEpisode(peer));
    const job = { id: `distill:${run.id}:routine`, userId: OFFLINE_USER, projectId: this.project.id,
      payload: { runId: run.id, trigger: "routine", scope: this.env, capabilityId: this.env, peers: peerRuns.map((peer) => ({ runId: peer.id, projectId: null })) } };
    const usageBefore = { ...this.steps.usage };
    /** @type {any} */
    let summary;
    try {
      const result = await this.distillation.execute({ job, project: this.project, run, feedback: [] });
      summary = { kind: "distill", taskId: record.taskId, runId: run.id, peers: peerRuns.map((peer) => peer.id), state: result.state, operation: result.operation ?? null,
        methodId: result.methodId ?? null, skipped: result.skipped ?? null };
      this.#count(`operation:${result.operation ?? "none"}`);
    } catch (error) {
      summary = { kind: "distill", taskId: record.taskId, runId: run.id, peers: peerRuns.map((peer) => peer.id), state: "error",
        code: String(/** @type {any} */ (error)?.code ?? "error"), message: String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].slice(0, 300) };
      this.#count(`error:${summary.code}`);
    }
    summary.integrate = await this.#drain({ sleep: false });
    summary.modelCalls = this.steps.usage.calls - usageBefore.calls;
    summary.tokens = (this.steps.usage.promptTokens - usageBefore.promptTokens) + (this.steps.usage.completionTokens - usageBefore.completionTokens);
    await this.#save(stepId, summary);
    return summary;
  }

  /** Run the queued jobs the policy runs: `integrate` (unless no consolidation), and `sleep` only when asked. @param {{sleep: boolean}} options */
  async #drain({ sleep }) {
    const outcomes = [];
    while (this.queue.length) {
      const job = this.queue.shift();
      if (job.kind !== "consolidate") continue;
      const action = job.payload?.action;
      if (action === "replay") { this.#count("replay:not_composed"); continue; }
      if (this.policy.consolidate === "none") { this.#count(`skipped:${action}`); continue; }
      if (action === "sleep") { this.state.sleepDue = true; if (!sleep) continue; }
      if (action === "integrate") {
        try {
          const result = await this.consolidation.integrate({ job: { id: job.idempotencyKey ?? `integrate:${outcomes.length}`, userId: OFFLINE_USER, projectId: this.project.id, payload: job.payload } });
          outcomes.push({ action, methodId: job.payload.methodId, neighbours: result.neighbours, relations: result.relations, builds: result.builds, noop: result.noop });
          this.#count("integrate:runs");
          this.#count("integrate:builds", Number(result.builds) || 0);
        } catch (error) {
          outcomes.push({ action, methodId: job.payload.methodId, error: String(/** @type {any} */ (error)?.code ?? error) });
          this.#count("integrate:errors");
        }
      }
    }
    return outcomes;
  }

  /** One consolidation pass over the whole library (`MethodConsolidation.sleep`), unless the policy has none. @param {{stepId: string}} input */
  async consolidate({ stepId }) {
    if (this.done(stepId)) return this.state.steps[stepId];
    if (this.policy.consolidate === "none") return null;
    this.state.clock += STEP_MS;
    await this.#drain({ sleep: true });
    const usageBefore = { ...this.steps.usage };
    /** @type {any} */
    let summary;
    try {
      const result = await this.consolidation.sleep({ job: { id: stepId, userId: OFFLINE_USER, projectId: this.project.id, payload: { action: "sleep" } } });
      summary = { kind: "sleep", methods: result.methods, shortlist: result.shortlist, groupsFormed: result.groupsFormed, groups: result.groups, relations: result.relations,
        relationTypes: result.relationTypes, builds: result.builds, refusals: (result.refusals ?? []).length, promoted: (result.promoted ?? []).length,
        stopped: result.stopped ?? [], levels: result.levels, graphIssues: result.graphIssues, noop: result.noop };
      this.#count("sleep:runs");
      this.#count("sleep:builds", Number(result.builds) || 0);
    } catch (error) {
      summary = { kind: "sleep", state: "error", code: String(/** @type {any} */ (error)?.code ?? "error"), message: String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].slice(0, 300) };
      this.#count("sleep:errors");
    }
    // A pass writes candidates and amendments of its own, which queue integrate jobs: the product's worker runs those too.
    summary.integrate = await this.#drain({ sleep: false });
    summary.modelCalls = this.steps.usage.calls - usageBefore.calls;
    this.state.sleepDue = false;
    this.state.lastConsolidatedAt = new Date(this.state.clock).toISOString();
    await this.#save(stepId, summary);
    return summary;
  }

  /** The library's documents as they stand. */
  async methods() {
    return (await this.learning.listMethods(OFFLINE_USER, { limit: 100 })).items ?? [];
  }

  /** @param {{ taskText: string, mode?: "flat" | "pyramid", removeRoles?: string[] }} input */
  async select({ taskText, mode = "pyramid", removeRoles = [] }) {
    return selectCards({ library: await this.methods(), taskText, mode, similarity: this.similarity, removeRoles,
      visibleBefore: this.policy.approve === "after-consolidation" ? (this.state.lastConsolidatedAt ?? "") : null });
  }

  /**
   * Which earlier clean (successful) episodes a lesson about `record` is induced across, and whether the product's own routine gate would
   * have fired: `routineLessonFor` with the toolchain switch on (file-free work: tool-bigram match at `toolchainMinSimilarity` and a request
   * similarity at the pair floor), the request similarity read the way `LearningEvidence` reads it (`similarity.nearest`, floor
   * `METHOD_SIMILARITY_PAIR_FLOOR`). Peers are the two nearest by request similarity, toolchain matches first.
   * @param {any} record @param {readonly any[]} earlier successful episodes of this environment, oldest first
   * @param {{ toolchainMinSimilarity?: number }} [options]
   */
  async lessonFor(record, earlier, { toolchainMinSimilarity = 0.8 } = {}) {
    const fingerprint = (/** @type {any} */ episode) => toolchainFingerprint([{ steps: (episode.steps ?? []).filter((/** @type {any} */ step) => step?.action).map((/** @type {any} */ step) => ({ tool: toolNameOf(step.action) })) }]);
    const toolchain = fingerprint(record);
    const documents = earlier.map((episode) => ({ id: episodeRunId(episode), payload: { frontmatter: { description: requestText(episode) } }, episode }));
    /** @type {Map<string, number>} */
    const scores = new Map();
    if (documents.length) {
      const hits = await this.similarity.nearest(requestText(record), documents, { limit: documents.length, minScore: 0 });
      for (const hit of hits) scores.set(hit.method.id, Number(hit.score));
      this.state.similarity.lastMode = hits.mode;
    }
    const family = documents.map((document) => ({ runId: document.id, projectId: null, shape: [], toolchain: fingerprint(document.episode),
      requestSimilarity: (scores.get(document.id) ?? 0) >= METHOD_SIMILARITY_PAIR_FLOOR ? scores.get(document.id) : 0 }));
    const gate = routineLessonFor({ run: { id: episodeRunId(record) }, scope: this.env, shape: [], family, toolchain, toolchainEnabled: true, minSimilarity: toolchainMinSimilarity });
    const ranked = documents.map((document) => ({ episode: document.episode, score: scores.get(document.id) ?? 0,
      toolchain: toolchainsMatch(fingerprint(document.episode), toolchain, { minSimilarity: toolchainMinSimilarity }) }))
      .sort((left, right) => Number(right.toolchain) - Number(left.toolchain) || right.score - left.score);
    const productPeers = gate ? new Set(gate.payload.peers.map((/** @type {any} */ peer) => peer.runId)) : null;
    return {
      productGate: Boolean(gate),
      productPeers: productPeers ? earlier.filter((episode) => productPeers.has(episodeRunId(episode))) : [],
      nearestPeers: ranked.slice(0, 2).map((entry) => entry.episode),
    };
  }

  /** Library statistics: counts by status, role and level, relations by type, what the steps did, and the model's cost. */
  async stats() {
    const methods = await this.methods();
    /** @param {(item: any) => string} key @param {readonly any[]} items */
    const tally = (key, items) => items.reduce((counts, item) => { const name = key(item); counts[name] = (counts[name] ?? 0) + 1; return counts; }, /** @type {Record<string, number>} */ ({}));
    const live = methods.filter((method) => method.payload?.status !== "retired");
    const relations = live.flatMap((method) => method.payload?.learning?.relations ?? []);
    const steps = Object.values(this.state.steps);
    return {
      env: this.env, variant: this.variant, policy: this.policy,
      methods: methods.length, byStatus: tally((method) => String(method.payload?.status), methods),
      byRole: tally((method) => String(method.payload?.frontmatter?.metadata?.role ?? "none"), live),
      byLevel: tally((method) => String(method.payload?.learning?.level ?? 0), live),
      relationsByType: tally((relation) => String(relation.type), relations),
      withDependencies: live.filter((method) => (method.payload?.dependencies ?? []).length).length,
      consolidated: live.filter((method) => String(method.payload?.provenance?.consolidatedBy ?? "").startsWith("consolidate:")).length,
      amended: live.filter((method) => Number(method.payload?.bodyVersion ?? 1) > 1).length,
      lessons: steps.filter((step) => step.kind === "distill").length,
      operations: tally((step) => String(step.operation ?? step.state), steps.filter((step) => step.kind === "distill")),
      sleeps: steps.filter((step) => step.kind === "sleep").length,
      counters: this.state.counters,
      modelUsage: this.state.modelUsage ?? null,
      similarity: { ...this.state.similarity, stats: this.similarity.stats() },
    };
  }

  /** The library as an arm reads it: the documents and the statistics. @param {string} file */
  async exportTo(file) {
    const value = { schema: "c1-library-export/1", env: this.env, variant: this.variant, policy: this.policy, lastConsolidatedAt: this.state.lastConsolidatedAt,
      stats: await this.stats(), methods: (await this.methods()).map((document) => ({ id: document.id, revision: document.revision, createdAt: document.createdAt, payload: document.payload })) };
    await writeJson(file, value);
    return value;
  }
}

/** A model client for the learning steps: DeepSeek direct, or the fake one. @param {{dryRun?: boolean, keyFile?: string, thinking?: "enabled" | "disabled"}} options */
export function learningModel({ dryRun = false, keyFile = "/srv/evimed/secrets/deepseek.api-key", thinking = "enabled" } = {}) {
  return dryRun ? fakeLearningModel() : createDeepSeekClient({ keyFile, model: "deepseek-flash", thinking, timeoutMs: 600_000, maxRetries: 5 });
}

/* ---------------------------------------------------------------------------------------------------------------------------- CLI */

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[flag.slice(2)] = true;
    else { options[flag.slice(2)] = next; index += 1; }
  }
  return options;
}

/** A library file read for selection, reloaded when it changes on disk (the evolving arm). @param {string} file @param {any} similarity */
function libraryReader(file) {
  /** @type {{ mtimeMs: number, documents: any[], visibleBefore: string | null } | null} */
  let held = null;
  return async () => {
    const info = await stat(file);
    if (!held || held.mtimeMs !== info.mtimeMs) {
      const saved = JSON.parse(await readFile(file, "utf8"));
      const approve = saved.policy?.approve ?? "immediate";
      held = { mtimeMs: info.mtimeMs, documents: libraryDocuments(saved), visibleBefore: approve === "after-consolidation" ? (saved.lastConsolidatedAt ?? "") : null };
    }
    return held;
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  const embedder = typeof options["embed-key-file"] === "string" ? await embedderFrom(String(options["embed-key-file"])) : null;
  const similarity = createMethodSimilarity({ embed: embedder?.embed ?? null, logger: { warn: (message) => process.stderr.write(`${message}\n`) } });
  if (command === "select" || command === "serve") {
    const read = libraryReader(String(options.library));
    /** @param {any} request */
    const answer = async (request) => {
      const { documents, visibleBefore } = await read();
      const result = await selectCards({ library: documents, taskText: String(request.taskText ?? ""), mode: request.mode === "flat" ? "flat" : "pyramid",
        similarity, removeRoles: Array.isArray(request.removeRoles) ? request.removeRoles : [], visibleBefore });
      return { ...result, similarityMode: result.mode, embedModel: embedder?.model ?? null };
    };
    if (command === "select") {
      process.stdout.write(`${JSON.stringify(await answer({ taskText: options.task, mode: options.mode, removeRoles: String(options["remove-roles"] ?? "").split(",").filter(Boolean) }))}\n`);
      return;
    }
    const lines = readline.createInterface({ input: process.stdin });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { process.stdout.write(`${JSON.stringify({ ok: true, ...(await answer(JSON.parse(line))) })}\n`); }
      catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, error: String(/** @type {any} */ (error)?.message ?? error).split("\n")[0].slice(0, 300) })}\n`); }
    }
    return;
  }
  if (command === "stats") {
    const saved = JSON.parse(await readFile(path.join(String(options.dir), "library.json"), "utf8"));
    const loop = await OfflineLoop.open({ dir: String(options.dir), env: saved.env, variant: saved.variant, policy: saved.policy, model: fakeLearningModel() });
    process.stdout.write(`${JSON.stringify(await loop.stats(), null, 2)}\n`);
    return;
  }
  throw new Error("Usage: offlineLoop.mjs select|serve|stats ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${String(error?.message ?? error).split("\n")[0]}\n`); process.exit(1); });
}
