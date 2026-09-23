/**
 * The run's own tool calls, drawn as what they mean to a researcher: the plan
 * as a list of deliverables, each delegation as a card for that piece of work,
 * each submission as its verdict.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client:
 *
 *  - `ui-tool` renders every call through `renderSlot('tool.call.toolview',
 *    owner, { entryKey: toolName, fallback: GenericToolCard })`. The key is the
 *    wire name, the key space is open, and a keyed hit REPLACES the generic
 *    row. None of ours is a shipped key, so these are additions, not
 *    takeovers. The owner carries `{ callId, toolName, block, inspect, … }`;
 *    `block` is the running call (`argsRaw` still growing, no result) or the
 *    settled result node (`call.argsRaw`, text `content`, `isError`).
 *  - A socket tool's result reaches the transcript as rendered text —
 *    `ok\n<JSON>` or `failed: <code>` with one `- (<severity>) <code> <msg>`
 *    line per issue — and is read with the kit's `parseToolText`.
 *  - A component that throws is retired from its key for the rest of the page
 *    (the renderer "abdicates" it and the generic row takes over). So each
 *    view computes its model inside a guard and draws a plain row when the
 *    call has a shape it does not know, rather than losing every later call
 *    of the same tool to one odd one.
 *  - The validator's issue text is English and written for the run. It never
 *    reaches these cards: a verdict is drawn as ✓ 通过 / ⚠ N 项需核对 / 未核验,
 *    a refusal as the Chinese sentence for its code.
 *  - What the call itself cannot say — which child is working on what, how
 *    many sources are in, which attempt this is — arrives from the shell as the
 *    bound run's state (C9 `run-state`, the control plane's `RunProgress`), and
 *    each card draws without it when it has not arrived.
 *  - 「查看子任务」 opens the kernel's own subagent view through
 *    `sessions.openSubagent`, which refuses any address the parent's catalogue
 *    does not list with that exact mode; the button waits for the catalogue.
 *
 * @module @evimed/harness-port/runtime-ui-toolviews
 */

import { frameStyles } from './runtimeUiStyles.mjs';

/** Services this body needs outright. */
export const inject = ['slots', 'sessions'];

/**
 * The words these views use, in one place.
 * @returns {{ status: Record<string, string>, childState: Record<string, string>, awaitStatus: Record<string, string>, refusal: Record<string, string> }}
 */
export function toolviewText() {
  return {
    // A deliverable's place in the plan (C3 `deliverables[].status`).
    status: {
      planned: '待开始', delegated: '进行中', submitted: '核对中', rejected: '需修改',
      accepted: '已通过', delivered: '已交付', failed: '未完成',
    },
    // A delegated child as the control plane last saw it (C5 `children[].state`).
    childState: { running: '进行中', idle: '等待中', done: '已结束', failed: '未完成' },
    // One result of `evimed_await` (C6).
    awaitStatus: { completed: '已完成', failed: '未完成', running: '仍在进行' },
    // Tool-level refusals: the call was not accepted for work or judgement.
    refusal: {
      plan_invalid: '计划需要修改',
      deliverable_unknown: '计划里没有这一件',
      deliverable_not_owned: '这一件不由当前子任务负责',
      deliverable_attempts_spent: '这一件的提交次数已用完',
      deliverable_dependency_pending: '它依赖的那一件还没有通过',
      capability_unknown: '工具目录里没有这一项',
      capability_background_only: '这项工具只在后台运行',
      subagent_start_failed: '子任务没有启动',
      subagent_failed: '子任务没有完成',
    },
  };
}

/**
 * A verdict in the three forms a reader acts on.
 * @param {{ verdict: string, mustFix?: number }} value
 * @returns {{ text: string, tone: 'ok' | 'warn' | 'muted' }}
 */
export function verdictText(value) {
  if (value.verdict === 'pass') return { text: '✓ 通过', tone: 'ok' };
  if (value.verdict === 'issues') return { text: `⚠ ${Math.max(1, Number(value.mustFix) || 0)} 项需核对`, tone: 'warn' };
  return { text: '未核对', tone: 'muted' };
}

