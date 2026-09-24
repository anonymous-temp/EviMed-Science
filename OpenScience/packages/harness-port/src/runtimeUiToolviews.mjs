/**
 * The run's own tool calls, drawn as what they mean to a researcher: the plan
 * as the list of what will be handed back, each delegation as one line for
 * that piece of work — and the delivery gate's own calls not at all.
 *
 * What a row says was cut to that on 2026-09-23 (整改方案 §5.3): the plan
 * card lost its revision, count, contract kinds, dependencies and
 * clarifications; the subtask card its clock, phase, source counts and
 * submission tally; and the rows for submitting (「提交」), checking a package
 * (「自检」), registering a conclusion (「登记结论 … 已核对 a/b」) and waiting on
 * children (「正在等待 N 个子任务…」) left the conversation. A gate verdict does
 * not withhold a delivery (ruling of 2026-09-17), so none of them is something
 * a reader acts on; every one of them is still in the kernel's 运行 view, which
 * draws its own ledger and not these views. A call that was refused outright
 * — not accepted for work or for judgement — still says so, because that is
 * the one case in which the reader learns something went wrong.
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
 *  - A view that renders nothing leaves the call's row (`[data-chat-call-id]`)
 *    empty inside its flow item; the shell stylesheet removes such an item,
 *    so a hidden call leaves no gap in the transcript.
 *  - A socket tool's result reaches the transcript as rendered text —
 *    `ok\n<JSON>` or `failed: <code>` with one `- (<severity>) <code> <msg>`
 *    line per issue — and is read with the kit's `parseToolText`.
 *  - A component that throws is retired from its key for the rest of the page
 *    (the renderer "abdicates" it and the generic row takes over). So each
 *    view computes its model inside a guard and draws a plain row when the
 *    call has a shape it does not know, rather than losing every later call
 *    of the same tool to one odd one.
 *  - The validator's text is English and written for the run. It never
 *    reaches a row: a refusal is the Chinese sentence for its code.
 *  - Where each piece of work stands comes from the shell as the bound run's
 *    state (C9 `run-state`, the control plane's `RunProgress`); each row draws
 *    without it when it has not arrived.
 *  - 「查看」 opens the kernel's own subagent view through
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
 * @returns {{ status: Record<string, string>, childState: Record<string, string>, refusal: Record<string, string> }}
 */
