import { renderEvolutionProgress } from './evolutionProgress.mjs';
import { EVOLUTION_EXECUTABLE_OPERATIONS, evolutionDecisionClass, evolutionAdaptiveClass } from '@evimed/domain';
import { evolutionKey } from './evolutionService.mjs';
import { HttpError } from './security.mjs';
import { shanghaiDay } from './notificationService.mjs';

/** The inbox refuses a body over 8,000 characters, a title over 150 and an action label over 80; the digest and a card are cut to fit them. */
export const EVOLUTION_NOTICE_LIMITS = Object.freeze({ body: 8000, title: 150, label: 80 });
/** A card whose expiry review cannot be had is asked again this many times, an hour apart, and then takes its conservative option. */
export const EVOLUTION_EXPIRY_REVIEW_ATTEMPTS = 3;
export const EVOLUTION_EXPIRY_REVIEW_RETRY_MS = 3_600_000;
/** What a decision category is called to the operator; a category this does not name is 其他事项, never its identifier. */
export const EVOLUTION_CATEGORY_LABELS = Object.freeze({
  implementation: '工具研发方向', 'tool-repair': '工具修复', 'tool-merge': '工具合并', 'tool-retire': '工具退役',
  resource: '研发线索等待资料', 'validation-resource': '工具等待验证资料', 'release-replay-resource': '工具回放等待资源', 'worker-resource': '进化任务等待资源',
});
/** Why a tool was retired, in words, for the researchers whose results used it; a reason this does not name reads as the general one. */
const RETIREMENT_REASONS = Object.freeze({
  'sequential-harm': '使用中连续出现需要纠正的结果', 'published-replay-regression': '用已发表算例复测时数值出现偏差', 'merge-direction-reversed': '已改为保留原有工具',
  'monthly-direction-review': '月度复核决定停用', 'alias-quiet-period': '已有新版本替代', 'retirement-recovery': '已有新版本替代',
});
/**
 * What a researcher is told when a tool their earlier results used is retired: the tool by its name and the reason in
 * words, not its identifier and the code. @param {{name?: string, toolId: string, reason: string}} input
 */
export function evolutionRetirementNotice({ name, reason }) {
  const label = /** @type {Record<string, string>} */ (RETIREMENT_REASONS)[reason] ?? '不再满足验证要求';
  return { title: '科研工具已更新状态', body: `先前结果使用的“${clip(name ?? '科研工具', 60)}”已停用，原因：${label}。原始结果和工具版本保留，可重新检查。` };
}
/** The categories whose own goal sentence is a reader's sentence (the others carry codes) and is shown beside the wait. */
const GOAL_SHOWN_CATEGORIES = Object.freeze(['resource', 'validation-resource']);
/** @param {unknown} value @param {number} max */
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text; };

/**
 * The operation a chosen option carries out. The executor's list is closed (`EVOLUTION_EXECUTABLE_OPERATIONS`): an
 * option that names anything else is refused here, whoever chose it and whatever class its decision has. This, and not
 * the classifier, is what keeps the engine from deleting, sending or spending past its budget.
 * @param {{options: any[], option: string}} action
 */
export function evolutionExecutableOperation(action) {
  const selected = action.options.find((/** @type {any} */ item) => item.id === action.option);
  const operation = selected?.operation ?? action.option;
  if (!EVOLUTION_EXECUTABLE_OPERATIONS.includes(operation)) throw new HttpError(400, 'evolution_action_unsupported', 'This action requires a separately authorized implementation.');
  return operation;
}
/**
 * The record of a candidate that passed nothing more it can pass and waits on validation: one per branch of its dossier.
 *
 * A decision is identified by (category, subject, materialVersion). Proposed for the dossier alone, the wait of a second
 * branch was answered with the first branch's record — already executed, by the very `rescout` that opened the second
 * branch — so nothing was pending and the operator had no card to answer (live acceptance, 2026-10-05: two waits on one
 * dossier, one decision). The first branch keeps version 1, which is the id already stored. A resource wait is class D:
 * never delivered, never executed by expiry, so one per branch re-arms nothing by itself.
 * @param {{ dossierId: string, decisionActionId?: string | null, goal: string }} wait
 */