/**
 * The sentence for a tool refusing the call — not accepted for work or for
 * judgement — or null when the failure is a verdict on the work.
 *
 * Decided by the result's code against the closed list of the socket tools'
 * own refusal codes. The envelope's shape cannot decide it: a gate verdict
 * with one finding carries that finding's code at the top as well, and read
 * as a refusal it would tell the reader the package was never judged.
 *
 * @param {any} result
 * @returns {string | null}
 */
export function refusalOf(result) {
  if (!result || result.ok) return null;
  const table = toolviewText().refusal;
  return Object.hasOwn(table, result.code) ? table[result.code] : null;
}

/**
 * The bound run's state, when it belongs to the conversation on screen.
 *
 * The shell sends the state of the run bound to its current task. A child's
 * view is the same run (its root session is the task's session), so the state
 * counts there too; a stale state for another task does not.
 *
 * @param {any} runState the shell's last `run-state`
 * @param {any} session the bridge's last `session` (`{ sessionId, rootSessionId? }`)
 * @returns {any} the run state, or null
 */
export function liveRunFor(runState, session) {
  if (!runState || typeof runState !== 'object' || !runState.runId) return null;
  const bound = typeof runState.sessionId === 'string' ? runState.sessionId : null;
  if (!bound || !session) return runState;
  const here = [session.sessionId, session.rootSessionId].filter((value) => typeof value === 'string');
  return here.includes(bound) ? runState : null;
}

/**
 * One deliverable of the live run, by id.
 * @param {any} live @param {string} id
 * @returns {any}
 */
export function liveDeliverable(live, id) {
  const list = live && live.progress && Array.isArray(live.progress.deliverables) ? live.progress.deliverables : [];
  return list.find((/** @type {any} */ entry) => entry && entry.id === id) ?? null;
}

/**
 * One child of the live run, by child session id or by the deliverable it
 * works on.
 * @param {any} live @param {{ childSessionId?: string | null, deliverableId?: string | null }} match
 * @returns {any}
 */
export function liveChild(live, match) {
  const list = live && live.progress && Array.isArray(live.progress.children) ? live.progress.children : [];
  if (match.childSessionId) {
    const byId = list.find((/** @type {any} */ entry) => entry && entry.childSessionId === match.childSessionId);
    if (byId) return byId;
  }
  if (!match.deliverableId) return null;
  const mine = list.filter((/** @type {any} */ entry) => entry && entry.deliverableId === match.deliverableId);
  return mine.at(-1) ?? null;
}

/**
 * The plan call: its deliverables with dependencies, or what it is still
 * writing.
 *
 * Statuses come from the live run only. The plan's own result is a snapshot
 * taken when it was written — every item `planned` — and drawn beside a run
 * twenty minutes later it says 「待开始」 about work that has long finished.
 * A `status` read-back is the exception: it is the state at that moment, and
 * says so.
 *
 * @param {any} block @param {any} live @param {any} kit
 * @param {Map<string, string>} [known] deliverable titles other plan calls on this page carried
 */
