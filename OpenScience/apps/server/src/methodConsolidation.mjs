/**
 * The nightly pass over the method library: what relates to what, what may take
 * effect, what should stop.
 *
 * Hidden knowledge: this is SkillPyramid's analyser and builder, plus the
 * hold-out gate SkillPyramid does not have. The paper's abstract says its
 * skills are "validated"; sections 2.3 and 2.4 describe no execution test and
 * no success gate, only a prompt line saying live feedback overrides the
 * generated skill. Its measured benefit is real but was obtained in game and
 * web environments at temperature zero, single run, no intervals. So the
 * structure is taken and the confidence is not: nothing an inferred pass
 * proposes becomes effective without a paired evaluation against a frozen
 * baseline (the plan's section 6.4 step 6, and the spec's own note at line 1812).
 *
 * The two model steps are separate runs on purpose, and in that order:
 *
 *  - SCREEN sees only names and descriptions. It is cheap, it is allowed to be
 *    wrong, and its job is to propose small groups worth reading properly.
 *  - DECIDE reads the bodies of one group and returns the paper's
 *    ASSIGNMENT / SKILLS / RELATION_TYPE / REASON. Its assignment is
 *    authoritative for the builder — the paper is explicit about that, and the
 *    reason is that a builder allowed to reconsider the relation will quietly
 *    merge two methods it was told merely share a step.
 *
 * Everything a builder produces is a new revision in `candidate`. Nothing here
 * writes over an effective method, and nothing here deletes: retirement is a
 * status and a notice with a rollback target.
 *
 * @module methodConsolidation
 */

import { createHash } from "node:crypto";

import {
  METHOD_RELATIONS_ACTIONS,
  METHOD_RELATION_TYPES,
  computeMethodLevels,
  evaluationEligible,
  parseSkillFrontmatter,
  preservedSectionsIntact,
  reflectionDue,
  validateMethodGraph,
} from "@evimed/domain";
import { methodRecordFrom } from "./learningService.mjs";
import { HttpError } from "./security.mjs";

/** What `consolidate` can be asked to do. There is no new job kind: the kinds
 *  are a DDL CHECK constraint, and `consolidate` was already one of them. */
export const CONSOLIDATE_ACTIONS = Object.freeze(["sleep", "integrate", "evaluate", "optimize"]);

/** The capability's own action vocabulary, asserted here so a rename upstream is
 *  a load-time failure rather than a run that submits an action nobody accepts. */
for (const action of ["screen", "decide", "build"]) {
  if (!METHOD_RELATIONS_ACTIONS.includes(action)) {
    throw new TypeError(`method-relations no longer accepts the "${action}" action.`);
  }
}

/** Bounds for one night, so a library that grows does not turn into a bill. */
export const CONSOLIDATION_LIMITS = Object.freeze({
  maxMethods: 100,
  maxGroups: 6,
  maxGroupSize: 8,
  minGroupSize: 2,
  maxBuilds: 6,
  // How many pairs one SCREEN run may be shown. The shortlist is already
  // ordered by overlap, so a cap takes the least plausible pairs off the end;
  // an uncapped screen would grow with the square of the library and stop being
  // the cheap step.
  maxScreenPairs: 40,
});

/** @param {string} value @returns {string} */
const shortDigest = (value) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);

/**
 * Candidate pairs worth showing SCREEN.
 *
 * Deterministic and free: shared tokens between names and descriptions. It is
 * not the screen — the model does that — it is the bound on how much the model
 * is asked to look at, because handing an LLM a hundred methods and asking for
 * groups costs a hundred methods of context and returns groups it invented to
 * fill the answer.
 * @param {readonly any[]} methods
 * @returns {{a: string, b: string, overlap: number}[]}
 */
