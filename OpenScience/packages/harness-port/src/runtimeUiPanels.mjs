/**
 * What a finished research run hands back, said in the conversation: the
 * delivery card above the composer, and the right column opening on the
 * kernel's own file tree the first time a run writes a report.
 *
 * Until 2026-09-22 this body also drew a 运行 view of its own in the
 * conversation's view ring and a 文件 tab of its own in the right column. Both
 * went on the owner's ruling that the process view is the kernel's
 * (「运行那部分咋没有用 dsh 那种有图的那种呢」, 「预览也没了」): the kernel's
 * trajectory view — a timing overview over the per-step ledger, with a record
 * inspector — is the 运行 tab now (relabelled by the language pack), and the
 * kernel's file tree with its document previews is the right column. What the
 * product still has to say about a run that the kernel cannot — that it was
 * delivered, how many of its conclusions checked out against their sources,
 * and where the report is — is the card.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client:
 *
 *  - `conversation.input.dock` is a list seat directly above the composer
 *    card, full width. The composer itself is `--dsh-composer-card-max-width`
 *    wide and centred, so an occupant that does not say its own width sits at
 *    the frame's left edge, beside a centred composer (the misaligned chip of
 *    2026-09-22). The kernel's own queue dock holds itself to
 *    `calc(var(--dsh-composer-card-max-width) - 2 * var(--dsh-composer-dock-inset))`
 *    with `margin: 0 auto`; so does this.
 *  - The right column's default page is the one registered guide entry, when
 *    there is exactly one. The kernel's file tree (`ui-sidebar-files`) is that
 *    entry; a second one — the product's own tab used to be it — turns the
 *    default into the kernel's 「开始」 compass.
 *  - `ctx.sidebarRight.openTab(kind)` acts through the mounted seat and throws
 *    when none is mounted, so an automatic open is attempted and retried on the
 *    next change rather than assumed. The kernel's file tree is kind `files`.
 *
 * Everything drawn comes from the shell: the bound run's state (C9 `run-state`,
 * with the run's delivered files) and the claims read from its evidence matrix
 * (`evidence`). Opening the report is a message to the shell, whose reader
 * marks each conclusion ✓/⚠ and goes through the control plane's own file
 * boundary.
 *
 * @module @evimed/harness-port/runtime-ui-panels
 */

import { frameStyles } from './runtimeUiStyles.mjs';
import { liveRunFor, toolviewText, verdictText } from './runtimeUiToolviews.mjs';

/** Services this body needs outright: the slot registry and the sessions. */
export const inject = ['slots', 'sessions'];

/** The kernel's own file-tree tab, which the column opens on a delivered report. */
export const KERNEL_FILES_TAB = 'files';

/**
 * A run's state in the words every surface uses for it.
 * @param {any} live
 * @returns {{ text: string, tone: string }}
 */
export function runStateText(live) {
  const state = String(live?.state ?? '');
  if (state === 'running') return { text: '进行中', tone: 'active' };
  if (state === 'succeeded') return live?.verification === 'unverified' ? { text: '已交付 · 有结论未逐字核对', tone: 'warn' } : { text: '已交付', tone: 'ok' };
  if (state === 'failed') return { text: '未完成', tone: 'warn' };
  if (state === 'canceled' || state === 'cancelled') return { text: '已停止', tone: 'muted' };
  return { text: '等待中', tone: 'muted' };
}

/**
 * What a delivered file is, from its name. The names are the capability
 * contracts' own (`clinical-evidence-report.md`, `clinical-evidence-matrix.json`,
 * `revision-notes.md`); anything else is a file under its own name.
 * @param {string} path
 * @returns {{ kind: 'report' | 'matrix' | 'notes' | 'document' | 'file', label: string }}
 */