export function planView(block, live, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const args = call.args ?? {};
  const action = typeof args.action === 'string' ? args.action : kit.partialArgField(call.argsRaw, 'action');
  const kindLabels = (kit.vocabulary && kit.vocabulary.contractKindLabels) || {};
  const statusWords = toolviewText().status;
  // A dependency is named by the title this same plan gives it.
  /** @type {Map<string, string>} */
  const titled = new Map(known);
  /** @param {any[]} list */
  const learn = (list) => {
    for (const item of list) if (item && item.id && typeof item.title === 'string' && item.title) titled.set(String(item.id), item.title);
  };
  /** @param {any} item @param {boolean} snapshot */
  const row = (item, snapshot) => {
    const id = String(item?.id ?? '');
    const liveItem = liveDeliverable(live, id);
    const status = liveItem?.status ?? (snapshot ? item?.status : undefined);
    /** @type {string[]} */
    const dependsOn = Array.isArray(item?.dependsOn) ? item.dependsOn.map(String) : [];
    return {
      id,
      title: String(item?.title || liveItem?.title || titled.get(id) || id),
      capability: kit.capabilityTitle(item?.capability ?? liveItem?.capability) ?? null,
      kind: kindLabels[item?.contractKind] ?? null,
      dependsOn: dependsOn.map((dep) => String(titled.get(dep) || liveDeliverable(live, dep)?.title || dep)),
      status: typeof status === 'string' && statusWords[status] ? { key: status, text: statusWords[status] } : null,
    };
  };
  const clarifications = Array.isArray(args.clarifications)
    ? args.clarifications.filter((/** @type {unknown} */ entry) => typeof entry === 'string' && entry.trim()).map(String)
    : [];
  if (call.running) {
    const drafted = Array.isArray(args.deliverables) ? args.deliverables.filter((/** @type {any} */ item) => item && item.id) : [];
    learn(drafted);
    return { kind: action === 'status' ? 'reading' : 'writing', deliverables: drafted.map((/** @type {any} */ item) => row(item, false)), clarifications };
  }
  const result = call.result;
  if (!result) return { kind: call.stopped ? 'stopped' : 'unknown', deliverables: [], clarifications };
  if (!result.ok) return { kind: 'refused', text: refusalOf(result) ?? '计划需要修改', deliverables: [], clarifications };
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const items = Array.isArray(data.deliverables) ? data.deliverables : Array.isArray(data.items) ? data.items : [];
  learn(items);
  const snapshot = action === 'status';
  return {
    kind: snapshot ? 'status' : 'written',
    revision: Number.isInteger(data.revision) ? data.revision : null,
    reason: typeof args.reason === 'string' && args.reason.trim() && !items.length ? args.reason.trim() : null,
    deliverables: items.filter((/** @type {any} */ item) => item && item.id).map((/** @type {any} */ item) => row(item, snapshot)),
    clarifications,
  };
}

/**
 * A delegation: the piece of work, who is doing it, how far it is.
 *
 * Two result shapes are read. The blocking delegate (until 2026-09-18) held
 * the call open while the child worked and returned `{ deliverableId,
 * childSessionId, report, status }` when it settled; the non-blocking one (C6)
 * returns `{ handle, deliverableId, childSessionId, status: 'started' }` at
 * once, and the child's progress is only in the live run.
 *
 * @param {any} block @param {any} live @param {number} now @param {any} kit
 * @param {Map<string, string>} [known]
 */