export function candidatePairs(methods) {
  /** @param {any} method @returns {Set<string>} */
  const tokens = (method) => new Set(
    `${method.payload?.frontmatter?.name ?? ""} ${method.payload?.frontmatter?.description ?? ""}`
      .toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3),
  );
  const indexed = methods.map((method) => ({ id: method.id, tokens: tokens(method) }));
  /** @type {{a: string, b: string, overlap: number}[]} */
  const pairs = [];
  for (let left = 0; left < indexed.length; left += 1) {
    for (let right = left + 1; right < indexed.length; right += 1) {
      let overlap = 0;
      for (const token of indexed[left].tokens) if (indexed[right].tokens.has(token)) overlap += 1;
      if (overlap >= 2) pairs.push({ a: indexed[left].id, b: indexed[right].id, overlap });
    }
  }
  return pairs.sort((one, two) => two.overlap - one.overlap || one.a.localeCompare(two.a));
}

/**
 * Apply one SCREEN answer to the shortlist it was given.
 *
 * Pure, so the rule is testable without a run. Only a pair the model kept
 * survives, and only if it was on the shortlist: an id the answer invented
 * names nothing the grouping budget accounted for, and a pair the answer
 * reordered is the same pair.
 *
 * @param {readonly {a: string, b: string, overlap: number}[]} shortlist
 * @param {any} output
 * @returns {{a: string, b: string, overlap: number}[]}
 */
export function screenedPairs(shortlist, output) {
  const answers = Array.isArray(output?.pairs) ? output.pairs : Array.isArray(output?.kept) ? output.kept : [];
  /** @type {Set<string>} */
  const keep = new Set();
  for (const answer of answers) {
    // `related: false` is an answer, not an absence, and a pair with no verdict
    // at all was not screened — both drop.
    if (answer?.related === false || answer?.keep === false) continue;
    const a = String(answer?.a?.id ?? answer?.a ?? "");
    const b = String(answer?.b?.id ?? answer?.b ?? "");
    if (!a || !b) continue;
    keep.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  }
  return shortlist.filter((pair) => keep.has(pair.a < pair.b ? `${pair.a}\u0000${pair.b}` : `${pair.b}\u0000${pair.a}`));
}

/**
 * Turn scored pairs into disjoint groups.
 *
 * Disjoint because the builder rewrites the methods in a group, and a method in
 * two groups on the same night gets two independent rewrites of the same body,
 * the second of which silently loses the first.
 * @param {{a: string, b: string, overlap: number}[]} pairs
 * @param {{maxGroups?: number, maxGroupSize?: number}} [limits]
 * @returns {string[][]}
 */
export function groupPairs(pairs, limits = {}) {
  const maxGroups = limits.maxGroups ?? CONSOLIDATION_LIMITS.maxGroups;
  const maxGroupSize = limits.maxGroupSize ?? CONSOLIDATION_LIMITS.maxGroupSize;
  /** @type {string[][]} */
  const groups = [];
  const placed = new Set();
  for (const pair of pairs) {
    if (groups.length >= maxGroups) break;
    if (placed.has(pair.a) && placed.has(pair.b)) continue;
    const existing = groups.find((group) => group.includes(pair.a) || group.includes(pair.b));
    if (existing) {
      if (existing.length >= maxGroupSize) continue;
      for (const id of [pair.a, pair.b]) {
        if (!existing.includes(id)) { existing.push(id); placed.add(id); }
      }
      continue;
    }
    groups.push([pair.a, pair.b]);
    placed.add(pair.a);
    placed.add(pair.b);
  }
  return groups;
}

export class MethodConsolidation {
  /**
   * @param {{dispatch: (input: any) => Promise<any>, readResult: (identity: any) => Promise<any>, learning: any,
   *          jobs?: any, notifications?: any, evaluate?: ((request: any) => Promise<any>) | null, now?: () => Date}} dependencies
   */
  constructor({ dispatch, readResult, learning, jobs = null, notifications = null, evaluate = null, now = () => new Date() }) {
    if (typeof dispatch !== "function" || typeof readResult !== "function") {
      throw new TypeError("Method consolidation requires the bounded run dispatcher and result reader.");
    }
    if (!learning) throw new TypeError("Method consolidation requires the learning service.");
    this.dispatch = dispatch;
    this.readResult = readResult;
    this.learning = learning;
    this.jobs = jobs;
    this.notifications = notifications;
    this.evaluate = evaluate;
    this.now = now;
  }

