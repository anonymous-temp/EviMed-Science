/**
 * The independent reviewer, as a control-plane module (plan 2026-09-22,
 * tiered review and in-place repair).
 *
 * Hidden knowledge: why a second pass works, and why this is built the way it
 * is. A second pass improves a draft when it brings four things the first did
 * not have (plan §1): a reviewer of another family that is not weaker than
 * the writer; a clean context; deterministic checks over every reference and
 * number rather than a sample; and findings that say where, coupled back into
 * the writer's own loop. The in-kernel reviewer this replaces had one and a
 * half of the four — a fresh context, and search tools on a forty-claim
 * sample — and ran on the writer's own model: on the 2026-09-22 review it
 * called a log odds ratio of 0.73 (0.46–1.00) 「跨越无效线」, which the log scale
 * says it does not.
 *
 * What this module does:
 *
 * - **L2/L3 — a submitted deliverable.** The run's submission asks the review
 *   gateway (`reviewGateway.mjs`) to start a review and polls for it. Here,
 *   the package is read from the workspace as the gate reads it; every
 *   reference is asked of the registries; an engine report's stated results
 *   are traced to the engine's own output; then Qwen3.8-Max reads the package
 *   as an outside submission, with the reporting checklist for its kind and
 *   the brief's own acceptance items, and answers with located findings. Code
 *   keeps a finding only if the words it rests on are in the package or in
 *   the source excerpts it was shown. The writer answers each finding —
 *   fixed, or declined with a reason — and those answers are the ledger a
 *   kind is later promoted or demoted by. Nothing here withholds a delivery.
 * - **L1 — a cited or medicine-naming conversation reply.** After the turn has
 *   ended and been shown, each cited sentence is judged against what its
 *   source actually says (the abstract the registry holds, never what the
 *   reply says the source says), and the verdicts become a row under the
 *   answer. A medicine claim the source contradicts also reaches the
 *   researcher's inbox, and the chat it came from.
 *
 * What it never does: write a file, rewrite a reply, block a turn, or decide
 * a delivery. The reviewer's inputs — this prompt, the checklists, the
 * thresholds — live in the control plane, where a run cannot read them
 * (plan §5 rule 6, memory: runtime-can-read-the-gate).
 *
 * @module reviewService
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  REPLY_CHECK_OUTPUT_SCHEMA,
  REPLY_CHECK_WARNING_VERDICTS,
  REVIEW_ANSWER_REQUIRED_KINDS,
  REVIEW_EDITOR_OUTPUT_SCHEMA,
  REVIEW_FINDING_KIND_LABELS_ZH,
  acceptEditorChecks,
  acceptEditorFindings,
  acceptReplyVerdicts,
  acceptReviewResponses,
  clinicalSafetyCautionHits,
  deliverableReviewTier,
  evidenceLocated,
  numericTraceFindings,
  outputNumbers,
  referenceEntries,
  referenceLookups,
  referenceResolutionFindings,
  replyCheckCounts,
  replyCitedSentences,
  replyReviewTier,
  reviewSeverity,
  statConsistencyFindings,
} from "@evimed/domain";
import { callReviewModel, ReviewModelError } from "./reviewModel.mjs";
import { migrateReview } from "./reviewPersistence.mjs";
import { createReferenceResolver } from "./referenceResolver.mjs";
import { openScopedFileNoFollow } from "./security.mjs";

/** The reporting checklists, by contract kind (data a methodologist edits). */
const CHECKLISTS = JSON.parse(fs.readFileSync(new URL("./reviewChecklists.json", import.meta.url), "utf8"));

const DELIVERABLES_DIR = "deliverables";
const SOURCES_DIR = ".evimed-sources";
const MATRIX_FILE = "clinical-evidence-matrix.json";
/** One workspace file the reviewer reads, at most. */
const FILE_LIMIT_BYTES = 4 * 1024 * 1024;
/** Characters of the package the editor is shown; past it, prose is cut and the editor told. */
const PACKAGE_CHAR_LIMIT = 160_000;
/** Claims the editor is shown with their sources. */
const CLAIM_LIMIT = 160;
/** Preserved sources read for the claims' excerpts. */
const SOURCE_FILE_LIMIT = 80;
/** Characters of source on either side of a quote. */
const EXCERPT_RADIUS = 300;
/** Files of an engine job's output read for numbers, and their total bytes. */
const JOB_FILE_LIMIT = 80;
const JOB_BYTES_LIMIT = 12 * 1024 * 1024;
/** Editor calls in flight across the control plane. */
const EDITOR_CONCURRENCY = 3;
/** A deliverable id, a claim id — the closed shapes the gateway accepts. */
const DELIVERABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Engine output directories by job-id prefix (`deploy/specialist-adapter`, `meta_agent.py`). */
const ENGINE_JOB_DIRECTORIES = Object.freeze({
  "mr-": "mendelian-randomization-runs",
  "bibliometric-": "bibliometric-analysis-runs",
  "topic-": "research-topic-runs",
  "review-": "peer-review-runs",
  "safety-": "drug-safety-runs",
  "meta-": "meta-analysis-runs",
});
const JOB_ID = /\b(mr|bibliometric|topic|review|safety|meta)-[a-z0-9-]{8,80}\b/g;

/** The pause before the editor's one retry; long enough to outlast a brief network drop. */
const EDITOR_RETRY_DELAY_MS = 5_000;