export function delegateView(block, live, now, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const text = toolviewText();
  const deliverableId = String(call.args?.deliverableId ?? kit.partialArgField(call.argsRaw, 'deliverableId') ?? '');
  const liveItem = deliverableId ? liveDeliverable(live, deliverableId) : null;
  const result = call.result;
  const data = result && result.ok && result.data && typeof result.data === 'object' ? result.data : null;
  const idOf = (/** @type {unknown} */ value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null);
  const child = liveChild(live, { childSessionId: idOf(data?.childSessionId) ?? idOf(liveItem?.childSessionId), deliverableId });
  const childSessionId = idOf(data?.childSessionId) ?? idOf(child?.childSessionId) ?? idOf(liveItem?.childSessionId);
  const base = {
    deliverableId,
    title: String(liveItem?.title || known.get(deliverableId) || deliverableId || '这一件'),
    capability: kit.capabilityTitle(liveItem?.capability) ?? null,
    childSessionId,
  };
  const refusal = refusalOf(result);
  if (result && !result.ok) return { ...base, state: 'refused', stateText: refusal ?? '委派未成功', tone: 'warn', elapsed: null, phase: null, sources: null, submission: null };
  if (!result && call.stopped) return { ...base, state: 'stopped', stateText: '已停止', tone: 'muted', elapsed: null, phase: null, sources: null, submission: null };

  // Where the work stands: the live child first, then the deliverable, then
  // what the call itself says. A non-blocking delegation with no live news
  // says only that it started — a clock started from the call and never
  // stopped would, on an old task with no bound run, count hours of work
  // nobody is doing.
  const startedOnly = Boolean(data && data.status === 'started');
  /** @type {'running' | 'idle' | 'started' | 'done' | 'failed'} */
  let state = 'done';
  if (child && ['running', 'idle', 'done', 'failed'].includes(child.state)) state = child.state;
  else if (call.running) state = 'running';
  else if (liveItem && ['accepted', 'delivered'].includes(liveItem.status)) state = 'done';
  else if (liveItem && liveItem.status === 'failed') state = 'failed';
  else if (startedOnly) state = 'started';
  else if (data && data.status === 'failed') state = 'failed';
  const deliverableStatus = liveItem?.status ?? (data && !startedOnly ? data.status : null);
  const working = state === 'running' || state === 'idle';
  const stateText = working ? text.childState[state]
    : state === 'started' ? '已启动'
      : (deliverableStatus && text.status[deliverableStatus]) || (state === 'failed' ? '未完成' : '已结束');
  const tone = !working && ['accepted', 'delivered'].includes(deliverableStatus) ? 'ok'
    : state === 'failed' || (!working && ['rejected', 'failed'].includes(deliverableStatus)) ? 'warn'
      : working || state === 'started' ? 'active' : 'muted';

  // Elapsed: from the call to now while the work is going, to the child's
  // last sign of life once it is not. The blocking call settled when its
  // child did; a non-blocking one settled at once and says nothing about it.
  const begun = call.startedAt;
  const lastActivity = child && typeof child.lastActivityAt === 'string' ? Date.parse(child.lastActivityAt) : NaN;
  const ended = working ? now
    : Number.isFinite(lastActivity) ? lastActivity
      : !startedOnly && data ? call.settledAt : null;
  const elapsed = begun && ended && ended >= begun ? kit.formatDuration(ended - begun) : null;

  // The run-level phase and source counts describe this child only when it is
  // the only one: with two at work they are the sum of both.
  const children = live && live.progress && Array.isArray(live.progress.children) ? live.progress.children : [];
  const alone = children.length <= 1 && (!child || children.length === 0 || children[0] === child);
  const phaseKey = live?.progress?.currentPhase;
  const phaseLabels = (kit.vocabulary && kit.vocabulary.phaseLabels) || {};
  const phase = alone && working && typeof phaseKey === 'string' && phaseLabels[phaseKey] ? phaseLabels[phaseKey] : null;
  const counts = alone ? live?.progress?.sources : null;
  const sources = counts && Number.isFinite(counts.included)
    ? `纳入 ${counts.included} 篇${Number.isFinite(counts.fullText) && counts.fullText > 0 ? ` · 全文 ${counts.fullText} 篇` : ''}`
    : null;
  const attempts = Number(liveItem?.attempts) || 0;
  const submission = attempts > 0
    ? {
      attempt: attempts,
      verdict: liveItem?.lastVerdict ? verdictText({ verdict: liveItem.lastVerdict, mustFix: liveItem.mustFixCount }) : null,
    }
    : null;
  return { ...base, state, stateText, tone, elapsed, phase, sources, submission };
}

/**
 * `evimed_await` (C6): which children the run waited for, and how each came
 * back.
 * @param {any} block @param {any} live @param {any} kit @param {Map<string, string>} [known]
 */
export function awaitView(block, live, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const handles = Array.isArray(call.args?.handles) ? call.args.handles.length : null;
  if (call.running) return { kind: 'waiting', handles, results: [] };
  const result = call.result;
  if (!result) return { kind: call.stopped ? 'stopped' : 'unknown', handles, results: [] };
  if (!result.ok) return { kind: 'refused', text: refusalOf(result) ?? '没有等到结果', handles, results: [] };
  const words = toolviewText().awaitStatus;
  const list = Array.isArray(result.data?.results) ? result.data.results : [];
  return {
    kind: 'settled',
    handles,
    results: list.filter((/** @type {any} */ entry) => entry && typeof entry === 'object').map((/** @type {any} */ entry) => {
      const id = String(entry.deliverableId ?? '');
      const submission = entry.submission && typeof entry.submission === 'object' ? entry.submission : null;
      return {
        deliverableId: id,
        title: String(liveDeliverable(live, id)?.title || known.get(id) || id || '这一件'),
        status: words[entry.status] ?? '未知',
        tone: entry.status === 'completed' ? 'ok' : entry.status === 'failed' ? 'warn' : 'active',
        verdict: submission && submission.verdict ? verdictText({ verdict: submission.verdict }) : null,
        attempts: submission && Number.isInteger(submission.attempts) ? submission.attempts : null,
      };
    }),
  };
}