  /** @param {{job: any, project?: any}} request */
  async run(request) {
    const action = String(request.job?.payload?.action ?? "");
    if (!CONSOLIDATE_ACTIONS.includes(action)) {
      throw new HttpError(400, "consolidate_action_invalid", `Unknown consolidation action ${JSON.stringify(action)}.`);
    }
    if (action === "sleep") return this.sleep(request);
    if (action === "integrate") return this.integrate(request);
    if (action === "evaluate") return this.evaluateCandidate(request);
    return this.optimize(request);
  }

  /**
   * One night's pass over a researcher's whole library.
   * @param {{job: any}} request
   */
  async sleep({ job }) {
    const page = await this.learning.listMethods(job.userId, { projectId: job.projectId, limit: CONSOLIDATION_LIMITS.maxMethods });
    const methods = (page.items ?? []).filter((item) => item.payload?.status !== "retired");
    if (methods.length < CONSOLIDATION_LIMITS.minGroupSize) {
      return { action: "sleep", methods: methods.length, groups: 0, relations: 0, builds: 0, screened: false, screenDropped: 0, promoted: [], queuedForEvaluation: [], retirements: [], graphIssues: [] };
    }

    const screen = await this.screenPairs(job, candidatePairs(methods), methods);
    const groups = groupPairs(screen.pairs);
    const byId = new Map(methods.map((method) => [method.id, method]));
    let relationCount = 0;
    let builds = 0;
    for (const group of groups) {
      const members = group.map((id) => byId.get(id)).filter(Boolean);
      if (members.length < CONSOLIDATION_LIMITS.minGroupSize) continue;
      const decided = await this.decideGroup(job, members).catch(() => null);
      if (!decided) continue;
      relationCount += await this.applyRelations(job, members, decided);
      if (builds < CONSOLIDATION_LIMITS.maxBuilds) {
        const built = await this.buildGroup(job, members, decided).catch(() => null);
        if (built?.applied) builds += 1;
      }
    }

    // Levels are recomputed after the builder has had its turn, because the
    // builder is the only thing that adds a dependency.
    const refreshed = (await this.learning.listMethods(job.userId, { projectId: job.projectId, limit: CONSOLIDATION_LIMITS.maxMethods })).items ?? [];
    const records = refreshed.map(methodRecordFrom);
    const graph = validateMethodGraph(records);
    const levels = computeMethodLevels(records).levels;

    /** @type {string[]} */
    const promoted = [];
    /** @type {string[]} */
    const queuedForEvaluation = [];
    for (const document of refreshed) {
      if (document.payload?.status !== "candidate") continue;
      const record = methodRecordFrom(document);
      record.learning = { ...record.learning, level: levels.get(record.name) ?? 0 };
      const eligibility = evaluationEligible(record);
      try {
        const approvedDocument = await this.learning.approve(job.userId, document.id, { expectedRevision: document.revision });
        promoted.push(approvedDocument.id);
      } catch (error) {
        // Not promotable is the ordinary outcome, and the reason is what the
        // researcher is shown. A candidate that has earned the cost of an
        // evaluation but has not had one gets queued for it here — that is the
        // one thing a nightly pass can do about "we do not know yet".
        if (error?.code !== "method_not_promotable") throw error;
        if (eligibility.eligible && !(document.payload.learning?.evaluations ?? []).length) {
          await this.enqueueEvaluation(job, document);
          queuedForEvaluation.push(document.id);
        }
      }
    }

    const retirements = await this.learning.retirementProposals(job.userId, { projectId: job.projectId, nowMs: this.now().getTime() });
    for (const entry of retirements) {
      if (entry.proposal.immediate) {
        await this.learning.retire(job.userId, entry.document.id, {
          expectedRevision: entry.document.revision,
          reason: entry.proposal.reason,
        }).catch(() => null);
        continue;
      }
      await this.notice(job, entry.document, `Proposed for retirement: ${entry.proposal.reason}. One click restores it.`);
    }

    const importance = relationCount * 10 + promoted.length * 40 + retirements.length * 20;
    if (reflectionDue(importance)) await this.reflect(job, { relationCount, promoted, retirements });

    return {
      action: "sleep",
      methods: refreshed.length,
      groups: groups.length,
      relations: relationCount,
      builds,
      screened: screen.screened,
      screenDropped: screen.dropped,
      promoted,
      queuedForEvaluation,
      retirements: retirements.map((entry) => entry.document.id),
      graphIssues: graph.issues.map((issue) => issue.code),
    };
  }