export function evolutionValidationWait({ dossierId, decisionActionId = null, goal }) {
  return { category: 'validation-resource', subjectId: dossierId, materialVersion: decisionActionId ?? 1, resourceOnly: true,
    title: '工具等待独立验证资料', body: goal, options: [{ id: 'wait', label: '等待验证资料' }, { id: 'rescout', label: '重查公开实例' }], recommended: 'wait', conservative: 'wait' };
}
/** A configured model name is not a provider receipt. @param {any} config @param {any} result */
export function evolutionDecisionReviewProof(config,result) {
 const family=/^qwen/i.test(result.model??'')?'qwen':'unknown';
 return {independent:config.reviewProvider==='dashscope' && result.modelReported===true && family==='qwen',family,model:result.model??null};
}
/** Delivery, expiry, and overrides retain every branch decision in the revision ledger. */
export class EvolutionDecisions {
  /** @param {any} dependencies */
  constructor({ service, notifications = service.notifications, callbacks = {}, now = service.now, config = service.config }) { this.service = service; this.notifications = notifications; this.callbacks = callbacks; this.now = now; this.config = config; }
  /** @param {any} input */
  async propose(input) { return this.service.withLock('decisions', () => this.proposeLocked(input)); }
  /** @param {any} input */
  async proposeLocked(input) {
    const id = `evolution-decision-${evolutionKey([input.category, input.subjectId, input.materialVersion ?? 1])}`;
    const existing = await this.service.get(id);
    if (existing) return existing;
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 3 || !input.options.some((/** @type {any} */ o) => o.id === input.recommended) || !input.options.some((/** @type {any} */ o) => o.id === input.conservative)) throw new HttpError(400, 'evolution_decision_invalid', 'A decision requires two or three explicit options.');
    let decisionClass = evolutionDecisionClass(input);
    const all = await this.service.list('decision');
    // What the operator's rate of overruling is measured over: the cards they were shown and the answers they gave.
    // A decision the engine took by itself (the day's cards were used up, or it was class A to begin with) was seen by
    // no one, and is not agreement.
    const history = all.filter((/** @type {any} */ row) => row.payload.category === input.category && row.payload.status === 'executed'
      && (row.payload.deliveredAt || row.payload.source === 'user')).map((/** @type {any} */ row) => row.payload).sort((/** @type {any} */ a, /** @type {any} */ b) => a.decidedAt.localeCompare(b.decidedAt));
    if (decisionClass === 'B' && (history.some((/** @type {any} */ h) => h.delegate === true) || input.delegate === true || evolutionAdaptiveClass(history) === 'A')) decisionClass = 'A';
    const day = shanghaiDay(this.now());
    const cards = all.filter((/** @type {any} */ row) => row.payload.cardDay === day && row.payload.deliveredAt).length;
    if (cards >= (this.config.evolutionMaxDecisionCards ?? 3) && decisionClass === 'B') decisionClass = 'A';
    const saved = await this.service.save('decision', id, { ...input, decisionClass, status: 'pending', createdAt: this.now().toISOString(), history: [], overridden: false });
    if (decisionClass === 'A') return this.execute(saved, input.recommended, 'autonomous');
    if (decisionClass === 'D') return saved;
    if (cards >= (this.config.evolutionMaxDecisionCards ?? 3)) return this.execute(saved, input.conservative, 'conservative');
    return saved;
  }
  /** Clock starts when delivery succeeds, not when the proposal is stored. @param {any} row */
  async deliver(row) {
    if (row.payload.deliveredAt) return row;
    let deliveredAt = this.now().toISOString();
    // The recommended option is the one marked primary, so a reader (and any channel that draws the actions) sees which it is.
    const notice = await this.notifications.create(await this.service.owner(), { noticeType: 'review', title: clip(row.payload.title, EVOLUTION_NOTICE_LIMITS.title), body: clip(row.payload.body, EVOLUTION_NOTICE_LIMITS.body),
      actions: row.payload.options.map((/** @type {any} */ o) => ({ id: o.id, label: clip(o.label, EVOLUTION_NOTICE_LIMITS.label), style: o.id === row.payload.recommended ? 'primary' : 'neutral' })),
      source: { type: 'system', id: row.id }, idempotencyKey: row.id });
    deliveredAt = notice.createdAt ?? deliveredAt;
    const dueAt = new Date(Date.parse(deliveredAt) + (this.config.evolutionDecisionTimeoutMs ?? 86400000)).toISOString();
    const saved = await this.service.save('decision', row.id, { ...row.payload, deliveredAt, dueAt, cardDay: shanghaiDay(new Date(deliveredAt)), notificationId: notice.id }, row);
    await this.service.enqueue('decision', { decisionId: row.id }, `expire:${row.id}`, new Date(dueAt));
    return saved;
  }
  /**
   * What a card that was not answered in time becomes. A resource wait takes its alternative; a one-way door takes its
   * conservative option at once, because no review can change that; a directional choice is refreshed against new
   * literature and reviewed by a second model family, and takes the reviewed recommendation. When that review cannot be
   * had it is asked again (three times, an hour apart; the card says so), and then the choice takes its conservative
   * option rather than waiting for ever or acting on an unreviewed recommendation. Whatever was taken, a later answer of
   * the operator's supersedes it.
   * @param {string} id
   */
  async expire(id) {
    const row = await this.service.get(id);
    if (row?.payload.status === 'executing') return this.execute(row, row.payload.execution.option, row.payload.execution.source, row.payload.execution.evidence);
    if (!row || row.payload.status !== 'pending' || !row.payload.deliveredAt || Date.parse(row.payload.dueAt) > this.now().getTime()) return row;
    if (row.payload.decisionClass === 'D') return this.execute(row, row.payload.alternative ?? row.payload.conservative, 'resource-alternative');
    if (row.payload.decisionClass === 'C') return this.execute(row, row.payload.conservative, 'default', { oneWayDoor: true });
    let refreshed, reviewed;
    try {
      if (!this.callbacks.refresh || !this.callbacks.review) throw new HttpError(503, 'evolution_review_unavailable', 'Expiry requires fresh evidence and independent review.');
      refreshed = await this.callbacks.refresh(row.payload);
      reviewed = await this.callbacks.review({ decision: row.payload, refreshed });
      if (!reviewed || reviewed.independent !== true || reviewed.family === refreshed?.family) throw new HttpError(503, 'evolution_review_invalid', 'A cross-family review is required.');
    } catch (error) { return this.deferExpiry(row, error); }
    return this.execute(row, reviewed.recommended ?? refreshed.recommended ?? row.payload.recommended, 'default', { refreshed, reviewed });
  }
  /** A review that could not be had: say so on the card, ask again later, and when the attempts are spent take the conservative option. @param {any} row @param {any} error */
  async deferExpiry(row, error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'evolution_review_unavailable';
    const attempts = Number(row.payload.expiry?.attempts ?? 0) + 1;
    const at = this.now().toISOString();
    const expiry = { state: 'review-unavailable', attempts, of: EVOLUTION_EXPIRY_REVIEW_ATTEMPTS, code, at };
    if (attempts >= EVOLUTION_EXPIRY_REVIEW_ATTEMPTS) {
      const noted = await this.service.save('decision', row.id, { ...row.payload, expiry: { ...expiry, state: 'conservative-taken' } }, row);
      return this.execute(noted, row.payload.conservative, 'conservative', { reviewUnavailable: { code, attempts } });
    }
    const saved = await this.service.save('decision', row.id, { ...row.payload, expiry }, row);
    await this.service.enqueue('decision', { decisionId: row.id }, `expire:${row.id}:retry:${attempts}`,
      new Date(this.now().getTime() + (this.config.evolutionDecisionReviewRetryMs ?? EVOLUTION_EXPIRY_REVIEW_RETRY_MS)));
    return saved;
  }
  /** @param {any} row @param {string} option @param {string} source @param {any} evidence */
  async execute(row, option, source, evidence = {}) {
    if (!row.payload.options.some((/** @type {any} */ item) => item.id === option)) throw new HttpError(400, 'evolution_option_invalid', 'Unknown decision option.');
    const actionId = row.payload.status === 'executing' ? row.payload.execution.actionId : `${row.id}:${row.revision}:${option}`;
    if (row.payload.status !== 'executing') row = await this.service.save('decision', row.id, { ...row.payload, status: 'executing', execution: { actionId, option, source, evidence } }, row);
    if (!this.callbacks.execute) throw new HttpError(503, 'evolution_execution_unavailable', 'Decision execution is unavailable.');
    const result = await this.callbacks.execute({ ...row.payload, id: row.id, option, source, actionId, evidence });
    const previous = row.payload.selected ?? null;
    // A person's answer overrules the recommendation exactly when it is another option; their latest answer is the one that counts.
    const overridden = source === 'user' ? option !== row.payload.recommended : row.payload.overridden === true;
    const saved = await this.service.save('decision', row.id, { ...row.payload, selected: option, status: 'executed', source, decidedAt: this.now().toISOString(), evidence, result: result ?? null,
      overridden, history: [...row.payload.history, { actionId, previous, selected: option, source, at: this.now().toISOString(), evidence }] }, row);
    await this.closeNotice(saved, option, source);
    return saved;
  }
  /** The inbox item of a card that was decided or expired is closed; best effort, because a decision made does not wait on its inbox item. @param {any} row @param {string} option @param {string} source */
  async closeNotice(row, option, source) {
    if (!row.payload.notificationId || !['B', 'C'].includes(row.payload.decisionClass) || !this.notifications?.get) return;
    try {
      const owner = await this.service.owner();
      const item = await this.notifications.get(owner, row.payload.notificationId);
      if (item.resolvedAt) return;
      if (source === 'user') await this.notifications.resolve(owner, item.id, { actionId: option, expectedRevision: item.revision });
      else await this.notifications.resolveByDefault(owner, item.id, { actionId: option, expectedRevision: item.revision });
    } catch { /* the item stays open and the card still shows the decision as made */ }
  }
  /** Late replies intentionally supersede a default branch. @param {string} id @param {any} input */
  async resolve(id, input) {
    const row = await this.service.get(id);
    if (!row || row.payload.recordType !== 'evolution-decision') throw new HttpError(404, 'evolution_decision_missing', 'Decision not found.');
    if (input.expectedRevision !== row.revision) throw new HttpError(409, 'product_revision_conflict', 'Decision changed; reload before choosing.');
    let option = input.option ?? row.payload.recommended;
    if (input.text) {
      if (!this.callbacks.interpretOverride) throw new HttpError(503, 'evolution_override_unavailable', 'Text overrides need an interpretation callback.');
      option = await this.callbacks.interpretOverride(row.payload, input.text);
    }
    // An answer that arrives while the expiry (or another answer) is carrying out a different option must not borrow its
    // action identity: the record would then say the person's option was chosen while the other was executed.
    if (row.payload.status === 'executing' && (row.payload.execution.source !== 'user' || row.payload.execution.option !== option)) {
      throw new HttpError(409, 'evolution_decision_executing', 'The decision is being carried out; reload and answer again.');
    }
    const saved = await this.execute(row, option, 'user');
    if (input.delegate === true && saved.payload.decisionClass !== 'C') {
      return this.service.save('decision', id, { ...saved.payload, delegate: true }, saved);
    }
    return saved;
  }
  /** @param {string} day */
  async digest(day = shanghaiDay(this.now())) { return this.service.withLock(`digest:${day}`, () => this.digestLocked(day)); }
  /** A retry sends the persisted snapshot, never newly discovered rows under an old notice key. @param {string} day */
  async digestLocked(day) {
    const id = `evolution-digest-${day}`;
    let saved = await this.service.get(id);
    if (!saved) {
      const until = this.now().getTime();
      const previousDigest = (await this.service.list('digest')).filter(row => row.payload.deliveredAt && Date.parse(row.payload.reportingUntil ?? row.payload.deliveredAt) <= until)
        .sort((left, right) => Date.parse(right.payload.reportingUntil ?? right.payload.deliveredAt) - Date.parse(left.payload.reportingUntil ?? left.payload.deliveredAt))[0];
      const from = Date.parse(previousDigest?.payload.reportingUntil ?? previousDigest?.payload.deliveredAt ?? '') || until - 86400000;
      const inWindow = timestamp => Date.parse(timestamp ?? '') > from && Date.parse(timestamp ?? '') <= until;
      let all = await this.service.list('decision');
      const pending = all.filter(row => row.payload.status === 'pending' && ['B', 'C'].includes(row.payload.decisionClass) && !row.payload.deliveredAt).sort((a,b) => Number(b.payload.impact ?? 0) - Number(a.payload.impact ?? 0));
      let slots = (this.config.evolutionMaxDecisionCards ?? 3) - all.filter(row => row.payload.cardDay === day).length;
      for (const row of pending) {
        if (slots-- > 0) await this.deliver(row);
        else await this.execute(row, row.payload.decisionClass === 'C' ? row.payload.conservative : row.payload.recommended, row.payload.decisionClass === 'C' ? 'conservative' : 'autonomous');
      }
      all = await this.service.list('decision');
      const today = all.filter(row => inWindow(row.payload.decidedAt ?? row.createdAt));
      const evaluations = (await this.service.list('evaluation')).filter(row => inWindow(row.payload.at ?? row.updatedAt));
      const label = (/** @type {any} */ row) => row.payload.options.find((/** @type {any} */ option) => option.id === row.payload.selected)?.label ?? row.payload.selected;
      // The snapshot keeps what the notice will say, not the documents it was read from: a day's worth of whole rows (a
      // tool drags every observation it has ever had) outgrew the record limit, and the text only ever uses these fields.
      saved = await this.service.save('digest', id, { day, reportingFrom: new Date(from).toISOString(), reportingUntil: new Date(until).toISOString(),
        decisions: all.filter(row => row.payload.status === 'pending' && row.payload.cardDay === day && ['B','C'].includes(row.payload.decisionClass)).slice(0,this.config.evolutionMaxDecisionCards ?? 3)
          .map(row => ({ id: row.id, title: clip(row.payload.title, 150) })),
        autonomous: today.filter(row => row.payload.status === 'executed' && row.payload.source !== 'user').slice(0, 200)
          .map(row => ({ id: row.id, category: row.payload.category ?? null, title: clip(row.payload.title, 150), selected: clip(label(row), 80) })),
        resources: all.filter(row => row.payload.decisionClass === 'D' && !row.payload.resourceReportedAt).slice(0, 200)
          .map(row => ({ id: row.id, category: row.payload.category ?? null, title: clip(row.payload.title, 150), ...(GOAL_SHOWN_CATEGORIES.includes(row.payload.category) ? { goal: clip(row.payload.body, 300) } : {}) })),
        // New tools that went live in the window. A tool's `updatedAt` moves on every call anyone makes of it, which is use and not an achievement.
        achievements: (await this.service.tools()).filter(row => inWindow(row.payload.createdAt) && ['active', 'alias'].includes(row.payload.status)).slice(0, 100)
          .map(row => ({ id: row.id, name: clip(row.payload.name ?? row.payload.description ?? row.id, 100), level: row.payload.validationLevel ?? 'V0' })),
        evaluationSummaries: evaluations.map(evolutionEvaluationDigest).slice(0, 20),
        progress: await this.service.callbacks.evolutionProgress?.(day) ?? null,
      });
    }
    const snapshot = saved.payload;
    const notice = await this.notifications.create(await this.service.owner(), { noticeType:'notify',title:'进化日报',body:renderEvolutionDigest(snapshot),
      source:{type:'system',id},idempotencyKey:id });
    const deliveredAt = notice.createdAt ?? this.now().toISOString();
    for (const captured of snapshot.resources) {
      let row = await this.service.get(captured.id);
      if (!row) continue;
      if (!row.payload.resourceReportedAt) row = await this.service.save('decision',row.id,{...row.payload,resourceReportedAt:deliveredAt,deliveredAt,dueAt:new Date(Date.parse(deliveredAt)+(this.config.evolutionDecisionTimeoutMs ?? 86400000)).toISOString(),notificationId:notice.id},row);
      await this.service.enqueue('decision',{decisionId:row.id},`resource:${row.id}`,new Date(row.payload.dueAt));
    }
    if (!saved.payload.deliveredAt) saved = await this.service.save('digest',id,{...saved.payload,deliveredAt,notificationId:notice.id},saved);
    return saved;
  }

}

