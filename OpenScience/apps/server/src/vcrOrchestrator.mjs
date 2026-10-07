/**
 * 「虚拟临研」's seven-step program (build plan 2026-09-28 §4, §6.3, §10):
 * which step runs next, decided by platform rules and never by the model.
 *
 * The division of labour is the one 「循证 GEO」 paid for and proved: **the
 * steps that think run as AI runs; the steps that compute run as platform
 * jobs.** Drafting the research definition, structuring eligibility criteria,
 * extracting precedents, choosing a comparator route, writing the package —
 * those are runs. Profiling a snapshot, building a cohort, synthesising a
 * population, weighting a comparator, simulating a design, evaluating criteria
 * — those are jobs in `evimed_vcr.jobs`, which do not take the study's one run
 * slot and so never block the researcher's own conversation.
 *
 * Hidden knowledge:
 *
 * - **What is wanted is derived, not stored.** A step the user asked for is
 *   `requested`; whatever it needs upstream is wanted too, as a *minimal*
 *   version when it was not itself requested (plan §4: 「缺的上游由 AI 补一个
 *   最小版本」). So 「这个单臂试验能不能用外部对照？」 asks for one step and gets
 *   a minimal definition under it, marked as minimal, and asking for the full
 *   thing later does not redo what was done.
 * - **A step's completion is read from the data, never from a run's word**
 *   (attachment E §2.2): the definition step is done when a definition version
 *   exists, the evidence step when a parameter cites its evidence (a card
 *   another step stated by itself is not its product), the comparator step
 *   when the design carries a result or a deterministic 「不可估计」 — which is
 *   a finished result, not a failure (plan §3.6). A failed run that wrote its object still counts (principle
 *   19); a run that failed and wrote nothing fails its steps, and one that
 *   ended well and wrote nothing leaves them not started, to be sent again
 *   within the key's attempts or asked for again.
 * - **「进行中」 is a statement about now.** A step reads running only while a
 *   job of its own is open or a run the study's slot holds covers it — never
 *   because its input exists, and never because a run once went out for it
 *   (`vcrStepUpdates`). A run is sent only for a step that is not running, so
 *   a step that read running with nothing out was a step nothing could move.
 * - **Every side effect is claimed first** in `evimed_vcr.schedule_marks` by a
 *   key that names it (`run:analysis`, `job:trial_scenario:scn_x@2`,
 *   `notice:not-estimable:<result>`, `recompute:<node>`). The key is what
 *   makes a tick, a restart and a second process idempotent, and a run's
 *   dispatch id is derived from its key and attempt so a dispatch that was
 *   accepted but not recorded returns the same run.
 * - **The worker's cross-process lease is an advisory lock, not a mark.**
 *   `schedule_marks.study_id` has a foreign key to `studies`, so the
 *   `_platform` row GEO uses for its leases cannot exist here; the lease is a
 *   session advisory lock on its own connection instead, which holds no pool
 *   connection while the work runs.
 * - **Nothing stops except the three stops** (§10.1). Over-budget compute
 *   waits in `awaiting_budget` for one confirmation; contacting a patient is
 *   the matching package's; clinical safety is the platform's existing rule.
 *   Everything else the AI decides takes effect at once, labelled `ai_set`.
 * - **A change recomputes, it does not delete** (§6.3, AC-16): `recomputePlan`
 *   splits what a change affects into light and heavy, both are marked stale
 *   with the reason, and the stale result keeps its numbers and its page until
 *   a new one supersedes it.
 *
 * @module vcrOrchestrator
 */

import { createHash } from "node:crypto";

import {
  VCR_DESIGN_SUPPORT, VCR_ENGINE_METHODS, VCR_EXPORT_KINDS, VCR_EXPORT_KIND_LABELS_ZH, VCR_JOB_METHODS, VCR_PATIENT_LEVEL_JOB_KINDS,
  VCR_HOSTED_MODEL_INTERFACES, VCR_MODEL_DOCUMENT_KINDS, VCR_MODEL_DOCUMENT_SECTIONS, VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH,
  VCR_MODEL_INTERFACE_LABELS_ZH, VCR_SCENARIO_SCHEMAS, VCR_STALE_REASONS, VCR_STEPS, VCR_STEP_CAPABILITIES, VCR_STEP_NEEDS, VCR_STEP_PRODUCTS,
  allowanceWaitingNote, lineageNode, parseLineageNode, recomputePlan, stepWaitingFor, vcrModelInterfaceOf, vcrScenarioChildKeys, vcrScenarioParentOf, whenHolds,
} from "@evimed/domain";

import { HttpError, randomId } from "./security.mjs";
import { readVcrReviewExportProof } from "./vcrReview.mjs";
import { studyReviewDigest } from "./studyReview.mjs";
import { vcrModelApplicabilityIssues, vcrPopulationVariables } from "./vcrModelApplicability.mjs";
import { isModelDocumentKind } from "./vcrModelDocuments.mjs";
import { VCR_COMPARISON_RESULT_KIND, VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrSealRequired } from "./vcrSeal.mjs";
import { vcrRouteOptions } from "./vcrService.mjs";
import { vcrObjectNode } from "./vcrStore.mjs";
import { vcrCurrentNodes, vcrInputDigest, vcrReviewIsCurrent } from "./vcrViews.mjs";
import { vcrExportHoldsDocument, vcrReportReviewRevision } from "./vcrRender.mjs";

export { vcrModelApplicabilityIssues, vcrPopulationVariables };

/** Which capability thinks each step (the domain's map, named here for readers). */
export const VCR_RUN_CAPABILITIES = VCR_STEP_CAPABILITIES;

/** Which `results.kind` each research object's result is filed under. */
export const VCR_OBJECT_RESULT_KINDS = Object.freeze({
  population: "population", patient_set: "patient_set", comparator: "comparator",
  trial_scenario: "trial_scenario", design_grid: "design_grid",
});

/** The four steps one `vcr-analysis` run covers, in order. */
export const VCR_ANALYSIS_STEPS = Object.freeze(["population", "patients", "comparator", "trial"]);

/**
 * The contract kinds a run sent for these steps delivers (`VCR_STEP_PRODUCTS`),
 * once each. The dispatch names them so the delivery gate holds the run to those
 * products' files and checks: the second analysis run of the live acceptance was
 * sent for the patients alone and was marked unverified for the comparability
 * table and the simulation report it had no reason to write. A step whose
 * capability produces one kind names nothing — there is nothing to narrow.
 * @param {readonly string[]} steps
 * @returns {string[]}
 */
export function vcrProductsOfSteps(steps) {
  const named = new Set(steps.map((step) => /** @type {Record<string, string>} */ (VCR_STEP_PRODUCTS)[step]).filter(Boolean));
  return [...new Set(Object.values(VCR_STEP_PRODUCTS))].filter((kind) => named.has(kind));
}

/** A step is finished when it is `done` or a deliberate `minimal`. */
const FINISHED = new Set(["done", "minimal"]);
const TERMINAL_RUN = new Set(["succeeded", "failed", "canceled", "cancelled"]);
/** Dispatch refusals that will not clear by waiting a minute. */
const TERMINAL_DISPATCH = new Set(["vcr_unavailable", "vcr_study_not_found", "project_not_found", "autopilot_capability_unavailable"]);

/** Runs: two tries a key, a claim that stalls for ten minutes is retried. */
export const VCR_RUN_RULES = Object.freeze({ attempts: 2, staleClaimMinutes: 10, studiesPerTick: 200, noticesPerTick: 20 });

/** How far actual accrual may drift from the registered forecast before a person hears about it. */
export const VCR_ACCRUAL_TOLERANCE = 0.2;

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_orchestrator_failed");
/**
 * The fields that take a step off the allowance when it starts or stops for another reason. Only what the allowance
 * wrote is cleared: a note the step has for any other reason stays.
 * @param {any} study @param {string} step
 */
const unwaiting = (study, step) => (study.steps?.[step]?.waiting ? { waiting: null, note: null } : {});
/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The lineage node of one version of one assumption card. Keyed by the card's
 * key rather than by its row id, because a new version is a new row: the whole
 * point of the graph is that 「脱落率 v2」 and 「脱落率 v1」 are versions of one
 * thing (plan §6.3).
 * @param {string} key @param {number} version
 */
export function vcrAssumptionNode(key, version) {
  return lineageNode("assumption", String(key), Number(version));
}

/**
 * The versions a change supersedes: every earlier version of the same object
 * that the graph knows about. A result was computed from 「脱落率 v1」, so
 * writing v2 is what makes that result stale — the traversal has to start at
 * v1, which is where the edges are.
 * @param {readonly { from: string, to: string }[]} edges @param {readonly string[]} changed
 * @returns {readonly string[]}
 */
export function vcrSupersededNodes(edges, changed) {
  const out = new Set(changed ?? []);
  for (const node of changed ?? []) {
    const at = node.lastIndexOf("@");
    if (at < 0) continue;
    const prefix = node.slice(0, at + 1);
    const version = Number(node.slice(at + 1));
    if (!Number.isFinite(version)) continue;
    for (const edge of edges ?? []) {
      for (const end of [edge?.from, edge?.to]) {
        if (typeof end !== "string" || !end.startsWith(prefix)) continue;
        if (Number(end.slice(at + 1)) < version) out.add(end);
      }
    }
  }
  return Object.freeze([...out]);
}

/**
 * A dispatch id as the mark carries it: one token, so the tag in a prompt
 * stays one tag whatever the id holds.
 * @param {string} dispatchId
 */
export function vcrRunId(dispatchId) {
  return String(dispatchId).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
}

/** The dispatch id of one attempt at one run key. @param {string} key @param {number} attempt */
export function vcrDispatchId(key, attempt) {
  return vcrRunId(`vcr-${key.replace(/[^A-Za-z0-9_-]+/g, "-")}-${attempt}`);
}

/**
 * The prompt a dispatched run gets: the brief, then the dispatch tag on its
 * own line so the run ledger can find the run again after a replay. The tag is
 * written here as a literal, the way `platformDispatchTags.test.mjs` reads it.
 * @param {string} brief @param {string} dispatchId
 */
export function vcrRunPrompt(brief, dispatchId) {
  return `${brief}\n\n<evimed-vcr-run>${vcrRunId(dispatchId)}</evimed-vcr-run>`;
}

/**
 * What each exportable document is, in one sentence: the outline the plan gives
 * it (§5.4, §8.3). Text a brief carries, so the run is told which document is
 * wanted in words and not only by a kind — the package capability's own skill
 * describes the study package in full and the other three by name alone.
 */
export const VCR_EXPORT_OUTLINES = Object.freeze(/** @type {Record<string, string>} */ ({
  study_package: "按研究包的九个部分写全：研究与分析概要、输入清单、假设登记表、人群与对照定义、结果、图表、执行记录、验证与局限、决策记录。",
  cde_communication_pack: "按《真实世界证据支持药物注册申请的沟通交流指导原则》的要点组织：必要性与可行性、数据适用性、方案与统计分析计划、偏倚控制与敏感性分析。",
  simulation_report: "按复杂创新设计的模拟报告清单写：设计总述、一个示例试验、情景参数及其依据（零假设情景必写）、每个情景的重复次数及理由、各情景的运行特征与蒙特卡洛误差、敏感性情景、方法版本与随机种子、总结。",
  validation_pack: "按方法逐个写：这项研究用到的每个方法及其版本、前提假设、数值验证的记录与参照用例、每次执行的种子与计算环境；平台没有记录的项照实写「未记录」，不要补写。",
  model_analysis_plan: "平台已按研究的记录写好这份计划的结构、表格和登记项（评估表、模型、假设、方法、情景），你只写各节的文字：引言（为什么要用模型、背景）、目的（模型的预期用途，对应关注的问题）、数据（数据来源与纳入排除的理由）、方法（建模与评价的做法、假设的依据）。每节提交一次，section 写 introduction、objectives、data、methods 之一；不要重写评估表、版本和哈希，也不要写任何结果。",
  model_analysis_report: "平台已写好这份报告的结构、表格和数字（所依据的计划版本、与计划的偏离、评估表、结果表、附录），你只写各节的文字：摘要、引言、目的、数据与方法、结果、讨论、结论。每节提交一次，section 写 executive_summary、introduction、objectives、data_methods、results、discussion、conclusions 之一；数仍写成 {{n:…}} 引用；平台列出的每一处偏离，在讨论里说明原因；平台标成「不可估计」的结果照样当成完成的结果来写，不要补数。",
}));

/** Which of the platform's own documents a kind is, and the sections a run writes words for (the domain's closed lists). @param {string} kind */
const modelDocumentSections = (kind) => (VCR_MODEL_DOCUMENT_KINDS.includes(kind)
  ? /** @type {Record<string, { prose: readonly string[] }>} */ (VCR_MODEL_DOCUMENT_SECTIONS)[kind].prose : null);

/**
 * The lines of a brief that say which document an export run is for and where
 * its words go. The dispatch is bound to that one export (`exportDispatch`): the
 * brief says so, because a run that is not told writes 「研究包」 — the kind its
 * skill's example shows — whatever it was sent for.
 * @param {string} kind one of `VCR_EXPORT_KINDS`
 */
export function vcrExportBriefLines(kind) {
  const label = /** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH)[kind] ?? kind;
  return [
    `本次只写一份资料：这项研究的「${label}」（kind: ${kind}）${kind === "study_package" ? "" : "，不是研究包，也不是别的资料"}。`,
    VCR_EXPORT_OUTLINES[kind] ?? "",
    `正文用 vcr_write 提交：what 写 report，data.kind 写 ${kind}。这次运行的报告只收进这一份导出；写成别的 kind 会被拒绝，不会另建一份。`,
    ...(modelDocumentSections(kind) ? [`文字按节提交，data.section 只能是：${modelDocumentSections(kind)?.map((section) => `${section}（${/** @type {Record<string, string>} */ (VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH)[section]}）`).join("、")}。其他 section 会被拒绝，平台写的表格和登记项不接受改写。`] : []),
    modelDocumentSections(kind) ? "工作区交付文件的文件名照能力清单不变，study-package.md 里按节放这些文字（每节一个小标题）。" : "工作区交付文件的文件名照能力清单不变，study-package.md 里放的就是这份正文。",
    "用 vcr_read 读研究已有的定义、假设、结果和可引用的字段（report_model）；报告里的数一律写成 {{n:…}} 引用，由平台渲染，不要自己算数，也不要手打数字。",
  ].filter(Boolean);
}

/**
 * The brief a dispatched run gets when whoever composed the module injected
 * none: the study's own question, then what this run is for — the document of
 * an export run, the steps of a step run.
 * @param {{ study: any, scope?: readonly string[], detail?: Record<string, any> }} input
 */
export function vcrDefaultBrief({ study, scope = [], detail = {} }) {
  const head = [
    `研究：${study.name}。`,
    study.question ? `研究问题：${study.question}` : "",
    `数据档位：${study.dataTier}；预期用途：${study.intendedUse}。`,
  ];
  const wanted = object(detail);
  if (wanted.exportId && VCR_EXPORT_KINDS.includes(String(wanted.kind))) {
    return [...head, ...vcrExportBriefLines(String(wanted.kind))].filter(Boolean).join("\n");
  }
  const steps = scope.length ? `本次要做的步骤：${scope.join("、")}。` : "";
  const minimal = wanted.fidelity === "minimal" ? "上游缺的部分先补一个最小版本，并标明「AI 设定」。" : "";
  return [
    ...head, steps, minimal,
    "用 vcr_read 读研究已有的定义、假设与结果；用 vcr_write 写定义、条件、假设、设计与决策；确定性计算一律用 vcr_simulate 排作业，不要自己算数。",
  ].filter(Boolean).join("\n");
}

/**
 * The brief of the one revision a review may ask for. The revision is the same
 * document as its original and the run is told which: its report is filed only
 * into the revision's export (`exportDispatch`), so a kind it guessed — the
 * skill's example shows 研究包 — would be refused rather than filed.
 * @param {{ revisionId: string, originalId: string, kind: string, templates: string, findings: readonly any[] }} input
 */
export function vcrReviewRepairBrief({ revisionId, originalId, kind, templates, findings }) {
  const label = /** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH)[kind] ?? kind;
  // The two model documents take their words by named section, each once: a body with no section would be refused.
  const sections = modelDocumentSections(kind);
  return `Revise the retained report in place within a new version. Export ID: ${revisionId}. Original export: ${originalId}.\n`
    + `Document: 「${label}」 (kind: ${kind}). Submit the complete revised body once with vcr_write what: "report", data.kind: "${kind}"; `
    + "this run's report is filed only into this export, and any other kind is refused rather than filed elsewhere.\n"
    + (sections ? `This document takes its words by section: submit each revised section once, data.section one of ${sections.join(", ")}; `
      + "the retained template below is labelled by section, the platform's tables are not yours to rewrite, and a section you do not submit has no words in the revision, so submit every section you keep, unchanged ones too.\n" : "")
    + "Preserve every valid computation, source and artifact. Use saved numeric bindings. Do not rerun engines or invent inputs. Address supported findings once; explain unresolved or declined advice. Human signature is optional.\n"
    + `Write this revision only under deliverables/vcr-review-${revisionId}/. Preserve every existing deliverable file.\n`
    + `Complete retained report template (preserve {{n:…}} bindings):\n${templates}\nLocated advisory findings:\n${JSON.stringify(findings).slice(0, 24000)}`;
}

/**
 * What the program wants from its steps: every requested step and, as a
 * minimal version, whatever it needs upstream (`VCR_STEP_NEEDS`).
 * @param {Record<string, { status: string, requested: boolean }>} steps
 */
export function wantedVcrSteps(steps) {
  const requested = new Set(VCR_STEPS.filter((step) => steps?.[step]?.requested === true));
  const full = VCR_STEPS.every((step) => requested.has(step));
  /** @type {Set<string>} */
  const want = new Set();
  /** @param {string} step */
  const add = (step) => {
    if (want.has(step)) return;
    want.add(step);
    for (const need of /** @type {Record<string, readonly string[]>} */ (VCR_STEP_NEEDS)[step] ?? []) add(need);
  };
  for (const step of requested) add(step);
  return {
    want, requested, full,
    /** @param {string} step @returns {"full" | "minimal"} */
    fidelity: (step) => (requested.has(step) ? "full" : "minimal"),
  };
}

/**
 * The steps as the program will read them on its next tick. A study whose
 * definition exists and which nobody asked anything of is running the whole
 * programme: 「一句话到研究包」 is the default path (plan §10.3), so a study
 * created from the home page's action cards does not sit still.
 * @param {Record<string, { status: string, requested: boolean }>} steps
 */
export function vcrProgramSteps(steps) {
  /** @type {Record<string, { status: string, requested: boolean }>} */
  const out = Object.fromEntries(VCR_STEPS.map((step) => {
    const entry = steps?.[step] ?? { status: "none", requested: false };
    return [step, { ...entry, requested: entry.requested === true || entry.status === "queued" }];
  }));
  if (VCR_STEPS.some((step) => out[step].requested)) return out;
  if (FINISHED.has(out.definition.status)) for (const step of VCR_STEPS) out[step].requested = true;
  return out;
}

/**
 * The steps a run is out for right now: the scope of every run mark the
 * study's slot holds (the caller reads the marks that are running, or claimed
 * and not stale). An export run covers no step.
 * @param {ReadonlyArray<{ detail?: any }>} marks
 * @returns {Set<string>}
 */
export function vcrStepsInFlight(marks) {
  /** @type {Set<string>} */
  const steps = new Set();
  for (const mark of marks) {
    for (const entry of list(object(mark?.detail).scope)) {
      const step = String(object(entry).step ?? entry);
      if (VCR_STEPS.includes(step)) steps.add(step);
    }
  }
  return steps;
}

/**
 * What the data says of a step that has no computed object of its own — the
 * definition, the evidence, the matching: 「进行中」 while a job of its own is
 * open, finished when what it produces is there, and otherwise nothing — the
 * data has no word on a step that has not produced its object, and what the
 * step reads then is the dispatch's to say ({@link vcrIdleStepStatus}).
 *
 * It used to answer 「进行中」 whenever the step's input existed: above T0 the
 * matching step read running from the moment a protocol had criteria, with no
 * run and no job out — and since a run is dispatched only from a step that is
 * not running, the matching run was never sent and 「让 AI 做」 did nothing.
 * @param {{ complete: boolean, jobOpen?: boolean, minimal?: boolean }} facts
 * @returns {{ status: string, note: null } | null}
 */
export function vcrSimpleStepStatus({ complete, jobOpen = false, minimal = false }) {
  if (jobOpen) return { status: "running", note: null };
  if (complete) return { status: minimal ? "minimal" : "done", note: null };
  return null;
}

/**
 * Whether an assumption card is the evidence step's own product (plan §4, step
 * 2: 「试验先例、假设卡」): a parameter that cites the verified values it was
 * taken from — `external_evidence`, a pooled card or one study taken as it
 * stands, which the writer refuses unless the cited rows are this study's and
 * passed their quotation check — or the expert setting widened from such
 * evidence (`pooling.basedOn`, which only `expertSetCard` writes: a run's own
 * write has no `pooling` field).
 *
 * The step is read from this and from nothing a neighbour can write. The
 * protocol run states expert settings and scenarios of its own (the live
 * acceptance of 2026-10-03: scenario cards written under the definition), and
 * so does the analysis run for the designs it configures; counting any card as
 * the evidence step's work read the step done before it started, and
 * `vcr-evidence` was never sent — no pooled value, no prediction interval, no
 * source anchor behind a single number the simulation drew from.
 * @param {unknown} card an assumption card as the store reads it
 */
export function vcrEvidenceProduct(card) {
  const entry = object(card);
  if (entry.sourceKind === "external_evidence") return list(entry.evidenceIds).length > 0;
  return entry.sourceKind === "expert_set" && Boolean(object(entry.pooling).basedOn);
}

/**
 * 「进行中」 is a statement about now. A step stored as running that the data
 * says nothing of, and that no run is out for, is not running: its run ended
 * and left nothing, or (the old matching rule) nothing was ever sent. It reads
 * `none` — where a step nothing has produced stands — so the next pass may send
 * a run again within the key's attempts, a run that failed is recorded as
 * failed, and 「让 AI 做」 is a request again rather than a no-op.
 * @param {string} stored the step's stored status @param {boolean} inFlight whether a run the slot holds covers the step
 * @returns {{ status: string, note: null } | null} the correction, or null when the stored status stands
 */
export function vcrIdleStepStatus(stored, inFlight) {
  return stored === "running" && !inFlight ? { status: "none", note: null } : null;
}

/**
 * What one observation changes: for every step, what the data says of it
 * (`seen`, null where it has no word), checked against the runs out for the
 * study (`flying`) and against what the programme wants. Pure — `#observe`
 * reads the data and writes what this returns.
 * @param {{ steps: Record<string, any>, seen: ReadonlyArray<[string, { status: string, note: string | null } | null]>,
 *   flying: ReadonlySet<string>, plan: { want: ReadonlySet<string> } }} input
 * @returns {Array<{ step: string, fields: { status: string, note?: string | null } }>}
 */
export function vcrStepUpdates({ steps, seen, flying, plan }) {
  /** @type {Array<{ step: string, fields: { status: string, note?: string | null } }>} */
  const updates = [];
  for (const [step, read] of seen) {
    const stored = steps?.[step]?.status ?? "none";
    // Where the data has no word, a step still stored as running with no run out for it is put back.
    const idle = read ? null : vcrIdleStepStatus(stored, flying.has(step));
    const found = read ?? idle;
    if (!found) continue;
    // A step a person has not asked for and which nothing has produced stays
    // where it is: observation never invents progress.
    if (!idle && !plan.want.has(step) && !FINISHED.has(found.status) && found.status !== "stale") continue;
    // Only a failure note is this pass's to write, and only a failed step's to clear.
    const note = found.status === "failed" || found.status === "none" ? found.note : (stored === "failed" ? null : undefined);
    if (stored === found.status && (note === undefined || (steps?.[step]?.note ?? null) === note)) continue;
    updates.push({ step, fields: { status: found.status, ...(note === undefined ? {} : { note }) } });
  }
  return updates;
}

/** Why a job was not run that is not a failure: the engine does not implement it, or an earlier stage already ended the question. */
const UNAVAILABLE_REASONS = Object.freeze(["design_not_supported", "route_unavailable", "model_comparator_unavailable", "data_tier_insufficient", "previous_not_estimable"]);

/** What a job mark says about why its object is not being computed, as a sentence. @param {any} mark */
function noteOfMark(mark) {
  const detail = object(mark.detail);
  const title = String(detail.title ?? "");
  const message = String(detail.message ?? "");
  const said = [title, message].filter(Boolean).join("：") || String(detail.error ?? detail.reason ?? "");
  const code = detail.error ? `（${detail.error}）` : "";
  return (said ? `${said}${detail.title ? "" : code}` : "这一步没有算成。").slice(0, 300);
}

/** @typedef {Record<string, any>} VcrRead one pass's reading of a study's objects and compute */

// --- what the engine is told: scenarios built from the objects ---------------------------------------
//
// The engine reads a scenario written in the domain's per-method schemas
// (`VCR_SCENARIO_SCHEMAS`) and refuses any key it does not read. The objects a
// run writes carry those keys in their own fields (a population's `definition`,
// a patient set's `scenario`, a design's `configuration`), so building a job is
// *projecting* the object onto the schema of the method that will run it:
// keys the schema takes are kept, everything else is named and refused. The
// assumption cards a design rests on are laid over the truth it states, so the
// number a card holds is the number the simulation used — and a new version of
// the card is a different scenario, which is what makes a change recompute.

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Keys a research object may carry that are not the engine's: what a page
 * reads (a design's `cost`, a comparator's `comparability` and `e10` tables, a
 * population's evidence window) and what binds an input (`snapshotId`) or
 * chooses between methods (`method`, `jobKind`). They never reach a scenario,
 * and they are the only keys allowed to be dropped without a word.
 */
export const VCR_NON_ENGINE_KEYS = Object.freeze([
  "label", "name", "note", "notes", "cost", "comparability", "e10", "snapshotId", "method", "jobKind", "evidenceWindow", "protocol", "simonSelection",
]);

/**
 * Keep of a candidate scenario only what a method's schema reads. Walks the
 * domain's schema (objects, discriminated variants, lists) with the same
 * `when` gates the validators use; `dropped` names every path that was not
 * kept. A `null` is not a value in the protocol, so it is left out.
 *
 * @param {string} method a key of `VCR_SCENARIO_SCHEMAS`
 * @param {Record<string, any>} candidate
 * @returns {{ scenario: Record<string, any>, dropped: string[] }}
 */
export function vcrProjectScenario(method, candidate) {
  const schema = /** @type {Record<string, any>} */ (VCR_SCENARIO_SCHEMAS)[method];
  /** @type {string[]} */
  const dropped = [];
  if (!schema) return { scenario: {}, dropped: [`method:${method}`] };
  /** @param {string} path @param {string} key */
  const at = (path, key) => (path ? `${path}.${key}` : key);
  /** @param {Record<string, any>} fields @param {unknown} value @param {string} path */
  const projectObject = (fields, value, path) => {
    if (!isObject(value)) return value;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) continue;
      const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!field || !whenHolds(field.when, candidate)) { dropped.push(at(path, key)); continue; }
      out[key] = projectNode(field, entry, at(path, key));
    }
    return out;
  };
  /** @param {Record<string, any>} node @param {unknown} value @param {string} path */
  const projectNode = (node, value, path) => {
    if (node.t === "object") return projectObject(node.fields, value, path);
    if (node.t === "variant") {
      if (!isObject(value)) return value;
      const chosen = value[node.on] === undefined ? node.default : value[node.on];
      const variant = typeof chosen === "string" ? node.variants[chosen] : null;
      if (!variant) return value;
      return projectObject({ [node.on]: { t: "string" }, ...variant }, value, path);
    }
    if (node.t === "array" && Array.isArray(value)) return value.map((item, index) => projectNode(node.items, item, `${path}[${index}]`));
    return value;
  };
  return { scenario: projectObject(schema.fields, candidate, ""), dropped };
}