  /**
   * The incremental pass a new candidate triggers: its bounded neighbourhood
   * only, never the whole library. SkillPyramid's incremental update.
   * @param {{job: any}} request
   */
  async integrate({ job }) {
    const methodId = String(job.payload?.methodId ?? "");
    if (!methodId) throw new HttpError(400, "consolidate_payload_invalid", "An integrate job must name a method.");
    const subject = await this.learning.getMethod(job.userId, methodId);
    const page = await this.learning.listMethods(job.userId, { projectId: job.projectId, limit: CONSOLIDATION_LIMITS.maxMethods });
    const neighbours = (page.items ?? []).filter((item) => item.id !== methodId && item.payload?.status !== "retired");
    const pairs = candidatePairs([subject, ...neighbours]).filter((pair) => pair.a === methodId || pair.b === methodId);
    const group = [subject, ...pairs.slice(0, CONSOLIDATION_LIMITS.maxGroupSize - 1)
      .map((pair) => neighbours.find((item) => item.id === (pair.a === methodId ? pair.b : pair.a)))
      .filter(Boolean)];
    if (group.length < CONSOLIDATION_LIMITS.minGroupSize) {
      return { action: "integrate", methodId, neighbours: 0, relations: 0 };
    }
    const decided = await this.decideGroup(job, group);
    const relations = decided ? await this.applyRelations(job, group, decided) : 0;
    return { action: "integrate", methodId, neighbours: group.length - 1, relations };
  }

  /**
   * Spend the evaluation budget on one candidate.
   *
   * The runner is injected because it is a Python harness that dispatches real
   * runs; this class's job is to record the verdict, and a verdict that cannot
   * name the baseline it beat is not recorded at all.
   * @param {{job: any}} request
   */
  async evaluateCandidate({ job }) {
    const methodId = String(job.payload?.methodId ?? "");
    if (!methodId) throw new HttpError(400, "consolidate_payload_invalid", "An evaluate job must name a method.");
    if (!this.evaluate) throw new HttpError(503, "method_evaluation_unavailable", "No paired evaluation runner is configured.");
    const document = await this.learning.getMethod(job.userId, methodId);
    const candidateDigest = document.payload.contentDigest;
    const baselineDigest = String(job.payload?.baselineDigest ?? "");
    const report = await this.evaluate({
      userId: job.userId,
      projectId: job.projectId,
      methodId,
      candidateDigest,
      baselineDigest,
    });
    if (!report?.verdict || !report?.report) {
      throw new HttpError(502, "method_evaluation_invalid", "The paired evaluation returned no verdict.");
    }
    await this.learning.recordEvaluation(job.userId, methodId, {
      report: report.report,
      baselineDigest: report.baselineDigest ?? baselineDigest,
      verdict: report.verdict,
      at: this.now().toISOString(),
    });
    return { action: "evaluate", methodId, verdict: report.verdict, report: report.report };
  }

