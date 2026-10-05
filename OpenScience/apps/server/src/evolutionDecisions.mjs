import { evolutionDecisionClass, evolutionAdaptiveClass } from '@evimed/domain';
import { evolutionKey } from './evolutionService.mjs';
import { HttpError } from './security.mjs';
import { shanghaiDay } from './notificationService.mjs';

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
    const history = (await this.service.list('decision')).filter((/** @type {any} */ row) => row.payload.category === input.category && row.payload.status === 'executed').map((/** @type {any} */ row) => row.payload).sort((/** @type {any} */ a, /** @type {any} */ b) => a.decidedAt.localeCompare(b.decidedAt));
    if (decisionClass === 'B' && (history.some((/** @type {any} */ h) => h.delegate === true) || input.delegate === true || evolutionAdaptiveClass(history) === 'A')) decisionClass = 'A';
    const day = shanghaiDay(this.now());
    const cards = (await this.service.list('decision')).filter((/** @type {any} */ row) => row.payload.cardDay === day && row.payload.deliveredAt).length;
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
    const notice = await this.notifications.create(await this.service.owner(), { noticeType: 'review', title: row.payload.title, body: row.payload.body,
      actions: row.payload.options.map((/** @type {any} */ o) => ({ id: o.id, label: o.label })), source: { type: 'system', id: row.id }, idempotencyKey: row.id });
    deliveredAt = notice.createdAt ?? deliveredAt;
    const dueAt = new Date(Date.parse(deliveredAt) + (this.config.evolutionDecisionTimeoutMs ?? 86400000)).toISOString();
    const saved = await this.service.save('decision', row.id, { ...row.payload, deliveredAt, dueAt, cardDay: shanghaiDay(new Date(deliveredAt)), notificationId: notice.id }, row);
    await this.service.enqueue('decision', { decisionId: row.id }, `expire:${row.id}`, new Date(dueAt));
    return saved;
  }
  /** @param {string} id */
  async expire(id) {
    const row = await this.service.get(id);
    if (row?.payload.status === 'executing') return this.execute(row, row.payload.execution.option, row.payload.execution.source, row.payload.execution.evidence);
    if (!row || row.payload.status !== 'pending' || !row.payload.deliveredAt || Date.parse(row.payload.dueAt) > this.now().getTime()) return row;
    if (row.payload.decisionClass === 'D') return this.execute(row, row.payload.alternative ?? row.payload.conservative, 'resource-alternative');
    if (!this.callbacks.refresh || !this.callbacks.review) throw new HttpError(503, 'evolution_review_unavailable', 'Expiry requires fresh evidence and independent review.');
    const refreshed = await this.callbacks.refresh(row.payload);
    const reviewed = await this.callbacks.review({ decision: row.payload, refreshed });
    if (!reviewed || reviewed.independent !== true || reviewed.family === refreshed?.family) throw new HttpError(503, 'evolution_review_invalid', 'A cross-family review is required.');
    const selected = row.payload.decisionClass === 'C' ? row.payload.conservative : reviewed.recommended ?? refreshed.recommended ?? row.payload.recommended;
    return this.execute(row, selected, 'default', { refreshed, reviewed });
  }
  /** @param {any} row @param {string} option @param {string} source @param {any} evidence */
  async execute(row, option, source, evidence = {}) {
    if (!row.payload.options.some((/** @type {any} */ item) => item.id === option)) throw new HttpError(400, 'evolution_option_invalid', 'Unknown decision option.');
    const actionId = row.payload.status === 'executing' ? row.payload.execution.actionId : `${row.id}:${row.revision}:${option}`;
    if (row.payload.status !== 'executing') row = await this.service.save('decision', row.id, { ...row.payload, status: 'executing', execution: { actionId, option, source, evidence } }, row);
    if (!this.callbacks.execute) throw new HttpError(503, 'evolution_execution_unavailable', 'Decision execution is unavailable.');
    const result = await this.callbacks.execute({ ...row.payload, id: row.id, option, source, actionId, evidence });
    const previous = row.payload.selected ?? null;
    return this.service.save('decision', row.id, { ...row.payload, selected: option, status: 'executed', source, decidedAt: this.now().toISOString(), evidence, result: result ?? null,
      overridden: row.payload.overridden || (source === 'user' && previous != null && previous !== option),
      history: [...row.payload.history, { actionId, previous, selected: option, source, at: this.now().toISOString(), evidence }] }, row);
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
      saved = await this.service.save('digest', id, { day, reportingFrom: new Date(from).toISOString(), reportingUntil: new Date(until).toISOString(),
        decisions: all.filter(row => row.payload.status === 'pending' && row.payload.cardDay === day && ['B','C'].includes(row.payload.decisionClass)).slice(0,this.config.evolutionMaxDecisionCards ?? 3),
        autonomous: today.filter(row => row.payload.status === 'executed' && row.payload.source !== 'user'),
        resources: all.filter(row => row.payload.decisionClass === 'D' && !row.payload.resourceReportedAt),
        achievements: (await this.service.tools()).filter(row => inWindow(row.updatedAt)),
        evaluationSummaries: evaluations.map(evolutionEvaluationDigest),
      });
    }
    const autonomousCounts=new Map();
    for(const row of saved.payload.autonomous) {
      const category=row.payload.category??'uncategorized';
      autonomousCounts.set(category,(autonomousCounts.get(category)??0)+1);
    }
    const autonomousLines=[...autonomousCounts].sort(([left],[right])=>left.localeCompare(right)).map(([category,count])=>`${category}：${count} 项`);
    const snapshot = saved.payload;
    const summaries = snapshot.evaluationSummaries ?? [];
    const engineNames = [['meta-analysis','Meta'],['adr-analysis','药物警戒'],['mendelian-randomization','孟德尔随机化']];
    const assessmentLines = summaries.flatMap(summary => summary.lines);
    const healthLines = engineNames.map(([capabilityId,name]) => `${name}体检：${summaries.some(summary => summary.capabilityIds.includes(capabilityId)) ? '当日实际评测见上方分项' : '当日未运行，分数未知'}`);
    const notice = await this.notifications.create(await this.service.owner(), { noticeType:'notify',title:'进化日报',body:[
      `待你裁决\n${snapshot.decisions.map(row=>row.payload.title).join('\n') || '暂无'}`,
      `已自主处理\n${autonomousLines.join('\n') || '暂无'}\n${snapshot.autonomous.slice(0,3).map(row=>`${row.payload.title}：${row.payload.options.find(option=>option.id===row.payload.selected)?.label ?? row.payload.selected}`).join('\n') || '暂无'}`,
      `资源等待\n${snapshot.resources.map(row=>`${row.payload.title}：${row.payload.body}`).join('\n') || '暂无新增'}`,
      `当日成果\n${snapshot.achievements.slice(0,10).map(row=>`${row.payload.name ?? row.payload.description ?? row.id} ${row.payload.validationLevel}`).join('\n') || '暂无新工具'}\n${assessmentLines.join('\n') || '评测：当日未运行，分数未知'}\n${healthLines.join('\n')}`,
    ].join('\n\n'),source:{type:'digest',id},idempotencyKey:id });
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