export function toolviewText() {
  return {
    // A deliverable's place in the plan (C3 `deliverables[].status`).
    status: {
      planned: '待开始', delegated: '进行中', submitted: '进行中', rejected: '进行中',
      accepted: '已完成', delivered: '已完成', failed: '未完成',
    },
    // A delegated child as the control plane last saw it (C5 `children[].state`).
    childState: { running: '进行中', idle: '进行中', done: '已完成', failed: '未完成' },
    // Tool-level refusals: the call was not accepted for work or judgement.
    refusal: {
      plan_invalid: '计划需要修改',
      deliverable_unknown: '计划里没有这一件',
      deliverable_not_owned: '这一件不由当前子任务负责',
      deliverable_attempts_spent: '这一件的提交次数已用完',
      deliverable_dependency_pending: '它依赖的那一件还没有完成',
      capability_unknown: '工具目录里没有这一项',
      capability_background_only: '这项工具只在后台运行',
      subagent_start_failed: '子任务没有启动',
      subagent_failed: '子任务没有完成',
    },
  };
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
 * The plan call: what the run will hand back, and where each piece stands.
 *
 * Statuses come from the live run only. The plan's own result is a snapshot
 * taken when it was written — every item `planned` — and drawn beside a run
 * twenty minutes later it says 「待开始」 about work that has long finished.
 * A `status` read-back is the run checking its own progress; it draws nothing.
 *
 * @param {any} block @param {any} live @param {any} kit
 * @param {Map<string, string>} [known] deliverable titles other plan calls on this page carried
 */
export function planView(block, live, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const args = call.args ?? {};
  const action = typeof args.action === 'string' ? args.action : kit.partialArgField(call.argsRaw, 'action');
  const statusWords = toolviewText().status;
  /** @param {any} item */
  const row = (item) => {
    const id = String(item?.id ?? '');
    const liveItem = liveDeliverable(live, id);
    const status = liveItem?.status;
    return {
      id,
      title: String(item?.title || liveItem?.title || known.get(id) || id),
      status: typeof status === 'string' && statusWords[status] ? statusWords[status] : null,
    };
  };
  /** @param {unknown} list */
  const rows = (list) => (Array.isArray(list) ? list : []).filter((/** @type {any} */ item) => item && item.id).map(row);
  if (action === 'status') return { kind: 'status', deliverables: [] };
  if (call.running) return { kind: 'writing', deliverables: rows(args.deliverables) };
  const result = call.result;
  if (!result) return { kind: call.stopped ? 'stopped' : 'unknown', deliverables: rows(args.deliverables) };
  if (!result.ok) return { kind: 'refused', text: refusalOf(result) ?? '计划需要修改', deliverables: [] };
  const data = result.data && typeof result.data === 'object' ? result.data : {};
  return { kind: 'written', deliverables: rows(Array.isArray(data.deliverables) ? data.deliverables : data.items) };
}

/**
 * A delegation: the piece of work and where it stands.
 *
 * Two result shapes are read. The blocking delegate (until 2026-09-18) held
 * the call open while the child worked and returned `{ deliverableId,
 * childSessionId, report, status }` when it settled; the non-blocking one (C6)
 * returns `{ handle, deliverableId, childSessionId, status: 'started' }` at
 * once, and the child's progress is only in the live run.
 *
 * @param {any} block @param {any} live @param {any} kit
 * @param {Map<string, string>} [known]
 */
export function delegateView(block, live, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const text = toolviewText();
  const deliverableId = String(call.args?.deliverableId ?? kit.partialArgField(call.argsRaw, 'deliverableId') ?? '');
  const liveItem = deliverableId ? liveDeliverable(live, deliverableId) : null;
  const result = call.result;
  const data = result && result.ok && result.data && typeof result.data === 'object' ? result.data : null;
  const idOf = (/** @type {unknown} */ value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null);
  const child = liveChild(live, { childSessionId: idOf(data?.childSessionId) ?? idOf(liveItem?.childSessionId), deliverableId });
  const base = {
    deliverableId,
    title: String(liveItem?.title || known.get(deliverableId) || deliverableId || '这一件'),
    childSessionId: idOf(data?.childSessionId) ?? idOf(child?.childSessionId) ?? idOf(liveItem?.childSessionId),
  };
  if (result && !result.ok) return { ...base, state: 'refused', stateText: refusalOf(result) ?? '子任务没有启动' };
  if (!result && call.stopped) return { ...base, state: 'stopped', stateText: '已停止' };

  // Where the work stands: the live child first, then the deliverable, then
  // what the call itself says. A non-blocking delegation with no live news
  // says only that it started.
  /** @type {'running' | 'idle' | 'started' | 'done' | 'failed'} */
  let state = 'done';
  if (child && ['running', 'idle', 'done', 'failed'].includes(child.state)) state = child.state;
  else if (call.running) state = 'running';
  else if (liveItem && ['accepted', 'delivered'].includes(liveItem.status)) state = 'done';
  else if (liveItem && liveItem.status === 'failed') state = 'failed';
  else if (data && data.status === 'started') state = 'started';
  else if (data && data.status === 'failed') state = 'failed';
  const deliverableStatus = liveItem?.status ?? (data && data.status !== 'started' ? data.status : null);
  const stateText = state === 'started' ? '已启动'
    : state === 'running' || state === 'idle' ? text.childState[state]
      : (deliverableStatus && text.status[deliverableStatus]) || text.childState[state] || '已完成';
  return { ...base, state, stateText };
}

/**
 * A call of the delivery gate — a submission, a package check, a registered
 * conclusion, a wait on children — as the conversation shows it: nothing,
 * unless the call was refused outright.
 * @param {any} block @param {any} live @param {any} kit @param {Map<string, string>} [known]
 * @returns {{ title: string | null, text: string } | null}
 */
export function gateRefusal(block, live, kit, known = new Map()) {
  const call = kit.toolCallState(block);
  const text = refusalOf(call.result);
  if (!text) return null;
  const deliverableId = String(call.args?.deliverableId ?? '');
  const title = deliverableId ? String(liveDeliverable(live, deliverableId)?.title || known.get(deliverableId) || '') : '';
  return { title: title || null, text };
}

/**
 * 「查看」: the kernel's own view of a child, reached through the parent's
 * catalogue — the only address `sessions.openSubagent` accepts, and only with
 * the exact mode the catalogue lists. Disabled until the catalogue lists the
 * child; the catalogue is asked for once when it does not.
 *
 * @param {any} ctx @param {any} kit @param {any} target
 * @returns {(props: { childSessionId: string, title?: string }) => any}
 */
export function childLinkFor(ctx, kit, target) {
  const h = kit.h;
  const React = kit.react;
  const { button } = frameStyles();
  /** @param {{ childSessionId: string, title?: string }} props */
  return function ChildLink({ childSessionId, title }) {
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
      'aria-label': title ? `查看「${title}」` : undefined,
      style: { ...button, marginLeft: 'auto', opacity: entry ? 1 : 0.5, cursor: entry ? 'pointer' : 'default' },
    }, '查看');
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
  const tools = (kit.vocabulary && kit.vocabulary.tools) || {};
  // Deliverable titles the plan calls on this page carried: the fallback
  // name for a row whose call names only an id and whose run state has not
  // arrived.
  /** @type {Map<string, string>} */
  const known = new Map();

  const { card, line, title, tone, tag } = frameStyles();

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

  /** @param {{ title?: string | null, text: string }} props */
  const RefusalRow = ({ title: name, text }) => h('div', { style: { ...line, color: tone('warn') }, 'data-evimed-toolview': 'refused' },
    h('span', { style: { minWidth: 0 } }, name ? `${name} · ${text}` : text));

  const ChildLink = childLinkFor(ctx, kit, target);

  /** @param {{ block: any }} props */
  function PlanView({ block }) {
    const live = useLive();
    const model = modelOf('plan', () => planView(block, live, kit, known));
    if (!model) return h(PlainRow, { label: '研究计划' });
    if (model.kind === 'status') return null;
    if (model.kind === 'refused') return h(RefusalRow, { text: model.text });
    for (const item of model.deliverables) if (item.title && item.title !== item.id) known.set(item.id, item.title);
    // A plan that names nothing to hand back has nothing to show once written.
    if (!model.deliverables.length && model.kind !== 'writing') return null;
    return h('div', { style: card, 'data-evimed-toolview': 'plan' },
      h('div', { style: { ...title, color: 'var(--dsw-alias-label-secondary)' } }, model.kind === 'writing' ? '正在写研究计划…' : '研究计划'),
      model.deliverables.length ? h('ul', { style: { margin: '4px 0 0', padding: 0, listStyle: 'none' } },
        model.deliverables.map((/** @type {any} */ item) => h('li', { key: item.id, style: { ...line, minHeight: '28px' }, 'data-deliverable': item.id },
          h('span', { style: { ...title, flex: '1 1 auto' } }, item.title),
          item.status ? h('span', { style: tag }, item.status) : null))) : null);
  }

  /** @param {{ block: any }} props */
  function DelegateView({ block }) {
    const live = useLive();
    const model = modelOf('delegate', () => delegateView(block, live, kit, known));
    if (!model) return h(PlainRow, { label: '子任务' });
    if (model.state === 'refused') return h(RefusalRow, { title: model.title, text: model.stateText });
    return h('div', { style: { ...card, ...line }, 'data-evimed-toolview': 'delegate', 'data-state': model.state },
      h('span', { style: { ...title, flex: '0 1 auto' } }, model.title),
      h('span', { style: tag }, model.stateText),
      model.childSessionId ? h(ChildLink, { childSessionId: model.childSessionId, title: model.title }) : null);
  }

  /** @param {{ block: any }} props */
  function GateRefusalRow({ block }) {
    const live = useLive();
    const model = modelOf('gate', () => gateRefusal(block, live, kit, known));
    return model ? h(RefusalRow, model) : null;
  }

  /**
   * A gate call: nothing, read off the call alone — only a refused one follows
   * the run state, for the title of the piece it names.
   * @param {{ block: any }} props
   */
  function GateView({ block }) {
    const refused = modelOf('gate', () => refusalOf(kit.toolCallState(block).result));
    return refused ? h(GateRefusalRow, { block }) : null;
  }

  const views = [
    [tools.plan, PlanView],
    [tools.delegate, DelegateView],
    [tools.await, GateView],
    [tools.submit, GateView],
    [tools.packageCheck, GateView],
    [tools.claimUpsert, GateView],
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
  parts: Object.freeze([frameStyles, toolviewText, refusalOf, liveRunFor, liveDeliverable, liveChild, planView, delegateView, gateRefusal, childLinkFor, apply]),
});