  /**
   * The platform-handbook arm. It never edits a shipped capability in place —
   * it produces a staged proposal for a pull request, which is the whole point
   * of a handbook change being reviewable.
   * @param {{job: any}} request
   */
  async optimize({ job }) {
    const capabilityId = String(job.payload?.capabilityId ?? "");
    if (!capabilityId) throw new HttpError(400, "consolidate_payload_invalid", "An optimize job must name a capability.");
    // The staging directory and the pull-request generator live outside the
    // control plane on purpose: a control plane that can open a pull request
    // against its own capabilities is a control plane that can change what it
    // is measured against.
    return {
      action: "optimize",
      capabilityId,
      staged: false,
      reason: "handbook proposals are staged by scripts/dev/open-method-pr.mjs, never by the control plane",
    };
  }

  /**
   * Record the relations one DECIDE run proposed.
   * @param {any} job @param {readonly any[]} members @param {any} decided
   * @returns {Promise<number>}
   */
  async applyRelations(job, members, decided) {
    const byId = new Map(members.map((member) => [member.id, member]));
    let count = 0;
    for (const relation of decided?.relations ?? []) {
      const source = byId.get(relation.source);
      if (!source) continue;
      const written = await this.learning.recordRelations(job.userId, source.id, [{
        type: relation.type,
        target: relation.target,
        evidence: relation.reason ?? "",
        proposedBy: `consolidate:${job.id}`,
      }], (id) => byId.has(id)).catch(() => null);
      if (written) count += 1;
    }
    return count;
  }

  /**
   * The SCREEN step: one bounded run that thins the deterministic shortlist.
   *
   * `candidatePairs` says in its own docstring that it is not the screen — "the
   * model does that" — and nothing did it. So the pairs a lexical token overlap
   * proposed went straight into grouping, which means two methods that share
   * four ordinary words about evidence appraisal were grouped, reasoned about at
   * DECIDE's price, and sometimes rewritten into each other. Word overlap is a
   * proxy for relatedness and a bad one; "are these two methods about the same
   * work" is a language judgment, and the principles put those on the model.
   *
   * Two constraints that make this cheap and safe:
   *
   *  - **One run for the whole shortlist**, not one per pair. The point of a
   *    screen is to cost less than what it saves.
   *  - **It may only remove.** A screen that could add pairs would have to see
   *    every pair to be fair, which is the quadratic cost the shortlist exists
   *    to avoid, and the grouping budget is sized on the shortlist. So the model
   *    answers "which of these are real", and a pair it does not name survives
   *    only if it was already there.
   *
   * A failed or unavailable screen returns the shortlist unchanged rather than
   * nothing: consolidation degraded to the old behaviour is worse than the new
   * one and much better than a night that silently consolidates nothing.
   *
   * @param {any} job @param {readonly {a: string, b: string, overlap: number}[]} pairs @param {readonly any[]} methods
   * @returns {Promise<{pairs: {a: string, b: string, overlap: number}[], screened: boolean, dropped: number}>}
   */
  async screenPairs(job, pairs, methods) {
    if (pairs.length < 2) return { pairs: [...pairs], screened: false, dropped: 0 };
    const byId = new Map(methods.map((method) => [method.id, method]));
    const shortlist = pairs.slice(0, CONSOLIDATION_LIMITS.maxScreenPairs);
    const dispatchId = `method-relations-screen-${shortDigest(shortlist.map((pair) => `${pair.a} ${pair.b}`).join("\n"))}`;
    /** @type {any} */
    let result = null;
    try {
      const identity = await this.dispatch({
        userId: job.userId,
        projectId: job.projectId,
        dispatchId,
        job,
        capabilityId: "method-relations",
        contractKind: "method-relations",
        input: {
          schemaVersion: 1,
          action: "screen",
          // Names and descriptions only. SCREEN is the cheap step; handing it
          // the bodies would make it cost what DECIDE costs and leave nothing
          // for DECIDE to add.
          pairs: shortlist.map((pair) => ({
            a: { id: pair.a, name: byId.get(pair.a)?.payload?.frontmatter?.name, description: byId.get(pair.a)?.payload?.frontmatter?.description },
            b: { id: pair.b, name: byId.get(pair.b)?.payload?.frontmatter?.name, description: byId.get(pair.b)?.payload?.frontmatter?.description },
          })),
        },
        question: "Screen the pairs in method-relations-input.json with the method-relations capability using action `screen`. "
          + "For each pair say whether the two methods plausibly describe related work, and drop the ones that merely share vocabulary. "
          + "Keeping a pair costs a later, more expensive reading; keeping every pair is the same as not screening. "
          + "You may only judge the pairs you are given — do not propose new ones.",
      });
      if (identity?.runId) {
        result = await this.readResult({ ...identity, dispatchId, userId: job.userId, projectId: job.projectId });
      }
    } catch {
      // isolated: evimed_learning_screen_failed_total
    }
    if (!result || result.status !== "succeeded") return { pairs: [...pairs], screened: false, dropped: 0 };
    const kept = screenedPairs(shortlist, result.output ?? {});
    // Everything past the shortlist was never shown to the screen, so it is
    // dropped rather than kept: a pair nobody judged is not a screened pair,
    // and letting it through would make the shortlist cap silently decide what
    // gets consolidated.
    return { pairs: kept, screened: true, dropped: pairs.length - kept.length };
  }