/** Whether a dotted path holds a value in an object. @param {Record<string, any>} root @param {string} path */
function hasPath(root, path) {
  let node = /** @type {any} */ (root);
  for (const key of path.split(".")) {
    if (!isObject(node) || node[key] === undefined || node[key] === null) return false;
    node = node[key];
  }
  return true;
}

/** The last segment of a dropped path, without its list index. @param {string} path */
const lastKey = (path) => path.replace(/\[\d+\]$/, "").split(".").pop() ?? path;

/**
 * Which assumption keys state which scenario parameter. Closed and deterministic
 * (principle 1): a card is bound by the name it was saved under, on the endpoint
 * it applies to. A key this table does not know is a lineage input and nothing
 * more; it never changes a scenario by accident.
 * @type {ReadonlyArray<{ match: RegExp, endpoint: string, path: readonly string[], group?: readonly string[] }>}
 */
export const VCR_ASSUMPTION_BINDINGS = Object.freeze([
  { match: /^hazard_ratio(?:_|$)/, endpoint: "time_to_event", path: ["truth", "hazardRatio"] },
  { match: /^(?:control_median|median_time|median_survival)/, endpoint: "time_to_event", path: ["truth", "controlMedian"] },
  { match: /^(?:dropout_rate|dropout_annual|annual_dropout)/, endpoint: "time_to_event", path: ["accrual", "dropoutAnnual"] },
  { match: /^(?:control_event_rate|control_rate|control_response_rate)$/, endpoint: "binary", path: ["truth", "controlRate"] },
  { match: /^(?:treatment_event_rate|treatment_rate|treatment_response_rate)$/, endpoint: "binary", path: ["truth", "treatmentRate"],
    group: ["treatmentRate", "riskDifference", "oddsRatio"] },
  { match: /^risk_difference$/, endpoint: "binary", path: ["truth", "riskDifference"], group: ["treatmentRate", "riskDifference", "oddsRatio"] },
  { match: /^odds_ratio$/, endpoint: "binary", path: ["truth", "oddsRatio"], group: ["treatmentRate", "riskDifference", "oddsRatio"] },
  { match: /^(?:mean_difference|treatment_effect|effect_size|effect)$/, endpoint: "continuous", path: ["truth", "effect"] },
  { match: /^(?:outcome_sd|standard_deviation|sd)$/, endpoint: "continuous", path: ["truth", "sd"] },
]);

/**
 * Lay the assumption cards over a candidate scenario: the card's point value
 * replaces whatever the object stated for the same parameter. Answers what was
 * bound, so the job records which card version each number came from.
 * @param {Record<string, any>} candidate @param {readonly Record<string, any>[]} cards @param {string | null} endpoint
 * @returns {Array<{ key: string, version: number, path: string }>}
 */
export function vcrBindAssumptions(candidate, cards, endpoint) {
  /** @type {Array<{ key: string, version: number, path: string }>} */
  const bound = [];
  for (const card of cards) {
    const value = Number(card?.pointValue);
    const rule = VCR_ASSUMPTION_BINDINGS.find((entry) => entry.endpoint === endpoint && entry.match.test(String(card?.key)));
    if (!rule || card?.pointValue === null || card?.pointValue === undefined || !Number.isFinite(value)) continue;
    const [section, name] = rule.path;
    const target = isObject(candidate[section]) ? candidate[section] : (candidate[section] = {});
    for (const other of rule.group ?? []) if (other !== name) delete target[other];
    target[name] = value;
    bound.push({ key: String(card.key), version: Number(card.version), path: rule.path.join(".") });
  }
  return bound;
}

/**
 * The card's distribution in the two shapes it is written in: the current
 * `{ family, params }` and the flat `{ kind, meanlog, sdlog }` an earlier run
 * wrote. @param {Record<string, any> | undefined} card
 */
function distributionOf(card) {
  const raw = isObject(card?.distribution) ? card.distribution : {};
  return { family: String(raw.family ?? raw.kind ?? ""), params: { ...raw, ...(isObject(raw.params) ? raw.params : {}) } };
}

/**
 * The design prior of an assurance calculation, from the assumption card that
 * states the effect: the card's own distribution, on the scale the engine
 * integrates (log hazard ratio, mean difference, risk difference) — and only
 * when the card is a prediction distribution. A prior built from a confidence
 * interval understates the spread of a new trial and is not offered
 * (plan §5.4, EB-11); a point value has no spread to integrate over.
 * @param {readonly Record<string, any>[]} cards @param {string | null} endpoint
 * @returns {{ prior: Record<string, any>, key: string, version: number } | null}
 */
export function vcrDesignPriorFrom(cards, endpoint) {
  const wanted = { time_to_event: /^hazard_ratio(?:_|$)/, continuous: /^(?:mean_difference|treatment_effect|effect_size|effect)$/, binary: /^risk_difference$/ };
  const pattern = /** @type {Record<string, RegExp>} */ (wanted)[String(endpoint)];
  const card = pattern ? cards.find((entry) => pattern.test(String(entry?.key))) : null;
  if (!card || String(object(card.pooling).basis ?? "prediction") === "confidence") return null;
  const { family, params } = distributionOf(card);
  const finite = (/** @type {unknown} */ x) => typeof x === "number" && Number.isFinite(x);
  if (endpoint === "time_to_event" && family === "lognormal" && finite(params.meanlog) && finite(params.sdlog) && params.sdlog > 0) {
    return { prior: { mean: params.meanlog, sd: params.sdlog, kind: "lognormal", basis: "prediction" }, key: String(card.key), version: Number(card.version) };
  }
  if (endpoint !== "time_to_event" && family === "normal" && finite(params.mean) && finite(params.sd) && params.sd > 0) {
    return { prior: { mean: params.mean, sd: params.sd, kind: "normal", basis: "prediction" }, key: String(card.key), version: Number(card.version) };
  }
  return null;
}

/** What a route asks of the data, in words a reader can act on, when the study's tier cannot reach it. */
const ROUTE_GAPS = Object.freeze(/** @type {Record<string, { title: string, detail: string, answers: string }>} */ ({
  external_control: {
    title: "外部患者的治疗与结局个体数据",
    detail: "真实外部对照要目标研究的数据和外部患者的个体治疗、结局记录（数据档位 T2 及以上）。",
    answers: "补上之后可以做加权的外部对照，并给出可比性诊断与有效样本量。",
  },
  prognostic_adjustment: {
    title: "随机试验的个体数据与预先锁定的预后评分",
    detail: "预后校正只用于有随机试验个体数据的研究（数据档位 T3）。",
    answers: "补上之后可以计算校正后的样本量，并并排给出不校正与常规协变量校正两条路径。",
  },
  literature_control: {
    title: "已发表的对照组曲线与风险人数表",
    detail: "文献对照要数字化的 KM 曲线坐标和发表的风险人数表，坐标来自数字化程序或人工点选。",
    answers: "补上之后可以重建伪个体数据并做 KM 与 RMST 对比。",
  },
  hybrid_control: {
    title: "历史对照组的汇总数据",
    detail: "混合对照要多项历史研究的对照组事件数与人数（或估计与标准误）。",
    answers: "补上之后可以得到稳健 MAP 先验、先验有效样本量和冲突情景下的运行特征。",
  },
  model_comparator: {
    title: "适用于该人群的结局模型",
    detail: "模型预测比较器要一个声明了适用范围的结局模型；当前版本的引擎里只有按情景参数生成的参考仿真器，它给出的是设定值，不是对该人群的预测。",
    answers: "有了带验证的数据模型之后，这条路线才能给出预测的对照分布及不确定性。",
  },
}));

/**
 * The verdict of a route the study cannot take, derived in code from the data
 * tier the route needs (`vcrRouteOptions`) — never from what a run says about
 * it. A finished result, not a failure: it says what is missing and what would
 * answer the question (plan §3.6).
 * @param {string} route @param {string} dataTier
 */
function routeVerdict(route, dataTier) {
  const option = vcrRouteOptions(dataTier).find((entry) => entry.route === route);
  const gap = ROUTE_GAPS[route];
  if (!gap) return null;
  if (route === "model_comparator") {
    return { rule: "route_unavailable_in_version", reason: "model_comparator_unavailable", gaps: [gap] };
  }
  if (option && !option.available) {
    return { rule: "data_tier_insufficient", reason: "data_tier_insufficient", gaps: [{ ...gap,
      detail: `${gap.detail}这个研究的数据档位是 ${dataTier}，这条路线最低要 ${option.minimumTier}。` }] };
  }
  return null;
}

/** Which patient-generator job runs each endpoint family. */
const PATIENT_KINDS = Object.freeze(/** @type {Record<string, string>} */ ({
  time_to_event: "generate_patients", continuous: "generate_patients_continuous", binary: "generate_patients_binary",
}));

/**
 * The generator a patient set's scenario runs: the endpoint family's, or the trajectory model's when the scenario states a visit
 * schedule (`visits` is a key no other generator reads, so it is the scenario's own word and never a guess from prose).
 * @param {unknown} scenario @param {unknown} type
 */
const patientKindOf = (scenario, type) => (Array.isArray(object(scenario).visits) ? "generate_patients_longitudinal" : PATIENT_KINDS[String(type)]);

/** The job a population of each kind runs. */
const POPULATION_KINDS = Object.freeze(/** @type {Record<string, string>} */ ({
  real: "build_cohort", scenario: "generate_population", literature: "literature_population", empirical_synthetic: "synthesize_population",
}));

/** Which engine job a research object needs first. Deterministic; the model never picks. @param {string} kind @param {Record<string, any>} row @param {Record<string, any>} [context] */
export function vcrJobKindFor(kind, row, context = {}) {
  const configuration = object(object(row).configuration);
  const configured = String(configuration.jobKind ?? "");
  if (kind === "population") return POPULATION_KINDS[String(object(row).kind)] ?? "generate_population";
  if (kind === "patient_set") {
    const endpoint = String(object(object(row).scenario).endpoint?.type ?? object(context.definition).endpointType ?? "time_to_event");
    return patientKindOf(object(row).scenario, endpoint) ?? "generate_patients";
  }
  if (kind === "comparator") {
    const route = String(object(row).route);
    // The endpoint the comparison is about: the design's own, else the study's definition. A time-to-event
    // MAIC is another method from the continuous/binary one (hazard ratios on a log scale, a comparator
    // that is a reconstruction), so the endpoint decides which of the two a `maic` design runs.
    const endpoint = String(object(configuration.endpoint).type ?? object(context.definition).endpointType ?? "");
    if (route === "literature_control") {
      if (configuration.method !== "maic") return "reconstruct_km";
      return endpoint === "time_to_event" ? "maic_time_to_event_comparator" : "maic_comparator";
    }
    if (route === "hybrid_control") return "map_prior";
    if (route === "prognostic_adjustment") {
      // A binary or time-to-event endpoint with a declared prognostic score is the marginal-effect analysis; a continuous endpoint stays
      // with PROCOVA's own design-stage calculation. The declared endpoint and the declared score column decide, never a word.
      return endpoint && endpoint !== "continuous" && configuration.prognosticScoreColumn !== undefined ? "prognostic_adjustment_comparator" : "procova";
    }
    if (route === "external_control") {
      // What the design declares, in this order: alternative covariate sets make the sensitivity analysis; a named
      // method (`weighted_cox`, `aipw`) makes that analysis; otherwise the weighting job of the estimand.
      if (list(configuration.covariateSets).length) return "covariate_set_comparator";
      if (configuration.method === "weighted_cox") return "weighted_cox_comparator";
      if (configuration.method === "aipw") return "aipw_comparator";
      return configuration.method === "propensity" || String(object(row).estimand ?? "ATT") !== "ATT" ? "propensity_weight_comparator" : "weight_comparator";
    }
    return null;
  }
  if (kind === "trial_scenario") {
    if (["design_analytic", "design_simulation", "assurance"].includes(configured)) return configured;
    return object(configuration).analytic === true ? "design_analytic" : "design_simulation";
  }
  if (kind === "design_grid") return "design_grid";
  return "profile_snapshot";
}

/**
 * One job of an object's plan.
 * @typedef {{ stage: string | null, jobKind: string, scenario: Record<string, any>, keepTables: string[],
 *   derived: Array<{ from: "object" | "stage", stage?: string, table: string, bindTo?: string }>, snapshot: boolean, after: string | null,
 *   bound: Array<{ key: string, version: number, path: string }>, detail: Record<string, any> }} VcrStage
 * @typedef {{ ok: true, stages: VcrStage[] }} VcrPlanOk
 * @typedef {{ ok: false, unavailable: { rule: string, reason: string, gaps: any[] } }} VcrPlanUnavailable
 * @typedef {{ ok: false, refused: { code: string, message: string, paths?: string[] } }} VcrPlanRefused
 * @typedef {{ ok: false, waiting: string }} VcrPlanWaiting
 * @typedef {VcrPlanOk | VcrPlanUnavailable | VcrPlanRefused | VcrPlanWaiting} VcrPlan
 */

/**
 * The analysis a covariate-set comparison re-runs, from the design's declared method and estimand:
 * the doubly robust one when it says `aipw`, the propensity weights when it says `propensity` or the
 * estimand is not the ATT (entropy balancing estimates the ATT and nothing else), else entropy balancing.
 * @param {Record<string, any>} configuration @param {string} estimand
 */
function covariateSetAnalysis(configuration, estimand) {
  if (configuration.method === "aipw") return "aipw";
  return configuration.method === "propensity" || estimand !== "ATT" ? "propensity" : "entropy_balance";
}

/**
 * Whether the study's declared design supports the comparator job the design chose, as a refusal that
 * says what to change, or null. The checks are the ones the engine would refuse by name later, made
 * here so the study reads one plain sentence at planning time: a Cox model needs an event time, the
 * doubly robust estimate a continuous or binary outcome and the trial's own population (ATT).
 * @param {string} jobKind @param {Record<string, any>} configuration @param {string} endpoint @param {string} estimand
 * @returns {{ code: string, message: string } | null}
 */
function externalControlRefusal(jobKind, configuration, endpoint, estimand) {
  const sets = jobKind === "covariate_set_comparator";
  const analysis = sets ? covariateSetAnalysis(configuration, estimand) : null;
  const wantsAipw = jobKind === "aipw_comparator" || analysis === "aipw";
  if (!(["weighted_cox_comparator", "aipw_comparator", "covariate_set_comparator"].includes(jobKind))) return null;
  if (!endpoint) return { code: "vcr_scenario_endpoint_missing", message: "这项比较要知道终点类型：先写研究定义，或在对照设计里写 endpoint.type。" };
  if (jobKind === "weighted_cox_comparator" && endpoint !== "time_to_event") {
    return { code: "vcr_job_scenario_invalid", message: `加权 Cox 只用于事件时间终点，这个研究的终点是 ${endpoint}：连续或二分类终点请用加权估计，或把方法改为 aipw。` };
  }
  if (wantsAipw && endpoint === "time_to_event") {
    return { code: "vcr_job_scenario_invalid", message: "双重稳健估计只用于连续或二分类终点；事件时间终点请用 weighted_cox。" };
  }
  if (wantsAipw && estimand !== "ATT") {
    return { code: "vcr_job_scenario_invalid", message: "双重稳健估计只估计试验人群自己的效应（ATT）；要别的估计对象请换成倾向评分加权。" };
  }
  return null;
}

// --- robustness methods ---

/**
 * What the engine reads inside the places a refusal names, as the refusal's own sentence: a run that guessed `accrual.months` is
 * told that `accrual` reads duration, followup and dropoutAnnual, so the repair needs no second lookup. Read from the domain's
 * schemas through the same rows the runtime's shape help is generated from (`vcrScenarioHelp.mjs`), never typed here. At most two
 * places, so the sentence stays what a page can show.
 * @param {string[]} paths @param {ReadonlyArray<{ jobKind: string, scenario: Record<string, any> }>} stages
 */
function readsHint(paths, stages) {
  const methods = [...new Set(stages.map((stage) => /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[stage.jobKind]).filter(Boolean))];
  const root = stages[0]?.scenario;
  const nodes = [...new Set(paths.slice(0, 8).map(vcrScenarioParentOf))].slice(0, 2);
  const places = [];
  for (const node of nodes) {
    const keys = vcrScenarioChildKeys(methods, node, root);
    if (keys.length) places.push(`${node ? `${node} 里` : "顶层"}引擎读：${keys.map((entry) => (entry.variant ? `${entry.key}（${entry.variant.join("、")}）` : entry.key)).join("、")}`);
  }
  return places.length ? `${places.join("；")}。` : "";
}

/**
 * The refusal for keys a plan's stages do not read.
 * @param {string[]} paths @param {ReadonlyArray<{ jobKind: string, scenario: Record<string, any> }>} [stages]
 * @returns {{ code: string, message: string, paths: string[] }}
 */
function unknownFieldsRefusal(paths, stages = []) {
  return { code: "vcr_scenario_unknown_fields", paths,
    message: `配置里有引擎不读的字段：${paths.slice(0, 8).join("、")}。${readsHint(paths, stages)}只写引擎认识的字段（vcr_simulate 的 action shape 按方法列出全部字段），其余字段会被拒绝而不是忽略。` };
}

/**
 * The keys of a comparator design that declare a robustness analysis beside its primary comparison, and what the primary then does not
 * read: `negativeControls` (a list of `{ name, column }`: outcomes the treatment cannot affect, each a 0/1 event column of the study's
 * patient table), `tippingPoint` (an object with the tipping-point job's own keys: how the missing outcomes are stressed), and the one
 * key only the negative-control job reads (`effectScale`).
 */
