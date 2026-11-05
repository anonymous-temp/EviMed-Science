import { EVOLUTION_OFFLINE_ONLY, evolutionServingDecision } from './evolutionServingPolicy.mjs';
import { EVOLUTION_EXECUTABLE_OPERATIONS } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { shanghaiDay } from './notificationService.mjs';

/** The inbox refuses a body over 8,000 characters, a title over 150 and an action label over 80; the digest and a card are cut to fit them. */
export const EVOLUTION_NOTICE_LIMITS = Object.freeze({ body: 8000, title: 150, label: 80 });
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
/** Delivery, expiry, and overrides retain every branch decision in the revision ledger. */
export class EvolutionDecisions {
  /** @param {any} dependencies */
  constructor({ service, notifications = service.notifications, callbacks = {}, now = service.now, config = service.config }) {
    this.service = service; this.notifications = notifications; this.callbacks = callbacks; this.now = now; this.config = config;
  }
  /**
   * What a card nobody answered takes: its conservative option, except that a harm review's is its protective one, the soft retirement the same decision reverses,
   * whatever was stored as conservative: cards written before 2026-10-26 named `keep`, and keeping a tool the harm test flagged silenced its alarm with nobody having decided it.
   * @param {any} row
   */
  async unansweredOption(row) {
    const subject = typeof row.payload.subjectId === 'string' ? await this.service.get(row.payload.subjectId) : null;
    if (subject?.payload?.recordType === 'evolution-maintenance-review' && subject.payload.kind === 'sequential-harm') {
      const protective = row.payload.options.find((/** @type {any} */ item) => (item.operation ?? item.id) === 'maintenance-retire');
      if (protective) return protective.id;
    }
    return row.payload.conservative;
  }
  /** Whether serving can carry out this option of the card. @param {any} row @param {string} option */
  servable(row, option) {
    try { return Boolean(option) && evolutionServingDecision(evolutionExecutableOperation({ ...row.payload, option })); } catch { return false; }
  }
  /**
   * Close a card serving cannot carry out, its work moved to the offline lab: terminal, said once (`retired-to-lab`), and the execution
   * it was stuck on kept in its history for the lab. A later answer with an option serving can carry out still supersedes it (`resolve`).
   * @param {any} row @param {string} source
   */
  async closeToLab(row, source) {
    const { execution, ...payload } = row.payload;
    const at = this.now().toISOString();
    const saved = await this.service.save('decision', row.id, { ...payload, status: 'closed', closedReason: 'retired-to-lab', closedAt: at,
      history: [...(payload.history ?? []), { actionId: execution?.actionId ?? null, previous: payload.selected ?? null, selected: null,
        option: execution?.option ?? null, source, closed: 'retired-to-lab', at }] }, row);
    // Its inbox item closes with it, as a default: nobody chose the option the item records, and the card itself says it closed.
    await this.closeNotice(saved, execution?.option ?? payload.conservative, 'serving');
    return saved;
  }
  /**
   * What this card becomes at its due date, as `expire` will decide it: the option it takes, or closing. Null when nothing is due on it.
   * @param {any} row @returns {Promise<{kind:'option',option:string,label:string}|{kind:'close'}|null>}
   */
  async dueOutcome(row) {
    if (row.payload.status !== 'pending' || !row.payload.dueAt) return null;
    const option = await this.unansweredOption(row);
    const chosen = row.payload.options.find((/** @type {any} */ item) => item.id === option);
    return chosen && this.servable(row, option) ? { kind: 'option', option, label: chosen.label } : { kind: 'close' };
  }
  /** Clock starts when delivery succeeds, not when the proposal is stored. @param {any} row */
  async deliver(row) {
    if (row.payload.deliveredAt) return row;
    let deliveredAt = this.now().toISOString();
    // The recommended option is the one marked primary, so a reader (and any channel that draws the actions) sees which it is.
    const notice = await this.notifications.create(await this.service.owner(), { noticeType: 'review', title: clip(row.payload.title, EVOLUTION_NOTICE_LIMITS.title), body: clip(row.payload.body, EVOLUTION_NOTICE_LIMITS.body),
      actions: row.payload.options.map((/** @type {any} */ o) => ({ id: o.id, label: clip(o.label, EVOLUTION_NOTICE_LIMITS.label), style: o.id === row.payload.recommended ? 'primary' : 'neutral' })),
      source: { type: 'system', id: row.id }, idempotencyKey: row.id }, { now: new Date(deliveredAt) });
    // One clock: the item is stamped with the decisions' own time, so the day a card counts against is the day it was delivered on.
    deliveredAt = notice.createdAt ?? deliveredAt;
    const dueAt = new Date(Date.parse(deliveredAt) + (this.config.evolutionDecisionTimeoutMs ?? 86400000)).toISOString();
    const saved = await this.service.save('decision', row.id, { ...row.payload, deliveredAt, dueAt, cardDay: shanghaiDay(new Date(deliveredAt)), notificationId: notice.id }, row);
    await this.service.enqueue('decision', { decisionId: row.id }, `expire:${row.id}`, new Date(dueAt));
    return saved;
  }
  /**
   * What a card that was not answered in time becomes: the option it takes when serving can carry that out, and otherwise it closes once, its execution kept for the offline lab.
   * Whatever was taken, a later answer of the operator's supersedes it. @param {string} id
   */
  async expire(id) {
    const row = await this.service.get(id);
    if (!row) return row;
    const executing = row.payload.status === 'executing';
    if (!executing && (row.payload.status !== 'pending' || !row.payload.deliveredAt || Date.parse(row.payload.dueAt) > this.now().getTime())) return row;
    const option = executing ? row.payload.execution.option : await this.unansweredOption(row);
    if (option && this.servable(row, option)) return this.execute(row, option, executing ? row.payload.execution.source : 'conservative', row.payload.execution?.evidence);
    return this.closeToLab(row, 'serving');
  }
  /** @param {any} row @param {string} option @param {string} source @param {any} evidence */
  async execute(row, option, source, evidence = {}) {
    if (!evolutionServingDecision(evolutionExecutableOperation({ ...row.payload, option }))) return EVOLUTION_OFFLINE_ONLY;
    if (!row.payload.options.some((/** @type {any} */ item) => item.id === option)) throw new HttpError(400, 'evolution_option_invalid', 'Unknown decision option.');
    const actionId = row.payload.status === 'executing' ? row.payload.execution.actionId : `${row.id}:${row.revision}:${option}`;
    if (row.payload.status !== 'executing') row = await this.service.save('decision', row.id, { ...row.payload, status: 'executing', execution: { actionId, option, source, evidence } }, row);
    if (!this.callbacks.execute) throw new HttpError(503, 'evolution_execution_unavailable', 'Decision execution is unavailable.');
    const result = await this.callbacks.execute({ ...row.payload, id: row.id, option, source, actionId, evidence });
    if (result?.status === 'deferred') return result;
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
    let row = await this.service.get(id);
    if (!row || row.payload.recordType !== 'evolution-decision') throw new HttpError(404, 'evolution_decision_missing', 'Decision not found.');
    if (input.expectedRevision !== row.revision) throw new HttpError(409, 'product_revision_conflict', 'Decision changed; reload before choosing.');
    // The operator closes a card whose work moved to the offline lab, a stranded execution included.
    if (input.close !== undefined) {
      if (input.close !== 'retired-to-lab') throw new HttpError(400, 'evolution_close_invalid', 'A card closes only as retired to the offline lab.');
      if (row.payload.status === 'closed') return row;
      if (row.payload.status === 'executed') throw new HttpError(409, 'evolution_decision_decided', 'The decision was carried out; answer it with an option instead.');
      if (row.payload.status === 'executing' && this.servable(row, row.payload.execution.option)) throw new HttpError(409, 'evolution_decision_executing', 'The decision is being carried out; reload and answer again.');
      return this.closeToLab(row, 'user');
    }
    // An answer in words needed a model to read it; refused, so that it is never carried out as the recommendation it did not choose.
    if (input.text) throw new HttpError(400, 'evolution_answer_invalid', 'Answer with one of the options.');
    const option = input.option ?? row.payload.recommended;
    // An answer that arrives while the expiry (or another answer) is carrying out a different option must not borrow its
    // action identity: the record would then say the person's option was chosen while the other was executed.
    if (row.payload.status === 'executing' && (row.payload.execution.source !== 'user' || row.payload.execution.option !== option)) {
      // An execution serving can never carry out (an experiment, moved to the offline lab) does not hold the card: an answer serving can
      // carry out supersedes it, and the stranded execution stays in the card's history.
      // An answer on a card with nothing serving can carry out is the way out of it: the card closes rather than saying `executing` to every click.
      const servableOption = row.payload.options.some((/** @type {any} */ item) => this.servable(row, item.id));
      if (this.servable(row, row.payload.execution.option) || (servableOption && !this.servable(row, option))) throw new HttpError(409, 'evolution_decision_executing', 'The decision is being carried out; reload and answer again.');
      row = await this.closeToLab(row, 'user');
      if (!servableOption) return row;
    }
    const saved = await this.execute(row, option, 'user');
    if (saved?.status === 'deferred') throw new HttpError(409, saved.code, saved.reason);
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
        // A card with nothing serving can carry out reaches nobody and takes no slot.
        if (!row.payload.options.some((/** @type {any} */ item) => this.servable(row, item.id))) { await this.closeToLab(row, 'serving'); continue; }
        if (slots-- > 0) await this.deliver(row);
        else {
          const [option, source] = row.payload.decisionClass === 'C' ? [await this.unansweredOption(row), 'conservative'] : [row.payload.recommended, 'autonomous'];
          // A card whose default is an experiment closes instead of waiting at every digest.
          if (!this.servable(row, option)) await this.closeToLab(row, 'serving');
          else await this.execute(row, option, source);
        }
      }
      all = await this.service.list('decision');
      const today = all.filter(row => inWindow(row.payload.decidedAt ?? row.createdAt));
      const label = (/** @type {any} */ row) => row.payload.options.find((/** @type {any} */ option) => option.id === row.payload.selected)?.label ?? row.payload.selected;
      // The snapshot keeps what the notice will say, not the documents it was read from: a day's worth of whole rows (a
      // tool drags every observation it has ever had) outgrew the record limit, and the text only ever uses these fields.
      saved = await this.service.save('digest', id, { day, reportingFrom: new Date(from).toISOString(), reportingUntil: new Date(until).toISOString(),
        decisions: all.filter(row => row.payload.status === 'pending' && row.payload.cardDay === day && ['B','C'].includes(row.payload.decisionClass)).slice(0,this.config.evolutionMaxDecisionCards ?? 3)
          .map(row => ({ id: row.id, title: clip(row.payload.title, 150) })),
        autonomous: today.filter(row => row.payload.status === 'executed' && row.payload.source !== 'user').slice(0, 200)
          .map(row => ({ id: row.id, category: row.payload.category ?? null, title: clip(row.payload.title, 150), selected: clip(label(row), 80) })),
        // Waits for material are not reported (`recordResourceWait`). A class D decision written before 2026-10-12 and not yet reported is still carried through once,
        // so that its expiry is scheduled and it closes; its line is no longer drawn.
        resources: all.filter(row => row.payload.decisionClass === 'D' && !row.payload.resourceReportedAt).slice(0, 200)
          .map(row => ({ id: row.id, category: row.payload.category ?? null })),
        // New tools that went live in the window. A tool's `updatedAt` moves on every call anyone makes of it, which is use and not an achievement.
        achievements: (await this.service.tools()).filter(row => inWindow(row.payload.createdAt) && ['active', 'alias'].includes(row.payload.status)).slice(0, 100)
          .map(row => ({ id: row.id, name: clip(row.payload.name ?? row.payload.description ?? row.id, 100), level: row.payload.validationLevel ?? 'V0' })),
      });
    }
    const snapshot = saved.payload;
    const notice = await this.notifications.create(await this.service.owner(), { noticeType:'notify',title:'进化日报',body:renderEvolutionDigest(snapshot),
      source:{type:'system',id},idempotencyKey:id });
    const deliveredAt = notice.createdAt ?? this.now().toISOString();
    for (const captured of snapshot.resources ?? []) {
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
  const sections = [
    `待你裁决\n${(snapshot.decisions ?? []).map((/** @type {any} */ row) => row.title).join('\n') || '暂无'}`,
    `已自主处理\n${bounded(autonomousLines, 10).join('\n') || '暂无'}\n${autonomous.slice(0, 3).map((/** @type {any} */ row) => `${row.title}：${row.selected}`).join('\n') || '暂无'}`,
    `当日成果\n${bounded((snapshot.achievements ?? []).map((/** @type {any} */ row) => `${row.name} ${row.level}`), 10).join('\n') || '暂无新工具'}`,
  ];
  const body = sections.join('\n\n');
  if (body.length <= limit) return body;
  const lines = body.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) { if (used + line.length + 1 > limit - 40) break; kept.push(line); used += line.length + 1; }
  return `${kept.join('\n')}\n（日报过长，另有 ${lines.length - kept.length} 行未显示）`;
}

/** @param {any} dependencies */
export function createEvolutionDecisions(dependencies) { return new EvolutionDecisions(dependencies); }