  /**
   * The DECIDE step: one bounded run reading one group's bodies.
   * @param {any} job @param {readonly any[]} members
   */
  async decideGroup(job, members) {
    const ids = members.map((member) => member.id).sort();
    const dispatchId = `method-relations-${shortDigest(ids.join(" "))}`;
    const identity = await this.dispatch({
      userId: job.userId,
      projectId: job.projectId,
      dispatchId,
      job,
      capabilityId: "method-relations",
      contractKind: "method-relations",
      input: {
        schemaVersion: 1,
        action: "decide",
        relationTypes: [...METHOD_RELATION_TYPES],
        methods: members.map((member) => ({
          id: member.id,
          name: member.payload?.frontmatter?.name,
          description: member.payload?.frontmatter?.description,
          digest: member.payload?.contentDigest,
          body: member.payload?.body,
        })),
      },
      question: "Decide how the methods in method-relations-input.json relate, using the method-relations capability with action `decide`. "
        + "Return ASSIGNMENT, SKILLS, RELATION_TYPE and REASON for each group you find. "
        + "shared_part is for a concrete shared sub-capability, never for vague topical similarity. "
        + "Say nothing rather than inventing a relation; an empty answer is correct when the methods are unrelated.",
    });
    if (!identity?.runId) return null;
    const result = await this.readResult({ ...identity, dispatchId, userId: job.userId, projectId: job.projectId });
    if (!result || result.status !== "succeeded") return null;
    return result.output ?? null;
  }