/**
 * The text of a day's digest, from its frozen snapshot, within what the inbox accepts. Every section is bounded: a list
 * shows its first entries and says how many it left out, and the whole is cut, with the count of the lines it did not
 * carry, if it is still too long. A digest that cannot be delivered is the one thing it must not be.
 * @param {any} snapshot @param {number} [limit]
 */
export function renderEvolutionDigest(snapshot, limit = EVOLUTION_NOTICE_LIMITS.body) {
  /** @param {string[]} lines @param {number} shown */
  const bounded = (lines, shown) => lines.length > shown ? [...lines.slice(0, shown), `另有 ${lines.length - shown} 项未列出`] : lines;
  const autonomous = snapshot.autonomous ?? [];
  const counts = new Map();
  for (const row of autonomous) { const label = EVOLUTION_CATEGORY_LABELS[/** @type {keyof typeof EVOLUTION_CATEGORY_LABELS} */ (row.category)] ?? '其他事项'; counts.set(label, (counts.get(label) ?? 0) + 1); }
  const autonomousLines = [...counts].sort(([left], [right]) => left.localeCompare(right, 'zh')).map(([label, count]) => `${label}：${count} 项`);
  const waits = new Map();
  for (const row of snapshot.resources ?? []) { const text = row.goal ? `${row.title}：${row.goal}` : row.title; waits.set(text, (waits.get(text) ?? 0) + 1); }
  const waitLines = [...waits].map(([text, count]) => count > 1 ? `${text}（${count} 项）` : text);
  const summaries = snapshot.evaluationSummaries ?? [];
  const engineNames = [['meta-analysis', 'Meta'], ['adr-analysis', '药物警戒'], ['mendelian-randomization', '孟德尔随机化']];
  const assessmentLines = bounded(summaries.flatMap((/** @type {any} */ summary) => summary.lines), 12);
  const healthLines = engineNames.map(([capabilityId, name]) => `${name}体检：${summaries.some((/** @type {any} */ summary) => summary.capabilityIds.includes(capabilityId)) ? '当日实际评测见上方分项' : '当日未运行，分数未知'}`);
  const sections = [
    renderEvolutionProgress(snapshot.progress),
    `待你裁决\n${(snapshot.decisions ?? []).map((/** @type {any} */ row) => row.title).join('\n') || '暂无'}`,
    `已自主处理\n${bounded(autonomousLines, 10).join('\n') || '暂无'}\n${autonomous.slice(0, 3).map((/** @type {any} */ row) => `${row.title}：${row.selected}`).join('\n') || '暂无'}`,
    `资源等待\n${bounded(waitLines, 8).join('\n') || '暂无新增'}`,
    `当日成果\n${bounded((snapshot.achievements ?? []).map((/** @type {any} */ row) => `${row.name} ${row.level}`), 10).join('\n') || '暂无新工具'}\n${assessmentLines.join('\n') || '评测：当日未运行，分数未知'}\n${healthLines.join('\n')}`,
  ];
  const body = sections.join('\n\n');
  if (body.length <= limit) return body;
  const lines = body.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) { if (used + line.length + 1 > limit - 40) break; kept.push(line); used += line.length + 1; }
  return `${kept.join('\n')}\n（日报过长，另有 ${lines.length - kept.length} 行未显示）`;
}