const ROBUSTNESS_DECLARATIONS = Object.freeze(["negativeControls", "tippingPoint"]);
const NEGATIVE_CONTROL_ONLY_KEYS = Object.freeze(["effectScale"]);

/** The design with the keys only a robustness stage reads taken out, so that the primary is held to what it reads. @param {Record<string, any>} configuration */
function withoutRobustnessKeys(configuration) {
  const own = { ...configuration };
  const negative = list(configuration.negativeControls).length > 0;
  for (const key of ROBUSTNESS_DECLARATIONS) delete own[key];
  if (negative) for (const key of NEGATIVE_CONTROL_ONLY_KEYS) delete own[key];
  return own;
}

/**
 * Whether the declared robustness analyses can be planned for this endpoint, as a refusal that says what to change, or null.
 * @param {Record<string, any>} configuration @param {string} endpoint
 * @returns {{ code: string, message: string } | null}
 */
function robustnessRefusal(configuration, endpoint) {
  if (configuration.tippingPoint === undefined && !list(configuration.negativeControls).length) return null;
  if (!endpoint) return { code: "vcr_scenario_endpoint_missing", message: "这项比较要知道终点类型：先写研究定义，或在对照设计里写 endpoint.type。" };
  if (configuration.tippingPoint !== undefined && !isObject(configuration.tippingPoint)) {
    return { code: "vcr_job_scenario_invalid", message: "tippingPoint 要写成一个对象：写明缺失结局怎样压力测试（方向、计数或结局列、事件时间终点的视野与偏移）。" };
  }
  if (configuration.tippingPoint !== undefined && endpoint !== "binary" && endpoint !== "time_to_event") {
    return { code: "vcr_job_scenario_invalid", message: `缺失结局的临界点分析只用于二分类和事件时间终点，这个研究的终点是 ${endpoint}。` };
  }
  // A control is a column of the patient table, analysed by the engine with the primary's adjustment. A number the design states in
  // its place would be a result nobody computed (the write path refuses `counts` for the same reason).
  const controls = list(configuration.negativeControls);
  if (controls.some((control) => !isObject(control) || typeof control.name !== "string" || typeof control.column !== "string")) {
    return { code: "vcr_job_scenario_invalid",
      message: "阴性对照每项写 name 和 column：column 是研究数据表里的 0/1 事件列，由引擎按主分析的加权方式计算；自己写的估计值不进研究计划，结果里的数字只来自引擎对授权数据的计算。" };
  }
  return null;
}

/**
 * The negative-control job's candidate scenario, from the design: the design's own adjustment (the weighting its method and estimand
 * name, its covariates and cohort rules) so that "the same adjustment" is the same words, and the outcomes it declared.
 * @param {Record<string, any>} configuration @param {string} endpoint @param {string} estimand
 */
function negativeControlScenario(configuration, endpoint, estimand) {
  const weighting = configuration.weighting ?? (configuration.method === "propensity" || estimand !== "ATT" ? "propensity" : "entropy_balance");
  // The controls are 0/1 event indicators (a risk or odds ratio), whatever the primary's endpoint is: the scenario states no endpoint, and
  // the primary effect is the design's own outcome column when it is binary (the same adjustment, so a calibrated p-value is possible).
  /** @type {Record<string, any>} */
  const scenario = { estimand, weighting, controls: configuration.negativeControls };
  for (const key of ["covariates", "treatmentColumn", "moments", "cohortRules", "effectScale"]) {
    if (configuration[key] !== undefined) scenario[key] = configuration[key];
  }
  if (endpoint === "binary" && typeof configuration.outcomeColumn === "string") scenario.primary = { column: configuration.outcomeColumn };
  return scenario;
}

/**
 * The tipping-point job's candidate scenario: the keys the design declared for it, over the design's own treatment column and cohort
 * rules. The design's endpoint type governs, so a declaration cannot change what kind of endpoint it stresses.
 * @param {Record<string, any>} configuration @param {string} endpoint
 */
function tippingPointScenario(configuration, endpoint) {
  /** @type {Record<string, any>} */
  const shared = {};
  for (const key of ["treatmentColumn", "cohortRules"]) if (configuration[key] !== undefined) shared[key] = configuration[key];
  return { ...shared, ...object(configuration.tippingPoint), endpoint: { ...object(configuration.endpoint), type: endpoint } };
}

/**
 * Whether a tipping-point stage reads the subject table: a binary tipping point given as an outcome column and every time-to-event one.
 * One given as counts reads no patients (a person typed those; the model cannot, the write path refuses `counts`). A negative-control
 * stage always does: its controls are columns.
 * @param {Record<string, any>} scenario
 */
function tippingReadsPatients(scenario) {
  return object(scenario.endpoint).type === "time_to_event" || scenario.outcomeColumn !== undefined;
}

// --- end robustness methods ---

/**
 * How a time-to-event MAIC gets its comparator, from what the design declares: the comparator's published curve
 * (`curve` with `riskTable`) is reconstructed into pseudo-patients by the platform; an anchored design may state
 * the comparator trial's log hazard ratio and standard error instead. The two are never mixed, a single curve
 * is the unanchored comparator, and two curves (`treatmentArm`) are the anchored one's.
 * @param {Record<string, any>} configuration
 * @returns {{ reconstruct: boolean, refused?: undefined } | { refused: string, reconstruct?: undefined }}
 */
function maicTimeToEventPlan(configuration) {
  const anchored = configuration.anchored === true;
  const curve = Array.isArray(configuration.curve) && configuration.curve.length > 0;
  const twoArms = isObject(configuration.treatmentArm);
  const published = configuration.aggregateEstimate != null || configuration.aggregateSe != null;
  if (!anchored) {
    if (!curve) return { refused: "非锚定的事件时间比较需要比较臂的发表曲线（curve 与 riskTable）：平台用它重建伪个体数据，不接受自己写的数据行。" };
    if (twoArms) return { refused: "非锚定比较只重建比较臂的一条曲线；treatmentArm 属于锚定比较（anchored: true）。" };
    if (published) return { refused: "非锚定比较没有已发表的对比可写：aggregateEstimate 与 aggregateSe 属于锚定比较。" };
    return { reconstruct: true };
  }
  if (curve && published) return { refused: "锚定比较的对比臂要么由曲线重建（curve、riskTable、treatmentArm），要么写已发表的风险比对数与标准误（aggregateEstimate、aggregateSe），不能两个都写。" };
  if (curve) {
    return twoArms ? { reconstruct: true }
      : { refused: "锚定比较要重建两个臂：curve 是共同对照臂，treatmentArm 是比较试验的试验臂；或改写已发表的风险比对数与标准误。" };
  }
  if (published) return { reconstruct: false };
  return { refused: "锚定比较要知道对比较试验的对比：写重建用的曲线（curve、riskTable、treatmentArm），或已发表的风险比对数与标准误（aggregateEstimate、aggregateSe）。" };
}

/**
 * Turn an object into the jobs that compute it — or say why it cannot be
 * computed. Pure: everything it reads is in `context`.
 *
 * @param {{ kind: string, row: Record<string, any> }} item
 * @param {{ study: Record<string, any>, definition: Record<string, any> | null, assumptions: readonly Record<string, any>[],
 *   populations?: readonly Record<string, any>[], scenarios?: readonly Record<string, any>[], grid?: Record<string, any> | null,
 *   analytic?: Record<string, any> | null, analyticJob?: Record<string, any> | null, models?: readonly Record<string, any>[] }} context
 * @returns {VcrPlan}
 */
export function vcrBuildStages(item, context) {
  const { row } = item;
  const definition = context.definition;
  const cards = context.assumptions ?? [];
  const endpointDefault = object(definition).endpointType ?? null;

  /**
   * @param {string} jobKind @param {Record<string, any>} candidate @param {Partial<VcrStage> & { endpoint?: string | null, bindAll?: boolean, cards?: readonly Record<string, any>[] }} [options]
   */
  const stage = (jobKind, candidate, options = {}) => {
    const method = /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[jobKind];
    const own = structuredClone(candidate);
    const curveReceiptId = jobKind === "reconstruct_km" ? own.provenance?.receiptId : undefined;
    if (curveReceiptId !== undefined) delete own.provenance.receiptId;
    // A path the object stated itself is the run's; a path only the binder wrote is the
    // platform's. The two are told apart before the binder runs, because what the
    // schema does not read is refused when it was the run's and dropped in silence
    // when it was ours — a Simon design with a 「对照事件率」 card was refused for
    // 「配置里有引擎不读的字段：truth.controlRate」, a key nobody had written.
    const stated = new Set(VCR_ASSUMPTION_BINDINGS.map((rule) => rule.path.join(".")).filter((path) => hasPath(own, path)));
    const bound = options.bindAll === false ? [] : vcrBindAssumptions(own, options.cards ?? cards, options.endpoint ?? object(own.endpoint).type ?? null);
    const { scenario, dropped } = vcrProjectScenario(method, own);
    const injected = new Set(bound.map((entry) => entry.path).filter((path) => !stated.has(path)));
    // What the binder wrote and the method does not read never reached the engine: it
    // is not the run's mistake, and no job used that card's number, so the job does
    // not say it did.
    const unread = new Set(dropped.filter((path) => injected.has(path)));
    const used = bound.filter((entry) => !unread.has(entry.path));
    // Bound assumptions were laid over a copy: the object itself is never edited.
    const unknown = dropped.filter((path) => !unread.has(path) && !VCR_NON_ENGINE_KEYS.includes(lastKey(path)));
    return { built: /** @type {VcrStage} */ ({
      stage: options.stage ?? null, jobKind, scenario, keepTables: options.keepTables ?? [], derived: options.derived ?? [],
      snapshot: options.snapshot ?? VCR_PATIENT_LEVEL_JOB_KINDS.includes(jobKind), after: options.after ?? null, bound: used,
      detail: { ...(options.detail ?? {}), ...(curveReceiptId !== undefined ? { curveReceiptId } : {}) },
    }), unknown };
  };
  /** @param {Array<{ built: VcrStage, unknown: string[] }>} built @returns {VcrPlan} */
  const finish = (built) => {
    // A key is unknown only when no stage of the plan reads it: a design states
    // the superset (`analysis.power` for the analytic stage, `targetMcse` for the
    // simulation), and each stage keeps what its own schema takes.
    const unknown = built.length ? built[0].unknown.filter((path) => built.every((entry) => entry.unknown.includes(path))) : [];
    if (unknown.length) return { ok: false, refused: unknownFieldsRefusal(unknown, built.map((entry) => entry.built)) };
    return { ok: true, stages: built.map((entry) => entry.built) };
  };

  // --- robustness methods ---
  /**
   * The robustness analyses the design declares beside its primary comparison, as stages, or the refusal that says what to change.
   * What one of them does not read is the declaration's own (the design-level keys it takes are ones its schema reads), so it is
   * refused by name rather than ignored.
   * @param {Record<string, any>} configuration @param {string} endpoint @param {string} estimand
   * @returns {{ refused: { code: string, message: string, paths?: string[] }, extras?: undefined } | { extras: Array<{ built: VcrStage, unknown: string[] }>, refused?: undefined }}
   */
  const robustnessStages = (configuration, endpoint, estimand) => {
    const refused = robustnessRefusal(configuration, endpoint);
    if (refused) return { refused };
    /** @type {Array<{ built: VcrStage, unknown: string[] }>} */
    const extras = [];
    if (list(configuration.negativeControls).length) {
      const scenario = negativeControlScenario(configuration, endpoint, estimand);
      extras.push(stage("negative_control_comparator", scenario, { stage: "negative_control", endpoint, bindAll: false, snapshot: true }));
    }
    if (isObject(configuration.tippingPoint)) {
      const scenario = tippingPointScenario(configuration, endpoint);
      extras.push(stage("tipping_point", scenario, { stage: "tipping_point", endpoint, bindAll: false,
        snapshot: tippingReadsPatients(scenario) }));
    }
    const unknown = extras.flatMap((entry) => entry.unknown);
    return unknown.length ? { refused: unknownFieldsRefusal(unknown, extras.map((entry) => entry.built)) } : { extras };
  };
  /**
   * The primary comparison held to the keys it reads (finish), with the robustness stages after it. A plan with robustness stages names
   * its primary stage, so that each stage's result is told apart when they are filed as one.
   * @param {string} jobKind @param {Record<string, any>} candidate @param {string | null} endpoint
   * @param {Array<{ built: VcrStage, unknown: string[] }>} extras
   * @returns {VcrPlan}
   */
  const finishWithRobustness = (jobKind, candidate, endpoint, extras) => {
    const checked = finish([stage(jobKind, candidate, { endpoint, bindAll: false, ...(extras.length ? { stage: "primary" } : {}) })]);
    if (!checked.ok || !extras.length) return checked;
    return { ok: true, stages: [...checked.stages, ...extras.map((entry) => entry.built)] };
  };
  // --- end robustness methods ---

  if (item.kind === "population") {
    const jobKind = vcrJobKindFor("population", row);
    const kind = String(row.kind);
    return finish([stage(jobKind, { ...object(row.definition) }, {
      bindAll: false, keepTables: kind === "scenario" || kind === "literature" ? ["population"] : [],
    })]);
  }

  if (item.kind === "patient_set") {
    const scenario = { ...object(row.scenario) };
    const type = object(scenario.endpoint).type ?? endpointDefault;
    if (!type) return { ok: false, refused: { code: "vcr_scenario_endpoint_missing", message: "虚拟患者集要知道终点类型：先写研究定义，或在场景里写 endpoint.type。" } };
    scenario.endpoint = { ...object(scenario.endpoint), type };
    const jobKind = patientKindOf(scenario, type);
    // A model answers only for what it declares it covers. A patient set that names a model
    // the study is outside of is refused before any job is queued, with what fell outside
    // (the reference simulators declare an endpoint and nothing else, so they pass).
    if (row.modelVersion && !row.modelId) return { ok: false, refused: { code: "vcr_model_not_found", message: "模型版本必须绑定明确的模型，其他研究结果继续保留。" } };
    if (row.modelId) {
      const models = context.models ?? [];
      const exact = models.filter((model) => model.id === row.modelId && (!row.modelVersion || model.version === row.modelVersion));
      const matches = exact.length ? exact : models.filter((model) => model.name === row.modelId && (!row.modelVersion || model.version === row.modelVersion));
      const named = matches.length === 1 ? matches[0] : null;
      if (!named) return { ok: false, refused: { code: "vcr_model_not_found", message: "选定模型的确切版本已不可用；这一步不使用替代模型，其他研究结果继续保留。" } };
      // A model of a call shape this deployment has no executor for is not run through a generator that is not that model.
      const shape = vcrModelInterfaceOf(named);
      if (shape !== null && !VCR_HOSTED_MODEL_INTERFACES.includes(shape)) {
        const word = /** @type {Record<string, string>} */ (VCR_MODEL_INTERFACE_LABELS_ZH)[shape] ?? shape;
        return { ok: false, refused: { code: "vcr_model_interface_not_hosted",
          message: `模型「${named.name}」用的是「${word}」接口：这个部署还没有接入能执行这类接口的模型包，这一步不用替代模型，其他研究结果继续保留。` } };
      }
      const population = row.populationId ? (context.populations ?? []).find((entry) => entry.id === row.populationId) : null;
      const issues = named ? vcrModelApplicabilityIssues(named, { endpointType: String(type), variables: vcrPopulationVariables(population) }) : [];
      if (issues.length) {
        return { ok: false, refused: { code: "vcr_model_not_applicable", paths: issues.map((issue) => issue.field),
          message: `模型「${named?.name}」的适用范围没有覆盖这个研究：${issues.map((issue) => issue.text).join("；")}。换一个适用的模型，或先补齐这些条件。` } };
      }
    }
    /** @type {VcrStage["derived"]} */
    const derived = [];
    if (row.populationId) {
      const population = (context.populations ?? []).find((entry) => entry.id === row.populationId);
      if (!population?.resultId) return { ok: false, waiting: "population_pending" };
      derived.push({ from: "object", table: "population" });
    }
    // The trajectory model's `effect` is a change per time unit, not the difference an outcome card holds: no card is bound into it.
    const built = stage(jobKind, scenario, { endpoint: String(type), derived, keepTables: ["virtual-patients"], snapshot: false,
      bindAll: jobKind !== "generate_patients_longitudinal", detail: { modelId: row.modelId ?? null, modelVersion: row.modelVersion ?? null } });
    return finish([built]);
  }

  if (item.kind === "comparator") {
    const route = String(row.route);
    const verdict = routeVerdict(route, String(context.study.dataTier));
    if (verdict) return { ok: false, unavailable: verdict };
    const configuration = { ...object(row.configuration) };
    const type = object(configuration.endpoint).type ?? endpointDefault;
    const estimand = String(row.estimand ?? "ATT");
    if (route === "literature_control") {
      if (configuration.method === "maic" && type === "time_to_event") {
        const plan = maicTimeToEventPlan(configuration);
        if (plan.refused) return { ok: false, refused: { code: "vcr_job_scenario_invalid", message: plan.refused } };
        const study = { ...configuration, endpoint: { ...object(configuration.endpoint), type } };
        // The comparator's patients are the reconstruction's pseudo-patients, handed to the MAIC by the result that wrote them.
        if (!plan.reconstruct) return finish([stage("maic_time_to_event_comparator", study, { endpoint: type, snapshot: true, bindAll: false })]);
        return finish([
          stage("reconstruct_km", configuration, { stage: "reconstruct", bindAll: false, snapshot: false, keepTables: ["reconstructed-ipd"] }),
          stage("maic_time_to_event_comparator", study, { stage: "maic", endpoint: type, snapshot: true, bindAll: false, after: "reconstruct",
            derived: [{ from: "stage", stage: "reconstruct", table: "reconstructed-ipd", bindTo: "pseudoIpdInputId" }] }),
        ]);
      }
      if (configuration.method === "maic") {
        return finish([stage("maic_comparator", { ...configuration, endpoint: { ...object(configuration.endpoint), type } }, { endpoint: type, snapshot: true, bindAll: false })]);
      }
      const twoArms = isObject(configuration.treatmentArm);
      /** @type {Array<{ built: VcrStage, unknown: string[] }>} */
      const stages = [stage("reconstruct_km", configuration, { stage: "reconstruct", bindAll: false, snapshot: false, keepTables: ["reconstructed-ipd"] })];
      // A single reconstructed arm is a benchmark, not a comparison: there is
      // nothing to subtract, and the RMST job says so if it is asked.
      if (twoArms) {
        stages.push(stage("rmst", configuration, { stage: "rmst", bindAll: false, snapshot: false, after: "reconstruct",
          derived: [{ from: "stage", stage: "reconstruct", table: "reconstructed-ipd" }] }));
      }
      return finish(stages);
    }
    if (route === "hybrid_control") return finish([stage("map_prior", configuration, { bindAll: false })]);
    if (route === "prognostic_adjustment") {
      // --- robustness methods ---
      if (vcrJobKindFor("comparator", row, { definition }) === "prognostic_adjustment_comparator") {
        const robust = robustnessStages(configuration, String(type ?? ""), estimand);
        if (robust.refused) return { ok: false, refused: robust.refused };
        return finishWithRobustness("prognostic_adjustment_comparator", { ...withoutRobustnessKeys(configuration), endpoint: { ...object(configuration.endpoint), type } },
          String(type ?? ""), robust.extras);
      }
      if (type && type !== "continuous") {
        return { ok: false, refused: { code: "vcr_job_scenario_invalid",
          message: `终点是 ${type}：二分类和事件时间终点的预后协变量调整要先写预后评分所在的列（prognosticScoreColumn）；设计期功效的 PROCOVA 只用于连续终点。` } };
      }
      // --- end robustness methods ---
      return finish([stage("procova", { ...configuration, endpoint: { ...object(configuration.endpoint), type: type ?? "continuous" } }, { endpoint: "continuous", snapshot: false })]);
    }
    if (route === "external_control") {
      const jobKind = /** @type {string} */ (vcrJobKindFor("comparator", row, { definition }));
      const refused = externalControlRefusal(jobKind, configuration, String(type ?? ""), estimand);
      if (refused) return { ok: false, refused };
      // --- robustness methods ---
      const robust = robustnessStages(configuration, String(type ?? ""), estimand);
      if (robust.refused) return { ok: false, refused: robust.refused };
      // --- end robustness methods ---
      /** @type {Record<string, any>} */
      const candidate = { ...withoutRobustnessKeys(configuration), estimand, endpoint: { ...object(configuration.endpoint), type } };
      // The analysis a covariate-set comparison re-runs is the design's own method, written by code from it and never typed in.
      if (jobKind === "covariate_set_comparator") candidate.analysis = covariateSetAnalysis(configuration, estimand);
      // A Cox model under another estimand than the ATT is weighted by the propensity score, as the weighting jobs are.
      if (jobKind === "weighted_cox_comparator" && estimand !== "ATT" && candidate.weighting === undefined) candidate.weighting = "propensity";
      return finishWithRobustness(jobKind, candidate, type ?? null, robust.extras);
    }
    return { ok: false, unavailable: { rule: "route_unavailable_in_version", reason: "route_unavailable", gaps: [ROUTE_GAPS.model_comparator] } };
  }

  if (item.kind === "trial_scenario") {
    const configuration = object(row.configuration);
    const type = String(row.endpointType);
    const design = { ...object(configuration.design), kind: row.design };
    const base = /** @type {Record<string, any>} */ ({ ...configuration, design, endpoint: { ...object(configuration.endpoint), type } });
    const used = list(row.assumptionIds).length
      ? cards.filter((card) => list(row.assumptionIds).includes(card.key) || list(row.assumptionIds).includes(card.id))
      : cards;
    /** @param {string} method */
    const supports = (method) => Boolean(/** @type {Record<string, Record<string, readonly string[]>>} */ (VCR_DESIGN_SUPPORT)[method]?.[String(row.design)]?.includes(type));
    /** @type {Array<{ built: VcrStage, unknown: string[] }>} */
    const stages = [];
    const simon = row.design === "simon_two_stage" && type === "binary";
    const statedBoundary = simon && ["n1", "n", "r1", "r"].every((key) => Number.isSafeInteger(design[key]));
    if (supports("design.analytic") && !statedBoundary) stages.push(stage("design_analytic", base, { stage: "analytic", endpoint: type, cards: used, snapshot: false }));
    if (simon) {
      const waiting = () => finish([...stages, stage("design_simulation", base, { stage: "simulation", endpoint: type,
        cards: used, snapshot: false, after: "analytic", detail: { awaitingAnalytic: true } })]);
      const selection = configuration.simonSelection ?? "optimal";
      if (!["optimal", "minimax"].includes(selection) || (configuration.analysis?.sided != null && configuration.analysis.sided !== 1)) {
        return { ok: false, refused: { code: "vcr_job_scenario_invalid", message: "Simon 两阶段只使用声明的单侧上尾判定；设计选择须为 optimal 或 minimax。" } };
      }
      const chosen = statedBoundary ? design : object(object(context.analytic?.diagnostics).simon)[selection];
      if (chosen && ["n1", "n", "r1", "r"].every((key) => Number.isSafeInteger(chosen[key]))) {
        const source = statedBoundary ? null : {
          resultId: context.analytic?.id, resultVersion: context.analytic?.version, executionId: context.analytic?.executionId,
          jobId: context.analyticJob?.id, methodVersion: context.analyticJob?.methodVersion,
          scenarioHash: context.analyticJob?.scenarioHash, selection,
        };
        if (source && (!source.resultId || !Number.isSafeInteger(source.resultVersion) || !source.executionId
          || !source.jobId || !source.methodVersion || !/^[a-f0-9]{64}$/.test(String(source.scenarioHash)))) {
          return waiting();
        }
        const truth = object(base.truth);
        const laws = truth.responseRate != null ? [truth.responseRate]
          : typeof truth.null === "boolean" ? [truth.null ? truth.nullRate : truth.alternativeRate]
            : [truth.nullRate, truth.alternativeRate];
        for (const responseRate of laws) {
          const nullLaw = responseRate === truth.nullRate;
          const candidate = { ...base, design: { kind: "simon_two_stage", ...Object.fromEntries(["n1", "n", "r1", "r"].map((key) => [key, chosen[key]])) },
            truth: { ...truth, responseRate }, analysis: { ...object(base.analysis), method: "simon_boundary", sided: 1 } };
          stages.push(stage("design_simulation", candidate, { stage: nullLaw ? "simulation_null" : "simulation", endpoint: type,
            cards: used, snapshot: false, after: source ? "analytic" : null,
            detail: { simonSelection: statedBoundary ? "declared" : selection, ...(source ? { analyticSource: source } : {}) } }));
        }
      } else {
        if (context.analyticJob?.state === "succeeded") {
          return { ok: false, refused: { code: "vcr_job_scenario_invalid", message: "当前样本量范围内没有满足所声明错误率和把握度的 Simon 设计；解析结果已保留。" } };
        }
        return waiting();
      }
    } else if (supports("design.simulate")) stages.push(stage("design_simulation", base, { stage: "simulation", endpoint: type, cards: used, snapshot: false }));
    if (!stages.length) {
      return { ok: false, unavailable: { rule: "route_unavailable_in_version", reason: "design_not_supported", gaps: [{
        title: `${row.design} 设计在当前版本的引擎里没有实现`,
        detail: `当前支持固定样本两组比较（三类终点）、成组序贯（事件时间），单臂试验（二分类的精确检验，连续和事件时间终点对固定基准的单样本检验），以及二分类的分层历史对照和 Simon 两阶段；${row.design} 与 ${type} 的这个组合尚未实现。`,
        answers: "改用引擎支持的设计并排比较，或等这个设计完成数值验证后再算。" }] } };
    }
    // Assurance integrates power over the design prior the effect's card states.
    const prior = supports("design.assurance") ? vcrDesignPriorFrom(used, type) : null;
    if (prior) {
      const events = type === "time_to_event"
        ? Math.ceil(Number(configuration.design?.events ?? findMeasure(context.analytic, "required_events") ?? Number.NaN)) : null;
      if (type !== "time_to_event" || Number.isFinite(events)) {
        const assuranceBase = { ...base, design: { ...design, ...(events ? { events } : {}) }, designPrior: prior.prior };
        // The design prior is the effect card's own distribution; the effect's point value
        // is a scenario, not an input of this integral. What it does read from the cards is
        // the scale the effect is measured on — the outcome's standard deviation, the
        // control rate — and the binder lays those over the design's own, exactly as it
        // does for the fixed-sample stages (a continuous design's assurance used to be
        // computed on a standard deviation of 1 or refused for want of a `truth`).
        stages.push(stage("assurance", assuranceBase, { stage: "assurance", endpoint: type, cards: used, snapshot: false,
          after: type === "time_to_event" && !configuration.design?.events ? "analytic" : null }));
      }
    }
    return finish(stages);
  }

  if (item.kind === "design_grid") {
    const dimensions = object(row.dimensions);
    const first = context.scenarios?.[0] ? object(context.scenarios[0].configuration) : {};
    const baseConfig = isObject(dimensions.base) ? dimensions.base : first;
    const type = object(baseConfig.endpoint).type ?? (context.scenarios?.[0]?.endpointType ?? endpointDefault);
    const designs = list(dimensions.designs).map((entry) => stripLabels(entry));
    const truths = list(row.truthScenarios).map((entry) => stripLabels(entry));
    if (!designs.length || !truths.length) {
      return { ok: false, refused: { code: "vcr_scenario_grid_empty", message: "设计网格要写明设计列表（dimensions.designs）和真值情景列表（truthScenarios）。" } };
    }
    const candidate = { ...baseConfig, endpoint: { ...object(baseConfig.endpoint), type }, design: { ...object(baseConfig.design), ...designs[0] },
      truth: { ...object(baseConfig.truth), ...truths[0] }, designs, truths };
    return finish([stage("design_grid", candidate, { endpoint: type, snapshot: false })]);
  }

  return { ok: false, refused: { code: "vcr_object_unknown", message: `不认识的对象：${item.kind}` } };
}