  /**
   * The builder: one bounded run that rewrites the group's bodies under the
   * analyser's assignment, plus the deterministic check the paper states as
   * prose. "Preserve the source skill's procedures, constraints, edge cases and
   * verification checks" is a judgement when written that way and a decidable
   * property when written as "the set of items under Verification and
   * Constraints may gain members and may not lose them".
   * @param {any} job @param {readonly any[]} members @param {any} decided
   */
  async buildGroup(job, members, decided) {
    const assignments = (decided?.assignments ?? []).filter((entry) => METHOD_RELATION_TYPES.includes(entry?.relationType));
    if (!assignments.length) return { applied: 0 };
    const identity = await this.dispatch({
      userId: job.userId,
      projectId: job.projectId,
      dispatchId: `method-relations-build-${shortDigest(JSON.stringify(assignments))}`,
      job,
      capabilityId: "method-relations",
      contractKind: "method-relations",
      input: {
        schemaVersion: 1,
        action: "build",
        assignments,
        methods: members.map((member) => ({
          id: member.id,
          name: member.payload?.frontmatter?.name,
          digest: member.payload?.contentDigest,
          frontmatter: member.payload?.frontmatter,
          body: member.payload?.body,
        })),
      },
      question: "Rewrite the methods named in the assignments in method-relations-input.json, using the method-relations capability with action `build`. "
        + "The analyser's ASSIGNMENT and RELATION_TYPE are authoritative and may not be changed. "
        + "Preserve every procedure, constraint, edge case and verification check of each source method. "
        + "Add reuse references only near the passages they affect. Invent no tools, scripts, files or dependencies. "
        + "Each rewritten method must still read as a standalone SKILL.md.",
    });
    if (!identity?.runId) return { applied: 0 };
    const result = await this.readResult({ ...identity, userId: job.userId, projectId: job.projectId });
    if (!result || result.status !== "succeeded") return { applied: 0 };
    let applied = 0;
    for (const rewrite of result.output?.methods ?? []) {
      const target = members.find((member) => member.id === rewrite.id);
      if (!target) continue;
      const parsed = parseSkillFrontmatter(String(rewrite.skill ?? ""));
      if (parsed.issues.length) continue;
      const preserved = preservedSectionsIntact(target.payload.body, parsed.body);
      if (!preserved.ok) {
        // The builder dropped a check. The paper asks the model not to; this
        // asks the record.
        await this.notice(job, target, `A rewrite dropped ${preserved.dropped.length} verification or constraint item(s) and was refused.`);
        continue;
      }
      const amended = await this.learning.amendMethod(job.userId, target.id, {
        expectedRevision: target.revision,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        dependencies: rewrite.dependencies ?? target.payload.dependencies ?? [],
        provenance: { ...target.payload.provenance, consolidatedBy: `consolidate:${job.id}` },
      }).catch(() => null);
      if (amended) applied += 1;
    }
    return { applied };
  }

  /** @param {any} job @param {any} document */
  async enqueueEvaluation(job, document) {
    if (!this.jobs) return;
    try {
      await this.jobs.enqueue(job.userId, "consolidate", {
        action: "evaluate",
        methodId: document.id,
        candidateDigest: document.payload.contentDigest,
      }, {
        idempotencyKey: `consolidate:evaluate:${document.id}:${document.payload.contentDigest}`,
        projectId: job.projectId,
      });
    } catch {
      // isolated: evimed_learning_evaluate_enqueue_failed_total
    }
  }

  /** @param {any} job @param {any} document @param {string} body */
  async notice(job, document, body) {
    if (!this.notifications) return;
    try {
      await this.notifications.create(job.userId, {
        noticeType: "notify",
        title: `方法库夜间整理：${document.payload?.frontmatter?.name ?? document.id}`,
        body,
        ...(job.projectId ? { projectId: job.projectId } : {}),
        source: { type: "system", id: document.id },
        idempotencyKey: `consolidate-notice:${job.id}:${document.id}`,
      });
    } catch {
      // isolated: evimed_learning_notice_failed_total
    }
  }

  /** @param {any} job @param {{relationCount: number, promoted: string[], retirements: any[]}} summary */
  async reflect(job, summary) {
    if (!this.notifications) return;
    try {
      await this.notifications.create(job.userId, {
        noticeType: "notify",
        title: "方法库有了一次值得一看的变化",
        body: `新增关系 ${summary.relationCount} 条，启用 ${summary.promoted.length} 条方法，建议停用 ${summary.retirements.length} 条。`,
        ...(job.projectId ? { projectId: job.projectId } : {}),
        idempotencyKey: `consolidate-reflection:${job.id}`,
      });
    } catch {
      // isolated: evimed_learning_notice_failed_total
    }
  }
}