export function artifactKind(path) {
  const name = String(path).split('/').pop()?.toLowerCase() ?? '';
  if (/matrix.*\.json$/.test(name)) return { kind: 'matrix', label: '证据表' };
  if (/revision-notes?\.md$/.test(name)) return { kind: 'notes', label: '修订说明' };
  // A deliverable's completed reporting checklist (CONSORT 2025, TRIPOD+AI…:
  // every item and where it is reported). Its name matches `report`, and read
  // as a report it would be the file the delivery card opens as 「报告」 in
  // place of the section it lists. The name is @evimed/domain's
  // REPORTING_CHECKLIST_FILE, written out because this function is shipped
  // into the frame on its own.
  if (name === 'reporting-checklist.md') return { kind: 'document', label: '报告规范清单' };
  if (/report.*\.(md|docx|pdf|html)$/.test(name)) return { kind: 'report', label: '报告' };
  if (/\.(md|docx|pdf|html)$/.test(name)) return { kind: 'document', label: '文档' };
  return { kind: 'file', label: '文件' };
}

/**
 * The run's files, grouped by the piece of work that wrote them. A file the
 * gate accepted and one it did not are both the run's output; the second says
 * so.
 * @param {any} live
 */
export function artifactModel(live) {
  if (!live) return null;
  const titles = new Map((Array.isArray(live.progress?.deliverables) ? live.progress.deliverables : [])
    .filter((/** @type {any} */ item) => item && item.id).map((/** @type {any} */ item) => [String(item.id), String(item.title || item.id)]));
  /** @type {Map<string, { deliverableId: string | null, title: string, files: any[] }>} */
  const groups = new Map();
  const files = [
    ...(Array.isArray(live.artifacts) ? live.artifacts : []).map((/** @type {unknown} */ path) => ({ path, verified: true })),
    ...(Array.isArray(live.unverifiedArtifacts) ? live.unverifiedArtifacts : []).map((/** @type {unknown} */ path) => ({ path, verified: false })),
  ].filter((entry) => typeof entry.path === 'string' && entry.path);
  const seen = new Set();
  for (const entry of files) {
    const path = String(entry.path);
    if (seen.has(path)) continue;
    seen.add(path);
    const owner = /(?:^|\/)deliverables\/([^/]+)\//.exec(path)?.[1] ?? null;
    const key = owner ?? '';
    const group = groups.get(key) ?? { deliverableId: owner, title: owner ? (titles.get(owner) ?? owner) : '其他文件', files: /** @type {any[]} */ ([]) };
    const { kind, label } = artifactKind(path);
    group.files.push({ path, name: path.split('/').pop() ?? path, kind, label, verified: entry.verified });
    groups.set(key, group);
  }
  const order = { report: 0, matrix: 1, notes: 2, document: 3, file: 4 };
  const list = [...groups.values()];
  for (const group of list) group.files.sort((a, b) => order[/** @type {keyof typeof order} */ (a.kind)] - order[/** @type {keyof typeof order} */ (b.kind)] || a.name.localeCompare(b.name));
  return { runId: String(live.runId), groups: list, produced: files.some((entry) => ['report', 'matrix'].includes(artifactKind(String(entry.path)).kind)) };
}

/**
 * Each conclusion of the report and what the control plane found when it
 * looked its quotation up in the source it names.
 * @param {any} evidence the shell's last `evidence`
 * @param {any} live
 */
export function evidenceModel(evidence, live) {
  if (!evidence || !Array.isArray(evidence.claims) || (live && evidence.runId && evidence.runId !== live.runId)) return null;
  const marks = {
    verified: { mark: '✓', tone: 'ok', statusText: '引文已在保存的原文中核对' },
    quote_not_found: { mark: '⚠', tone: 'warn', statusText: '引文未在保存的原文中找到' },
    source_unavailable: { mark: '⚠', tone: 'warn', statusText: '来源原文没有保存，无法核对' },
    no_quote: { mark: '⚠', tone: 'warn', statusText: '没有给出可核对的引文' },
    derived: { mark: '·', tone: 'muted', statusText: '推算结果，本身没有引文' },
  };
  const claims = evidence.claims.filter((/** @type {any} */ claim) => claim && typeof claim.claimId === 'string').map((/** @type {any} */ claim) => {
    const status = /** @type {Record<string, any>} */ (marks)[claim.status] ?? { mark: '?', tone: 'muted', statusText: '尚未核对' };
    return {
      claimId: claim.claimId,
      text: typeof claim.claim === 'string' ? claim.claim : '',
      source: typeof claim.sourceTitle === 'string' ? claim.sourceTitle : null,
      ...status,
    };
  });
  const verified = claims.filter((/** @type {any} */ claim) => claim.tone === 'ok').length;
  const attention = claims.filter((/** @type {any} */ claim) => claim.tone === 'warn').length;
  return {
    runId: typeof evidence.runId === 'string' ? evidence.runId : null,
    reportPath: typeof evidence.reportPath === 'string' ? evidence.reportPath : null,
    summary: claims.length ? `${claims.length} 条结论：✓ ${verified} 条已核对${attention ? `，⚠ ${attention} 条待核对` : ''}` : null,
    attention,
    claims,
  };
}