/** An entry of a grid's lists without the words a page shows it by. @param {unknown} entry */
function stripLabels(entry) {
  const { label: _label, name: _name, ...rest } = object(entry);
  return rest;
}

/** The value of one measure of a stored result, or undefined. @param {Record<string, any> | null | undefined} result @param {string} name */
function findMeasure(result, name) {
  const found = list(result?.measures).find((measure) => object(measure).name === name);
  const value = Number(object(found).value);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Where two key assumptions cannot both hold, said by closed-form identities
 * and by a card contradicting its own range (plan §10.4: 「关键假设之间冲突」).
 * Deterministic — no model judges whether two numbers agree. Every finding
 * names the cards (and versions) it rests on, which is also what keys its
 * notice: the same conflict is one notice, a changed card is a new one.
 * @param {readonly Record<string, any>[]} cards
 * @returns {Array<{ code: string, keys: string[], versions: string[], detail: string }>}
 */
export function vcrAssumptionConflicts(cards) {
  /** @type {Array<{ code: string, keys: string[], versions: string[], detail: string }>} */
  const found = [];
  const point = (/** @type {RegExp} */ pattern) => cards.find((card) => pattern.test(String(card.key)) && Number.isFinite(Number(card.pointValue)) && card.pointValue !== null);
  const tag = (/** @type {Record<string, any>[]} */ used) => used.map((card) => `${card.key}@${card.version}`);
  for (const card of cards) {
    const range = object(object(card.distribution).range ?? object(card.sensitivity).range);
    const value = Number(card.pointValue);
    if (card.pointValue !== null && card.pointValue !== undefined && Number.isFinite(value) && Number.isFinite(Number(range.low)) && Number.isFinite(Number(range.high))
      && (value < Number(range.low) || value > Number(range.high))) {
      found.push({ code: "point_outside_range", keys: [String(card.key)], versions: tag([card]),
        detail: `「${card.name || card.key}」的设定值 ${value} 落在它自己声明的范围 ${range.low}–${range.high} 之外` });
    }
  }
  const hazard = point(/^hazard_ratio(?:_|$)/);
  const control = point(/^control_median/);
  const treatment = point(/^treatment_median/);
  if (hazard && control && treatment && Number(hazard.pointValue) > 0 && Number(treatment.pointValue) > 0 && Number(control.pointValue) > 0) {
    const implied = Number(control.pointValue) / Number(treatment.pointValue);
    if (Math.abs(Math.log(implied / Number(hazard.pointValue))) > Math.log(1.15)) {
      found.push({ code: "hazard_ratio_vs_medians", keys: [String(hazard.key), String(control.key), String(treatment.key)], versions: tag([hazard, control, treatment]),
        detail: `两组中位数（${control.pointValue}、${treatment.pointValue}）推出的风险比约 ${Math.round(implied * 1000) / 1000}，和设定的风险比 ${hazard.pointValue} 差得超过 15%` });
    }
  }
  const pc = point(/^(?:control_event_rate|control_rate|control_response_rate)$/);
  const pt = point(/^(?:treatment_event_rate|treatment_rate|treatment_response_rate)$/);
  const rd = point(/^risk_difference$/);
  if (pc && pt && rd && Math.abs(Number(pt.pointValue) - Number(pc.pointValue) - Number(rd.pointValue)) > 0.02) {
    found.push({ code: "risk_difference_vs_rates", keys: [String(pc.key), String(pt.key), String(rd.key)], versions: tag([pc, pt, rd]),
      detail: `两组的率之差 ${Math.round((Number(pt.pointValue) - Number(pc.pointValue)) * 1000) / 1000} 和设定的风险差 ${rd.pointValue} 不一致` });
  }
  return found;
}

/**
 * The gaps a stored `not_estimable` result names, by the rule that fired: what
 * is missing and what would answer it (plan §3.6). Fixed sentences — the rule is
 * the engine's, and the words are the platform's.
 * @param {string} rule
 */
export function vcrGapsForRule(rule) {
  /** @type {Record<string, { title: string, detail: string, answers: string }>} */
  const table = {
    entropy_balance_infeasible: { title: "试验人群与外部对照不重叠", detail: "试验人群的协变量均值落在外部对照的范围之外，加权无解。", answers: "换一个与试验人群更接近的外部数据源，或放宽入排标准后再比。" },
    outside_common_support: { title: "共同支持域外的人太多", detail: "试验人群里有相当比例在外部对照的倾向得分范围之外。", answers: "补充覆盖这部分人群的外部数据，或收窄目标人群。" },
    effective_sample_size_below_floor: { title: "加权后有效样本量太低", detail: "加权后外部对照的有效样本量低于下限，估计不稳。", answers: "补充更多可比的外部患者。" },
    standardized_difference_above_floor: { title: "加权后关键协变量仍不平衡", detail: "至少一个关键协变量加权后的标准化差异不低于 0.1。", answers: "换协变量集、补充数据，或承认这两群人不可比。" },
    tau_beyond_followup: { title: "限制平均生存时间的时点超过了随访", detail: "所选时点比某一组最长的随访还长。", answers: "把时点缩到报告里给出的最大可用时点以内，或补充随访更长的数据。" },
    too_few_events: { title: "某一组没有事件，风险比不存在", detail: "有一组一个事件都没有，或 Cox 模型没有收敛，风险比无法估计。", answers: "延长随访或补充事件更多的数据；也可以改看不依赖事件数的指标，如限制平均生存时间的差。" },
    nuisance_model_not_estimable: { title: "倾向性模型或结局模型拟合不出来", detail: "协变量之间高度共线，或外部对照的人数不足以拟合结局模型的全部系数。", answers: "删去重复或共线的协变量，减少结局模型里的项，或补充更多外部对照患者。" },
    reconstruction_failed_qc: { title: "重建的曲线没有通过质控", detail: "重建出的风险人数、事件数、中位数或风险比与原文对不上。", answers: "重新数字化曲线并核对风险人数表，或换一篇报告完整的文献。" },
    map_prior_conflict: { title: "历史信息与当前数据冲突", detail: "MAP 先验与当前对照组数据的冲突检验越界。", answers: "检查历史研究与本研究人群是否可比，或降低借用权重。" },
    // The two the control plane derives before any job: they carry the route's
    // own gap where one is known (`ROUTE_GAPS`); these are the general sentences.
    data_tier_insufficient: { title: "现有数据不够走这条路线", detail: "研究现在的数据档位达不到这条对照路线需要的档位。", answers: "补上这条路线需要的数据后再算，或先用对数据要求更低的路线。" },
    route_unavailable_in_version: { title: "这条路线在当前版本还没有方法", detail: "模型预测对照需要一个声明了适用范围的模型包，当前版本还没有可用的实现。", answers: "改用文献对照或外部对照；模型包上线后可以回到这条路线。" },
    // robustness methods (2026-10-04)
    negative_controls_not_estimable: { title: "没有一个阴性对照能得出估计", detail: "每个阴性对照结局都有一组没有事件，或没有提供可用的数据，算不出效应。", answers: "换事件更多的阴性对照结局，或用随访更长的数据。" },
    primary_analysis_not_estimable: { title: "这项分析本身的主要估计不存在", detail: "某一组没有事件或没有人，或模型没有收敛，或预后评分没有变异，主要估计算不出来。", answers: "补充事件或样本，或换一个有变异的预后评分。" },
    // end robustness methods
  };
  return table[rule] ? [table[rule]] : [];
}

/**
 * How long a study's results must have stood still before an advisory review of
 * them is queued, and how recent they must be to be reviewed at all.
 *
 * Hidden knowledge: a review is two paid calls of a minute or more each over the
 * whole frozen study, and a study's results change in bursts — an assumption is
 * edited, the light half recomputes at once and the heavy half queues behind it,
 * and each time the queue drained a review of that moment was asked for. On
 * 2026-10-04 one project held sixteen distinct snapshots reviewed this way, nearly
 * all of them states a later one replaced a few minutes on. A review exists to
 * give a second opinion on what the study concluded, so it is asked of the state
 * the study settles into: results older than the quiet period, none newer than the
 * last review, no work open. A study with no review at all is not reviewed from
 * the day this shipped, only when it produces something (a day's freshness): an
 * old study never costs two calls for being opened.
 */
export const VCR_REVIEW_QUIET_MS = 10 * 60_000;
export const VCR_REVIEW_FRESH_MS = 24 * 3_600_000;

/**
 * Whether a study's results have settled and are not yet reviewed. Pure: the
 * orchestrator reads the three times and decides here.
 * @param {{ lastResultAt: unknown, lastReviewAt: unknown, now: Date, quietMs?: number, freshMs?: number }} input
 */
export function vcrReviewDue({ lastResultAt, lastReviewAt, now, quietMs = VCR_REVIEW_QUIET_MS, freshMs = VCR_REVIEW_FRESH_MS }) {
  const result = lastResultAt ? new Date(/** @type {any} */ (lastResultAt)).getTime() : NaN;
  if (!Number.isFinite(result)) return false;
  const review = lastReviewAt ? new Date(/** @type {any} */ (lastReviewAt)).getTime() : -Infinity;
  const at = now.getTime();
  return result > review && at - result >= quietMs && at - result <= freshMs;
}

export class VcrOrchestrator {
  /**
   * @param {{ store: import("./vcrStore.mjs").VcrStore, jobs: import("./vcrJobs.mjs").VcrJobs, config?: Record<string, any>,
   *   notifier?: any, seal?: any, queueExport?: any, queueReviews?: ((studyId:string, options?:Record<string,any>) => Promise<unknown>) | null,
   *   dispatchRun?: ((input: { userId: string, projectId: string, studyId: string, capabilityId: string, dispatchId: string,
   *     reason: string, brief: string, products?: string[] }) => Promise<{ runId: string, sessionId: string | null, status?: string | null }>) | null,
   *   latestSessionId?: ((input: { userId: string, projectId: string }) => Promise<string | null>) | null,
   *   briefFor?: ((input: { study: any, key: string, scope: string[], detail: Record<string, any>,
   *     fidelity: (step: string) => string }) => string | Promise<string>) | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   */
  constructor({ store, jobs, config = {}, notifier = null, seal = null, queueExport = null, queueReviews = null, dispatchRun = null, latestSessionId = null,
    briefFor = null, now = () => new Date(), report = () => {} }) {
    if (!store) throw new TypeError("The VCR orchestrator needs the VCR store.");
    if (!jobs) throw new TypeError("The VCR orchestrator needs the VCR job queue.");
    this.store = store;
    this.jobs = jobs;
    this.config = config;
    this.notifier = notifier;
    this.seal = seal;
    this.queueExport = queueExport;
    this.queueReviews = queueReviews;
    this.dispatchRun = dispatchRun;
    this.latestSessionId = latestSessionId;
    this.briefFor = briefFor;
    this.now = now;
    this.report = report;
    this.owner = `vcr-${process.pid}-${randomId().slice(0, 12)}`;
    // A cancel reaches the module from the routes and from the runtime's own tool;
    // a job finished by the worker is told to the orchestrator by the worker.
    if (typeof this.jobs.addFinishHook === "function") {
      this.jobs.addFinishHook(async (/** @type {any} */ outcome) => {
        if (outcome?.state === "canceled" && outcome.job) await this.onJobFinished({ job: outcome.job, result: null });
      });
    }
    this.leaseSeconds = Math.max(60, Math.round(Number(config.vcrLeaseMs ?? 900_000) / 1000));
    /** @type {Map<string, Promise<unknown>>} one advance per study at a time, in this process */
    this.locks = new Map();
    /** @type {Map<string, number>} when a settled-review request was last attempted for a study, so a review that cannot be queued is not rebuilt every tick */
    this.reviewAttempts = new Map();
    this.counters = { ticks: 0, dispatched: 0, deferred: 0, dispatchFailed: 0, runsFinished: 0, jobsEnqueued: 0,
      jobsSkipped: 0, recomputes: 0, notices: 0, studyErrors: 0, verdicts: 0, evidenceRefreshes: 0 };
    /** @type {string | null} */
    this.lastDeferral = null;
    /** @type {string | null} */
    this.lastError = null;
    /** @type {string | null} */
    this.lastTickAt = null;
  }

  status() {
    return {
      dispatch: this.dispatchRun ? "wired" : "missing",
      engine: this.jobs.engine?.configured?.() ? "wired" : "missing",
      lastTickAt: this.lastTickAt, lastDeferral: this.lastDeferral, lastError: this.lastError,
      counters: { ...this.counters },
    };
  }

  // --- the worker's cross-process lease -----------------------------------------------

  /**
   * Run `work` holding one loop's lease. A session advisory lock on its own
   * connection: another control plane, or a tick that outlived its interval
   * here, answers `{ acquired: false }` and nothing runs twice. Without a
   * database that hands out clients (a unit test's double) the work runs
   * unleased — a single-process test needs no lock.
   * @param {string} loop @param {() => Promise<unknown>} work
   */
  async leaseLoop(loop, work) {
    const database = /** @type {any} */ (this.store).database;
    if (typeof database?.withClient !== "function") return { acquired: true, value: await work() };
    return database.withClient(async (/** @type {any} */ client) => {
      const got = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [`evimed-vcr-loop:${loop}`]);
      if (got.rows[0]?.held !== true) return { acquired: false };
      try {
        return { acquired: true, value: await work() };
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`evimed-vcr-loop:${loop}`]).catch(() => {});
      }
    });
  }

  // --- marks -----------------------------------------------------------------------

  /** @param {string} studyId @param {string} key */
  async #mark(studyId, key) {
    return this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND key = $2`, [studyId, key]);
  }

  /**
   * Insert a mark unless its key exists; a `claimed` mark left stale (a
   * process that died mid-claim) is taken over. Returns the row when this
   * caller holds it.
   * @param {any} study @param {string} key @param {string} kind @param {string} state
   * @param {{ step?: string | null, jobId?: string | null, detail?: Record<string, any> }} [fields]
   */
  async #claim(study, key, kind, state, fields = {}) {
    return this.store.one(`INSERT INTO ${VCR_SCHEMA}.schedule_marks (study_id, key, user_id, kind, state, step, job_id, detail, done_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CASE WHEN $5 IN ('done', 'failed', 'skipped') THEN now() END)
      ON CONFLICT (study_id, key) DO UPDATE SET state = EXCLUDED.state, detail = schedule_marks.detail || EXCLUDED.detail, updated_at = now()
        WHERE schedule_marks.state = 'claimed' AND schedule_marks.updated_at < now() - make_interval(mins => $9)
      RETURNING *`,
    [study.id, key, study.userId, kind, state, fields.step ?? null, fields.jobId ?? null,
      JSON.stringify(fields.detail ?? {}), VCR_RUN_RULES.staleClaimMinutes]);
  }

  /**
   * Move a mark; only out of the states given when any are.
   * @param {string} studyId @param {string} key
   * @param {{ state?: string, runId?: string | null, sessionId?: string | null, dispatchId?: string | null,
   *   jobId?: string | null, attempts?: number, detail?: Record<string, any> }} patch @param {readonly string[]} [from]
   */
  async #update(studyId, key, patch, from) {
    /** @type {string[]} */
    const sets = [];
    /** @type {unknown[]} */
    const values = [studyId, key];
    const put = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.state !== undefined) {
      put("state", patch.state);
      sets.push(`done_at = CASE WHEN $${values.length} IN ('done', 'failed', 'skipped') THEN now() ELSE NULL END`);
    }
    if (patch.runId !== undefined) put("run_id", patch.runId);
    if (patch.sessionId !== undefined) put("session_id", patch.sessionId);
    if (patch.dispatchId !== undefined) put("dispatch_id", patch.dispatchId);
    if (patch.jobId !== undefined) put("job_id", patch.jobId);
    if (patch.attempts !== undefined) put("attempts", patch.attempts);
    if (patch.detail !== undefined) { values.push(JSON.stringify(patch.detail)); sets.push(`detail = detail || $${values.length}::jsonb`); }
    let guard = "";
    if (from?.length) { values.push([...from]); guard = ` AND state = ANY($${values.length}::text[])`; }
    return this.store.one(`UPDATE ${VCR_SCHEMA}.schedule_marks SET ${[...sets, "updated_at = now()"].join(", ")}
      WHERE study_id = $1 AND key = $2${guard} RETURNING *`, values);
  }

  /** @param {string} studyId @param {() => Promise<any>} work */
  async #exclusive(studyId, work) {
    const previous = this.locks.get(studyId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    this.locks.set(studyId, settled);
    try { return await next; } finally { if (this.locks.get(studyId) === settled) this.locks.delete(studyId); }
  }

  /** @param {any} study @param {string} step @param {Record<string, any>} fields */
  async #step(study, step, fields) {
    const current = object(study.steps?.[step]);
    const changed = Object.entries(fields).some(([key, value]) => (current[key] ?? null) !== (value ?? null));
    if (!changed) return study;
    return (await this.store.setStep(study.id, step, fields)) ?? study;
  }

  // --- the route hooks ---------------------------------------------------------------

  /** Review-only conversion, with no research dispatch or scientific model replacement.
   * @param {string} studyId @param {any} input */
  async requestReviewExportRefresh(studyId, input) {
    if (!this.queueExport) return { skipped: "conversion_unavailable" };
    const proof = await this.store.reportSnapshot(snapshot => readVcrReviewExportProof(snapshot, studyId, input));
    if (!proof || proof.study.status !== "active") return { skipped: "review_proof_stale" };
    const id = studyReviewDigest({ reportRevision: input.reportRevision, sourceDigest: input.sourceDigest,
      configurationDigest: input.configurationDigest, reviewIds: proof.records.map(row => row.platformReviewId).sort() });
    const row = await this.store.updateExportCover(proof.exported.id, async (cover, snapshot) => {
      if (vcrReportReviewRevision(cover) !== input.reportRevision || cover.reviewDocumentRefresh?.id === id) return cover;
      const current = await readVcrReviewExportProof(snapshot, studyId, input);
      if (!current) return cover;
      return { ...cover, reviewDocumentRefresh: { id, state: "pending", exportId: current.exported.id,
        sourceDigest: input.sourceDigest, configurationDigest: input.configurationDigest, reportRevision: input.reportRevision,
        reviewIds: current.records.map(record => record.platformReviewId), records: current.records,
        baseConversion: cover.documentExportId ? { id: cover.documentExportId, sourceRevision: cover.documentExportSourceRevision } : null } };
    });
    if (row?.cover.reviewDocumentRefresh?.id !== id) return { skipped: "report_changed" };
    if (row.cover.reviewDocumentRefresh.state === "pending") {
      try { await this.queueExport({ id: proof.study.userId }, proof.study, row); }
      catch (error) { this.report(codeOf(error)); }
    }
    return { queued: row.cover.reviewDocumentRefresh.state === "pending" };
  }

  /** Resume conversions after a worker restart using the existing study loop.
   * @param {any} study */
  async #refreshReviewExports(study) {
    if (!this.queueExport) return;
    const pending = this.store.pendingReviewExports ? await this.store.pendingReviewExports(study.id)
      : (await this.store.exports(study.id)).filter(item => item.cover.reviewDocumentRefresh?.state === "pending");
    for (const row of pending) {
      try { await this.queueExport({ id: study.userId }, study, row); }
      catch (error) { this.report(codeOf(error)); }
    }
  }

  /** Queue advisory review only after the current calculations have settled.
   * @param {string} studyId @param {Record<string,any>} [options] */
  async #queueReview(studyId, options = {}) {
    if (!this.queueReviews) return;
    try {
      const open = await this.store.one(`SELECT 1 FROM ${VCR_SCHEMA}.jobs WHERE study_id=$1 AND state IN ('queued','running','awaiting_budget') LIMIT 1`, [studyId]);
      if (open || (await this.store.staleMarks(studyId)).length) return;
      await this.queueReviews(studyId, options);
    } catch (error) { this.report(codeOf(error)); }
  }

  /** A trusted review completion can request one new report revision. The
   * original package and its conversions remain available throughout.
   * @param {string} studyId @param {{sourceDigest:string,exportId:string,reviewIds:string[],findings?:any[]}} input */
  async requestReviewRepair(studyId, input) {
    if (!/^[a-f0-9]{64}$/.test(String(input.sourceDigest)) || !list(input.reviewIds).length) return { skipped: "review_identity_invalid" };
    const study = await this.store.studyById(studyId);
    if (!study || study.status !== "active") return { skipped: "study_inactive" };
    const [reviews, results, stale, assumptions, populations, patientSets, comparators, scenarios, grid, definition, protocol, exports] = await Promise.all([
      this.store.reviews(studyId), this.store.results(studyId), this.store.staleMarks(studyId), this.store.assumptions(studyId),
      this.store.populations(studyId), this.store.patientSets(studyId), this.store.comparatorDesigns(studyId),
      this.store.trialScenarios(studyId), this.store.latestDesignGrid(studyId), this.store.latestDefinition(studyId),
      this.store.latestProtocolVersion(studyId), this.store.exports(studyId),
    ]);
    const original = exports.find((row) => row.id === input.exportId);
    if (!original || original.cover?.revisionOf) return { skipped: "revision_already_attempted" };
    const retained = list(original.cover.reports?.length ? original.cover.reports : [original.cover.report]);
    // A model document's sections are named in what the run is handed, since each is submitted under its own name.
    const templates = retained.map(report => (modelDocumentSections(original.kind) ? `[section: ${String(object(report).section ?? "main")}]\n` : "")
      + String(object(report).template ?? "")).join("\n\n");
    if (!templates.trim() || templates.length > 200_000) return { skipped: "retained_report_not_bounded" };
    const reportRevision = vcrReportReviewRevision(original.cover);
    const current = vcrCurrentNodes({ study, results, assumptions, populations, patientSets, comparators, scenarios, grid, definition, protocol });
    const accepted = reviews.filter((review) => review.reviewerKind === "ai" && input.reviewIds.includes(review.platformReviewId)
      && review.provenance?.inputDigest === input.sourceDigest && review.provenance?.subjectRef?.exportId === original.id
      && vcrReviewIsCurrent(review, { results, stale, current, exports }));
    const findings = accepted.flatMap((review) => list(review.provenance?.findings).filter((finding) => typeof finding.fix === "string" && finding.fix.trim()));
    if (!findings.length) return { skipped: "review_stale_or_no_action" };
    const key = `run:review-repair:${original.id}`;
    const created = await this.store.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-review-repair:' || $1))", [studyId]);
      const existing = (await client.query(`SELECT detail FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id=$1 AND key=$2`, [studyId, key])).rows[0];
      if (existing) return false;
      const locked = (await client.query(`SELECT cover FROM ${VCR_SCHEMA}.exports WHERE study_id=$1 AND id=$2 FOR UPDATE`, [studyId, original.id])).rows[0];
      if (!locked || vcrReportReviewRevision(locked.cover) !== reportRevision) return false;
      const cover = structuredClone(original.cover);
      delete cover.report; delete cover.reports; delete cover.documentExportId;
      cover.revisionOf = original.id; cover.reviewRepair = { sourceDigest: input.sourceDigest, reportRevision,
        reviewIds: accepted.map((review) => review.platformReviewId) };
      const row = await this.store.createExport({ studyId, userId: study.userId, kind: original.kind, cover }, { client });
      const brief = vcrReviewRepairBrief({ revisionId: row.id, originalId: original.id, kind: original.kind, templates, findings });
      await client.query(`INSERT INTO ${VCR_SCHEMA}.schedule_marks(study_id,key,user_id,kind,state,detail)
        VALUES($1,$2,$3,'run','pending',$4::jsonb)`, [studyId, key, study.userId,
        JSON.stringify({ purpose: "export", allowed: 1, kind: original.kind, exportId: row.id, revisionOf: original.id, reportRevision, brief })]);
      return true;
    });
    if (created) await this.advance(studyId);
    return { queued: created };
  }

  /**
   * 「让 AI 做」: the step is requested, what serves it gets a fresh try, and
   * the study is advanced now — a run dispatched at once when one can be.
   * @param {{ id: string }} user @param {{ id: string }} input @param {string} step
   */
  async runStep(user, input, step) {
    if (!VCR_STEPS.includes(step)) throw new HttpError(400, "vcr_step_invalid", `step must be one of: ${VCR_STEPS.join(", ")}.`);
    const study = await this.store.getStudy(String(user.id), String(input.id));
    if (!study) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
    if (study.status !== "active") throw new HttpError(409, "vcr_study_paused", "This study is paused.");
    const status = study.steps[step]?.status ?? "none";
    const again = ["none", "failed", "stale"].includes(status);
    await this.store.setStep(study.id, step, { requested: true, ...(again ? { status: "queued" } : {}) });
    await this.#allowRetries(study, step);
    // A job that failed, was cancelled or could not be queued is tried again
    // because a person asked: its mark is what says it was already tried.
    await this.store.query(`DELETE FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'job' AND step = $2 AND state IN ('failed', 'skipped')`, [study.id, step]);
    const result = await this.advance(study.id);
    return this.#answer(study, result);
  }

  /**
   * 导出: a package run asked for now, dispatched when the study's run slot is
   * free. A review is not a condition — export is never withheld for want of
   * one (§10.2, AC-21); the cover states what is reviewed and what is not.
   * @param {{ id: string }} user @param {{ id: string }} input @param {string} kind
   */
  async requestExport(user, input, kind) {
    const study = await this.store.getStudy(String(user.id), String(input.id));
    if (!study) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
    if (study.status !== "active") throw new HttpError(409, "vcr_study_paused", "This study is paused.");
    // A document stands on what it was written from. A model document stands on one frozen version of the plan: a draft written before
    // the plan froze, or against an older version, is not the one asked for once a newer version exists. Every other kind records the
    // digest of the study's version nodes it was written from (`inputDigest`, `vcrInputDigest`): the same digest is the same document,
    // converted again on request, and a different one — or none recorded, which says nothing about what it was written from — is a new
    // document, the earlier one staying listed as replaced. No timer decides it, and nothing but the existing button asks.
    const cover = await this.#cover(study);
    const modelKind = isModelDocumentKind(kind);
    const latestPlan = modelKind ? Number((await this.store.modelPlanVersions(study.id))[0]?.version ?? 0) : 0;
    const previous = (await this.store.exports(study.id)).find(row => row.kind === kind && vcrExportHoldsDocument(row.cover)
      && (modelKind ? Number(row.cover?.results?.modelAnalysis?.plan?.version ?? 0) >= latestPlan : row.cover?.inputDigest === cover.inputDigest));
    if (previous && this.queueExport) {
      const conversion = await this.queueExport(user, study, previous);
      return { export: previous, conversion, sessionId: null, runId: previous.runId ?? null };
    }
    const row = await this.store.createExport({ studyId: study.id, userId: study.userId, kind, cover });
    await this.#claim(study, `run:export:${row.id}`, "run", "pending",
      { detail: { purpose: "export", kind, exportId: row.id, requestedBy: String(user.id) } });
    const result = await this.advance(study.id);
    return { export: row, ...this.#answerShape(result) };
  }

  /**
   * Ask for a run that takes new evidence into a study's assumption cards (flywheel F24, 2026-10-06). The consumer of the frontier
   * feed calls this once it has labelled the cards; this only records the request, as a pending run mark named by `token` (the same
   * news asked twice is one request), and the next pass dispatches it by the rules of any programme run (`#pendingEvidenceRefresh`).
   * A study that is not active asks for nothing.
   * @param {string} studyId @param {{ token: string, keys: readonly string[], items?: readonly unknown[], brief: string }} request
   * @returns {Promise<{ requested: boolean, reason?: string, key?: string }>}
   */
  async requestEvidenceRefresh(studyId, { token, keys, items = [], brief }) {
    const study = await this.store.studyById(studyId);
    if (!study || study.status !== "active") return { requested: false, reason: "study_not_active" };
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(token))) throw new TypeError("requestEvidenceRefresh: the token is a short word.");
    const key = `run:evidence-refresh:${token}`;
    const claimed = await this.#claim(study, key, "run", "pending", { detail: { purpose: "evidence_refresh", keys: [...keys], items: [...items], brief: String(brief) } });
    if (!claimed) return { requested: false, reason: "already_requested", key };
    this.counters.evidenceRefreshes += 1;
    return { requested: true, key };
  }

  /**
   * The evidence-refresh run this runtime is out for right now, or null: the mark the study's one run slot holds (claimed and not
   * stale, or running) when the run was dispatched for new evidence. What the runtime's gateway binds an assumption write to — the
   * dispatch names the purpose, and nothing a run types does. `runtimeRunId` is the dispatch the calling runtime is reserved for,
   * when the gateway knows one; a runtime reserved for another dispatch is not this run.
   * @param {string} studyId @param {{ runtimeRunId?: string | null }} [caller]
   * @returns {Promise<{ key: string, dispatchId: string | null, runId: string | null } | null>}
   */
  async evidenceRefreshRun(studyId, { runtimeRunId = null } = {}) {
    const mark = await this.store.one(`SELECT key, dispatch_id, run_id, detail FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run'
        AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2)))
      ORDER BY updated_at DESC LIMIT 1`, [studyId, VCR_RUN_RULES.staleClaimMinutes]);
    if (!mark || object(mark.detail).purpose !== "evidence_refresh") return null;
    if (runtimeRunId && mark.dispatch_id && String(mark.dispatch_id) !== String(runtimeRunId)) return null;
    return { key: String(mark.key), dispatchId: mark.dispatch_id == null ? null : String(mark.dispatch_id), runId: mark.run_id == null ? null : String(mark.run_id) };
  }

  /**
   * The digest of the study's version nodes as they stand now: what a document
   * written at this moment is written from (the `inputDigest` a cover records).
   * @param {any} study @returns {Promise<string>}
   */
  async inputDigest(study) {
    return (await this.#cover(study)).inputDigest;
  }

  /**
   * The export a run of this study is out for right now, or null: the mark the
   * study's one run slot holds (claimed and not stale, or running), when the run
   * was dispatched to write an export — an export the researcher asked for
   * (`run:export:<id>`) or the one revision a review asked for
   * (`run:review-repair:<id>`). This is what the runtime's gateway binds a report
   * write to: the dispatch names the export, and the kind a run types never does.
   *
   * `runtimeRunId` is the dispatch the calling runtime is reserved for, when the
   * gateway knows one (a bounded runtime). A runtime reserved for some other
   * dispatch is not this export's run, whatever the slot holds.
   * @param {string} studyId @param {{ runtimeRunId?: string | null }} [caller]
   * @returns {Promise<{ key: string, exportId: string, dispatchId: string | null, runId: string | null } | null>}
   */
  async exportDispatch(studyId, { runtimeRunId = null } = {}) {
    const mark = await this.store.one(`SELECT key, dispatch_id, run_id, detail FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run'
        AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2)))
      ORDER BY updated_at DESC LIMIT 1`, [studyId, VCR_RUN_RULES.staleClaimMinutes]);
    const detail = object(mark?.detail);
    if (!mark || detail.purpose !== "export" || !detail.exportId) return null;
    if (runtimeRunId && mark.dispatch_id && String(mark.dispatch_id) !== String(runtimeRunId)) return null;
    return { key: String(mark.key), exportId: String(detail.exportId),
      dispatchId: mark.dispatch_id == null ? null : String(mark.dispatch_id), runId: mark.run_id == null ? null : String(mark.run_id) };
  }

  /**
   * The cover of a package, written from what is true right now: the review
   * state of every kind, the intended use the evidence carries, the seal's two
   * timestamps and whether anything on the page is stale (plan §8.3, §10.2).
   * @param {any} study
   */
  async #cover(study) {
    const [reviews, stale, results, definition, assumptions, populations, patientSets, comparators, scenarios, grid, protocol, exports] = await Promise.all([
      this.store.reviews(study.id), this.store.staleMarks(study.id), this.store.results(study.id), this.store.latestDefinition(study.id),
      this.store.assumptions(study.id), this.store.populations(study.id, 20), this.store.patientSets(study.id, 20),
      this.store.comparatorDesigns(study.id, 20), this.store.trialScenarios(study.id, 60), this.store.latestDesignGrid(study.id),
      this.store.latestProtocolVersion(study.id),
      this.store.exports(study.id),
    ]);
    // A countersignature is printed on the cover for what it still covers: one whose versions have moved on is
    // said to have changed after review, never 已复核 (the same test the page's ceiling uses, `vcrReviewIsCurrent`).
    const current = vcrCurrentNodes({ study, assumptions, populations, patientSets, comparators, scenarios, grid, results, definition, protocol });
    const stillHolds = (/** @type {any} */ review) => vcrReviewIsCurrent(review, { results, stale, current, exports });
    return {
      reviewed: reviews.some(stillHolds),
      reviews: reviews.map((review) => ({ kind: review.kind, reviewer: review.reviewer, nodes: review.nodes, at: review.createdAt, current: stillHolds(review) })),
      staleResults: stale.length,
      // What this document is written from: a request for the same kind later asks whether the study still holds these versions.
      inputDigest: vcrInputDigest(current),
      intendedUse: study.intendedUse,
      conclusions: [...new Set(results.map((result) => result.conclusion).filter(Boolean))],
      seal: this.seal ? await this.seal.sealState(study).catch(() => null) : null,
      preparedAt: this.now().toISOString(),
    };
  }

  /** @param {any} study @param {any} result */
  #answer(study, result) {
    return this.#answerShape(result, study);
  }

  /** @param {any} result @param {any} [study] */
  #answerShape(result, study) {
    const dispatched = object(result).dispatched;
    if (dispatched?.runId) return { sessionId: dispatched.sessionId ?? null, runId: dispatched.runId, deferred: null };
    return {
      sessionId: null, runId: null,
      deferred: object(result).deferred ?? null,
      ...(study ? { studyId: study.id } : {}),
      enqueued: list(object(result).enqueued),
    };
  }

  /** A person asking again gives the runs that serve the step two more tries. @param {any} study @param {string} step */
  async #allowRetries(study, step) {
    const key = VCR_ANALYSIS_STEPS.includes(step) ? "run:analysis" : `run:${step}`;
    await this.store.query(`UPDATE ${VCR_SCHEMA}.schedule_marks
      SET detail = detail || jsonb_build_object('allowed', attempts + $3::integer), updated_at = now()
      WHERE study_id = $1 AND key = $2 AND state IN ('failed', 'done')`, [study.id, key, VCR_RUN_RULES.attempts]);
  }

  // --- the tick ------------------------------------------------------------------------

  /** Advance every active study once. The worker's `orchestrator` loop. */
  async tick() {
    this.counters.ticks += 1;
    this.lastTickAt = this.now().toISOString();
    const studies = await this.store.activeStudies(VCR_RUN_RULES.studiesPerTick);
    let advanced = 0;
    for (const study of studies) {
      try {
        await this.advance(study.id);
        advanced += 1;
      } catch (error) {
        this.counters.studyErrors += 1;
        this.lastError = codeOf(error);
        this.report(codeOf(error));
      }
    }
    return { studies: studies.length, advanced, dispatched: this.counters.dispatched, enqueued: this.counters.jobsEnqueued };
  }

  /**
   * One pass over one study: read what the data says each step is, enqueue the
   * deterministic work whose configuration is ready, dispatch at most one run,
   * and send whatever notices are due.
   * @param {string} studyId
   */
  async advance(studyId) {
    return this.#exclusive(studyId, async () => {
      let study = await this.store.studyById(studyId);
      if (!study || study.status !== "active") return { skipped: study ? "paused" : "gone" };
      await this.#detectChanges(study);
      await this.#refreshReviewExports(study);
      // Two passes, because what the programme wants depends on what is
      // already finished: a study whose definition has just been written is a
      // study that wants the whole programme, and reading the plan before
      // observing would leave it waiting a whole tick for something already
      // on disk.
      study = await this.#observe(study, wantedVcrSteps(vcrProgramSteps(study.steps)));
      const plan = wantedVcrSteps(vcrProgramSteps(study.steps));
      /** @type {{ dispatched: any, deferred: string | null, enqueued: string[] }} */
      const result = { dispatched: null, deferred: null, enqueued: [] };
      study = await this.#observe(study, plan);
      await this.#enqueueWork(study, plan, result);
      study = await this.#observe(study, plan);
      await this.#nextRun(study, plan, result);
      await this.#notices(study);
      await this.#reviewSettled(study);
      return result;
    });
  }

  /**
   * Queue the advisory review of a study whose results have settled (`vcrReviewDue`). Pulled by the orchestrator's
   * minute tick from the data itself, so it survives a restart and needs no mark: the review's own row is what
   * says it was asked, and a review already asked for the same bytes is the same review (`studyReview.mjs`).
   * @param {any} study
   */
  async #reviewSettled(study) {
    if (!this.queueReviews) return;
    try {
      const times = await this.store.one(`SELECT
        (SELECT max(created_at) FROM ${VCR_SCHEMA}.results WHERE study_id = $1) AS last_result,
        (SELECT max(created_at) FROM ${VCR_SCHEMA}.reviews WHERE study_id = $1 AND reviewer_kind = 'ai') AS last_review`, [study.id]);
      const now = this.now();
      if (!vcrReviewDue({ lastResultAt: times?.last_result, lastReviewAt: times?.last_review, now })) return;
      const tried = this.reviewAttempts.get(study.id) ?? 0;
      if (now.getTime() - tried < VCR_REVIEW_QUIET_MS) return;
      this.reviewAttempts.set(study.id, now.getTime());
      await this.#queueReview(study.id, { reason: "results_settled" });
    } catch (error) { this.report(codeOf(error)); }
  }

  // --- reading the steps from the data ---------------------------------------------------

  /**
   * Everything one pass reads about a study's objects and the compute around
   * them, once: the latest object of each line, the open stale marks, the jobs
   * in flight by the node they were queued for, and the job marks that say why
   * an object is not being computed.
   * @param {any} study
   */
  async #read(study) {
    const [definition, assumptions, populations, patientSets, comparators, scenarioRows, grid, protocol, stale, openJobs, marks] = await Promise.all([
      this.store.latestDefinition(study.id),
      this.store.assumptions(study.id),
      this.store.populations(study.id, 50),
      this.store.patientSets(study.id, 50),
      this.store.comparatorDesigns(study.id, 50),
      this.store.trialScenarios(study.id, 60),
      this.store.latestDesignGrid(study.id),
      this.store.latestProtocolVersion(study.id),
      this.store.staleMarks(study.id),
      this.store.rows(`SELECT kind, state, checkpoint ->> 'node' AS node FROM ${VCR_SCHEMA}.jobs
        WHERE study_id = $1 AND state IN ('queued', 'running', 'awaiting_budget')`, [study.id]),
      this.store.rows(`SELECT key, state, step, job_id, detail, created_at, updated_at FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'job'`, [study.id]),
    ]);
    // A labelled design is a line of versions: the newest row of each label is the design.
    /** @type {Map<string, any>} */
    const byLabel = new Map();
    for (const scenario of scenarioRows) {
      const key = scenario.label || scenario.id;
      if (!byLabel.has(key)) byLabel.set(key, scenario);
    }
    const scenarios = [...byLabel.values()].sort((a, b) => Number(a.version) - Number(b.version));
    /** @type {Map<string, any>} */
    const staleByNode = new Map(stale.map((mark) => [String(mark.node), mark]));
    /** @type {Map<string, string[]>} */
    const openByNode = new Map();
    /** @type {Set<string>} kinds of jobs nobody tied to a node (a run's own `vcr_simulate`) */
    const openKinds = new Set();
    for (const job of openJobs) {
      if (job.node) openByNode.set(String(job.node), [...(openByNode.get(String(job.node)) ?? []), String(job.state)]);
      else openKinds.add(String(job.kind));
    }
    /** @type {Map<string, any[]>} */
    const marksByNode = new Map();
    for (const mark of marks) {
      const node = String(object(mark.detail).node ?? "");
      if (node) marksByNode.set(node, [...(marksByNode.get(node) ?? []), mark]);
    }
    // The model library, read only when a patient set names a model (whether the model
    // covers the study is decided before a job is queued).
    const models = patientSets[0]?.modelId ? await this.store.models(String(study.userId)) : [];
    return { definition, assumptions, populations, population: populations[0] ?? null, patientSets, patientSet: patientSets[0] ?? null,
      comparators, comparator: comparators[0] ?? null, scenarios, grid, protocol, stale, staleByNode, openByNode, openKinds, marksByNode, models };
  }

  /**
   * The state of every object of each analysis step: has it a result, is it
   * being computed, is it stale, did its compute fail or stop, is it waiting for
   * something upstream. Read from the data and the job marks, never from a run.
   * `open` says a job of its own is queued or running — the platform holds it.
   * @param {any} read
   * @returns {Record<string, Array<Record<string, any>>>}
   */
  #objectStates(read) {
    /** @param {{ kind: string, row: any, node: string, done: boolean }} object_ */
    const stateOf = (object_) => {
      const marks = read.marksByNode.get(object_.node) ?? [];
      const failing = marks.find((mark) => mark.state === "failed" || (mark.state === "skipped" && !UNAVAILABLE_REASONS.includes(String(object(mark.detail).reason)) && object(mark.detail).canceled !== true));
      const unavailable = marks.find((mark) => mark.state === "skipped" && UNAVAILABLE_REASONS.includes(String(object(mark.detail).reason)));
      const cancelled = marks.find((mark) => mark.state === "skipped" && object(mark.detail).canceled === true);
      const open = read.openByNode.get(object_.node);
      /** @type {{ state: string, note: string | null }} */
      let found = { state: "waiting", note: null };
      if (read.staleByNode.has(object_.node) && (object_.done || open)) found = { state: "stale", note: null };
      else if (open?.length) found = { state: open.every((state) => state === "awaiting_budget") ? "queued" : "running", note: null };
      else if (failing) found = { state: "failed", note: noteOfMark(failing) };
      else if (object_.done) found = { state: "done", note: unavailable ? noteOfMark(unavailable) : null };
      else if (unavailable) found = { state: "unavailable", note: noteOfMark(unavailable) };
      else if (cancelled) found = { state: "cancelled", note: "这一步的计算被取消了；再让 AI 做一次就会重新计算。" };
      return { ...object_, ...found, open: Boolean(open?.length) };
    };
    /** @param {string} kind @param {any} row */
    const info = (kind, row) => stateOf({ kind, row, node: vcrObjectNode(kind, row),
      done: kind === "design_grid" ? list(row.cells).length > 0 : Boolean(row.resultId) });
    return {
      population: read.population ? [info("population", read.population)] : [],
      patients: read.patientSet ? [info("patient_set", read.patientSet)] : [],
      comparator: read.comparator ? [info("comparator", read.comparator)] : [],
      trial: [...read.scenarios.map((row) => info("trial_scenario", row)), ...(read.grid ? [info("design_grid", read.grid)] : [])],
    };
  }

  /**
   * Each step's status, read from what is stored. Never from a run's report:
   * a run that said it was done and wrote nothing has not done it.
   * @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan
   */
  async #observe(study, plan) {
    const read = await this.#read(study);
    const criteria = read.protocol ? Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.criteria
      WHERE study_id = $1 AND protocol_version_id = $2`, [study.id, read.protocol.id]))?.n ?? 0) : 0;
    // Only what was judged against the criteria as they stand now. An assessment made against an earlier version of the
    // protocol stays in the history and answers a question that is no longer asked; counting it called the step done while
    // nobody had been judged against the criteria the study holds (`protocol_version_id` is that version).
    const assessments = read.protocol ? Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.matching_assessments
      WHERE study_id = $1 AND protocol_version_id = $2`, [study.id, read.protocol.id]))?.n ?? 0) : 0;

    const objects = this.#objectStates(read);
    /** @param {string} step */
    const aggregate = (step) => {
      const states = objects[step];
      if (!states.length) return null;
      const has = (/** @type {string} */ name) => states.filter((entry) => entry.state === name);
      if (has("stale").length) return { status: "stale", note: null };
      if (has("running").length || has("queued").length) return { status: has("running").length ? "running" : "queued", note: null };
      if (has("failed").length) return { status: "failed", note: has("failed")[0].note };
      const done = has("done");
      const unavailable = has("unavailable");
      if (done.length && done.length + unavailable.length === states.length) {
        return { status: plan.fidelity(step) === "minimal" && !plan.requested.has(step) ? "minimal" : "done", note: [...done, ...unavailable].map((entry) => entry.note).filter(Boolean)[0] ?? null };
      }
      if (unavailable.length && !done.length) return { status: "failed", note: unavailable[0].note };
      if (has("cancelled").length) return { status: "none", note: has("cancelled")[0].note };
      return { status: "queued", note: null };
    };
    /** @param {string} step @param {{ complete: boolean, kinds?: readonly string[] }} facts */
    const simple = (step, facts) => vcrSimpleStepStatus({
      complete: facts.complete, jobOpen: (facts.kinds ?? []).some((kind) => read.openKinds.has(kind)),
      minimal: plan.fidelity(step) === "minimal" && !plan.requested.has(step),
    });

    // Each simple step is done by what only it produces. The evidence step is
    // done when a parameter cites its evidence (`vcrEvidenceProduct`) — never
    // when any card exists, because the protocol and analysis runs write cards
    // of their own — and reads running while its pooling jobs are out. The
    // four analysis steps are done by an engine result the platform attached,
    // which no run can write (`attachResult`, the gateway's closed field
    // lists), so a neighbour's output or a placeholder cannot satisfy them.
    //
    // Structuring the eligibility criteria is what step 7 is at T0, where
    // nobody's records exist to match (plan §3.2); above T0 it is done when
    // patients have been judged. The criteria are one object two steps may
    // write — the protocol run structures them from the protocol it reads, the
    // matching run when it finds none — and the plan's own T0 timeline (§10.3)
    // has no matching run: reading step 7 done on criteria that exist is the
    // plan's meaning, not a neighbour's output satisfying it.
    const facts = /** @type {Array<[string, { status: string, note: string | null } | null]>} */ ([
      ["definition", simple("definition", { complete: Boolean(read.definition) })],
      ["evidence", simple("evidence", { kinds: ["pool_evidence"], complete: read.assumptions.some(vcrEvidenceProduct) })],
      ["population", aggregate("population")],
      ["patients", aggregate("patients")],
      ["comparator", aggregate("comparator")],
      ["trial", aggregate("trial")],
      ["matching", simple("matching", { kinds: ["match_criteria"],
        complete: criteria > 0 && (study.dataTier === "T0" || assessments > 0) })],
    ]);
    // The runs out for this study now, by the steps they cover: what 「进行中」 is checked against.
    const flying = vcrStepsInFlight(await this.store.rows(`SELECT detail FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run'
        AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2)))`,
    [study.id, VCR_RUN_RULES.staleClaimMinutes]));
    let current = study;
    for (const update of vcrStepUpdates({ steps: study.steps, seen: facts, flying, plan })) {
      current = await this.#step(current, update.step, update.fields);
    }
    return current;
  }

  // --- the deterministic half: jobs -----------------------------------------------------

  /**
   * Enqueue the compute whose configuration exists and whose result does not,
   * or whose result has gone stale. This is the platform owning the numbers: a
   * run writes a design, the platform runs it (attachment E §2.2), and a run
   * that forgot to queue its own simulation still gets one.
   * @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @param {{ enqueued: string[] }} result
   */
  async #enqueueWork(study, plan, result) {
    const read = await this.#read(study);
    /** @type {Array<{ step: string, kind: string, row: any }>} */
    const items = [];
    if (read.population && plan.want.has("population")) items.push({ step: "population", kind: "population", row: read.population });
    if (read.patientSet && plan.want.has("patients")) items.push({ step: "patients", kind: "patient_set", row: read.patientSet });
    if (read.comparator && plan.want.has("comparator")) items.push({ step: "comparator", kind: "comparator", row: read.comparator });
    if (plan.want.has("trial")) {
      for (const scenario of read.scenarios) items.push({ step: "trial", kind: "trial_scenario", row: scenario });
      if (read.grid) items.push({ step: "trial", kind: "design_grid", row: read.grid });
    }
    for (const item of items) {
      const enqueued = await this.#enqueueFor(study, item, read);
      result.enqueued.push(...enqueued);
    }
  }

  /** @param {string} studyId @param {string} key */
  async #dropMarks(studyId, key) {
    await this.store.query(`DELETE FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'job' AND (key = $2 OR starts_with(key, $3))`,
      [studyId, key, `${key}#`]);
  }

  /**
   * One object's jobs. The scenario is frozen here — every assumption value,
   * every version — because re-reading them later is what makes a result
   * unreproducible (AC-04).
   * @param {any} study @param {{ step: string, kind: string, row: any }} item @param {VcrRead} read
   * @returns {Promise<string[]>} the ids of the jobs queued
   */
  async #enqueueFor(study, item, read) {
    const node = vcrObjectNode(item.kind, item.row);
    if (item.kind === "comparator" && item.row.route === "literature_control" && item.row.configuration?.provenance?.receiptId) {
      try {
        if (!this.jobs.curveVerifier) throw new HttpError(503, "vcr_curve_provenance_unavailable", "曲线来源核验暂不可用；其他分析可以继续。");
        const configuration = object(item.row.configuration);
        const fields = object(/** @type {any} */ (VCR_SCENARIO_SCHEMAS)["evidence.reconstruct_km"]).fields;
        const scenario = Object.fromEntries(Object.entries(configuration).filter(([key]) => Object.hasOwn(fields, key)));
        const verified = await this.jobs.curveVerifier({ studyId: study.id, principal: study.userId, scenario, inputs: [] });
        item = { ...item, row: { ...item.row, configuration: { ...configuration, ...verified.scenario,
          provenance: { ...verified.scenario.provenance, receiptId: verified.detail.curveReceiptId } } } };
      } catch (error) {
        await this.#claim(study, `job:${node}`, "job", "failed", { step: item.step,
          detail: { node, error: codeOf(error), message: String(error?.message ?? "曲线来源无法核验。") } });
        this.report(codeOf(error));
        return [];
      }
    }
    const marks = read.marksByNode.get(node) ?? [];
    const staleMark = read.staleByNode.get(node);
    // A stale object whose last compute finished before it went stale is computed
    // again, under a new idempotency key: the same frozen scenario asked twice is
    // one job, a scenario under new assumption versions is another.
    // Compare inside PostgreSQL: Date would discard sub-millisecond ordering
    // and leave a late result falsely current after an in-flight source change.
    const frozenBeforeChange = staleMark && marks.length ? await this.store.one(`SELECT
      bool_and(COALESCE(j.created_at,m.created_at)<s.marked_at) AS all_old
      FROM ${VCR_SCHEMA}.schedule_marks m LEFT JOIN ${VCR_SCHEMA}.jobs j ON j.id=m.job_id
      JOIN ${VCR_SCHEMA}.stale_marks s ON s.study_id=m.study_id AND s.node=$2 AND s.cleared_at IS NULL
      WHERE m.study_id=$1 AND m.kind='job' AND m.key=ANY($3::text[])`,
    [study.id, node, marks.map(mark => String(mark.key))]) : null;
    if (staleMark && marks.length && marks.every((mark) => ["done", "failed", "skipped"].includes(mark.state))
      && frozenBeforeChange?.all_old === true) {
      await this.#dropMarks(study.id, `job:${node}`);
      marks.length = 0;
    }
    const analyticMark = marks.find((mark) => object(mark.detail).stage === "analytic" && mark.state === "done");
    const analyticJob = analyticMark?.job_id ? await this.jobs.get(study.id, String(analyticMark.job_id)) : null;
    const analytic = item.kind === "trial_scenario" ? (item.row.design === "simon_two_stage"
      ? analyticJob ? await this.jobs.resultOf(study.id, analyticJob.id) : null
      : await this.store.currentResultOf(study.id, "trial_scenario", item.row.id)) : null;
    const plan = vcrBuildStages(item, { study, definition: read.definition, assumptions: read.assumptions, populations: read.populations,
      scenarios: read.scenarios, grid: read.grid, analytic, analyticJob, models: read.models });
    /** @type {string[]} */
    const queued = [];
    if (plan.ok === false) {
      if ("waiting" in plan) return queued;
      const key = `job:${node}`;
      if (await this.#mark(study.id, key)) return queued;
      if ("unavailable" in plan) {
        await this.#unavailable(study, item, node, plan.unavailable);
        return queued;
      }
      const refused = /** @type {VcrPlanRefused} */ (plan).refused;
      await this.#claim(study, key, "job", "failed", { step: item.step, detail: { node, error: refused.code, message: refused.message, ...(refused.paths ? { paths: refused.paths } : {}) } });
      this.lastError = refused.code;
      this.report(refused.code);
      return queued;
    }
    const generation = Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.jobs
      WHERE study_id = $1 AND checkpoint ->> 'node' = $2`, [study.id, node]))?.n ?? 0);
    // Every stage of this pass's plan, said on each job: a stage that the object had before
    // and this plan no longer has is one no job will run again (`vcrMergeStageResult`).
    const planned = plan.stages.map((stage) => stage.stage).filter((name) => typeof name === "string" && name);
    for (const stage of plan.stages) {
      const outcome = await this.#enqueueStage(study, item, node, stage, read, generation, planned, plan.stages);
      if (outcome.jobId) queued.push(outcome.jobId);
      // A stage waits for the one it needs; nothing after it goes ahead of it.
      if (outcome.stop) break;
    }
    return queued;
  }

  /**
   * A route or design the engine cannot compute in this version, or that the
   * study's data tier cannot reach. A comparator's verdict is a finished result
   * (not estimable, with its gaps); any other object is left with a reason.
   * @param {any} study @param {{ step: string, kind: string, row: any }} item @param {string} node
   * @param {{ rule: string, reason: string, gaps: any[] }} verdict
   */
  async #unavailable(study, item, node, verdict) {
    const key = `job:${node}`;
    if (item.kind !== "comparator") {
      await this.#claim(study, key, "job", "skipped", { step: item.step, detail: { node, reason: verdict.reason, rule: verdict.rule,
        message: String(object(verdict.gaps[0]).detail ?? ""), title: String(object(verdict.gaps[0]).title ?? "") } });
      this.counters.jobsSkipped += 1;
      return;
    }
    const claimed = await this.#claim(study, key, "job", "done", { step: item.step, detail: { node, verdict: true, rule: verdict.rule, reason: verdict.reason } });
    if (!claimed) return;
    const gaps = list(item.row.gapList).length ? list(item.row.gapList) : verdict.gaps;
    const line = await this.#lineOf(study.id, item.kind, item.row);
    const recorded = await this.store.recordResult({
      studyId: study.id, userId: study.userId, kind: "comparator", subjectId: item.row.id, conclusion: "not_estimable",
      notEstimableRule: verdict.rule, counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: null },
      measures: [], diagnostics: { gaps, derivedBy: "control_plane", reason: verdict.reason }, tables: [],
      supersedesSubjects: line, requestedUse: study.intendedUse,
    });
    await this.store.attachResult("comparator_designs", item.row.id, recorded.id, { conclusion: "not_estimable", gapList: gaps });
    await this.store.addEdges(study.id, [{ from: node, to: lineageNode("result", recorded.id, recorded.version), cost: "light" }]);
    this.counters.verdicts += 1;
  }

  /**
   * The ids of the earlier versions of an object's line, whose results a new
   * version's result replaces: every earlier row of a population, patient set
   * or grid; of a comparator on the same route; of a trial scenario of the same
   * label.
   * @param {string} studyId @param {string} kind @param {any} row
   * @returns {Promise<string[]>}
   */
  async #lineOf(studyId, kind, row) {
    /** @type {any[]} */
    let rows = [];
    if (kind === "population") rows = await this.store.populations(studyId, 50);
    else if (kind === "patient_set") rows = await this.store.patientSets(studyId, 50);
    else if (kind === "comparator") rows = (await this.store.comparatorDesigns(studyId, 50)).filter((entry) => entry.route === row.route);
    else if (kind === "trial_scenario") rows = (await this.store.trialScenarios(studyId, 60)).filter((entry) => (entry.label || entry.id) === (row.label || row.id));
    return rows.filter((entry) => entry.id !== row.id && Number(entry.version) < Number(row.version)).map((entry) => String(entry.id));
  }

  /**
   * One job of an object's plan.
   * @param {any} study @param {{ step: string, kind: string, row: any }} item @param {string} node @param {import("./vcrOrchestrator.mjs").VcrStage} stage
   * @param {VcrRead} read @param {number} generation @param {string[]} planned the stage names of the plan this job belongs to
   * @param {readonly import("./vcrOrchestrator.mjs").VcrStage[]} [stages] every stage of the plan this job belongs to
   * @returns {Promise<{ jobId?: string, stop?: boolean }>}
   */
  async #enqueueStage(study, item, node, stage, read, generation, planned, stages = [stage]) {
    if (stage.detail.awaitingAnalytic === true) return { stop: true };
    const key = stage.stage ? `job:${node}#${stage.stage}` : `job:${node}`;
    if (await this.#mark(study.id, key)) return {};
    /** @type {Array<{ resultId: string, table: string, bindTo?: string }>} */
    const derived = [];
    if (stage.after) {
      const previous = await this.#mark(study.id, `job:${node}#${stage.after}`);
      if (!previous || previous.state !== "done") return { stop: true };
      if (object(previous.detail).conclusion === "not_estimable") {
        await this.#claim(study, key, "job", "skipped", { step: item.step, detail: { node, reason: "previous_not_estimable",
          message: "前一步已经判定不可估计，这一步不再计算。" } });
        return {};
      }
    }
    for (const entry of stage.derived) {
      const resultId = entry.from === "stage"
        ? String(object((await this.#mark(study.id, `job:${node}#${entry.stage}`))?.detail).resultId ?? "")
        : String(read.populations.find((population) => population.id === item.row.populationId)?.resultId ?? "");
      if (!resultId) return { stop: true };
      derived.push({ resultId, table: entry.table, ...(entry.bindTo ? { bindTo: entry.bindTo } : {}) });
    }
    const inputs = await this.#freeze(item, stage, read);
    if (stage.snapshot && !inputs.some((input) => input.kind === "snapshot")) {
      // A patient-level method with no snapshot grant is a data gap, not a
      // failure: the step says so and the rest of the study goes on (§10.5).
      await this.#claim(study, key, "job", "skipped", { step: item.step, detail: { node, reason: "no_snapshot", jobKind: stage.jobKind,
        message: "缺少数据快照：这一步需要患者级数据的访问授权。" } });
      this.counters.jobsSkipped += 1;
      return {};
    }
    const claimed = await this.#claim(study, key, "job", "claimed", { step: item.step, detail: { jobKind: stage.jobKind, node, stage: stage.stage } });
    if (!claimed) return {};
    try {
      await this.#freezePlanIfSealed(study, item, stage, stages);
      const line = await this.#lineOf(study.id, item.kind, item.row);
      const { job } = await this.jobs.enqueue({
        studyId: study.id, userId: study.userId, kind: stage.jobKind, scenario: stage.scenario, inputs, derived, internal: true,
        idempotencyKey: `vcr:${study.id}:${node}${stage.stage ? `#${stage.stage}` : ""}:g${generation}`,
        // The result this job files under is the object it was queued for, not a
        // guess from the method: a literature control computed by `reconstruct_km`
        // and then `rmst` is still the comparator's result, and each of N designs
        // is its own subject, so N designs are N current results.
        detail: { node, step: item.step, stage: stage.stage, plannedStages: planned, resultKind: VCR_OBJECT_RESULT_KINDS[item.kind] ?? null,
          subjectId: item.row.id, supersedes: line, keepTables: stage.keepTables, bound: stage.bound,
          // A hybrid control's historical counts are evidence only when verified extractions say so.
          ...(stage.jobKind === "map_prior" && !(await this.#historicalIsVerified(study, stage.scenario)) ? { inputsAssumed: true } : {}),
          ...stage.detail },
      });
      await this.#update(study.id, key, { state: "running", jobId: job.id, detail: { jobId: job.id, state: job.state } });
      if (read.staleByNode.has(node)) await this.store.noteRecomputeJob(study.id, node, job.id);
      const cost = ["design_simulation", "design_grid", "assurance"].includes(stage.jobKind) ? "heavy" : "light";
      await this.store.addEdges(study.id, [
        ...inputs.filter((input) => /^[a-z_]+:[^@]+@\d+$/.test(String(input.id))).map((input) => ({ from: String(input.id), to: node, cost })),
        ...(await this.#sourceEdges(study, item, node, cost)),
      ]);
      this.counters.jobsEnqueued += 1;
      return { jobId: job.id };
    } catch (error) {
      const detail = /** @type {any} */ (error);
      await this.#update(study.id, key, { state: "failed", detail: { node, error: codeOf(error), message: String(detail?.message ?? "").slice(0, 400),
        ...(Array.isArray(detail?.issues) ? { issues: detail.issues.slice(0, 8) } : {}) } });
      this.lastError = codeOf(error);
      this.report(codeOf(error));
      return {};
    }
  }

  /**
   * Whether the historical control arms a MAP prior is asked to borrow from are
   * numbers the study's own verified extractions hold: every (events, n) pair of
   * the scenario is the events and sample size of a verified control-arm evidence
   * item (a value with the quotation it was read from, checked against the source).
   * Numbers typed into a comparator's configuration are settings, not evidence, and
   * the prior a run builds on them says so; the estimate-and-standard-error path
   * carries no counts to hold against an item and is always a setting.
   * @param {any} study @param {Record<string, any>} scenario
   */
  async #historicalIsVerified(study, scenario) {
    const historical = object(scenario.historical);
    const events = list(historical.events).map(Number);
    const sizes = list(historical.n).map(Number);
    if (!events.length || events.length !== sizes.length) return false;
    const rows = await this.store.rows(`SELECT events, sample_size FROM ${VCR_SCHEMA}.evidence_items
      WHERE study_id = $1 AND arm_role = 'control' AND events IS NOT NULL AND sample_size IS NOT NULL
        AND value IS NOT NULL AND locator ->> 'verification' = 'verified'`, [study.id]);
    /** @type {Map<string, number>} */
    const held = new Map();
    for (const row of rows) held.set(`${row.events}/${row.sample_size}`, (held.get(`${row.events}/${row.sample_size}`) ?? 0) + 1);
    return events.every((count, index) => {
      const key = `${count}/${sizes[index]}`;
      const left = held.get(key) ?? 0;
      if (left <= 0) return false;
      held.set(key, left - 1);
      return true;
    });
  }

  /**
   * The lineage edges a snapshot and a protocol version add: a cohort is built
   * from a snapshot under a protocol's criteria, so a corrected source or a
   * revised protocol reaches it (plan §6.3).
   * @param {any} study @param {{ kind: string, row: any }} item @param {string} node @param {string} cost
   */
  async #sourceEdges(study, item, node, cost) {
    /** @type {Array<{ from: string, to: string, cost: string }>} */
    const edges = [];
    const snapshotId = this.#snapshotIdOf(item);
    if (snapshotId) {
      const snapshot = await this.store.one(`SELECT source_id, version FROM ${VCR_SCHEMA}.snapshots WHERE id = $1`, [snapshotId]);
      if (snapshot) edges.push({ from: lineageNode("snapshot", String(snapshot.source_id), Number(snapshot.version)), to: node, cost });
    }
    if (item.kind === "population" && item.row.kind === "real") {
      const protocol = await this.store.latestProtocolVersion(study.id);
      if (protocol) edges.push({ from: lineageNode("protocol_version", study.id, protocol.version), to: node, cost: "light" });
    }
    return edges;
  }

  /** The snapshot an object reads, if it names one. @param {{ kind: string, row: any }} item */
  #snapshotIdOf(item) {
    const named = item.row.snapshotId ?? object(item.row.configuration).snapshotId ?? object(item.row.definition).snapshotId ?? null;
    return named ? String(named) : null;
  }

  /**
   * Everything the job froze, as engine inputs. Assumption ids carry their
   * version (`assumption:key@3`), which is what the lineage edge is built from.
   * A snapshot is named the way a caller names one — the control plane, not the
   * orchestrator, decides which files the engine may open — and a corrected
   * source is read at its newest snapshot.
   * @param {{ kind: string, row: any }} item @param {import("./vcrOrchestrator.mjs").VcrStage} stage
   * @param {VcrRead} read
   */
  async #freeze(item, stage, read) {
    /** @type {Array<Record<string, any>>} */
    const inputs = [];
    const used = item.kind === "trial_scenario" && list(item.row.assumptionIds).length
      ? read.assumptions.filter((assumption) => list(item.row.assumptionIds).includes(assumption.key) || list(item.row.assumptionIds).includes(assumption.id))
      : read.assumptions;
    for (const assumption of used) {
      let id;
      try { id = vcrAssumptionNode(assumption.key, assumption.version); } catch { continue; }
      // An assumption's lineage identity is its **key**, not its row id: every
      // version of 「脱落率」 is a new row with a new id, and a graph keyed by the
      // row id would make each edit a node with no history — which is exactly
      // the traversal §6.3 needs to work.
      inputs.push({ kind: "assumption", id,
        value: { key: assumption.key, pointValue: assumption.pointValue, distribution: assumption.distribution, unit: assumption.unit } });
    }
    if (read.definition) {
      inputs.push({ kind: "study_definition", id: lineageNode("study_definition", read.definition.id, read.definition.version),
        value: { estimand: read.definition.estimand, endpointType: read.definition.endpointType } });
    }
    if (item.kind !== "population" && read.population) {
      inputs.push({ kind: "population", id: lineageNode("population", read.population.id, read.population.version),
        value: { kind: read.population.kind, counts: read.population.counts } });
    }
    if (item.kind === "trial_scenario" && read.comparator) {
      inputs.push({ kind: "comparator_design", id: lineageNode("comparator_design", read.comparator.id, read.comparator.version),
        value: { route: read.comparator.route, estimand: read.comparator.estimand } });
    }
    if (stage.detail.analyticSource) {
      const source = stage.detail.analyticSource;
      inputs.push({ kind: "evidence", id: lineageNode("result", source.resultId, source.resultVersion), value: source });
    }
    const named = stage.snapshot ? (this.#snapshotIdOf(item) ?? read.population?.snapshotId ?? null) : null;
    if (named) {
      const newest = await this.store.one(`SELECT id FROM ${VCR_SCHEMA}.snapshots
        WHERE source_id = (SELECT source_id FROM ${VCR_SCHEMA}.snapshots WHERE id = $1) ORDER BY version DESC LIMIT 1`, [String(named)]);
      inputs.push({ kind: "snapshot", id: String(newest?.id ?? named) });
    }
    return inputs;
  }

  /**
   * An analysis run under a sealed use freezes its plan before the first job
   * that reads an outcome (plan §6.5): the plan is the comparator's route,
   * estimand and configuration, and what the assumptions said then.
   * A plan with more than one stage that reads patients (a comparison and the robustness analyses declared beside it) freezes them
   * together, the same way from whichever stage is queued first: the analyses planned up front are part of the plan, and a second
   * stage freezing a different plan would be a new plan version, not the same plan read twice.
   * @param {any} study @param {{ kind: string, row: any }} item @param {import("./vcrOrchestrator.mjs").VcrStage} stage
   * @param {readonly import("./vcrOrchestrator.mjs").VcrStage[]} [stages] every stage of the plan the job belongs to
   */
  async #freezePlanIfSealed(study, item, stage, stages = [stage]) {
    if (!this.seal?.freezePlan || !vcrSealRequired(study.intendedUse) || !stage.snapshot || item.kind !== "comparator") return;
    const reading = stages.filter((entry) => entry.snapshot);
    const lead = reading[0] ?? stage;
    const alsoRead = reading.slice(1).map((entry) => ({ stage: entry.stage, jobKind: entry.jobKind, scenario: entry.scenario }));
    await this.seal.freezePlan({ studyId: study.id, actor: "orchestrator", plan: {
      intendedUse: study.intendedUse,
      comparator: { route: item.row.route, estimand: item.row.estimand, scenario: lead.scenario, ...(alsoRead.length ? { alsoRead } : {}) },
      endpoint: object(lead.scenario.endpoint), assumptions: lead.bound,
    } });
  }

  /**
   * A job the worker finished: point the object at its result, write the
   * lineage edge, clear the stale marks the recompute left once every stage of
   * the object has landed, register the predictions the result makes, and let
   * the step status follow from the data on the next pass.
   * @param {{ job: any, result?: any, partial?: boolean }} outcome
   */
  async onJobFinished({ job, result = null }) {
    if (!job) return false;
    // A comparison of two library versions is a result of its own, kept aside from the study's (`VCR_COMPARISON_RESULT_KIND`):
    // no object points at it, no step follows it and no review is queued for it.
    if (result?.kind === VCR_COMPARISON_RESULT_KIND) return true;
    const mark = await this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'job' AND job_id = $2`, [job.studyId, job.id]);
    const study = await this.store.studyById(String(job.studyId));
    if (!study) return false;
    await this.#exclusive(study.id, async () => {
      const detail = object(mark?.detail);
      const node = String(detail.node ?? "");
      const stage = detail.stage ? String(detail.stage) : null;
      if (result && node) await this.#landResult(study, job, result, node);
      if (mark) {
        const state = job.state === "succeeded" ? "done" : job.state === "canceled" ? "skipped" : "failed";
        await this.#update(job.studyId, String(mark.key), { state, detail: {
          jobState: job.state, resultId: result?.id ?? null, conclusion: result?.conclusion ?? null,
          ...(job.state === "canceled" ? { canceled: true } : {}),
          ...(job.state === "failed" ? { error: String(object(job.error).code ?? "vcr_job_failed"), message: String(object(job.error).message ?? "").slice(0, 400) } : {}),
          ...(stage ? { stage } : {}),
        } });
      }
      if (job.state === "succeeded" && result) await this.#registerForecasts(study, job, result);
    });
    // No review here: the study's results are reviewed once they have stopped changing (`#reviewSettled`), not
    // each time the queue drains, and the review of a package or a finished programme is queued by its run.
    await this.advance(job.studyId);
    return true;
  }

  /**
   * Point an object at the result a stage produced.
   * @param {any} study @param {any} job @param {any} result @param {string} node
   */
  async #landResult(study, job, result, node) {
    const parsed = parseLineageNode(node);
    if (!parsed) return;
    const table = { population: "populations", patient_set: "patient_sets", comparator_design: "comparator_designs", trial_scenario: "trial_scenarios" }[parsed.kind];
    if (table) {
      const gaps = list(object(result.diagnostics).gaps).length ? list(object(result.diagnostics).gaps)
        : (result.conclusion === "not_estimable" ? vcrGapsForRule(String(result.notEstimableRule ?? "")) : []);
      await this.store.attachResult(table, parsed.id, result.id, table === "comparator_designs" ? { conclusion: result.conclusion, gapList: gaps } : {});
    } else if (parsed.kind === "design_grid") {
      // The engine numbers a grid's designs and truths from 1 (it is R's, and its own long table
      // says design 2, truth 1 of the second design under the first truth); a cell is kept as
      // the engine numbered it, and the page reads it as that — a 0 is not a cell of this grid.
      const cells = list(object(result.diagnostics).cells).map(object)
        .filter((cell) => Number.isInteger(cell.designIndex) && Number.isInteger(cell.truthIndex) && cell.designIndex >= 1 && cell.truthIndex >= 1);
      if (cells.length) await this.store.attachGridCells(parsed.id, cells.map((cell) => ({ designIndex: cell.designIndex, truthIndex: cell.truthIndex,
        status: cell.status, measures: list(cell.measures) })));
    }
    await this.store.addEdges(job.studyId, [{ from: node, to: lineageNode("result", result.id, result.version), cost: "light" }]);
    const changedAfterFreeze = await this.store.one(`SELECT 1 FROM ${VCR_SCHEMA}.stale_marks s
      JOIN ${VCR_SCHEMA}.jobs j ON j.id=$3 WHERE s.study_id=$1 AND s.node=$2 AND s.cleared_at IS NULL AND s.marked_at>j.created_at LIMIT 1`,
    [job.studyId, node, job.id]);
    if (changedAfterFreeze) return;
    // The stale marks of an object clear once nothing of it is still computing:
    // its own, its earlier results', and — when nothing downstream is left
    // stale — the superseded inputs they were marked for.
    const open = Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.jobs
      WHERE study_id = $1 AND state IN ('queued', 'running', 'awaiting_budget') AND checkpoint ->> 'node' = $2`, [job.studyId, node]))?.n ?? 0);
    if (open) return;
    await this.store.clearStale(job.studyId, [node]);
    await this.store.query(`UPDATE ${VCR_SCHEMA}.schedule_marks SET state = 'done', done_at = now(), updated_at = now()
      WHERE study_id = $1 AND kind = 'recompute' AND key = $2 AND state <> 'done'`, [job.studyId, `recompute:${node}`]);
    await this.#settleUpstream(job.studyId);
  }

  /**
   * Stale marks are for what is current. A mark on a version something newer
   * has replaced — the earlier result of a recomputed object, an earlier
   * version of a design — is cleared once its successor exists; and once
   * nothing current is left stale, the superseded inputs they were marked for
   * (the old assumption version, the old snapshot) have nothing left to say.
   * @param {string} studyId
   */
  async #settleUpstream(studyId) {
    const open = await this.store.staleMarks(studyId);
    if (!open.length) return;
    const [populations, patientSets, comparators, scenarios, grid, results] = await Promise.all([
      this.store.populations(studyId, 50), this.store.patientSets(studyId, 50), this.store.comparatorDesigns(studyId, 50),
      this.store.trialScenarios(studyId, 60), this.store.latestDesignGrid(studyId), this.store.results(studyId),
    ]);
    /** @type {Set<string>} */
    const current = new Set();
    if (populations[0]) current.add(vcrObjectNode("population", populations[0]));
    if (patientSets[0]) current.add(vcrObjectNode("patient_set", patientSets[0]));
    /** @type {Set<string>} */
    const routes = new Set();
    for (const design of comparators) if (!routes.has(design.route)) { routes.add(design.route); current.add(vcrObjectNode("comparator", design)); }
    /** @type {Set<string>} */
    const labels = new Set();
    for (const scenario of scenarios) {
      const key = scenario.label || scenario.id;
      if (!labels.has(key)) { labels.add(key); current.add(vcrObjectNode("trial_scenario", scenario)); }
    }
    if (grid) current.add(lineageNode("design_grid", grid.id, grid.version));
    for (const result of results) current.add(lineageNode("result", result.id, result.version));
    const managed = new Set(["population", "patient_set", "comparator_design", "trial_scenario", "design_grid", "result"]);
    const obsolete = open.filter((mark) => managed.has(String(parseLineageNode(mark.node)?.kind)) && !current.has(mark.node));
    if (obsolete.length) await this.store.clearStale(studyId, obsolete.map((mark) => mark.node));
    const remaining = open.filter((mark) => !obsolete.includes(mark));
    const upstream = new Set(["study_definition", "assumption", "snapshot", "protocol_version", "criterion"]);
    if (remaining.length && remaining.every((mark) => upstream.has(String(parseLineageNode(mark.node)?.kind)))) {
      await this.store.clearStale(studyId, remaining.map((mark) => mark.node));
    }
  }

  // --- forecasts (plan §5.4: 预测登记) --------------------------------------------------------

  /**
   * The key predictions of a finished simulation or accrual forecast, frozen
   * with the instant they were made (hash over the payload and the time, so the
   * same numbers registered later are a different claim). Once per job; a
   * change of the result is a new job and a new version.
   * @param {any} study @param {any} job @param {any} result
   */
  async #registerForecasts(study, job, result) {
    if (!["design_simulation", "accrual_forecast"].includes(String(job.kind))) return;
    const claimed = await this.#claim(study, `forecast:${job.id}`, "notice", "done", { detail: { jobId: job.id } });
    if (!claimed) return;
    const measures = list(result.measures).map(object);
    if (job.kind === "design_simulation") {
      const keep = ["power", "type_one_error", "assurance", "expected_events", "expected_sample_size", "duration_months", "bias", "coverage"];
      const prediction = { scenarioId: result.subjectId ?? null, resultId: result.id, replicates: result.replicates ?? null,
        measures: Object.fromEntries(measures.filter((measure) => keep.includes(String(measure.name))).map((measure) => [String(measure.name), { value: measure.value, mcse: measure.mcse ?? null }])) };
      if (Object.keys(prediction.measures).length) await this.store.registerForecast({ studyId: study.id, userId: study.userId, kind: "trial", prediction, at: this.now() });
      return;
    }
    const frozen = await this.store.one(`SELECT scenario FROM ${VCR_SCHEMA}.jobs WHERE id = $1`, [String(job.id)]);
    const scenario = object(frozen?.scenario);
    const sites = list(scenario.sites).map(object);
    const lastPatient = measures.find((measure) => measure.name === "last_patient_in_months");
    if (!lastPatient || !sites.length) return;
    await this.store.registerForecast({
      studyId: study.id, userId: study.userId, kind: "accrual", at: this.now(),
      prediction: {
        resultId: result.id, measure: "last_patient_in_months", median: lastPatient.value,
        low: object(lastPatient.interval).low ?? null, high: object(lastPatient.interval).high ?? null, target: scenario.target ?? null,
        // The shape the accrual backtest reads (`accrualBacktestSlices`): the measure with its prediction interval.
        measures: [{ name: "last_patient_in_months", value: lastPatient.value, unit: "months", interval: lastPatient.interval ?? null }],
        interval: lastPatient.interval ?? null,
        // What the forecast's own rate posteriors say the enrolment should be at
        // any later month — closed form over the frozen sites, so the comparison
        // with what actually happened needs no second simulation.
        baseline: sites.reduce((total, site) => total + Number(site.enrolled ?? 0), 0),
        sites: sites.map((site) => ({ rate: Number(site.alpha) / Number(site.beta), start: Number(site.startTime ?? 0) })),
      },
    });
  }

  /**
   * Hold each registered accrual forecast against the enrolment that actually
   * happened. Only when the study keeps referrals at all: with none, an
   * enrolment of zero would read as a forecast missed by all of it.
   * @param {any} study
   */
  async #compareForecasts(study) {
    const forecasts = (await this.store.forecasts(study.id)).filter((forecast) => forecast.kind === "accrual" && Array.isArray(object(forecast.prediction).sites));
    if (!forecasts.length) return;
    const kept = Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.referrals WHERE study_id = $1`, [study.id]))?.n ?? 0);
    if (!kept) return;
    const actual = Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.referrals
      WHERE study_id = $1 AND state = 'enrolled' AND enrolled_on IS NOT NULL`, [study.id]))?.n ?? 0);
    for (const forecast of forecasts) {
      const prediction = object(forecast.prediction);
      const months = (this.now().getTime() - Date.parse(String(forecast.createdAt))) / (30.4375 * 86_400_000);
      if (!(months >= 1)) continue;
      const expected = Number(prediction.baseline ?? 0) + list(prediction.sites).map(object)
        .reduce((total, site) => total + Number(site.rate) * Math.max(0, months - Number(site.start ?? 0)), 0);
      const predicted = Math.round(Number.isFinite(Number(prediction.target)) ? Math.min(Number(prediction.target), expected) : expected);
      if (object(forecast.actual).enrolled === actual && object(forecast.actual).predictedEnrolled === predicted) continue;
      await this.store.compareForecast(forecast.id, { enrolled: actual, predictedEnrolled: predicted, elapsedMonths: Math.round(months * 10) / 10, asOf: this.now().toISOString() });
    }
  }

  // --- the thinking half: one run ---------------------------------------------------------

  /** @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @param {{ dispatched: any, deferred: string | null }} result */
  async #nextRun(study, plan, result) {
    if (!this.dispatchRun) return;
    const active = (await this.store.rows(`SELECT 1 FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run' AND state IN ('claimed', 'running') LIMIT 1`, [study.id])).length > 0;
    if (active) return;
    const candidates = [
      () => this.#pendingReviewRepair(study),
      () => this.#pendingExport(study),
      () => this.#pendingEvidenceRefresh(study),
      () => this.#stepRun(study, plan, "definition"),
      () => this.#stepRun(study, plan, "evidence"),
      () => this.#analysisRun(study, plan),
      () => this.#stepRun(study, plan, "matching"),
    ];
    for (const candidate of candidates) {
      const spec = await candidate();
      if (!spec) continue;
      const outcome = await this.#dispatch(study, spec);
      if (outcome.dispatched) result.dispatched = outcome.dispatched;
      if (outcome.deferred) result.deferred = outcome.deferred;
      if (outcome.dispatched || outcome.deferred || outcome.busy) return;
    }
  }

  /** @typedef {{ key: string, purpose: string, capabilityId: string, reason: string, brief: string, steps: string[], detail?: Record<string, any>,
   *   products?: string[] }} VcrRunSpec */

  /** Whether a run key may be tried again. @param {any} mark */
  #allowed(mark) {
    if (!mark) return true;
    if (["claimed", "running"].includes(String(mark.state))) return false;
    return Number(mark.attempts ?? 0) < Number(object(mark.detail).allowed ?? VCR_RUN_RULES.attempts);
  }

  /** @param {any} study @returns {Promise<VcrRunSpec | null>} */
  async #pendingReviewRepair(study) {
    const mark = await this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id=$1 AND kind='run'
      AND starts_with(key,'run:review-repair:') AND state='pending' ORDER BY created_at LIMIT 1`, [study.id]);
    if (!mark || !this.#allowed(mark)) return null;
    const detail = object(mark.detail);
    const original = await this.store.exportRow(study.id, String(detail.revisionOf));
    const [reviews, results, stale, assumptions, populations, patientSets, comparators, scenarios, grid, definition, protocol] = await Promise.all([
      this.store.reviews(study.id), this.store.results(study.id), this.store.staleMarks(study.id), this.store.assumptions(study.id),
      this.store.populations(study.id), this.store.patientSets(study.id), this.store.comparatorDesigns(study.id),
      this.store.trialScenarios(study.id), this.store.latestDesignGrid(study.id), this.store.latestDefinition(study.id), this.store.latestProtocolVersion(study.id),
    ]);
    const current = vcrCurrentNodes({ study, results, assumptions, populations, patientSets, comparators, scenarios, grid, definition, protocol });
    const revision = await this.store.exportRow(study.id, String(detail.exportId));
    const ids = list(revision?.cover?.reviewRepair?.reviewIds);
    if (!original || vcrReportReviewRevision(original.cover) !== detail.reportRevision
      || !reviews.some(review => ids.includes(review.platformReviewId) && vcrReviewIsCurrent(review, { results, stale, current, exports: [original] }))) {
      await this.#update(study.id, String(mark.key), { state: "failed", detail: { lastError: "review_changed_before_repair" } }, ["pending"]);
      if (revision) await this.store.updateExport(revision.id, { state: "failed" });
      return null;
    }
    return { key: String(mark.key), purpose: "export", capabilityId: "vcr-package", reason: "vcr:review-repair",
      brief: String(detail.brief), steps: [], detail };
  }

  /** @param {any} study @returns {Promise<VcrRunSpec | null>} */
  async #pendingExport(study) {
    const mark = await this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'run'
      AND starts_with(key, 'run:export:') AND state = 'pending' ORDER BY created_at LIMIT 1`, [study.id]);
    if (!mark || !this.#allowed(mark)) return null;
    const detail = object(mark.detail);
    return {
      key: String(mark.key), purpose: "export", capabilityId: "vcr-package", reason: `vcr:export-${detail.kind ?? "study_package"}`,
      brief: await this.#brief(study, String(mark.key), [], { kind: detail.kind, exportId: detail.exportId }),
      steps: [], detail: { kind: detail.kind, exportId: detail.exportId },
    };
  }

  /**
   * The run the frontier consumer asked for to take new evidence into a study's cards (flywheel F24): an `evidence` run with a brief
   * naming the cards and the news. It is dispatched exactly as every other run of the study is — the study active, the one run slot
   * free, the key within its attempts, and the allowance and the bounded budget `dispatchRun` asks of any programme run — and when
   * any of those says no the key stays pending and nothing else happens.
   * @param {any} study @returns {Promise<VcrRunSpec | null>}
   */
  async #pendingEvidenceRefresh(study) {
    const mark = await this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'run'
      AND starts_with(key, 'run:evidence-refresh:') AND state = 'pending' ORDER BY created_at LIMIT 1`, [study.id]);
    if (!mark || !this.#allowed(mark)) return null;
    const detail = object(mark.detail);
    return {
      key: String(mark.key), purpose: "evidence_refresh", capabilityId: /** @type {Record<string, string>} */ (VCR_STEP_CAPABILITIES).evidence,
      reason: "vcr:evidence-refresh", brief: String(detail.brief ?? ""), steps: [],
      detail: { keys: list(detail.keys), items: list(detail.items) },
    };
  }

  /** @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @param {string} step @returns {Promise<VcrRunSpec | null>} */
  async #stepRun(study, plan, step) {
    if (!plan.want.has(step)) return null;
    // A study made without saying what it is about has nothing to write a
    // definition from; a run on an empty brief would invent one. It waits for the
    // question (the composer's sentence, or an uploaded protocol's title).
    if (step === "definition" && !String(study.question ?? "").trim() && !(await this.store.latestDefinition(study.id))) {
      await this.#step(study, step, { note: "先说一句要研究什么：在对话里写下问题，或上传方案。" });
      return null;
    }
    if (step === "definition" && String(study.steps.definition?.note ?? "").startsWith("先说一句")) await this.#step(study, step, { note: null });
    const status = study.steps[step]?.status ?? "none";
    const wanted = ["none", "queued", "failed", "stale"].includes(status)
      || (status === "minimal" && plan.requested.has(step));
    if (!wanted) return null;
    const key = `run:${step}`;
    if (!this.#allowed(await this.#mark(study.id, key))) return null;
    return {
      key, purpose: step, capabilityId: /** @type {Record<string, string>} */ (VCR_STEP_CAPABILITIES)[step],
      reason: `vcr:${step}`,
      brief: await this.#brief(study, key, [step], { fidelity: plan.fidelity(step) }),
      steps: [step], detail: { scope: [{ step, fidelity: plan.fidelity(step) }] },
    };
  }

  /**
   * The four analysis steps in one run (plan §10.3's timeline is one
   * continuous stretch of work): the run writes each object and the platform
   * computes it, so the run's own order follows a real data dependency, never
   * a staged workflow (principle 12).
   * @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @returns {Promise<VcrRunSpec | null>}
   */
  async #analysisRun(study, plan) {
    const held = this.#objectStates(await this.#read(study));
    const scope = VCR_ANALYSIS_STEPS.filter((step) => {
      if (!plan.want.has(step)) return false;
      // What the run wrote is the platform's to compute: an object being
      // computed (a recomputation included) or waiting for compute upstream needs
      // no second run to write it again. A run is for what is not written, failed,
      // or stale with nothing already on its way.
      const objects = held[step] ?? [];
      if (objects.length && objects.every((entry) => entry.open || entry.state === "waiting")) return false;
      const status = study.steps[step]?.status ?? "none";
      if (["none", "queued", "failed", "stale"].includes(status)) return true;
      return status === "minimal" && plan.requested.has(step);
    }).map((step) => ({ step, fidelity: plan.fidelity(step) }));
    if (!scope.length) return null;
    // A step whose compute is already out does not need a run to write it again.
    const working = await this.store.rows(`SELECT 1 FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1
      AND state IN ('queued', 'running') LIMIT 1`, [study.id]);
    const waiting = scope.every((entry) => (study.steps[entry.step]?.status ?? "none") === "running");
    if (working.length && waiting) return null;
    const key = "run:analysis";
    if (!this.#allowed(await this.#mark(study.id, key))) return null;
    return {
      key, purpose: "analysis", capabilityId: VCR_STEP_CAPABILITIES.population, reason: `vcr:${scope[0].step}`,
      brief: await this.#brief(study, key, scope.map((entry) => entry.step), { scope }),
      steps: scope.map((entry) => entry.step), detail: { scope }, products: vcrProductsOfSteps(scope.map((entry) => entry.step)),
    };
  }

  /**
   * What the run is told. A brief is text, injected by whoever composes the
   * module (so it stays editable prose, never a control flow — principle 7);
   * without one the run gets the study's own question and what it is for
   * ({@link vcrDefaultBrief}): the steps asked of it, or — for an export — which
   * document, which a skill cannot know and a run cannot guess.
   * @param {any} study @param {string} key @param {string[]} scope @param {Record<string, any>} detail
   */
  async #brief(study, key, scope, detail) {
    if (this.briefFor) {
      const custom = await this.briefFor({ study, key, scope, detail, fidelity: (/** @type {string} */ step) => (scope.includes(step) ? "full" : "minimal") });
      if (custom) return String(custom);
    }
    return vcrDefaultBrief({ study, scope, detail });
  }

  /**
   * Claim the run slot and the key, dispatch, record. A refusal that waiting
   * can clear leaves the key pending; one that cannot fails the steps it would
   * have served.
   * @param {any} study @param {VcrRunSpec} spec
   */
  async #dispatch(study, spec) {
    const claim = await this.store.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-run:' || $1))", [study.id]);
      const status = await client.query(`SELECT status FROM ${VCR_SCHEMA}.studies WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [study.id]);
      if (status.rows[0]?.status !== "active") return { busy: true };
      const active = await client.query(`SELECT key FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'run'
        AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2))) LIMIT 1`,
      [study.id, VCR_RUN_RULES.staleClaimMinutes]);
      if (active.rows.length) return { busy: true };
      const existing = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND key = $2 FOR UPDATE`,
        [study.id, spec.key])).rows[0];
      if (existing && !this.#allowed(existing)) return { busy: true };
      const attempts = Number(existing?.attempts ?? 0);
      const reuse = existing && ["pending", "claimed"].includes(String(existing.state)) && existing.dispatch_id;
      const dispatchId = reuse ? String(existing.dispatch_id) : vcrDispatchId(spec.key, attempts + 1);
      const detail = { ...object(spec.detail), purpose: spec.purpose, capabilityId: spec.capabilityId };
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.schedule_marks (study_id, key, user_id, kind, state, dispatch_id, detail)
        VALUES ($1, $2, $3, 'run', 'claimed', $4, $5::jsonb)
        ON CONFLICT (study_id, key) DO UPDATE SET state = 'claimed', dispatch_id = EXCLUDED.dispatch_id,
          detail = schedule_marks.detail || EXCLUDED.detail, run_id = NULL, session_id = NULL, done_at = NULL, updated_at = now()
        RETURNING *`, [study.id, spec.key, study.userId, dispatchId, JSON.stringify(detail)])).rows[0];
      return { mark: row };
    });
    if (claim.busy) return { busy: true };
    const mark = claim.mark;
    let current = study;
    for (const step of spec.steps) {
      if ((current.steps[step]?.status ?? "none") !== "running") current = await this.#step(current, step, { status: "queued" });
    }
    try {
      const out = await /** @type {NonNullable<VcrOrchestrator["dispatchRun"]>} */ (this.dispatchRun)({
        userId: study.userId, projectId: study.projectId, studyId: study.id, capabilityId: spec.capabilityId,
        dispatchId: String(mark.dispatch_id), reason: spec.reason, brief: spec.brief,
        ...(spec.products?.length ? { products: spec.products } : {}),
      });
      const running = await this.#update(study.id, spec.key, {
        state: "running", runId: String(out.runId), sessionId: out.sessionId ?? null, attempts: Number(mark.attempts ?? 0) + 1,
      }, ["claimed"]);
      for (const step of spec.steps) current = await this.#step(current, step, { status: "running", runId: String(out.runId), ...unwaiting(current, step) });
      this.counters.dispatched += 1;
      if (running && out.status && TERMINAL_RUN.has(String(out.status))) await this.#finishRun(current, running, String(out.status));
      return { dispatched: { runId: String(out.runId), sessionId: out.sessionId ?? null } };
    } catch (error) {
      const code = codeOf(error);
      if (TERMINAL_DISPATCH.has(code)) {
        await this.#update(study.id, spec.key, { state: "failed", detail: { lastError: code, allowed: Number(mark.attempts ?? 0) } }, ["claimed"]);
        for (const step of spec.steps) current = await this.#step(current, step, { status: "failed", ...unwaiting(current, step) });
        // An export has no step to fail: its row is what says the run will never come, or it reads 「排队中」 for good.
        if (spec.purpose === "export" && object(spec.detail).exportId) {
          await this.store.updateExport(String(object(spec.detail).exportId), { state: "failed" });
        }
        this.counters.dispatchFailed += 1;
        this.lastError = code;
        return { failed: code };
      }
      await this.#update(study.id, spec.key, { state: "pending", detail: { lastError: code } }, ["claimed"]);
      this.counters.deferred += 1;
      this.lastDeferral = code;
      // A start the allowance refused is not a step that is merely queued: the page says what it waits on, and where
      // that is put right. The key stays pending, so the next tick asks again and the step starts by itself.
      const waiting = stepWaitingFor(code);
      if (waiting) {
        for (const step of spec.steps) current = await this.#step(current, step, { status: "queued", waiting, note: allowanceWaitingNote(waiting) });
      }
      return { deferred: code };
    }
  }

  /**
   * The run ledger's completion, for every run of the platform: a run this
   * module dispatched (`vcr-…`) is folded into its steps.
   * @param {{ userId: string, id: string }} controlProject @param {{ id: string, dispatchId?: string | null, status: string }} run
   */
  async onRunFinished(controlProject, run) {
    if (!String(run?.dispatchId ?? "").startsWith("vcr-") || !TERMINAL_RUN.has(String(run.status))) return false;
    const row = await this.store.one(`SELECT m.* FROM ${VCR_SCHEMA}.schedule_marks m
      JOIN ${VCR_SCHEMA}.studies s ON s.id = m.study_id
      WHERE s.user_id = $1 AND s.project_id = $2 AND s.deleted_at IS NULL AND m.kind = 'run' AND m.dispatch_id = $3`,
    [String(controlProject.userId), String(controlProject.id), String(run.dispatchId)]);
    if (!row || ["done", "failed"].includes(String(row.state))) return false;
    await this.#exclusive(String(row.study_id), async () => {
      const study = await this.store.studyById(String(row.study_id));
      if (study) await this.#finishRun(study, { ...row, run_id: row.run_id ?? run.id }, String(run.status));
    });
    await this.advance(String(row.study_id));
    return true;
  }

  /** @param {any} study @param {any} mark @param {string} status */
  async #finishRun(study, mark, status) {
    const moved = await this.#update(study.id, String(mark.key), {
      state: status === "succeeded" ? "done" : "failed", detail: { runStatus: status },
    }, ["claimed", "running", "pending"]);
    if (!moved) return;
    this.counters.runsFinished += 1;
    const detail = object(mark.detail);
    // A run for new evidence has no step to read and nothing to review: what it wrote is on the cards (`ai_set`), and the frontier
    // consumer sees the versions arrive and closes the labels.
    if (detail.purpose === "evidence_refresh") return;
    if (detail.purpose === "export" && detail.exportId) {
      const existing = await this.store.exportRow(study.id, String(detail.exportId));
      // The report's snapshot owns its cover; completion cannot relabel old
      // numbers with newer reviews or replace usable work after a run failure.
      const cover = existing?.cover ?? {};
      // A run that ends with no document in its export leaves the row `failed`, whatever the run's own status: the
      // study page reads that row into 「需要关注」 the way it reads a step that did not finish (`attentionOf`).
      const usable = vcrExportHoldsDocument(cover);
      const row = await this.store.updateExport(String(detail.exportId), {
        state: usable ? "ready" : "failed", runId: mark.run_id ?? null, cover,
      });
      if (usable && this.queueExport) await this.queueExport({ id: study.userId }, study, row);
      if (usable) await this.#queueReview(study.id, { exportId: row.id, runId: mark.run_id ?? undefined, reason: "package_finished" });
      if (row?.state === "ready" && this.notifier?.packageReady) {
        await this.#notice(study, `notice:package:${row.id}`, () => this.notifier.packageReady(study, {
          exportId: row.id, kind: row.kind, headline: object(cover).headline ?? null, gaps: Number(object(cover).staleResults ?? 0),
        }));
      }
      return;
    }
    // Everything else is read from the data on the next pass: a failed run
    // that wrote its object still counts, and a finished run that wrote
    // nothing leaves its step where it was for a person to ask again. The run
    // is over by now, so a step it left nothing for no longer reads running
    // (`vcrIdleStepStatus`) — which is what lets a run that failed be said here.
    const plan = wantedVcrSteps(vcrProgramSteps(study.steps));
    const observed = await this.#observe(study, plan);
    for (const entry of list(detail.scope)) {
      const step = String(object(entry).step ?? entry);
      if (!VCR_STEPS.includes(step)) continue;
      const now = observed.steps[step]?.status ?? "none";
      if (FINISHED.has(now) || now === "running") continue;
      if (status !== "succeeded") await this.#step(observed, step, { status: "failed" });
    }
    await this.#queueReview(study.id, { runId: mark.run_id ?? undefined, reason: "research_finished" });
  }

  // --- change propagation (plan §6.3) --------------------------------------------------

  /**
   * Something changed: work out what it makes stale, mark all of it with the
   * reason, recompute the light half now and queue the heavy half. Stale
   * results are never deleted or hidden (AC-16) — the page greys them and says
   * why, and a study package either recomputes them or says so on its cover.
   *
   * The five reasons are raised from five places: a written assumption
   * (`assumption_changed`), a written criterion (`criterion_changed`) or a
   * revision of a protocol that was already frozen (`protocol_revised`), a new
   * snapshot of a source a result was computed from (`source_corrected`, found
   * by `#detectChanges`), and a method whose version moved
   * (`method_version_changed`, found there too).
   *
   * @param {{ studyId: string, changed: readonly string[], reason: string, detail?: Record<string, any> }} input
   */
  async recomputeAfterChange({ studyId, changed, reason, detail = {} }) {
    if (!VCR_STALE_REASONS.includes(reason)) throw new TypeError(`recomputeAfterChange: unknown reason ${JSON.stringify(reason)}`);
    const study = await this.store.studyById(studyId);
    if (!study) return { light: [], heavy: [], marked: 0 };
    const plan = await this.#mark_stale(study, changed, reason, detail);
    await this.advance(studyId);
    return plan;
  }

  /**
   * The marking half of a change, without the pass that follows it (which
   * would wait for the lock the caller may hold).
   * @param {any} study @param {readonly string[]} changed @param {string} reason @param {Record<string, any>} detail
   */
  async #mark_stale(study, changed, reason, detail) {
    const edges = await this.store.edges(study.id);
    changed = await this.#protocolLine(study, changed);
    const refined = await this.#refineReason(study, changed, reason);
    const plan = recomputePlan({ edges, changed: [...changed], reason: refined });
    if (!plan.all.length) return { ...plan, marked: 0 };
    await this.store.markStale(study.id, plan.all, refined, { ...detail, changed: [...changed] });
    this.counters.recomputes += 1;
    // An object whose result is stale is computed again by the next pass (its
    // stale mark is what says so, and a job of the same object under the new
    // versions is a new idempotency key). The light half goes at once; the heavy
    // half is queued the same way and stops at `awaiting_budget` if the study's
    // compute budget cannot carry it — the second human stop.
    for (const [cost, nodes] of [["light", plan.light], ["heavy", plan.heavy]]) {
      for (const node of /** @type {readonly string[]} */ (nodes)) {
        await this.#claim(study, `recompute:${node}`, "recompute", "pending", { detail: { reason: refined, cost } });
        await this.#dropMarks(study.id, `job:${node}`);
      }
    }
    return { ...plan, marked: plan.all.length };
  }

  /**
   * A protocol is one line of versions per study, and its lineage node is that
   * line: `protocol_version:<study>@<version>`. A version row has an id of its
   * own, but a node named by it would be a different object from the version it
   * replaced, and the change would reach nothing the old one fed. A caller that
   * names a version by its row id is read as the line it belongs to.
   * @param {any} study @param {readonly string[]} changed
   */
  async #protocolLine(study, changed) {
    /** @type {string[]} */
    const out = [];
    for (const node of changed) {
      const parsed = parseLineageNode(node);
      if (parsed?.kind !== "protocol_version" || parsed.id === study.id) { out.push(node); continue; }
      const row = await this.store.one(`SELECT version FROM ${VCR_SCHEMA}.protocol_versions WHERE id = $1 AND study_id = $2`, [parsed.id, study.id]);
      out.push(row ? lineageNode("protocol_version", study.id, Number(row.version)) : node);
    }
    return out;
  }

  /**
   * A criterion change under a protocol that was already frozen is a revision of
   * the protocol: the plan reads 「方案正式修订」 and names it separately from an
   * edit of a draft (§6.3).
   * @param {any} study @param {readonly string[]} changed @param {string} reason
   */
  async #refineReason(study, changed, reason) {
    if (reason !== "criterion_changed") return reason;
    for (const node of changed) {
      const parsed = parseLineageNode(node);
      if (parsed?.kind !== "protocol_version" || parsed.version < 2) continue;
      const earlier = await this.store.one(`SELECT frozen_at FROM ${VCR_SCHEMA}.protocol_versions WHERE study_id = $1 AND version < $2
        ORDER BY version DESC LIMIT 1`, [study.id, parsed.version]);
      if (earlier?.frozen_at) return "protocol_revised";
    }
    return reason;
  }

  /**
   * The changes nobody writes down: a source that has a newer snapshot than the
   * one a result was computed from, and an engine method whose version is not
   * the one a current result was computed with. Each is raised once (a mark
   * keyed by what changed to), so a pass that finds it again does nothing.
   * @param {any} study
   */
  async #detectChanges(study) {
    const edges = await this.store.edges(study.id);
    const snapshots = new Map();
    for (const edge of edges) {
      const parsed = parseLineageNode(edge.from);
      if (parsed?.kind === "snapshot") snapshots.set(parsed.id, Math.max(snapshots.get(parsed.id) ?? 0, parsed.version));
    }
    for (const [sourceId, used] of snapshots) {
      const newest = Number((await this.store.one(`SELECT max(version)::integer AS v FROM ${VCR_SCHEMA}.snapshots WHERE source_id = $1`, [sourceId]))?.v ?? 0);
      if (newest <= used) continue;
      const node = lineageNode("snapshot", sourceId, newest);
      if (!(await this.#claim(study, `detect:${node}`, "notice", "done", { detail: { sourceId, from: used, to: newest } }))) continue;
      await this.#mark_stale(study, [node], "source_corrected", { by: "detect", sourceId });
    }
    // A current result can aggregate several stages. Its execution_id names
    // only the last landing, while earlier stages still supply its numbers.
    // Require the current stageResults bond and the stored job's study/node/
    // stage, so a retired or foreign diagnostic reference grants no authority.
    const rows = await this.store.rows(`WITH current_results AS (
        SELECT r.study_id,r.diagnostics,e.id AS execution_id,j.checkpoint->>'node' AS node
        FROM ${VCR_SCHEMA}.results r
        JOIN ${VCR_SCHEMA}.executions e ON e.id=r.execution_id AND e.study_id=r.study_id
        JOIN ${VCR_SCHEMA}.jobs j ON j.id=e.job_id AND j.study_id=r.study_id
        WHERE r.study_id=$1 AND r.superseded_by IS NULL AND j.checkpoint ? 'node'
      ), contributions AS (
        SELECT study_id,node,execution_id FROM current_results
        UNION
        SELECT c.study_id,c.node,e.id FROM current_results c
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.diagnostics->'stages')='array'
          THEN c.diagnostics->'stages' ELSE '[]'::jsonb END) AS s(stage)
        JOIN ${VCR_SCHEMA}.executions e ON e.job_id=s.stage->>'jobId' AND e.study_id=c.study_id
        JOIN ${VCR_SCHEMA}.jobs j ON j.id=e.job_id AND j.study_id=c.study_id
        WHERE c.diagnostics->'stageResults'->(s.stage->>'stage')->>'jobId'=e.job_id
          AND j.checkpoint->>'node'=c.node AND j.checkpoint->>'stage'=s.stage->>'stage'
      ) SELECT DISTINCT c.node,e.method,e.method_version FROM contributions c
      JOIN ${VCR_SCHEMA}.executions e ON e.id=c.execution_id AND e.study_id=c.study_id`, [study.id]);
    for (const row of rows) {
      const now = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[String(row.method)]?.version;
      if (!now || now === String(row.method_version)) continue;
      const node = String(row.node);
      if (!parseLineageNode(node)) continue;
      const key = `detect:method:${node}:${now}`;
      if (!(await this.#claim(study, key, "notice", "done", { detail: { method: row.method, from: row.method_version, to: now } }))) continue;
      // The object itself is what is computed again; nothing upstream of it moved.
      const plan = { light: [node], heavy: [], all: [node] };
      await this.store.markStale(study.id, plan.all, "method_version_changed", { method: row.method, from: row.method_version, to: now });
      await this.#claim(study, `recompute:${node}`, "recompute", "pending", { detail: { reason: "method_version_changed" } });
      await this.#dropMarks(study.id, `job:${node}`);
      this.counters.recomputes += 1;
    }
  }

  // --- notices (plan §10.4) --------------------------------------------------------------

  /**
   * Send a notice once per key: the mark is written only when the inbox took
   * it, so an inbox that was down is tried again.
   * @param {any} study @param {string} key @param {() => Promise<any> | undefined} send
   */
  async #notice(study, key, send) {
    if (!this.notifier || (await this.#mark(study.id, key))) return false;
    const sent = await send();
    if (!sent) return false;
    await this.#claim(study, key, "notice", "done", { detail: {} });
    this.counters.notices += 1;
    return true;
  }

  /** @param {any} study */
  async #notices(study) {
    if (!this.notifier) return;
    const results = await this.store.results(study.id);
    for (const result of results.filter((row) => row.conclusion === "not_estimable").slice(0, VCR_RUN_RULES.noticesPerTick)) {
      await this.#notice(study, `notice:not-estimable:${result.id}`, () => this.notifier.notEstimable?.(study, {
        resultId: result.id, rule: result.notEstimableRule,
        what: result.kind === "comparator" ? "对照分析" : result.kind === "trial_scenario" ? "试验仿真" : "分析",
        gaps: list(object(result.diagnostics).gaps).map((gap) => (typeof gap === "string" ? gap : String(object(gap).title ?? ""))).filter(Boolean),
      }));
    }
    // Two assumptions that cannot both hold are the other half of the same
    // notice (plan §10.4): a conclusion built on them is not one.
    for (const conflict of vcrAssumptionConflicts(await this.store.assumptions(study.id)).slice(0, VCR_RUN_RULES.noticesPerTick)) {
      const id = `conflict-${createHash("sha256").update(`${conflict.code}:${conflict.versions.join(",")}`).digest("hex").slice(0, 16)}`;
      await this.#notice(study, `notice:conflict:${id}`, () => (this.notifier.assumptionConflict
        ? this.notifier.assumptionConflict(study, { conflictId: id, code: conflict.code, keys: conflict.keys, detail: conflict.detail })
        : this.notifier.notEstimable?.(study, { resultId: id, rule: null, what: "关键假设", gaps: [conflict.detail] })));
    }
    await this.#compareForecasts(study);
    const tolerance = Number(object(study.budget).accrualTolerance ?? VCR_ACCRUAL_TOLERANCE);
    for (const forecast of (await this.store.forecasts(study.id)).filter((row) => row.actual && row.comparedAt)) {
      const predicted = Number(object(forecast.actual).predictedEnrolled ?? object(forecast.prediction).enrolled ?? object(forecast.prediction).value);
      const actual = Number(object(forecast.actual).enrolled ?? object(forecast.actual).value);
      if (!Number.isFinite(predicted) || !Number.isFinite(actual) || predicted <= 0) continue;
      if (Math.abs(actual - predicted) / predicted <= tolerance) continue;
      // Once per forecast, however many times it is compared afterwards: the
      // deviation is a fact about the prediction, not about the day it was checked.
      await this.#notice(study, `notice:accrual:${forecast.id}`, () => this.notifier.accrualOffForecast?.(study, {
        forecastId: forecast.id, predicted, actual, byMonth: object(forecast.actual).asOf ?? null,
      }));
    }
  }
}