/**
 * A submission, or a check that judges without spending an attempt: the
 * verdict and nothing of the validator's own words.
 * @param {any} block @param {any} live @param {any} kit @param {Map<string, string>} [known]
 */
export function verdictView(block, live, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const deliverableId = String(call.args?.deliverableId ?? kit.partialArgField(call.argsRaw, 'deliverableId') ?? '');
  const liveItem = deliverableId ? liveDeliverable(live, deliverableId) : null;
  const result = call.result;
  const label = result && result.ok && typeof result.data?.label === 'string' ? result.data.label : null;
  const base = { deliverableId, title: String(liveItem?.title || known.get(deliverableId) || label || deliverableId || '这一件'), label };
  if (call.running) return { ...base, kind: 'judging', verdict: null, advice: 0 };
  if (!result) return { ...base, kind: call.stopped ? 'stopped' : 'unknown', verdict: null, advice: 0 };
  const refusal = refusalOf(result);
  if (refusal) return { ...base, kind: 'refused', text: refusal, verdict: null, advice: 0 };
  const verdict = kit.verdictOf(result);
  // A submission renders the numbering, runs the gate and asks the control
  // plane's independent reviewer, and comes back with all three. The review is
  // worth a reader's glance — it is the half that resolves every reference and
  // reads the package as an outside editor.
  const review = result.ok && result.data?.review && typeof result.data.review === 'object' ? result.data.review : null;
  const references = review?.references && typeof review.references === 'object' ? review.references : null;
  return {
    ...base,
    kind: 'judged',
    verdict: verdictText(verdict),
    advice: verdict.advice,
    review: review && review.status === 'done'
      ? {
        findings: Number(review.findings) || 0,
        answerRequired: Array.isArray(review.answerRequired) ? review.answerRequired.length : 0,
        resolved: Number(references?.resolved) || 0,
        withIdentifier: Number(references?.withIdentifier) || 0,
        unresolvable: Number(references?.unresolvable) || 0,
      }
      : review && review.status === 'unavailable' ? { unavailable: true } : null,
  };
}

/**
 * What the reviewer found, in one phrase, or null when it did not run.
 * @param {{ findings?: number, answerRequired?: number, resolved?: number, withIdentifier?: number, unresolvable?: number, unavailable?: boolean } | null} review
 * @returns {string | null}
 */
export function reviewSummaryText(review) {
  if (!review) return null;
  if (review.unavailable) return '独立审查未完成';
  const parts = [review.findings ? `审查发现 ${review.findings} 条${review.answerRequired ? `（${review.answerRequired} 条需回应）` : ''}` : '审查未发现问题'];
  if (review.withIdentifier) parts.push(`文献核对 ${review.resolved}/${review.withIdentifier}${review.unresolvable ? `，${review.unresolvable} 条查无此条` : ''}`);
  return parts.join(' · ');
}

/**
 * One claim registered against a deliverable (C7 `evimed_claim_upsert`).
 * @param {any} block @param {any} kit
 */
export function claimView(block, kit) {
  const call = kit.toolCallState(block);
  const claim = call.args?.claim && typeof call.args.claim === 'object' ? call.args.claim : null;
  const wording = ['text', 'statement', 'claim'].map((key) => claim?.[key]).find((value) => typeof value === 'string' && value.trim());
  const streamed = wording ?? kit.partialArgField(call.argsRaw, 'text');
  const statement = typeof streamed === 'string' ? streamed.replace(/\s+/g, ' ').trim().slice(0, 160) : null;
  if (call.running) return { kind: 'recording', statement, status: null, totals: null };
  const result = call.result;
  if (!result) return { kind: call.stopped ? 'stopped' : 'unknown', statement, status: null, totals: null };
  if (!result.ok) return { kind: 'refused', text: refusalOf(result) ?? '这条结论没有登记', statement, status: null, totals: null };
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  const totals = data.totals && Number.isFinite(data.totals.total) && Number.isFinite(data.totals.verified)
    ? `已核对 ${data.totals.verified}/${data.totals.total}` : null;
  const status = data.status === 'verified' ? { text: '✓ 已核对', tone: 'ok' } : { text: '⚠ 未核对', tone: 'warn' };
  return { kind: 'recorded', statement, status, totals };
}