/**
 * What a finished run hands back, in the six facts a reader acts on.
 *
 * This is the card at the end of the turn that delivered: today a delivered
 * report announced itself only in whatever the model happened to write last,
 * and on 2026-09-20 that was an English aside about frozen bytes — the reader
 * was never told the report existed, let alone that thirteen of its
 * conclusions carried an advisory.
 *
 * @param {any} live @param {any} evidence @param {number} now @param {any} kit
 */
export function deliveryModel(live, evidence, now, kit) {
  const state = String(live?.state ?? '');
  if (!live || !['succeeded', 'failed'].includes(state)) return null;
  const files = artifactModel(live);
  const report = files?.groups.flatMap((/** @type {any} */ group) => group.files).find((/** @type {any} */ file) => file.kind === 'report') ?? null;
  const claims = evidenceModel(evidence, live);
  const progress = live.progress && typeof live.progress === 'object' ? live.progress : {};
  const counted = progress.claims && Number(progress.claims.total) > 0 ? progress.claims : null;
  const total = claims?.claims.length || Number(counted?.total) || 0;
  const verified = claims ? claims.claims.filter((/** @type {any} */ claim) => claim.tone === 'ok').length : Number(counted?.verified) || 0;
  const started = typeof progress.startedAt === 'string' ? Date.parse(progress.startedAt) : NaN;
  const ended = typeof progress.updatedAt === 'string' ? Date.parse(progress.updatedAt) : now;
  const usage = progress.usage && typeof progress.usage === 'object' ? progress.usage : live.usage;
  if (!report && !total) return null;
  return {
    runId: String(live.runId),
    state: runStateText(live),
    title: report ? (typeof live.title === 'string' && live.title.trim() ? live.title.trim() : report.name) : null,
    reportPath: report ? report.path : null,
    fileCount: files ? files.groups.reduce((sum, /** @type {any} */ group) => sum + group.files.length, 0) : 0,
    claims: total ? `结论 ${total} 条，已核对 ${verified} 条${total > verified ? `，${total - verified} 条待核对` : ''}` : null,
    attention: claims ? claims.attention : 0,
    elapsed: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? kit.formatDuration(ended - started) : null,
    cost: usage && Number.isFinite(usage.costCny) && usage.costCny > 0 ? `约 ¥${Number(usage.costCny).toFixed(2)}` : null,
  };
}

/**
 * The width of anything that sits in the composer's column above or below
 * the card: the card's own maximum, less the kernel's dock inset, centred.
 * Read off the kernel's queue dock; an occupant without it lands at the
 * frame's left edge beside a centred composer.
 */
