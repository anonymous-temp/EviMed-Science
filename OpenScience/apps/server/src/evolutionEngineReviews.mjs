/**
 * The proposals 循证进化 prepares for the platform's own code, and who hears of them.
 *
 * A module whose improvement is a change to code (runtime, sources, evidence, memory) cannot be promoted by a measurement: its mission ends
 * with a review input on disk (`evolutionEngineReview.mjs`), and a person turns that into a pull request. The input used to be written and
 * announced to nobody, so the work waited for ever (review D-E3b). Now each operator account is sent one inbox item with the proposal's
 * summary and two actions, 「采纳」 and 「不采纳」, and the first answer closes the review: the opportunity's dossier becomes `adopted` or
 * `declined`, recording who answered and when, and an adopted proposal stays on the dossier as work to implement. There is no other step: no
 * expiry, no second model, no daily limit on these items, and the module is not held while it waits (the mission ended with the input).
 *
 * @module evolutionEngineReviews
 */

export const ENGINE_REVIEW_ACTIONS = Object.freeze({ adopt: 'adopt', decline: 'decline' });
/** The inbox item's source: one id per review, so two proposals never share an item. */
export const ENGINE_REVIEW_SOURCE_PREFIX = 'evolution-engine-review-';
/** What a module is called to an operator; one this does not name is the platform itself. */
const MODULE_LABELS = Object.freeze({ runtime: '运行时与路由', sources: '知识库', evidence: '证据专区', memory: '记忆' });
/** At most this many reviews are announced in one pass, so a backlog never holds the worker. */
const PASS_LIMIT = 20;
/** @param {unknown} value @param {number} max */
const clip = (value, max) => { const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''; return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text; };

/**
 * The inbox item for one proposal. Only what the proposal says goes in: what changes, why, what it is expected to do and what it may cost,
 * and the files it touches; the staged input's location stays on the dossier.
 * @param {{ moduleId?: string, summary?: any }} input
 * @returns {{ title: string, body: string, actions: { id: string, label: string, style: string }[] }}
 */
export function engineReviewNotice({ moduleId, summary = null }) {
  const label = MODULE_LABELS[/** @type {keyof typeof MODULE_LABELS} */ (moduleId ?? '')] ?? '平台';
  const facts = summary && typeof summary === 'object' ? summary : {};
  const list = (/** @type {unknown} */ value, /** @type {number} */ count) => (Array.isArray(value) ? value : []).map((item) => clip(item, 160)).filter(Boolean).slice(0, count);
  const files = list(facts.files, 6);
  const lines = [
    clip(facts.change, 240) ? `改动：${clip(facts.change, 240)}` : (clip(facts.goal, 240) ? `目标：${clip(facts.goal, 240)}` : null),
    clip(facts.reason, 240) ? `原因：${clip(facts.reason, 240)}` : null,
    list(facts.benefits, 3).length ? `预期：${list(facts.benefits, 3).join('；')}` : null,
    list(facts.harms, 3).length ? `可能的代价：${list(facts.harms, 3).join('；')}` : null,
    files.length ? `涉及文件：${files.join('、')}${Array.isArray(facts.files) && facts.files.length > files.length ? ` 等 ${facts.files.length} 个` : ''}` : null,
    '采纳后记入待实现的工作；不采纳则关闭这一项。',
  ].filter(Boolean);
  return { title: `循证进化提出一项代码改动：${label}`, body: lines.join('\n'),
    actions: [{ id: ENGINE_REVIEW_ACTIONS.adopt, label: '采纳', style: 'primary' }, { id: ENGINE_REVIEW_ACTIONS.decline, label: '不采纳', style: 'neutral' }] };
}

/**
 * @param {{ service: any, notifications: any, config?: any, now?: () => Date }} dependencies
 */