/**
 * 「查看子任务」: the kernel's own view of a child, reached through the parent's
 * catalogue — the only address `sessions.openSubagent` accepts, and only with
 * the exact mode the catalogue lists. Disabled until the catalogue lists the
 * child; the catalogue is asked for once when it does not.
 *
 * Shared by the delegation card and the progress tab: the build emits it into
 * each body that lists it among its parts.
 *
 * @param {any} ctx @param {any} kit @param {any} target
 * @returns {(props: { childSessionId: string }) => any}
 */
export function childLinkFor(ctx, kit, target) {
  const h = kit.h;
  const React = kit.react;
  const { button } = frameStyles();
  /** @param {{ childSessionId: string }} props */
  return function ChildLink({ childSessionId }) {
    const list = ctx.sessions && ctx.sessions.list;
    const read = () => (list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null);
    const snapshot = React.useSyncExternalStore(
      (/** @type {() => void} */ listener) => (list && typeof list.subscribe === 'function' ? list.subscribe(listener) : () => {}),
      read,
      read,
    );
    const parent = kit.hub.getState().session?.rootSessionId ?? snapshot?.current ?? null;
    const catalogue = parent && snapshot && snapshot.subagentsByParent ? snapshot.subagentsByParent[parent] : null;
    const entry = Array.isArray(catalogue?.entries)
      ? catalogue.entries.find((/** @type {any} */ candidate) => candidate && candidate.id === childSessionId && candidate.kind === 'child')
      : null;
    const asked = React.useRef(false);
    React.useEffect(() => {
      if (entry || !parent || asked.current || typeof ctx.sessions?.refreshSubagents !== 'function') return;
      asked.current = true;
      try { ctx.sessions.refreshSubagents(parent); } catch { /* the catalogue refreshes on its own events too */ }
    }, [entry, parent]);
    const open = () => {
      if (!entry || !parent) return;
      try { ctx.sessions.openSubagent({ parentSessionId: parent, childSessionId, mode: entry.mode }); } catch (error) {
        target.console?.warn?.('[evimed-frame] the subagent view did not open:', error);
      }
    };
    return h('button', {
      type: 'button', onClick: open, disabled: !entry, 'data-evimed-open-child': childSessionId,
      title: entry ? '在内核的子任务视图中查看这件工作的完整过程' : '子任务目录还在载入',
      style: { ...button, opacity: entry ? 1 : 0.5, cursor: entry ? 'pointer' : 'default' },
    }, '查看子任务');
  };
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h || !kit.react) return;
  const h = kit.h;
  const React = kit.react;
  const tools = (kit.vocabulary && kit.vocabulary.tools) || {};
  // Deliverable titles the plan calls on this page carried: the fallback
  // name for a card whose call names only an id and whose run state has not
  // arrived.
  /** @type {Map<string, string>} */
  const known = new Map();

  const { card, line, title, quiet, pill } = frameStyles();

  /** The run state for the conversation on screen, or null. */
  function useLive() {
    const runState = kit.useFrameState((/** @type {any} */ state) => state.runState);
    const session = kit.useFrameState((/** @type {any} */ state) => state.session);
    return liveRunFor(runState, session);
  }

  /**
   * The model of one call, or null when the call has a shape the view does
   * not know — drawn then as a plain row, never thrown (see the module note).
   * @param {string} name @param {() => any} compute
   */
  function modelOf(name, compute) {
    try { return compute(); } catch (error) { target.console?.warn?.(`[evimed-frame] ${name} view could not read a call:`, error); return null; }
  }

  /** @param {{ label: string }} props */
  const PlainRow = ({ label }) => h('div', { style: line, 'data-evimed-toolview': 'plain' }, h('span', { style: title }, label));

  const ChildLink = childLinkFor(ctx, kit, target);

  /** @param {{ block: any }} props */
  function PlanView({ block }) {
    const live = useLive();
    const model = modelOf('plan', () => planView(block, live, kit, known));
    if (!model) return h(PlainRow, { label: '研究计划' });
    for (const item of model.deliverables) if (item.title && item.title !== item.id) known.set(item.id, item.title);
    const heading = {
      writing: '正在写研究计划…', reading: '正在读回进度…', refused: model.text, stopped: '研究计划 · 已停止', unknown: '研究计划',
      status: '研究计划 · 当前进度', written: model.revision && model.revision > 1 ? `研究计划 · 第 ${model.revision} 版` : '研究计划',
    }[/** @type {string} */ (model.kind)] ?? '研究计划';
    const rows = model.deliverables.map((/** @type {any} */ item) => h('li', {
      key: item.id, style: { ...line, listStyle: 'none' }, 'data-deliverable': item.id,
    },
    h('span', { style: { color: 'var(--dsw-alias-label-primary)', flex: 'none' } }, item.title),
    item.capability || item.kind ? h('span', { style: quiet }, [item.capability, item.kind].filter(Boolean).join(' · ')) : null,
    item.dependsOn.length ? h('span', { style: quiet }, `依赖：${item.dependsOn.join('、')}`) : null,
    item.status ? h('span', { style: { ...pill(item.status.key === 'accepted' || item.status.key === 'delivered' ? 'ok' : ['rejected', 'failed'].includes(item.status.key) ? 'warn' : item.status.key === 'planned' ? 'muted' : 'active'), marginLeft: 'auto' } }, item.status.text) : null));
    return h('div', { style: card, 'data-evimed-toolview': 'plan' },
      h('div', { style: line }, h('span', { style: title }, heading),
        model.deliverables.length ? h('span', { style: quiet }, `要交付 ${model.deliverables.length} 件`) : null),
      model.reason ? h('div', { style: quiet }, model.reason) : null,
      rows.length ? h('ul', { style: { margin: '4px 0 0', padding: 0 } }, rows) : null,
      model.clarifications.length ? h('details', { style: { marginTop: '4px' } },
        h('summary', { style: { ...quiet, cursor: 'pointer' } }, `澄清与假设 · ${model.clarifications.length} 条`),
        h('ul', { style: { margin: '2px 0 0', paddingLeft: '18px' } },
          model.clarifications.map((/** @type {string} */ entry, /** @type {number} */ index) => h('li', { key: index, style: { color: 'var(--dsw-alias-label-secondary)' } }, entry)))) : null);
  }

  /** @param {{ block: any }} props */
  function DelegateView({ block }) {
    const live = useLive();
    const [now, setNow] = React.useState(() => Date.now());
    const model = modelOf('delegate', () => delegateView(block, live, now, kit, known));
    // The elapsed time ticks only while nothing says the work has stopped.
    const ticking = Boolean(model && (model.state === 'running' || model.state === 'idle'));
    React.useEffect(() => {
      if (!ticking || typeof target.setInterval !== 'function') return undefined;
      const timer = target.setInterval(() => setNow(Date.now()), 1000);
      return () => target.clearInterval(timer);
    }, [ticking]);
    if (!model) return h(PlainRow, { label: '子任务' });
    const facts = [model.elapsed ? `已用时 ${model.elapsed}` : null, model.phase ? `当前：${model.phase}` : null, model.sources].filter(Boolean);
    return h('div', { style: card, 'data-evimed-toolview': 'delegate', 'data-state': model.state },
      h('div', { style: line },
        h('span', { style: quiet }, '子任务'),
        h('span', { style: title }, model.title),
        model.capability ? h('span', { style: quiet }, model.capability) : null,
        h('span', { style: { ...pill(model.tone), marginLeft: 'auto' } }, model.stateText)),
      facts.length || model.submission || model.childSessionId
        ? h('div', { style: { ...line, marginTop: '2px' } },
          facts.length ? h('span', { style: quiet }, facts.join(' · ')) : null,
          model.submission ? h('span', { style: { flex: 'none' } },
            h('span', { style: quiet }, `第 ${model.submission.attempt} 次提交`),
            model.submission.verdict ? h('span', { style: { ...pill(model.submission.verdict.tone), marginLeft: '6px' } }, model.submission.verdict.text) : null) : null,
          model.childSessionId ? h(ChildLink, { childSessionId: model.childSessionId }) : null)
        : null);
  }

  /** @param {{ block: any }} props */
  function AwaitView({ block }) {
    const live = useLive();
    const model = modelOf('await', () => awaitView(block, live, kit, known));
    if (!model) return h(PlainRow, { label: '等待子任务' });
    const heading = model.kind === 'waiting'
      ? (model.handles ? `正在等待 ${model.handles} 个子任务…` : '正在等待子任务…')
      : model.kind === 'refused' ? model.text : model.kind === 'stopped' ? '等待子任务 · 已停止' : '等待子任务';
    return h('div', { style: line, 'data-evimed-toolview': 'await' },
      h('span', { style: title }, heading),
      model.results.length ? h('span', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', minWidth: 0 } },
        model.results.map((/** @type {any} */ entry, /** @type {number} */ index) => h('span', { key: `${entry.deliverableId}:${index}`, style: { display: 'inline-flex', gap: '6px' } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, entry.title),
          h('span', { style: pill(entry.tone) }, entry.status),
          entry.verdict ? h('span', { style: pill(entry.verdict.tone) }, entry.verdict.text) : null))) : null);
  }

  /** @param {{ block: any, heading: string }} props */
  function VerdictView({ block, heading }) {
    const live = useLive();
    const model = modelOf('verdict', () => verdictView(block, live, kit, known));
    if (!model) return h(PlainRow, { label: heading });
    const state = model.kind === 'judging'
      ? h('span', { style: pill('active') }, '核对中…')
      : model.kind === 'refused' ? h('span', { style: pill('warn') }, model.text)
        : model.kind === 'judged' ? h('span', { style: pill(model.verdict.tone) }, model.verdict.text)
          : h('span', { style: pill('muted') }, model.kind === 'stopped' ? '已停止' : '未核对');
    return h('div', { style: line, 'data-evimed-toolview': 'verdict' },
      h('span', { style: quiet }, heading),
      h('span', { style: title }, model.title),
      state,
      model.kind === 'judged' && model.advice > 0 ? h('span', { style: quiet }, `另有 ${model.advice} 条建议`) : null,
      model.kind === 'judged' && reviewSummaryText(model.review) ? h('span', { style: quiet }, reviewSummaryText(model.review)) : null);
  }

  /** @param {{ block: any }} props */
  function ClaimView({ block }) {
    const model = modelOf('claim', () => claimView(block, kit));
    if (!model) return h(PlainRow, { label: '登记结论' });
    return h('div', { style: line, 'data-evimed-toolview': 'claim' },
      h('span', { style: quiet }, '登记结论'),
      model.statement ? h('span', { style: { ...quiet, color: 'var(--dsw-alias-label-secondary)', flex: '1 1 auto' } }, model.statement) : null,
      model.kind === 'recorded' ? h('span', { style: pill(model.status.tone) }, model.status.text)
        : model.kind === 'refused' ? h('span', { style: pill('warn') }, model.text)
          : model.kind === 'recording' ? h('span', { style: pill('active') }, '登记中…') : null,
      model.totals ? h('span', { style: { ...quiet, flex: 'none' } }, model.totals) : null);
  }

  const views = [
    [tools.plan, PlanView],
    [tools.delegate, DelegateView],
    [tools.await, AwaitView],
    [tools.submit, (/** @type {any} */ props) => h(VerdictView, { ...props, heading: '提交' })],
    [tools.packageCheck, (/** @type {any} */ props) => h(VerdictView, { ...props, heading: '自检' })],
    [tools.claimUpsert, ClaimView],
  ];
  for (const [name, View] of views) {
    if (typeof name !== 'string' || !name) continue;
    kit.guarded(`${name} view`, () => kit.occupy({ slot: 'tool.call.toolview', key: name, locale: 'conversation' }, View));
  }
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'toolviews',
  inject,
  parts: Object.freeze([frameStyles, toolviewText, verdictText, refusalOf, liveRunFor, liveDeliverable, liveChild, planView, delegateView, awaitView, verdictView, reviewSummaryText, claimView, childLinkFor, apply]),
});
