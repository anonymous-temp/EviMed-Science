/**
 * Two surfaces the kernel already has seats for, and one job each:
 *
 *  - **运行**, an entry in the conversation's own view ring
 *    (`conversation.view`), beside 对话: what this research run is made of —
 *    how far it is, what it produced, whether each conclusion checked out
 *    against its source, and what it stands on.
 *  - **文件**, the right column's single tab: the files this conversation
 *    produced, opened in the product's reader.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client:
 *
 *  - `conversation.view` is a list slot whose entries ARE the tab strip in the
 *    session header (`viewTabs()` in `ui-conversation`'s client reads
 *    `options.id` and `options.label` off each entry, label falling back to the
 *    id). `ui-chat` holds `chat` at order 0 and stays the default, so an entry
 *    of ours adds a tab rather than taking one. Only the selected view renders.
 *  - The right column's default page depends on the number of registered GUIDE
 *    entries, not on tab types: exactly one opens that page directly, while
 *    zero or several open the guide — whose title is 「开始」 and whose body is
 *    a compass with one capsule per entry. Four entries are why every session
 *    opened onto a launcher that launched nothing, and why 「+ 新标签页」 read
 *    as a way to start work while a sub-task was running. One entry, and the
 *    panel is the file list.
 *  - `ctx.sidebarRight.openTab(kind)` acts through the mounted seat and throws
 *    when none is mounted, so an automatic open is attempted and retried on the
 *    next change rather than assumed.
 *
 * Everything drawn comes from the shell: the bound run's state (C9 `run-state`,
 * with the run's delivered files) and the claims and sources read from its
 * evidence matrix (`evidence`). The frame reads no file itself; opening one is
 * a message to the shell, whose reader goes through the control plane's own
 * file boundary.
 *
 * @module @evimed/harness-port/runtime-ui-panels
 */

import { frameStyles } from './runtimeUiStyles.mjs';
import { childLinkFor, liveRunFor, toolviewText, verdictText } from './runtimeUiToolviews.mjs';

/** Services this body needs outright: the slot registry and the sessions (for the child link). */
export const inject = ['slots', 'sessions'];

/**
 * The right column's tab types. One, deliberately: a second guide entry turns
 * the column's default page into the kernel's empty compass.
 * @returns {{ id: string, title: string, description: string }[]}
 */
export function panelTabs() {
  return [
    { id: 'evimed-files', title: '文件', description: '这次对话产出的报告、证据矩阵与附件' },
  ];
}

/** The view-ring entry this body adds, beside the kernel's own 对话. */
export function runViewTab() {
  return { id: 'evimed-run', label: '运行', order: 5 };
}

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
  if (/report.*\.(md|docx|pdf|html)$/.test(name)) return { kind: 'report', label: '报告' };
  if (/\.(md|docx|pdf|html)$/.test(name)) return { kind: 'document', label: '文档' };
  return { kind: 'file', label: '文件' };
}

/**
 * The run, its phases, its counts and each piece of work.
 *
 * The phase reads as the furthest one reached rather than the latest labelled
 * call, and a phase nothing happened in is left out: a delivered run used to
 * read 「核验」 because a verification call happened to be last, and 「筛选」 read
 * 0 on every run because two tools carry it.
 *
 * @param {any} live @param {number} now @param {any} kit
 */