export function createEvolutionEngineReviews({ service, notifications, config = {}, now = () => service.now() }) {
  /** Since process start: items sent, passes where nobody could be told, and the answers given. */
  const counters = { announced: 0, announceFailed: 0, adopted: 0, declined: 0 };
  const operators = () => [...new Set((config.operatorUsers ?? []).map(String).filter(Boolean))];
  const reviewOf = (/** @type {any} */ row) => row?.payload?.review ?? null;

  /**
   * Tell the operators of one prepared proposal, once. The item's key is the review's identity, so a repeated pass sends nothing new, and a
   * proposal already answered (or already announced) is left alone.
   * @param {string} dossierId
   */
  async function announce(dossierId) {
    return service.withLock(`engine-review:${dossierId}`, async () => {
      const dossier = await service.get(dossierId);
      const review = reviewOf(dossier);
      if (dossier?.payload.opportunity !== true || dossier.payload.status !== 'review' || !review?.reviewId || review.notice || review.decision) return dossier;
      const mission = review.missionId ? await service.get(review.missionId) : null;
      const text = engineReviewNotice({ moduleId: dossier.payload.moduleId, summary: mission?.payload.engineReview?.summary ?? null });
      /** @type {{ userId: string, id: string }[]} */
      const items = [];
      for (const userId of operators()) {
        try {
          const item = await notifications.create(userId, { noticeType: 'review', title: text.title, body: text.body, actions: text.actions,
            source: { type: 'system', id: `${ENGINE_REVIEW_SOURCE_PREFIX}${review.reviewId}` }, idempotencyKey: `evolution-engine-review:${review.reviewId}` });
          items.push({ userId, id: item.id });
        } catch { counters.announceFailed++; }
      }
      // Nobody could be told this pass: the dossier stays as it is and the next pass tries again.
      if (!items.length) return dossier;
      counters.announced++;
      return service.save('dossier', dossier.id, { ...dossier.payload, review: { ...review, notice: { at: now().toISOString(), items } } }, dossier);
    });
  }

  /** Announce the prepared proposals nobody has been told of yet: those whose first attempt failed, and those prepared before the inbox item existed. */
  async function announcePending() {
    let sent = 0;
    // Only the dossiers waiting on an answer are read: this pass comes round every minute.
    for (const row of await service.list('dossier', null, { status: 'review' })) {
      if (sent >= PASS_LIMIT) break;
      const review = reviewOf(row);
      if (row.payload.opportunity !== true || row.payload.status !== 'review' || !review?.reviewId || review.notice || review.decision) continue;
      await announce(row.id);
      sent++;
    }
    return sent;
  }

  /** The dossier of a review is its opportunity's; the engine's own dossier (the build record) carries the same review and follows it. */
  async function dossiersOf(/** @type {string} */ reviewId) {
    const all = await service.dossiers();
    return { opportunity: all.find((row) => row.payload.opportunity === true && reviewOf(row)?.reviewId === reviewId) ?? null,
      engine: all.find((row) => row.payload.moduleEngine === true && row.payload.review?.identity === reviewId) ?? null };
  }

  /**
   * Carry out an answer: close the review on its dossiers, with who answered and when, and close the other operators' copies of the item.
   * Registered with the inbox (`NotificationService.onAction`), so it runs before the item resolves; a failure leaves the item open to be
   * answered again, and an answer after the first changes nothing.
   * @param {any} item @param {string} actionId
   */
  async function decide(item, actionId) {
    const source = String(item?.source?.id ?? '');
    if (item?.source?.type !== 'system' || !source.startsWith(ENGINE_REVIEW_SOURCE_PREFIX) || !(/** @type {string[]} */ (Object.values(ENGINE_REVIEW_ACTIONS))).includes(actionId)) return null;
    const reviewId = source.slice(ENGINE_REVIEW_SOURCE_PREFIX.length);
    const outcome = await service.withLock(`engine-review-decision:${reviewId}`, async () => {
      const { opportunity, engine } = await dossiersOf(reviewId);
      const review = reviewOf(opportunity);
      if (!opportunity || !review) return null;
      if (review.decision) return { state: review.decision.state, first: false, notice: review.notice };
      const state = actionId === ENGINE_REVIEW_ACTIONS.adopt ? 'adopted' : 'declined';
      const decision = { state, actionId, by: String(item.userId), at: now().toISOString() };
      // Where the staged input is and what it says are on the mission that prepared it (the build record, when there is one, carries the same).
      const staged = (review.missionId ? (await service.get(review.missionId))?.payload.engineReview : null) ?? engine?.payload.review ?? null;
      // The proposal an operator adopted stays with the dossier as work to implement: what it changes, where its staged input is and the command
      // that turns it into a branch for review.
      const adoptedWork = state === 'adopted' ? { reviewId, moduleId: opportunity.payload.moduleId, summary: staged?.summary ?? null,
        stagedAt: staged?.relativeDirectory ?? null, prepareCommand: staged?.prepareCommand ?? null, adoptedBy: decision.by, adoptedAt: decision.at } : null;
      await service.save('dossier', opportunity.id, { ...opportunity.payload, status: state, review: { ...review, decision }, ...(adoptedWork ? { adoptedWork } : {}) }, opportunity);
      if (engine) await service.save('dossier', engine.id, { ...engine.payload, status: state, review: { ...engine.payload.review, decision }, ...(adoptedWork ? { adoptedWork } : {}) }, engine);
      counters[state === 'adopted' ? 'adopted' : 'declined']++;
      return { state, first: true, notice: review.notice };
    });
    // The same item sent to the other operators is settled with the answer, best effort: the review is closed whether or not they are.
    if (outcome?.first) {
      for (const sibling of outcome.notice?.items ?? []) {
        if (sibling.id === item.id) continue;
        try {
          const current = await notifications.get(sibling.userId, sibling.id);
          if (!current.resolvedAt) await notifications.resolveByDefault(sibling.userId, sibling.id, { actionId, expectedRevision: current.revision });
        } catch { /* the review is closed; their copy stays open until they open it */ }
      }
    }
    return outcome;
  }

  return { announce, announcePending, decide, counters };
}