export function composerColumnStyle() {
  return {
    width: '100%',
    maxWidth: 'calc(var(--dsh-composer-card-max-width, 952px) - 2 * var(--dsh-composer-dock-inset, 8px))',
    margin: '0 auto',
    boxSizing: 'border-box',
  };
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} _target Browser global (unused: the card reads nothing off the window).
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, _target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h || !kit.react) return;
  const h = kit.h;
  const React = kit.react;
  const { card, line, title, quiet, pill, button } = frameStyles();
  // `toolviewText` and `verdictText` are what the transcript's tool cards say;
  // the card below reads the run in the same words they do.
  void toolviewText; void verdictText;

  function useLive() {
    const runState = kit.useFrameState((/** @type {any} */ state) => state.runState);
    const session = kit.useFrameState((/** @type {any} */ state) => state.session);
    return liveRunFor(runState, session);
  }
  function useEvidence() { return kit.useFrameState((/** @type {any} */ state) => state.evidence); }

  /** @param {string} runId @param {string} path @param {string | null} [anchor] */
  const openArtifact = (runId, path, anchor = null) => {
    kit.hub.send('open-artifact', { runId, path, ...(anchor ? { anchor } : {}) });
  };

  /**
   * What a finished run hands back, said in the conversation.
   *
   * Above the composer rather than under the turn that delivered: a turn tail
   * exists for every completed turn and nothing in its props says which one the
   * run belongs to, so a card there either repeats itself down the transcript
   * or needs the occupants to agree among themselves which is newest. This seat
   * renders once per session by construction, and it is where the reader's eye
   * already is. It stays until the reader dismisses it or asks the next thing.
   */
  const DeliveryCard = () => {
    const live = useLive();
    const evidence = useEvidence();
    const [dismissed, setDismissed] = React.useState(/** @type {string | null} */ (null));
    const model = kit.guarded('delivery card', () => deliveryModel(live, evidence, Date.now(), kit));
    if (!model || dismissed === model.runId) return null;
    return h('div', { style: { ...card, ...composerColumnStyle(), margin: '0 auto 6px' }, 'data-evimed-delivery': model.runId },
      h('div', { style: line },
        h('span', { style: pill(model.state.tone) }, model.state.text),
        model.title ? h('span', { style: { ...title, flex: '1 1 auto', whiteSpace: 'normal' } }, model.title) : null,
        model.reportPath
          ? h('button', { type: 'button', style: button, onClick: () => openArtifact(model.runId, model.reportPath) }, '打开报告')
          : null,
        h('button', { type: 'button', 'aria-label': '收起这条', style: { ...button, marginLeft: 0 }, onClick: () => setDismissed(model.runId) }, '收起')),
      h('div', { style: { ...quiet, whiteSpace: 'normal', marginTop: '2px' } },
        [model.claims, model.fileCount ? `${model.fileCount} 个文件` : null, model.elapsed ? `用时 ${model.elapsed}` : null, model.cost].filter(Boolean).join(' · ')),
      model.attention
        ? h('div', { style: { ...quiet, whiteSpace: 'normal', color: 'var(--dsw-alias-state-warn-label)' } }, '引用前请在报告里核对带 ⚠ 的结论。')
        : null);
  };
  kit.guarded('delivery card', () => kit.occupy({ slot: 'conversation.input.dock', id: 'evimed-delivery', order: 10 }, DeliveryCard));

  // The column opens itself once per run, on the kernel's file tree, when
  // that run first produces a report while the reader is watching — never on
  // a visit to a finished task, and never onto an empty list.
  kit.withServices(['sidebarRight'], (/** @type {any} */ scope) => {
    /** @type {Set<string>} */
    const opened = new Set();
    /** @type {Set<string>} */
    const watchedWithout = new Set();
    const check = () => {
      const state = kit.hub.getState();
      const live = liveRunFor(state.runState, state.session);
      if (!live || !live.runId) return;
      const runId = String(live.runId);
      const produced = Boolean(artifactModel(live)?.produced);
      if (!produced) { watchedWithout.add(runId); return; }
      if (!watchedWithout.has(runId) || opened.has(runId)) return;
      try { scope.sidebarRight.openTab(KERNEL_FILES_TAB); opened.add(runId); } catch { /* no seat mounted yet; the next change tries again */ }
    };
    scope.effect(() => kit.hub.subscribe(check), 'evimed-panels: automatic open');
    check();
  });
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'panels',
  inject,
  parts: Object.freeze([frameStyles, toolviewText, verdictText, liveRunFor, runStateText, artifactKind, artifactModel, evidenceModel, deliveryModel, composerColumnStyle, apply]),
});