/** Actual evaluation scope and denominator remain explicit; missing-input responses are not research success. @param {any} row */
export function evolutionEvaluationDigest(row) {
  const units = row.payload.units ?? [];
  const groups = new Map();
  for (const unit of units) {
    const key = `${unit.capabilityId ?? unit.engineId ?? unit.track ?? 'unknown'}:${unit.type ?? 'unknown'}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(unit);
  }
  const lines = [...groups].map(([key,items]) => {
    const eligible = items.filter(unit => typeof (unit.type === 'research' ? unit.fullResearchReproductionValid : unit.allStagesValid) === 'boolean');
    const valid = eligible.filter(unit => unit.type === 'research' ? unit.fullResearchReproductionValid : unit.allStagesValid).length;
    const scope = items[0].type === 'research' ? '完整研究复现' : items[0].type === 'method' ? '方法算例' : '问题驱动';
    return `${key.split(':')[0]} ${scope}：${eligible.length ? `${valid}/${eligible.length} 有效` : '分数未知'}`;
  });
  return { evaluationId:row.id,capabilityIds:[...new Set(units.map(unit=>unit.capabilityId).filter(Boolean))],lines:lines.length ? lines : ['评测资料待补齐，尚未评分'] };
}

/** @param {any} dependencies */
export function createEvolutionDecisions(dependencies) { return new EvolutionDecisions(dependencies); }