export function progressModel(live, now, kit) {
  if (!live) return null;
  const progress = live.progress && typeof live.progress === 'object' ? live.progress : {};
  const vocabulary = kit.vocabulary || {};
  const phaseLabels = vocabulary.phaseLabels || {};
  const counts = progress.phaseCounts && typeof progress.phaseCounts === 'object' ? progress.phaseCounts : {};
  const order = Array.isArray(vocabulary.phases) ? vocabulary.phases : [];
  const reached = order.filter((/** @type {string} */ key) => Number(counts[key]) > 0);
  const furthest = reached.length ? reached[reached.length - 1] : null;
  const phases = reached.map((/** @type {string} */ key) => ({
    key,
    label: phaseLabels[key] ?? key,
    count: Number(counts[key]) || 0,
    current: key === furthest && live.state === 'running',
  }));
  const started = typeof progress.startedAt === 'string' ? Date.parse(progress.startedAt) : NaN;
  const running = live.state === 'running';
  const ended = running ? now : (typeof progress.updatedAt === 'string' ? Date.parse(progress.updatedAt) : NaN);
  const elapsed = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? kit.formatDuration(ended - started) : null;
  const usage = progress.usage && typeof progress.usage === 'object' ? progress.usage : live.usage;
  const cost = usage && Number.isFinite(usage.costCny) && usage.costCny > 0 ? `约 ¥${Number(usage.costCny).toFixed(2)}` : null;
  const sources = progress.sources && typeof progress.sources === 'object' ? progress.sources : null;
  const claims = progress.claims && typeof progress.claims === 'object' ? progress.claims : null;
  const statusWords = toolviewText().status;
  const childWords = toolviewText().childState;
  const children = Array.isArray(progress.children) ? progress.children : [];
  const deliverables = (Array.isArray(progress.deliverables) ? progress.deliverables : [])
    .filter((/** @type {any} */ item) => item && item.id)
    .map((/** @type {any} */ item) => {
      const child = children.filter((/** @type {any} */ entry) => entry && entry.deliverableId === item.id).at(-1)
        ?? (item.childSessionId ? children.find((/** @type {any} */ entry) => entry && entry.childSessionId === item.childSessionId) : null);
      const status = String(item.status ?? '');
      return {
        id: String(item.id),
        title: String(item.title || item.id),
        capability: kit.capabilityTitle(item.capability) ?? null,
        status: statusWords[status] ?? null,
        tone: ['accepted', 'delivered'].includes(status) ? 'ok' : ['rejected', 'failed'].includes(status) ? 'warn' : status === 'planned' ? 'muted' : 'active',
        attempts: Number(item.attempts) || 0,
        verdict: item.lastVerdict ? verdictText({ verdict: item.lastVerdict, mustFix: item.mustFixCount }) : null,
        childSessionId: typeof (child?.childSessionId ?? item.childSessionId) === 'string' ? (child?.childSessionId ?? item.childSessionId) : null,
        childState: child && childWords[child.state] ? childWords[child.state] : null,
      };
    });
  return {
    title: typeof live.title === 'string' && live.title.trim() ? live.title.trim() : null,
    state: runStateText(live),
    elapsed,
    cost,
    phases,
    sources: sources && Number.isFinite(sources.included)
      // `searched` counts search calls, not records found: 「次」, never 「篇」.
      ? `检索 ${Number(sources.searched) || 0} 次 · 纳入 ${Number(sources.included) || 0} 篇 · 全文 ${Number(sources.fullText) || 0} 篇` : null,
    claims: claims && Number.isFinite(claims.total) && claims.total > 0
      ? `结论 ${claims.total} 条 · 已核对 ${Number(claims.verified) || 0} 条` : null,
    deliverables,
  };
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
 * The sources the report's conclusions cite.
 * @param {any} evidence @param {any} live @param {any} kit
 */
export function sourcesModel(evidence, live, kit) {
  const labels = (kit.vocabulary && kit.vocabulary.sourceTypeLabels) || {};
  const list = evidence && Array.isArray(evidence.sources) && !(live && evidence.runId && evidence.runId !== live.runId) ? evidence.sources : [];
  return {
    sources: list.filter((/** @type {any} */ source) => source && (source.title || source.identifier)).map((/** @type {any} */ source) => ({
      title: String(source.title || source.identifier),
      identifier: typeof source.identifier === 'string' && source.identifier !== source.title ? source.identifier : null,
      url: typeof source.url === 'string' && /^https?:\/\//.test(source.url) ? source.url : null,
      type: typeof source.sourceType === 'string' && labels[source.sourceType] ? labels[source.sourceType] : null,
      claims: Number(source.claims) || 0,
    })),
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
  const { card, line, title, quiet, pill, button, section, empty, secondary } = frameStyles();
  const ChildLink = childLinkFor(ctx, kit, target);
  const tabs = panelTabs();
  const view = runViewTab();
  const pane = { ...secondary, padding: '12px 16px 24px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-secondary)' };
  // The view fills the conversation body, which is wider than the right
  // column; the reading column is held to the transcript's own width so the
  // two tabs do not read as two different pages.
  const viewPane = { ...pane, padding: '16px 24px 48px' };
  const column = { maxWidth: '748px', margin: '0 auto' };

  function useLive() {
    const runState = kit.useFrameState((/** @type {any} */ state) => state.runState);
    const session = kit.useFrameState((/** @type {any} */ state) => state.session);
    return liveRunFor(runState, session);
  }
  function useEvidence() { return kit.useFrameState((/** @type {any} */ state) => state.evidence); }

  /** @param {{ text: string }} props */
  const Empty = ({ text }) => h('div', { style: empty }, text);

  /** @param {string} runId @param {string} path @param {string | null} [anchor] */
  const openArtifact = (runId, path, anchor = null) => {
    kit.hub.send('open-artifact', { runId, path, ...(anchor ? { anchor } : {}) });
  };

  /**
   * The files of a run, as rows. Shared by the view and the right column; the
   * group's own title appears only when there is more than one, because with
   * one piece of work it just repeats the run's title.
   */
  /** @param {{ model: any }} props */
  const FileGroups = ({ model }) => h('div', null, model.groups.map((/** @type {any} */ group) => h('div', { key: group.deliverableId ?? '', style: { marginBottom: '8px' } },
    model.groups.length > 1 ? h('div', { style: section }, group.title) : null,
    group.files.map((/** @type {any} */ file) => h('div', { key: file.path, style: card, 'data-artifact': file.path },
      h('div', { style: line },
        h('span', { style: { ...pill(file.kind === 'report' ? 'active' : 'muted'), fontWeight: 500 } }, file.label),
        h('span', { style: { ...quiet, color: 'var(--dsw-alias-label-secondary)', flex: '1 1 auto' }, title: file.path }, file.name),
        file.verified ? null : h('span', { style: pill('warn'), title: '这件文件没有通过交付核对，内容照常保留' }, '未核对'),
        h('button', { type: 'button', style: button, onClick: () => openArtifact(model.runId, file.path) }, '打开')))))));

  /**
   * The 运行 view: everything about this conversation's research run, in the
   * order a reader asks for it — how it is going, what it is producing,
   * whether the conclusions check out, and what they stand on.
   */
  function RunView() {
    const live = useLive();
    const evidence = useEvidence();
    const [now, setNow] = React.useState(() => Date.now());
    const [onlyAttention, setOnlyAttention] = React.useState(false);
    const running = live?.state === 'running';
    React.useEffect(() => {
      if (!running || typeof target.setInterval !== 'function') return undefined;
      const timer = target.setInterval(() => setNow(Date.now()), 1000);
      return () => target.clearInterval(timer);
    }, [running]);
    const model = kit.guarded('run view', () => progressModel(live, now, kit));
    if (!model) {
      return h('div', { style: viewPane, 'data-evimed-view': 'run' },
        h('div', { style: column }, h(Empty, { text: '这次对话还没有研究任务。提出一个研究问题，这里会显示它的进展、产出和核对结果。' })));
    }
    const claims = kit.guarded('run view claims', () => evidenceModel(evidence, live));
    const sources = kit.guarded('run view sources', () => sourcesModel(evidence, live, kit));
    const files = kit.guarded('run view files', () => artifactModel(live));
    const shownClaims = claims && onlyAttention ? claims.claims.filter((/** @type {any} */ claim) => claim.tone === 'warn') : claims?.claims ?? [];
    return h('div', { style: viewPane, 'data-evimed-view': 'run' }, h('div', { style: column },
      h('div', { style: line },
        model.title ? h('span', { style: { ...title, flex: '1 1 auto', whiteSpace: 'normal' } }, model.title) : null,
        h('span', { style: { ...pill(model.state.tone), marginLeft: 'auto' } }, model.state.text)),
      h('div', { style: quiet }, [model.elapsed ? `用时 ${model.elapsed}` : null, model.cost].filter(Boolean).join(' · ')),
      model.phases.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', margin: '10px 0 0' } },
        model.phases.map((/** @type {any} */ phase) => h('span', {
          key: phase.key, 'data-phase': phase.key, 'data-current': phase.current || undefined,
          style: { color: phase.current ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)', fontWeight: phase.current ? 600 : 400 },
        }, `${phase.label} ${phase.count}`))) : null,
      model.sources || model.claims ? h('div', { style: { ...quiet, whiteSpace: 'normal', marginTop: '4px' } }, [model.sources, model.claims].filter(Boolean).join(' · ')) : null,

      h('div', { style: section }, `这次要交付的 · ${model.deliverables.length} 件`),
      model.deliverables.length
        ? model.deliverables.map((/** @type {any} */ item) => h('div', { key: item.id, style: card, 'data-deliverable': item.id },
          h('div', { style: line },
            h('span', { style: { ...title, flex: '1 1 auto', whiteSpace: 'normal' } }, item.title),
            item.status ? h('span', { style: pill(item.tone) }, item.status) : null),
          h('div', { style: { ...line, marginTop: '2px' } },
            h('span', { style: quiet }, [item.capability, item.childState ? `子任务${item.childState}` : null, item.attempts ? `第 ${item.attempts} 次提交` : null].filter(Boolean).join(' · ')),
            item.verdict ? h('span', { style: pill(item.verdict.tone) }, item.verdict.text) : null,
            item.childSessionId ? h(ChildLink, { childSessionId: item.childSessionId }) : null)))
        : h('div', { style: quiet }, '计划写好后，要交付的东西会列在这里。'),

      claims && claims.claims.length ? h('div', null,
        h('div', { style: { ...section, display: 'flex', alignItems: 'baseline', gap: '8px' } },
          h('span', { style: { flex: '1 1 auto' } }, claims.summary),
          claims.attention ? h('button', { type: 'button', style: { ...button, marginLeft: 0 }, 'aria-pressed': onlyAttention, onClick: () => setOnlyAttention(!onlyAttention) }, onlyAttention ? '显示全部' : '只看待核对') : null),
        shownClaims.map((/** @type {any} */ claim) => h('button', {
          key: claim.claimId, type: 'button', 'data-claim': claim.claimId, title: claim.text,
          onClick: () => { if (claims.runId && claims.reportPath) openArtifact(claims.runId, claims.reportPath, claim.claimId); },
          style: { ...card, display: 'block', width: '100%', textAlign: 'left', cursor: claims.reportPath ? 'pointer' : 'default', font: 'inherit' },
        },
        h('div', { style: line },
          h('span', { style: pill(claim.tone), 'aria-label': claim.statusText }, claim.mark),
          h('span', { style: { color: 'var(--dsw-alias-label-primary)', minWidth: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, claim.text)),
        h('div', { style: { ...quiet, paddingLeft: '20px' } }, [claim.source, claim.tone !== 'ok' ? claim.statusText : null].filter(Boolean).join(' · ') || claim.claimId)))) : null,

      files && files.groups.length ? h('div', null, h('div', { style: section }, '产出的文件'), h(FileGroups, { model: files })) : null,

      sources && sources.sources.length ? h('div', null,
        h('div', { style: section }, `报告引用的来源 · ${sources.sources.length} 项`),
        sources.sources.map((/** @type {any} */ source, /** @type {number} */ index) => h('div', { key: `${source.title}:${index}`, style: card },
          h('div', { style: line },
            source.type ? h('span', { style: pill('active') }, source.type) : null,
            source.url
              ? h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--dsw-alias-link)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, source.title)
              : h('span', { style: { color: 'var(--dsw-alias-label-primary)', minWidth: 0 } }, source.title)),
          h('div', { style: quiet }, [source.identifier, source.claims ? `支撑 ${source.claims} 条结论` : null].filter(Boolean).join(' · '))))) : null));
  }

  /** The right column: this conversation's files, and nothing else. */
  function FilesTab() {
    const live = useLive();
    const model = kit.guarded('files tab', () => artifactModel(live));
    if (!model || !model.groups.length) return h(Empty, { text: '还没有产出文件。报告和证据表写成后会出现在这里。' });
    return h('div', { style: pane, 'data-evimed-tab': 'files' }, h(FileGroups, { model }));
  }

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
    return h('div', { style: { ...card, margin: '0 0 6px' }, 'data-evimed-delivery': model.runId },
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

  kit.guarded('run view', () => kit.occupy({ slot: 'conversation.view', id: view.id, order: view.order, label: () => view.label }, RunView));
  for (const tab of tabs) {
    kit.guarded(`${tab.id} body`, () => kit.occupy({ slot: 'sidebar.right.pane.tab', key: tab.id }, FilesTab));
  }

  kit.withServices(['sidebarRightTabs'], (/** @type {any} */ scope) => {
    tabs.forEach((tab, index) => {
      scope.effect(() => scope.sidebarRightTabs.register({
        id: tab.id,
        kind: tab.id,
        priority: 'extension',
        title: () => tab.title,
        guide: [{ order: 10 + index, title: () => tab.title, description: () => tab.description }],
      }), `evimed-panels: ${tab.id} type`);
    });
  });

  // The column opens itself once per run, when that run first produces a file
  // while the reader is watching — never on a visit to a finished task, and
  // never onto an empty list.
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
      try { scope.sidebarRight.openTab(tabs[0].id); opened.add(runId); } catch { /* no seat mounted yet; the next change tries again */ }
    };
    scope.effect(() => kit.hub.subscribe(check), 'evimed-panels: automatic open');
    check();
  });
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'panels',
  inject,
  parts: Object.freeze([frameStyles, toolviewText, verdictText, liveRunFor, childLinkFor, panelTabs, runViewTab, runStateText, artifactKind, progressModel, artifactModel, evidenceModel, sourcesModel, deliveryModel, apply]),
});