/** The order findings are shown in: what a reader must see first, first. */
const KIND_ORDER = ["safety", "reference_unresolvable", "contradiction", "stat_inconsistent", "number_untraced", "reference_mismatch", "overclaim", "interpretation", "weak_support", "missing_item", "structure", "wording"];

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** A short random id with a prefix. @param {string} prefix */
function newId(prefix) {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** A tiny counting semaphore. @param {number} limit */
function semaphore(limit) {
  let active = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  return {
    /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
    async run(work) {
      if (active >= limit) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
      active += 1;
      try {
        return await work();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
    get active() { return active; },
    get queued() { return waiting.length; },
  };
}

/**
 * The excerpt of a preserved source around the quote a claim cites, or the
 * source's opening when the quote cannot be found (the gate says so on its own).
 * @param {string} source @param {string} quote
 */
function excerptAround(source, quote) {
  const text = String(source ?? "");
  const wanted = String(quote ?? "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  for (const probe of [wanted.slice(0, 60), wanted.slice(0, 30), wanted.slice(0, 15)]) {
    const needle = probe.trim().toLowerCase();
    if (needle.length < 8) continue;
    const at = lower.indexOf(needle);
    if (at >= 0) {
      const start = Math.max(0, at - EXCERPT_RADIUS);
      const end = Math.min(text.length, at + wanted.length + EXCERPT_RADIUS);
      return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    }
  }
  return `${text.slice(0, EXCERPT_RADIUS * 2)}${text.length > EXCERPT_RADIUS * 2 ? "…" : ""}`;
}

/** The checklist items for a contract kind. @param {string} contractKind */
export function checklistFor(contractKind) {
  const ids = Array.isArray(CHECKLISTS.byContractKind?.[contractKind]) ? CHECKLISTS.byContractKind[contractKind] : [];
  return ids.flatMap((/** @type {string} */ id) => {
    const list = CHECKLISTS.checklists?.[id];
    if (!list) return [];
    return (Array.isArray(list.items) ? list.items : []).map((/** @type {any} */ item) => ({ id: String(item.id), text: String(item.text), list: String(list.title) }));
  });
}

/**
 * The system prompt of the editor. Short and stable (principle 16): the role,
 * the rules its answer is held to, the vocabulary. Everything about this
 * package is in the user message.
 * @param {{ safety: boolean, pass: number }} input
 */
export function editorSystemPrompt({ safety, pass }) {
  return [
    "你是独立的同行编辑，审阅一份外部提交的研究交付物。你没有看过产出它的过程；不要重建它，也不要替它辩护。只依据提交的文件、给你的来源摘录和确定性核验结果判断。",
    "",
    "按给定 JSON 结构回答：",
    "- findings：每条是一个具体缺陷。location 写论断编号（CLM-012）、参考文献编号（[7]）、章节标题或清单条目号；evidence 是你依据的原文，必须从提交内容或来源摘录里逐字复制——不改字、不翻译、不概括、不拼接；给不出原文的问题不要写。fix 用中文写一句可执行的最小改法，不要重写整段。",
    "- kind：contradiction（论断与其来源相反）、weak_support（来源对论断的支持弱于写法）、overclaim（结论强于证据，如相关写成因果、不显著写成有效、单项研究写成定论）、interpretation（统计或结果解读错误：效应方向、置信区间与 P 值、指标尺度、检验适用性）、missing_item（缺少清单或验收项要求的内容）、structure（结构问题）、wording（易误导的措辞）" + (safety ? "、safety（剂量、禁忌、相互作用、监测等用药安全方面的错误或遗漏）" : "") + "。",
    "- 只报告有原文依据的问题，宁缺毋滥，最多 25 条，按严重程度排序。确定性核验已经报告的问题不要重复。",
    "- fix 里引用词句用「」，不要用英文双引号——它会提前结束 JSON 字符串，后面写的内容会丢失。evidence 只放原文本身，不加引号、不加「报告原文：」之类的标签；要把报告和来源对照着给，就各占一行。原文里本身带英文双引号时，按 JSON 规则写成 \\\"。",
    "- checklist：对给出的每个清单条目回答 present / absent / not_applicable；present 时在 evidence 里逐字复制报告中对应的原文，其余留空。缺的条目在这里答 absent 就够了，不要再写成 findings。",
    "- acceptance：对每条验收项回答 met；met 为 true 时在 evidence 里逐字复制满足它的原文。",
    pass > 1 ? "- 这是作者修改后的第二轮：先看上一轮的发现和作者的回应。只报告仍未解决且作者没有给出合理理由的问题，以及改动处新出现的问题；不要重提已解决或作者已合理说明的问题。" : "",
  ].filter(Boolean).join("\n");
}

/**
 * @typedef {object} ReviewIdentity
 * @property {string} userId
 * @property {string} projectId
 */

export class ReviewService {
  /**
   * @param {{
   *   config: Record<string, any>, database: any, usageLedger?: any, runtimeManager?: any, store: any,
   *   agentRegistry?: Promise<any> | any, attributeRun?: (input: { userId: string, projectId: string, sessionId?: string | null }) => Promise<string | null>,
   *   notifications?: any, imService?: any, webReader?: any, fetchImpl?: typeof fetch, referenceResolver?: any,
   *   report?: (code: string, detail?: string) => void, now?: () => Date, retryDelayMs?: number,
   * }} deps
   */
  constructor({ config, database, usageLedger = null, runtimeManager = null, store, agentRegistry = null, attributeRun = async () => null,
    notifications = null, imService = null, webReader = null, fetchImpl = globalThis.fetch, referenceResolver = null, report = () => {}, now = () => new Date(),
    retryDelayMs = EDITOR_RETRY_DELAY_MS }) {
    this.config = config;
    this.retryDelayMs = retryDelayMs;
    this.database = database;
    this.usageLedger = usageLedger;
    this.runtimeManager = runtimeManager;
    this.store = store;
    this.agentRegistry = agentRegistry;
    this.attributeRun = attributeRun;
    this.notifications = notifications;
    this.imService = imService;
    this.fetchImpl = fetchImpl;
    this.report = report;
    this.now = now;
    this.resolver = referenceResolver ?? createReferenceResolver({
      fetchImpl,
      timeoutMs: Number(config.reviewReferenceTimeoutMs ?? 8_000),
      ncbiApiKey: String(config.publicSourceCredentials?.ncbi ?? ""),
      webReader,
    });
    this.editors = semaphore(EDITOR_CONCURRENCY);
    /** @type {Map<string, Promise<void>>} */
    this.running = new Map();
    this.counts = {
      reviewsStarted: 0, reviewsDone: 0, reviewsFailed: 0, editorCalls: 0, editorRetries: 0, editorFailures: 0,
      /** @type {Record<string, number>} */ findings: {}, /** @type {Record<string, number>} */ dropped: {},
      /** @type {Record<string, number>} */ responses: {}, replyChecks: 0, replyFailures: 0,
      /** @type {Record<string, number>} */ replyVerdicts: {}, safetyAlerts: 0,
    };
    /** @type {string | null} */
    this.lastError = null;
  }

  /** Whether the module is switched on and can reach its store. */
  get enabled() {
    return Boolean(this.config.reviewEnabled && this.database);
  }

  /** Whether the reviewer has a key to call its model with. */
  get configured() {
    return Boolean(String(this.config.dashscopeApiKey ?? ""));
  }

  /** The schema, and runs a restart interrupted marked as such. */
  async ready() {
    if (!this.database) return;
    await migrateReview(this.database);
    await this.database.query(`UPDATE evimed_review.reviews SET status='failed', error_code='review_interrupted', finished_at=clock_timestamp()
      WHERE status='running' AND created_at < clock_timestamp() - make_interval(secs => $1)`, [Math.ceil(Number(this.config.reviewEditorTimeoutMs ?? 900_000) / 1000) + 60]);
    await this.database.query(`UPDATE evimed_review.reply_checks SET status='queued', lease_owner=NULL, lease_until=NULL
      WHERE status='running' AND lease_until < clock_timestamp()`);
  }

  /* ------------------------------------------------------------ L2 / L3 */

  /**
   * Start the review of one submitted deliverable.
   * @param {ReviewIdentity} identity
   * @param {{ runId?: string, sessionId?: string, deliverableId: string, contractKind: string, capability?: string, attempt?: number, turn?: number, acceptance?: string[], editor?: boolean }} input
   * @returns {Promise<{ reviewId: string, status: 'running' } | { status: 'skipped', reason: string }>}
   */
  async startDeliverableReview(identity, input) {
    const tier = deliverableReviewTier(input.contractKind);
    if (!tier.tier) return { status: "skipped", reason: "review_kind_unreviewed" };
    const user = await this.store.userById(identity.userId);
    if (!user) throw Object.assign(new Error("The workload's user no longer exists."), { status: 401, code: "evimed_workload_token_invalid" });
    const project = await this.store.requireProject(user, identity.projectId);
    await migrateReview(this.database);
    const socketRunId = clip(input.runId ?? "", 120);
    const sessionId = clip(input.sessionId ?? "", 200);
    const runId = await this.attributeRun({ userId: identity.userId, projectId: identity.projectId, sessionId: sessionId || null }).catch(() => null);
    const previous = await this.database.query(`SELECT id, pass, package_digest, report_text, status, created_at FROM evimed_review.reviews
      WHERE user_id=$1 AND project_id=$2 AND socket_run_id=$3 AND deliverable_id=$4 ORDER BY created_at DESC LIMIT 5`,
    [identity.userId, identity.projectId, socketRunId, input.deliverableId]);
    const id = newId("rv_");
    await this.database.query(`INSERT INTO evimed_review.reviews
      (id,user_id,project_id,run_id,socket_run_id,session_id,deliverable_id,contract_kind,tier,safety,attempt,status,model)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running',$12)`,
    [id, identity.userId, identity.projectId, runId, socketRunId, sessionId, input.deliverableId, input.contractKind, tier.tier, tier.safety,
      Math.max(1, Math.floor(Number(input.attempt) || 1)), this.config.reviewModel]);
    this.counts.reviewsStarted += 1;
    const task = this.#review({ id, identity, project, runId, tier, input, previous: previous.rows })
      .catch(async (error) => {
        this.counts.reviewsFailed += 1;
        this.lastError = error?.code ?? "review_failed";
        this.report("review_failed", String(error?.message ?? error));
        await this.database.query(`UPDATE evimed_review.reviews SET status='failed', error_code=$2, finished_at=clock_timestamp() WHERE id=$1`,
          [id, String(error?.code ?? "review_failed").slice(0, 64)]).catch(() => {});
      })
      .finally(() => this.running.delete(id));
    this.running.set(id, task);
    return { reviewId: id, status: "running" };
  }

  /**
   * One review's state, and its result once done.
   * @param {ReviewIdentity} identity @param {string} reviewId
   */
  async reviewStatus(identity, reviewId) {
    const found = await this.database.query(`SELECT * FROM evimed_review.reviews WHERE id=$1 AND user_id=$2 AND project_id=$3`,
      [reviewId, identity.userId, identity.projectId]);
    const row = found.rows[0];
    if (!row) return null;
    if (row.status === "running") return { reviewId, status: "running" };
    if (row.status === "failed") return { reviewId, status: "failed", code: row.error_code ?? "review_failed" };
    const findings = await this.database.query(`SELECT * FROM evimed_review.findings WHERE review_id=$1 ORDER BY finding_id`, [reviewId]);
    return { reviewId, status: "done", ...publicResult(row, findings.rows) };
  }

  /**
   * A writer's answers to a review's findings.
   * @param {ReviewIdentity} identity @param {{ reviewId: string, answers: unknown }} input
   */
  async recordResponses(identity, { reviewId, answers }) {
    const review = await this.database.query(`SELECT id FROM evimed_review.reviews WHERE id=$1 AND user_id=$2 AND project_id=$3 AND status='done'`,
      [reviewId, identity.userId, identity.projectId]);
    if (!review.rows[0]) return null;
    const findings = await this.database.query(`SELECT finding_id AS id, kind FROM evimed_review.findings WHERE review_id=$1`, [reviewId]);
    const { answers: accepted, refused } = acceptReviewResponses(answers, findings.rows);
    for (const answer of accepted) {
      await this.database.query(`UPDATE evimed_review.findings SET response=$3, response_reason=$4, responded_at=clock_timestamp()
        WHERE review_id=$1 AND finding_id=$2`, [reviewId, answer.id, answer.response, answer.reason || null]);
      const kind = findings.rows.find((/** @type {any} */ row) => row.id === answer.id)?.kind ?? "unknown";
      const key = `${kind}:${answer.response}`;
      this.counts.responses[key] = (this.counts.responses[key] ?? 0) + 1;
    }
    return { recorded: accepted.length, refused };
  }

  /**
   * The review of one package: read it, check it, have it edited, keep what
   * can be located.
   * @param {{ id: string, identity: ReviewIdentity, project: any, runId: string | null, tier: { tier: 'L2'|'L3', safety: boolean }, input: Record<string, any>, previous: any[] }} job
   */
  async #review({ id, identity, project, runId, tier, input, previous }) {
    const root = this.runtimeManager?.workspaceRootForDelivery
      ? await this.runtimeManager.workspaceRootForDelivery(project)
      : project.workspaceDir;
    const outputs = await this.#declaredOutputs(input.capability);
    const files = await readDeliverable(root, input.deliverableId, outputs);
    const prose = [...files.entries()].filter(([name]) => name.endsWith(".md"));
    const report = prose.find(([name]) => /report|报告/i.test(name))?.[1] ?? prose[0]?.[1] ?? "";
    const packageText = [...files.entries()].map(([name, text]) => `${name}\n${text}`).join("\n\n");
    const packageDigest = sha256(packageText);

    // Deterministic, full coverage: every reference, every stated result.
    const entries = referenceEntries(report);
    const lookups = referenceLookups(entries);
    const resolved = lookups.dois.length || lookups.pmids.length
      ? await this.resolver.resolve(lookups)
      : { doi: new Map(), pmid: new Map() };
    const references = referenceResolutionFindings(entries, resolved);
    /** @type {{ findings: any[], metrics: any, jobs: string[] }} */
    let numeric = { findings: [], metrics: null, jobs: [] };
    if (tier.tier === "L3" && input.contractKind !== "dataset-scoping-package") {
      const jobs = [...new Set(packageText.match(JOB_ID) ?? [])].slice(0, 4);
      const jobFiles = await readJobOutputs(root, jobs);
      const numbers = outputNumbers(jobFiles);
      const traced = numericTraceFindings({ reportText: report, outputs: numbers, outputLabel: jobs.length ? `作业 ${jobs.join("、")} 的输出` : "引擎输出" });
      numeric = { findings: traced.findings, metrics: { ...traced.metrics, jobFiles: jobFiles.length }, jobs };
    }
    const stats = prose.flatMap(([name, text]) => statConsistencyFindings(text).map((finding) => ({ ...finding, file: name })));

    /** @type {any[]} */
    const codeFindings = [
      ...references.findings.map((finding) => ({ kind: finding.kind, location: finding.location, evidence: finding.evidence, fix: "", message: finding.message })),
      ...numeric.findings.map((finding) => ({ kind: finding.kind, location: finding.location, evidence: finding.evidence, fix: "", message: finding.message })),
    ];

    // The claims and what their sources say around each quote (the
    // clinical evidence report is the one kind with a claim matrix).
    const claims = await claimsWithExcerpts(root, files.get(MATRIX_FILE));
    const checklist = checklistFor(input.contractKind);
    const acceptanceItems = (Array.isArray(input.acceptance) ? input.acceptance : []).map((item) => clip(item, 240)).filter(Boolean).slice(0, 10);

    // The editor: at most `reviewEditorPasses` passes a deliverable, and only
    // over a package that changed since the last one.
    const editorPasses = previous.filter((row) => Number(row.pass) > 0);
    const lastEditor = editorPasses[0] ?? null;
    const changed = !lastEditor || lastEditor.package_digest !== packageDigest;
    const pass = editorPasses.length + 1;
    const editorAllowed = input.editor !== false && this.configured && changed && pass <= Number(this.config.reviewEditorPasses ?? 2);
    /** @type {any[]} */
    let editorFindings = [];
    /** @type {any[]} */
    let dropped = [];
    /** @type {{ checklist: any[], acceptance: any[] }} */
    let checks = { checklist: [], acceptance: [] };
    /** @type {Record<string, any>} */
    let usage = {};
    let cost = 0;
    let model = this.config.reviewModel;
    /** @type {string | null} */
    let editorError = null;
    /** @type {{ open: string[], resolved: string[] }} */
    let carried = { open: [], resolved: [] };
    if (lastEditor) carried = await this.#carriedFindings(lastEditor.id, packageText);
    if (editorAllowed) {
      const previousFindings = lastEditor ? await this.#findingsWithResponses(lastEditor.id) : [];
      const haystacks = [packageText, ...claims.flatMap((claim) => claim.sources.map((/** @type {any} */ source) => source.excerpt))];
      const message = editorMessage({
        contractKind: input.contractKind, deliverableId: input.deliverableId, tier, files, claims, checklist, acceptanceItems,
        deterministic: { references: references.metrics, referenceFindings: references.findings, numeric, stats }, previousFindings,
      });
      const edit = () => this.editors.run(() => callReviewModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId: identity.userId, projectId: identity.projectId, runId,
        messages: [{ role: "system", content: editorSystemPrompt({ safety: tier.safety, pass }) }, { role: "user", content: message }],
        schema: REVIEW_EDITOR_OUTPUT_SCHEMA, schemaName: "review_findings",
        thinking: { enabled: true, budget: Number(this.config.reviewThinkingBudget ?? 8_000) },
        maxTokens: Number(this.config.reviewMaxOutputTokens ?? 24_000),
        timeoutMs: Number(this.config.reviewEditorTimeoutMs ?? 900_000),
      }));
      try {
        this.counts.editorCalls += 1;
        // One retry, for a failure the provider calls transient (a broken
        // stream, a 5xx, a 429, a connection that never opened), after a
        // pause: on 2026-09-23 the dev box lost DashScope for a stretch of
        // five calls, and an immediate retry lands in the same stretch. A
        // timeout or a refusal is not retried: it would fail the same way.
        const answer = await edit().catch(async (error) => {
          if (!(error instanceof ReviewModelError) || !error.retryable) throw error;
          this.counts.editorRetries += 1;
          this.report("review_editor_retry", String(error.message));
          await new Promise((done) => setTimeout(done, this.retryDelayMs));
          return edit();
        });
        const accepted = acceptEditorFindings(answer.value, { haystacks, idPrefix: "E" });
        editorFindings = accepted.findings;
        dropped = accepted.dropped;
        checks = acceptEditorChecks(answer.value, { haystacks, checklistItems: checklist, acceptanceItems });
        usage = answer.usage;
        cost = answer.cost;
        model = answer.model;
      } catch (error) {
        this.counts.editorFailures += 1;
        editorError = error instanceof ReviewModelError ? error.code : "review_editor_failed";
        this.lastError = editorError;
      }
    }

    // One list, ordered for a reader, numbered once.
    const merged = [
      ...codeFindings.map((finding) => ({ ...finding, origin: "code" })),
      ...editorFindings.map((finding) => ({ kind: finding.kind, location: finding.location, evidence: finding.evidence, fix: finding.fix, message: finding.message, origin: "editor" })),
    ].sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
    const numbered = merged.map((finding, index) => ({
      id: `F${String(index + 1).padStart(2, "0")}`,
      kind: finding.kind,
      severity: reviewSeverity(finding.kind),
      origin: finding.origin,
      location: clip(finding.location, 200),
      evidence: clip(finding.evidence, 600),
      fix: clip(finding.fix, 400),
      message: clip(finding.message, 1200),
    }));
    for (const finding of numbered) this.counts.findings[`${finding.origin}:${finding.kind}`] = (this.counts.findings[`${finding.origin}:${finding.kind}`] ?? 0) + 1;
    for (const entry of dropped) this.counts.dropped[entry.reason] = (this.counts.dropped[entry.reason] ?? 0) + 1;

    await this.database.transaction(async (/** @type {any} */ client) => {
      for (const finding of numbered) {
        await client.query(`INSERT INTO evimed_review.findings (review_id,finding_id,kind,severity,origin,location,evidence,fix,message)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, finding.id, finding.kind, finding.severity, finding.origin, finding.location, finding.evidence, finding.fix, finding.message]);
      }
      await client.query(`UPDATE evimed_review.reviews SET status='done', pass=$2, model=$3, package_digest=$4, report_text=$5, deterministic=$6,
          checklist=$7, acceptance=$8, dropped=$9, usage=$10, cost=$11, error_code=$12, finished_at=clock_timestamp() WHERE id=$1`,
      [id, editorAllowed && !editorError ? pass : 0, model, packageDigest, clip(report, 200_000),
        JSON.stringify({
          references: references.metrics,
          numeric: numeric.metrics,
          jobs: numeric.jobs,
          stats: stats.length,
          previous: carried,
          editor: editorAllowed ? (editorError ? "failed" : "done") : (changed ? "skipped" : "unchanged"),
          acceptanceItems,
        }),
        JSON.stringify(checks.checklist), JSON.stringify(checks.acceptance), JSON.stringify(dropped), JSON.stringify(usage), cost, editorError]);
    });
    this.counts.reviewsDone += 1;
  }

  /** The output files a capability declares, from the control plane's own registry. */
  async #declaredOutputs(capabilityId) {
    try {
      const registry = await this.agentRegistry;
      const agent = registry?.get?.(String(capabilityId ?? ""));
      const outputs = Array.isArray(agent?.outputs) ? agent.outputs : [];
      return outputs.map((/** @type {any} */ output) => String(output?.path ?? output ?? "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** A previous review's findings, with what the writer answered. @param {string} reviewId */
  async #findingsWithResponses(reviewId) {
    const rows = await this.database.query(`SELECT finding_id, kind, location, evidence, fix, response, response_reason FROM evimed_review.findings
      WHERE review_id=$1 ORDER BY finding_id`, [reviewId]);
    return rows.rows;
  }

  /**
   * Which of the last pass's findings the new package no longer carries: a
   * finding whose evidence was in the report and is not any more was acted
   * on. One whose evidence is in a source is not decided here.
   * @param {string} reviewId @param {string} packageText
   */
  async #carriedFindings(reviewId, packageText) {
    const rows = await this.#findingsWithResponses(reviewId);
    /** @type {string[]} */
    const open = [];
    /** @type {string[]} */
    const resolved = [];
    for (const row of rows) {
      if (!row.evidence) continue;
      if (evidenceLocated(row.evidence, [packageText])) open.push(row.finding_id);
      else resolved.push(row.finding_id);
    }
    return { open, resolved };
  }

  /**
   * The notices a finished run carries from its reviews: one summary per
   * reviewed deliverable, then each finding that owes an answer and got none.
   * First in the list, so the ledger's forty-notice cap never drops them (it
   * did: the 2026-09-22 review's seven contradictions reached no reader).
   * @param {string} userId @param {string} projectId @param {string} runId
   * @returns {Promise<{ code: string, severity: string, text: string, detail?: string }[]>}
   */
  async reviewNoticesForRun(userId, projectId, runId) {
    if (!this.enabled || !runId) return [];
    const latest = await this.database.query(`SELECT DISTINCT ON (deliverable_id) * FROM evimed_review.reviews
      WHERE user_id=$1 AND project_id=$2 AND run_id=$3 AND status='done' ORDER BY deliverable_id, created_at DESC`, [userId, projectId, runId]);
    /** @type {{ code: string, severity: string, text: string, detail?: string }[]} */
    const notices = [];
    for (const review of latest.rows) {
      const findings = (await this.database.query(`SELECT * FROM evimed_review.findings WHERE review_id=$1 ORDER BY finding_id`, [review.id])).rows;
      const fixed = findings.filter((/** @type {any} */ row) => row.response === "fixed").length;
      const declined = findings.filter((/** @type {any} */ row) => row.response === "declined").length;
      const owed = findings.filter((/** @type {any} */ row) => REVIEW_ANSWER_REQUIRED_KINDS.includes(row.kind) && !row.response);
      const text = findings.length
        ? `独立审查：交付物「${review.deliverable_id}」有 ${findings.length} 条审查发现（已修 ${fixed}，不改并说明 ${declined}，未回应 ${owed.length}）。`
        : `独立审查：交付物「${review.deliverable_id}」没有发现需要处理的问题。`;
      notices.push({ code: "review_summary", severity: "advice", text, detail: text });
      for (const row of owed.slice(0, 8)) {
        notices.push({
          code: `review_${row.kind}`,
          severity: row.kind === "safety" ? "safety" : "advice",
          text: `${row.kind === "safety" ? "SAFETY — " : ""}${row.message}`,
          detail: row.message,
        });
      }
    }
    return notices;
  }

  /**
   * The reviews a run's deliverables got, for the report reader and the
   * delivery card.
   * @param {ReviewIdentity} identity @param {string} runId
   */
  async reviewsForRun(identity, runId) {
    const reviews = await this.database.query(`SELECT DISTINCT ON (deliverable_id) * FROM evimed_review.reviews
      WHERE user_id=$1 AND project_id=$2 AND (run_id=$3 OR socket_run_id=$3) AND status='done' ORDER BY deliverable_id, created_at DESC`,
    [identity.userId, identity.projectId, runId]);
    const out = [];
    for (const review of reviews.rows) {
      const findings = await this.database.query(`SELECT * FROM evimed_review.findings WHERE review_id=$1 ORDER BY finding_id`, [review.id]);
      out.push({ deliverableId: review.deliverable_id, contractKind: review.contract_kind, ...publicResult(review, findings.rows) });
    }
    return out;
  }

  /* ------------------------------------------------------------------ L1 */

  /**
   * Queue the check of a finished conversation reply, when it cites or names
   * a medicine. Called once per finished run; a reply with nothing to check
   * (L0) is not written anywhere.
   * @param {{ userId: string, projectId: string }} identity
   * @param {{ id: string, sessionId?: string }} run
   * @param {{ replyText: string, question?: string, turnSeq?: number | null }} reply
   */
  async considerReply(identity, run, { replyText, question = "", turnSeq = null }) {
    if (!this.enabled || this.config.reviewRepliesEnabled === false) return null;
    const tier = replyReviewTier(replyText);
    if (tier.tier !== "L1") return null;
    await migrateReview(this.database);
    const id = newId("rc_");
    const inserted = await this.database.query(`INSERT INTO evimed_review.reply_checks
      (id,user_id,project_id,run_id,session_id,turn_seq,status,reply_text,question,medicines)
      VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9) ON CONFLICT (user_id, project_id, run_id) DO NOTHING RETURNING id`,
    [id, identity.userId, identity.projectId, run.id, String(run.sessionId ?? ""), Number.isSafeInteger(turnSeq) ? turnSeq : null,
      clip(replyText, 60_000), clip(question, 4_000), tier.medicines.slice(0, 20)]);
    return inserted.rows[0]?.id ?? null;
  }

  /**
   * One worker tick: claim queued reply checks and do them.
   * @param {string} workerId
   * @returns {Promise<number>} how many were processed
   */
  async processReplyChecks(workerId) {
    if (!this.enabled || !this.configured || this.config.reviewRepliesEnabled === false) return 0;
    await migrateReview(this.database);
    const limit = Math.max(1, Number(this.config.reviewReplyConcurrency ?? 2));
    const claimed = await this.database.query(`UPDATE evimed_review.reply_checks SET status='running', lease_owner=$1,
        lease_until=clock_timestamp() + interval '5 minutes', attempts=attempts+1
      WHERE id IN (SELECT id FROM evimed_review.reply_checks WHERE status='queued' AND attempts < 3 ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [workerId, limit]);
    await Promise.all(claimed.rows.map((/** @type {any} */ row) => this.#checkReply(row).catch(async (error) => {
      this.counts.replyFailures += 1;
      this.lastError = error?.code ?? "reply_check_failed";
      await this.database.query(`UPDATE evimed_review.reply_checks SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
          error_code=$2, lease_owner=NULL, lease_until=NULL, finished_at=CASE WHEN attempts >= 3 THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
      [row.id, String(error?.code ?? "reply_check_failed").slice(0, 64)]).catch(() => {});
    })));
    return claimed.rows.length;
  }

  /** @param {Record<string, any>} row */
  async #checkReply(row) {
    const { sentences, references } = replyCitedSentences(row.reply_text);
    const cautions = row.medicines?.length
      ? clinicalSafetyCautionHits({ reportText: row.reply_text, question: row.question }).map((hit) => ({ ruleId: hit.ruleId, title: hit.titleZh, message: hit.messageZh }))
      : [];
    /** @type {any[]} */
    let verdicts = [];
    let cost = 0;
    let model = null;
    if (sentences.length) {
      const cited = references.filter((reference) => sentences.some((sentence) => sentence.numbers.includes(reference.number)));
      const readable = await this.resolver.sourceTexts(cited);
      const answer = readable.size
        ? await callReviewModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
          userId: row.user_id, projectId: row.project_id, runId: row.run_id,
          messages: [
            { role: "system", content: replySystemPrompt() },
            { role: "user", content: replyMessage({ sentences, references: cited, readable }) },
          ],
          schema: REPLY_CHECK_OUTPUT_SCHEMA, schemaName: "reply_check",
          thinking: { enabled: false }, maxTokens: 4_000,
          timeoutMs: Number(this.config.reviewReplyTimeoutMs ?? 90_000),
        })
        : null;
      verdicts = acceptReplyVerdicts(answer?.value ?? { verdicts: [] }, { sentences, readable }).map((verdict) => {
        const sentence = sentences[verdict.sentence];
        const source = cited.find((reference) => sentence?.numbers.includes(reference.number));
        return {
          ...verdict,
          text: sentence?.sentence ?? "",
          numbers: sentence?.numbers ?? [],
          source: source ? { number: source.number, title: clip(source.text, 200), url: sourceUrl(source) } : null,
        };
      });
      cost = answer?.cost ?? 0;
      model = answer?.model ?? null;
    }
    const counts = { ...replyCheckCounts(verdicts), cautions: cautions.length };
    for (const verdict of verdicts) this.counts.replyVerdicts[verdict.verdict] = (this.counts.replyVerdicts[verdict.verdict] ?? 0) + 1;
    this.counts.replyChecks += 1;
    await this.database.query(`UPDATE evimed_review.reply_checks SET status='done', sentences=$2, verdicts=$3, cautions=$4, counts=$5, model=$6, cost=$7,
        lease_owner=NULL, lease_until=NULL, error_code=NULL, finished_at=clock_timestamp() WHERE id=$1`,
    [row.id, JSON.stringify(sentences.map((sentence) => ({ index: sentence.index, numbers: sentence.numbers }))), JSON.stringify(verdicts),
      JSON.stringify(cautions), JSON.stringify(counts), model, cost]);
    if (counts.contradictedSafety > 0 && !row.notified) await this.#alertSafety(row, verdicts.filter((verdict) => verdict.safety === "contradicted"));
  }

  /**
   * A medicine claim its own source contradicts reaches the researcher: in
   * the inbox, and in the chat the question came from.
   * @param {Record<string, any>} row @param {any[]} contradicted
   */
  async #alertSafety(row, contradicted) {
    const lines = contradicted.slice(0, 3).map((verdict) => `「${clip(verdict.text, 120)}」——${verdict.reason || "来源所述与此相反"}${verdict.source?.url ? `（${verdict.source.url}）` : ""}`);
    const body = `刚才的回答里有 ${contradicted.length} 处用药相关的说法与它引用的来源不符：\n${lines.join("\n")}\n请以原始来源为准，必要时咨询药师。`;
    this.counts.safetyAlerts += 1;
    try {
      await this.notifications?.create?.(row.user_id, {
        noticeType: "notify", severity: "safety", title: "回答中的用药说法与来源不符", body,
        projectId: row.project_id, source: { type: "run", id: row.run_id }, idempotencyKey: `reply-check-safety:${row.id}`,
      });
      await this.imService?.sendRunCorrection?.(row.user_id, row.project_id, row.run_id, `【更正提示】${body}`);
    } finally {
      await this.database.query(`UPDATE evimed_review.reply_checks SET notified=true WHERE id=$1`, [row.id]).catch(() => {});
    }
  }

  /**
   * The reply checks of one conversation, for the row under each answer.
   * @param {ReviewIdentity} identity @param {string} sessionId
   */
  async replyChecksForSession(identity, sessionId) {
    if (!this.enabled) return [];
    await migrateReview(this.database);
    const rows = await this.database.query(`SELECT id, run_id, session_id, turn_seq, status, verdicts, cautions, counts, medicines, created_at, finished_at
      FROM evimed_review.reply_checks WHERE user_id=$1 AND project_id=$2 AND session_id=$3 ORDER BY created_at DESC LIMIT 100`,
    [identity.userId, identity.projectId, sessionId]);
    return rows.rows.map((/** @type {any} */ row) => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      turnSeq: row.turn_seq,
      status: row.status,
      counts: row.counts ?? {},
      medicines: row.medicines ?? [],
      cautions: row.cautions ?? [],
      verdicts: (row.verdicts ?? []).map((/** @type {any} */ verdict) => ({
        sentence: verdict.text,
        verdict: verdict.verdict,
        warning: REPLY_CHECK_WARNING_VERDICTS.includes(verdict.verdict),
        reason: verdict.reason,
        evidence: verdict.evidence,
        safety: verdict.safety,
        source: verdict.source,
      })),
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }));
  }

  /* ------------------------------------------------------------- health */

  /** Counters for the operator's metrics endpoint. */
  stats() {
    return {
      ...this.counts,
      running: this.running.size,
      editorsActive: this.editors.active,
      editorsQueued: this.editors.queued,
      references: this.resolver?.stats?.() ?? null,
    };
  }

  /**
   * The module's readiness entry: red only for its own invariants — a store it
   * cannot migrate, no key to call its model with. A model call that failed is
   * a warning on a green check, as an external dependency is everywhere else.
   */
  async readiness() {
    if (!this.config.reviewEnabled) return { required: false, enabled: false };
    if (!this.database) throw readinessError("review_unavailable", { reason: "no_product_database" });
    if (!this.configured) throw readinessError("review_model_unconfigured");
    try {
      await migrateReview(this.database);
    } catch (error) {
      throw readinessError("review_migration_failed", { reason: typeof error?.code === "string" ? error.code : "migration_error" });
    }
    return { required: true, enabled: true, model: this.config.reviewModel, ...(this.lastError ? { warning: this.lastError } : {}) };
  }
}

/** @param {string} code @param {Record<string, unknown>} [details] */
function readinessError(code, details) {
  /** @type {Error & Record<string, any>} */
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

/** The public view of a done review. @param {Record<string, any>} row @param {any[]} findings */
function publicResult(row, findings) {
  const checklist = Array.isArray(row.checklist) ? row.checklist : [];
  const acceptance = Array.isArray(row.acceptance) ? row.acceptance : [];
  const deterministic = row.deterministic ?? {};
  return {
    tier: row.tier,
    safety: Boolean(row.safety),
    model: row.model,
    pass: Number(row.pass) || 0,
    editor: deterministic.editor ?? "skipped",
    editorError: row.error_code ?? null,
    findings: findings.map((finding) => ({
      id: finding.finding_id,
      kind: finding.kind,
      label: REVIEW_FINDING_KIND_LABELS_ZH[/** @type {keyof typeof REVIEW_FINDING_KIND_LABELS_ZH} */ (finding.kind)] ?? finding.kind,
      severity: finding.severity,
      origin: finding.origin,
      location: finding.location,
      evidence: finding.evidence,
      fix: finding.fix,
      message: finding.message,
      answerRequired: REVIEW_ANSWER_REQUIRED_KINDS.includes(finding.kind),
      ...(finding.response ? { response: finding.response, responseReason: finding.response_reason ?? "" } : {}),
    })),
    checklist: {
      present: checklist.filter((/** @type {any} */ item) => item.status === "present").length,
      absent: checklist.filter((/** @type {any} */ item) => item.status === "absent").map((/** @type {any} */ item) => item.item),
      unlocated: checklist.filter((/** @type {any} */ item) => item.status === "unlocated").map((/** @type {any} */ item) => item.item),
    },
    acceptance: {
      met: acceptance.filter((/** @type {any} */ item) => item.met === true).map((/** @type {any} */ item) => item.item),
      unmet: acceptance.filter((/** @type {any} */ item) => item.met === false).map((/** @type {any} */ item) => item.item),
      unlocated: acceptance.filter((/** @type {any} */ item) => item.met === null).map((/** @type {any} */ item) => item.item),
    },
    deterministic: {
      references: deterministic.references ?? null,
      numeric: deterministic.numeric ?? null,
      jobs: deterministic.jobs ?? [],
      previous: deterministic.previous ?? { open: [], resolved: [] },
    },
    dropped: Array.isArray(row.dropped) ? row.dropped.length : 0,
    cost: Number(row.cost) || 0,
  };
}

/** A reference's best link. @param {{ dois: readonly string[], pmids: readonly string[], urls: readonly string[] }} reference */
function sourceUrl(reference) {
  if (reference.pmids[0]) return `https://pubmed.ncbi.nlm.nih.gov/${reference.pmids[0]}/`;
  if (reference.dois[0]) return `https://doi.org/${reference.dois[0]}`;
  return reference.urls[0] ?? "";
}

/**
 * The deliverable's files, as the gate reads them: the capability's declared
 * outputs, or — for a capability this control plane cannot name — every
 * readable file in the deliverable's directory.
 * @param {string} root @param {string} deliverableId @param {readonly string[]} outputs
 * @returns {Promise<Map<string, string>>}
 */
async function readDeliverable(root, deliverableId, outputs) {
  if (!DELIVERABLE_ID.test(deliverableId)) return new Map();
  const dir = path.join(root, DELIVERABLES_DIR, deliverableId);
  let names = outputs.filter((name) => /^[^/\\]+$/.test(name));
  if (!names.length) {
    try {
      names = (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).slice(0, 40);
    } catch {
      names = [];
    }
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const name of names) {
    const text = await readWorkspaceText(root, path.join(DELIVERABLES_DIR, deliverableId, name));
    if (text != null) files.set(name, text);
  }
  return files;
}

/** @param {string} root @param {string} relative @returns {Promise<string | null>} */
async function readWorkspaceText(root, relative) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(root, path.join(root, relative));
    if (!opened.stat.isFile() || opened.stat.size <= 0 || opened.stat.size > FILE_LIMIT_BYTES) return null;
    return await opened.handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

/**
 * The claims of a clinical evidence matrix with an excerpt of each source
 * around the quote it cites.
 * @param {string} root @param {string | undefined} matrixText
 */
async function claimsWithExcerpts(root, matrixText) {
  if (!matrixText) return [];
  let matrix;
  try { matrix = JSON.parse(matrixText); } catch { return []; }
  const claims = Array.isArray(matrix?.claims) ? matrix.claims.slice(0, CLAIM_LIMIT) : [];
  /** @type {Map<string, string | null>} */
  const sources = new Map();
  const out = [];
  for (const claim of claims) {
    const entries = claim?.claimType === "synthesized" && Array.isArray(claim?.supportingSources)
      ? claim.supportingSources
      : [{ artifactPath: claim?.artifactPath, supportQuote: claim?.supportQuote, sourceTitle: claim?.sourceTitle }];
    const withExcerpts = [];
    for (const entry of entries.slice(0, 6)) {
      const artifactPath = String(entry?.artifactPath ?? "");
      if (!artifactPath.startsWith(`${SOURCES_DIR}/`) || artifactPath.includes("..")) {
        withExcerpts.push({ artifactPath, quote: clip(entry?.supportQuote, 600), title: clip(entry?.sourceTitle, 200), excerpt: "" });
        continue;
      }
      if (!sources.has(artifactPath) && sources.size < SOURCE_FILE_LIMIT) sources.set(artifactPath, await readWorkspaceText(root, artifactPath));
      const source = sources.get(artifactPath) ?? null;
      withExcerpts.push({ artifactPath, quote: clip(entry?.supportQuote, 600), title: clip(entry?.sourceTitle, 200), excerpt: source ? excerptAround(source, String(entry?.supportQuote ?? "")) : "" });
    }
    out.push({ claimId: String(claim?.claimId ?? ""), claimType: String(claim?.claimType ?? ""), claim: clip(claim?.claim, 800), sources: withExcerpts });
  }
  return out;
}

/**
 * The machine-readable files an engine job wrote, bounded.
 * @param {string} root @param {readonly string[]} jobIds
 * @returns {Promise<{ path: string, text: string }[]>}
 */
async function readJobOutputs(root, jobIds) {
  /** @type {{ path: string, text: string }[]} */
  const files = [];
  let bytes = 0;
  for (const jobId of jobIds) {
    const prefix = Object.keys(ENGINE_JOB_DIRECTORIES).find((candidate) => jobId.startsWith(candidate));
    if (!prefix) continue;
    const base = path.join(ENGINE_JOB_DIRECTORIES[/** @type {keyof typeof ENGINE_JOB_DIRECTORIES} */ (prefix)], jobId, "output");
    /** @type {string[]} */
    const queue = [base];
    while (queue.length && files.length < JOB_FILE_LIMIT && bytes < JOB_BYTES_LIMIT) {
      const relative = /** @type {string} */ (queue.shift());
      let entries;
      try {
        entries = await fsp.readdir(path.join(root, relative), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const child = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && child.split(path.sep).length < base.split(path.sep).length + 4) queue.push(child);
        else if (entry.isFile() && /\.(?:json|csv|tsv)$/i.test(entry.name) && files.length < JOB_FILE_LIMIT) {
          const text = await readWorkspaceText(root, child);
          if (text == null) continue;
          bytes += text.length;
          files.push({ path: child, text });
          if (bytes >= JOB_BYTES_LIMIT) break;
        }
      }
    }
  }
  return files;
}

/**
 * The user message of an editor pass: stable parts first (checklist,
 * acceptance items, claims and their sources), so a second pass over a
 * repaired report shares the provider's cached prefix; the report last.
 * @param {Record<string, any>} input
 */
export function editorMessage({ contractKind, deliverableId, tier, files, claims, checklist, acceptanceItems, deterministic, previousFindings }) {
  const parts = [];
  parts.push(`<submission contract="${contractKind}" deliverable="${deliverableId}" tier="${tier.tier}"${tier.safety ? " clinical=\"true\"" : ""}>`);
  if (checklist.length) {
    parts.push("<checklist>", ...checklist.map((/** @type {any} */ item) => `${item.id}（${item.list}）${item.text}`), "</checklist>");
  }
  if (acceptanceItems.length) {
    parts.push("<acceptance>", ...acceptanceItems.map((/** @type {string} */ item, /** @type {number} */ index) => `A${index + 1} ${item}`), "</acceptance>");
  }
  if (claims.length) {
    parts.push("<claims>");
    for (const claim of claims) {
      parts.push(`${claim.claimId} [${claim.claimType}] ${claim.claim}`);
      for (const source of claim.sources) {
        parts.push(`  来源 ${source.artifactPath}${source.title ? `《${source.title}》` : ""}`);
        if (source.quote) parts.push(`  引文：${source.quote}`);
        if (source.excerpt) parts.push(`  来源摘录：${source.excerpt}`);
      }
    }
    parts.push("</claims>");
  }
  parts.push("<deterministic>");
  const references = deterministic.references;
  if (references?.references) {
    parts.push(`参考文献：列出 ${references.references} 条，带 DOI/PMID 的 ${references.withIdentifier} 条；登记处确认 ${references.resolved} 条，查无此条 ${references.unresolvable} 条，与标识符不符 ${references.mismatched} 条，未能判定 ${references.undecided} 条。`);
    for (const finding of deterministic.referenceFindings.slice(0, 20)) parts.push(`- ${finding.message}`);
  }
  if (deterministic.numeric?.metrics) {
    const metrics = deterministic.numeric.metrics;
    parts.push(`数字溯源（${deterministic.numeric.jobs.join("、") || "无作业号"}）：正文结果数字 ${metrics.stated} 个，与输出一致 ${metrics.verified} 个，相近而不同 ${metrics.mismatched} 个，找不到 ${metrics.unsupported} 个。`);
  }
  if (deterministic.stats.length) {
    parts.push(`统计一致性：${deterministic.stats.length} 处自相矛盾（门禁已报告）。`);
  }
  parts.push("</deterministic>");
  if (previousFindings.length) {
    parts.push("<previous-review>");
    for (const finding of previousFindings) {
      const answer = finding.response ? `作者：${finding.response === "fixed" ? "已修" : `不改——${finding.response_reason ?? ""}`}` : "作者未回应";
      parts.push(`${finding.finding_id} ${REVIEW_FINDING_KIND_LABELS_ZH[/** @type {keyof typeof REVIEW_FINDING_KIND_LABELS_ZH} */ (finding.kind)] ?? finding.kind}（${finding.location}）「${clip(finding.evidence, 200)}」 建议：${finding.fix}；${answer}`);
    }
    parts.push("</previous-review>");
  }
  let budget = PACKAGE_CHAR_LIMIT;
  const ordered = [...files.entries()].sort(([left], [right]) => Number(right.endsWith(".md")) - Number(left.endsWith(".md")));
  for (const [name, text] of ordered) {
    if (name === MATRIX_FILE) continue;
    const limit = name.endsWith(".md") ? budget : Math.min(budget, 8_000);
    if (limit <= 0) {
      parts.push(`<file name="${name}" omitted="length"/>`);
      continue;
    }
    const body = text.length > limit ? `${text.slice(0, limit)}\n…（其余 ${text.length - limit} 字未给出）` : text;
    budget -= Math.min(text.length, limit);
    parts.push(`<file name="${name}">`, body, "</file>");
  }
  parts.push("</submission>");
  return parts.join("\n");
}

/** The reply checker's system prompt. */
export function replySystemPrompt() {
  return [
    "你核对一段对话回答里带引用的句子：每句话后面的编号指向它引用的来源，你拿到的是这些来源自己的题名与摘要（不是回答对它们的转述）。",
    "对每一句（S0、S1…）判断来源是否支持这句话：supported（支持）、partial（只支持一部分，或回答说得更强）、unsupported（来源没有这样说，或说的相反）、uncertain（摘录不足以判断）。",
    "reason 用回答的语言写一句理由。evidence 必须从来源摘录里逐字复制你依据的原文；给不出原文就判 uncertain。",
    "标了「涉药」的句子：safety 回答 consistent（剂量、禁忌、相互作用、监测等说法与来源一致或来源未涉及）或 contradicted（与来源相反）；其余句子 safety 填 none。",
    "reason 里引用词句用「」，不要用英文双引号——它会提前结束 JSON 字符串。evidence 只放来源原文本身，不加引号或标签。",
  ].join("\n");
}

/**
 * @param {{ sentences: readonly any[], references: readonly any[], readable: Map<number, string> }} input
 */
export function replyMessage({ sentences, references, readable }) {
  const parts = ["<sources>"];
  for (const reference of references) {
    const text = readable.get(reference.number);
    if (!text) continue;
    parts.push(`[${reference.number}]`, text, "");
  }
  parts.push("</sources>", "<sentences>");
  for (const sentence of sentences) {
    parts.push(`S${sentence.index}${sentence.medicines.length ? "（涉药）" : ""} 引用 ${sentence.numbers.map((/** @type {number} */ number) => `[${number}]`).join("")}：${sentence.sentence}`);
  }
  parts.push("</sentences>");
  return parts.join("\n");
}


/**
 * The reviewer's counters as metric families for the operator endpoint: how
 * many reviews ran and failed, what each kind of finding came to, what writers
 * answered, what the reply checks said — the distribution a kind is promoted
 * or demoted by (principle 4), and the one alert that must never be silent, a
 * medicine claim its own source contradicts.
 * @param {boolean} enabled @param {ReturnType<ReviewService["stats"]> | null} stats
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function reviewMetricFamilies(enabled, stats) {
  /** @type {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>} */
  const families = [
    { name: "open_science_review_enabled", help: "Whether the independent reviewer is composed in this deployment.", type: /** @type {const} */ ("gauge"), series: [{ value: enabled ? 1 : 0 }] },
  ];
  if (!enabled || !stats) return families;
  /** @param {Record<string, number>} map @param {string} a @param {string} [b] */
  const split = (map, a, b) => Object.entries(map).map(([key, value]) => {
    const [first, second] = key.split(":");
    return { value, labels: b ? { [a]: first, [b]: second ?? "" } : { [a]: key } };
  });
  families.push(
    { name: "open_science_review_reviews_total", help: "Deliverable reviews by outcome.", type: "counter", series: [
      { value: stats.reviewsStarted, labels: { outcome: "started" } },
      { value: stats.reviewsDone, labels: { outcome: "done" } },
      { value: stats.reviewsFailed, labels: { outcome: "failed" } },
    ] },
    { name: "open_science_review_editor_calls_total", help: "Editor model calls, those retried once after a transient failure, and those that failed.", type: "counter", series: [
      { value: stats.editorCalls, labels: { outcome: "called" } },
      { value: stats.editorRetries, labels: { outcome: "retried" } },
      { value: stats.editorFailures, labels: { outcome: "failed" } },
    ] },
    { name: "open_science_review_findings_total", help: "Findings kept, by origin (code or editor) and kind.", type: "counter", series: split(stats.findings, "origin", "kind") },
    { name: "open_science_review_findings_dropped_total", help: "Editor findings dropped, by reason (evidence not located, kind, duplicate, limit).", type: "counter", series: split(stats.dropped, "reason") },
    { name: "open_science_review_responses_total", help: "Writers' answers to findings, by kind and response.", type: "counter", series: split(stats.responses, "kind", "response") },
    { name: "open_science_review_reply_checks_total", help: "Conversation reply checks done, and those that failed.", type: "counter", series: [
      { value: stats.replyChecks, labels: { outcome: "done" } },
      { value: stats.replyFailures, labels: { outcome: "failed" } },
    ] },
    { name: "open_science_review_reply_verdicts_total", help: "Reply-check verdicts per cited sentence.", type: "counter", series: split(stats.replyVerdicts, "verdict") },
    { name: "open_science_review_safety_alerts_total", help: "Medicine claims their own cited source contradicts, alerted to the researcher.", type: "counter", series: [{ value: stats.safetyAlerts }] },
    { name: "open_science_review_in_flight", help: "Reviews running, and editor calls active and queued.", type: "gauge", series: [
      { value: stats.running, labels: { state: "running" } },
      { value: stats.editorsActive, labels: { state: "editor_active" } },
      { value: stats.editorsQueued, labels: { state: "editor_queued" } },
    ] },
  );
  return families;
}

/**
 * A finished run's reply as the researcher saw it: the last assistant text
 * inside the run's time window (the window `imService.finalReplyText` reads),
 * with the event sequence of the message that carried it — the key the
 * conversation page draws its row under — and the question it answered.
 * @param {readonly any[]} messages transcript messages of the run's own session
 * @param {{ startedAt?: string, finishedAt?: string }} run
 * @returns {{ replyText: string, turnSeq: number | null, question: string } | null}
 */
export function replyOfRun(messages, run) {
  const started = Date.parse(String(run?.startedAt ?? "")) - 5_000;
  const finished = Date.parse(String(run?.finishedAt ?? "")) + 5_000;
  /** @param {any} message */
  const textOf = (message) => (Array.isArray(message?.parts) ? message.parts : [])
    .filter((/** @type {any} */ part) => part?.type === "text" && typeof part.text === "string").map((/** @type {any} */ part) => part.text).join("").trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const time = Number(message.time);
    if (Number.isFinite(finished) && Number.isFinite(time) && time > finished) continue;
    if (Number.isFinite(started) && Number.isFinite(time) && time < started) break;
    const replyText = textOf(message);
    if (!replyText) continue;
    let question = "";
    for (let back = index - 1; back >= 0; back -= 1) {
      if (messages[back]?.role === "user") {
        question = textOf(messages[back]);
        break;
      }
    }
    return { replyText, turnSeq: Number.isSafeInteger(message.seq) ? message.seq : null, question };
  }
  return null;
}
