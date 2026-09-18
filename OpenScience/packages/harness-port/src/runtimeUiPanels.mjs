/**
 * The right column as the run's workbench: 进展 (how far each piece of work
 * is), 交付物 (what it produced, opened in the shell's reader), 依据 (whether
 * each claim of the report checks out against its preserved source) and 来源
 * (what the report stands on).
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client
 * (`dsh-client-ui-sidebar-right`):
 *
 *  - A tab type registers in two stages: `ctx.sidebarRightTabs.register(…)`
 *    says what the type is (id, kind, title, guide entry), and a keyed
 *    `sidebar.right.pane.tab` entry under the definition's `id` draws its body.
 *    `priority: 'extension'` is the band for a type from outside the product.
 *    A page type (no address patterns) is opened by kind.
 *  - `ctx.sidebarRight.openTab(kind)` acts through the mounted seat and throws
 *    when no seat is mounted, so an automatic open is attempted, and retried
 *    on the next change, rather than assumed.
 *  - The hosted composition mounts no other tab type: the file tree and the
 *    document preview read the workspace unrestricted and stay disabled. What
 *    a tab here opens, it opens in the shell (`open-artifact`), whose reader
 *    goes through the control plane's own file boundary.
 *
 * Everything drawn comes from the shell: the bound run's state (C9 `run-state`,
 * with the run's delivered files) and the claims and sources read from its
 * evidence matrix (`evidence`). The frame reads no file itself.
 *
 * Opening on its own is kept to two moments a reader would want it: 进展 when
 * the run on screen is working through delegated pieces, 交付物 when a report
 * or matrix appears while the reader is watching — once per run each, and not
 * on every visit to a finished task.
 *
 * @module @evimed/harness-port/runtime-ui-panels
 */

import { frameStyles } from './runtimeUiStyles.mjs';
import { childLinkFor, liveRunFor, toolviewText, verdictText } from './runtimeUiToolviews.mjs';

/** Services this body needs outright: the slot registry and the sessions (for the child link). */
export const inject = ['slots', 'sessions'];

/**
 * The four tab types, in guide order.
 * @returns {{ id: string, title: string, description: string }[]}
 */
export function panelTabs() {
  return [
    { id: 'evimed-progress', title: '进展', description: '每件交付物做到哪一步、用了多久' },
    { id: 'evimed-deliverables', title: '交付物', description: '报告、证据矩阵与修订说明' },
    { id: 'evimed-evidence', title: '依据', description: '每条主张的引文是否在原文中核对过' },
    { id: 'evimed-sources', title: '来源', description: '本次纳入的文献、指南与说明书' },
  ];
}

/**
 * A run's state in the words of the runs page.
 * @param {any} live
 * @returns {{ text: string, tone: string }}
 */
export function runStateText(live) {
  const state = String(live?.state ?? '');
  if (state === 'running') return { text: '运行中', tone: 'active' };
  if (state === 'succeeded') return live?.verification === 'unverified' ? { text: '已交付 · 未核验', tone: 'warn' } : { text: '已完成', tone: 'ok' };
  if (state === 'failed') return { text: '未完成', tone: 'warn' };
  if (state === 'canceled' || state === 'cancelled') return { text: '已取消', tone: 'muted' };
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
  if (/matrix.*\.json$/.test(name)) return { kind: 'matrix', label: '证据矩阵' };
  if (/revision-notes?\.md$/.test(name)) return { kind: 'notes', label: '修订说明' };
  if (/report.*\.(md|docx|pdf|html)$/.test(name)) return { kind: 'report', label: '报告' };
  if (/\.(md|docx|pdf|html)$/.test(name)) return { kind: 'document', label: '文档' };
  return { kind: 'file', label: '文件' };
}

/**
 * The 进展 tab: the run, its phases, its counts and each deliverable.
 * @param {any} live @param {number} now @param {any} kit
 */
export function progressModel(live, now, kit) {
  if (!live) return null;
  const progress = live.progress && typeof live.progress === 'object' ? live.progress : {};
  const vocabulary = kit.vocabulary || {};
  const phaseLabels = vocabulary.phaseLabels || {};
  const counts = progress.phaseCounts && typeof progress.phaseCounts === 'object' ? progress.phaseCounts : {};
  const phases = (Array.isArray(vocabulary.phases) ? vocabulary.phases : []).map((/** @type {string} */ key) => ({
    key,
    label: phaseLabels[key] ?? key,
    count: Number.isFinite(counts[key]) ? Number(counts[key]) : 0,
    current: progress.currentPhase === key,
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
      ? `检索 ${Number(sources.searched) || 0} 篇 · 纳入 ${Number(sources.included) || 0} 篇 · 全文 ${Number(sources.fullText) || 0} 篇` : null,
    claims: claims && Number.isFinite(claims.total) && claims.total > 0
      ? `主张 ${claims.total} 条 · 已核对 ${Number(claims.verified) || 0} 条` : null,
    deliverables,
  };
}

/**
 * The 交付物 tab: the run's files, grouped by the deliverable that wrote them.
 * A file the gate accepted and one it did not are both the run's output; the
 * second says so.
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
 * The 依据 tab: each claim of the report and what the control plane found when
 * it looked its quotation up in the source it names.
 * @param {any} evidence the shell's last `evidence`
 * @param {any} live
 */
export function evidenceModel(evidence, live) {
  if (!evidence || !Array.isArray(evidence.claims) || (live && evidence.runId && evidence.runId !== live.runId)) return null;
  // The words are the shell's own for the same statuses (`CLAIM_STATUS_TEXT`),
  // shortened for a narrow column.
  const marks = {
    verified: { mark: '✓', tone: 'ok', statusText: '引文已在保存的原文中核对' },
    quote_not_found: { mark: '⚠', tone: 'warn', statusText: '引文未在保存的原文中找到' },
    source_unavailable: { mark: '⚠', tone: 'warn', statusText: '来源原文没有保存，无法核对' },
    no_quote: { mark: '⚠', tone: 'warn', statusText: '没有给出可核对的引文' },
    derived: { mark: '·', tone: 'muted', statusText: '推导结果，本身没有引文' },
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
    summary: claims.length ? `${claims.length} 条主张：✓ ${verified} 条已核对${attention ? `，⚠ ${attention} 条需核对` : ''}` : null,
    attention,
    claims,
  };
}

/**
 * The 来源 tab: the run's counts, and the sources the report's claims cite.
 * @param {any} evidence @param {any} live @param {any} kit
 */
export function sourcesModel(evidence, live, kit) {
  const counts = live?.progress?.sources;
  const labels = (kit.vocabulary && kit.vocabulary.sourceTypeLabels) || {};
  const list = evidence && Array.isArray(evidence.sources) && !(live && evidence.runId && evidence.runId !== live.runId) ? evidence.sources : [];
  return {
    counts: counts && Number.isFinite(counts.included)
      ? `检索 ${Number(counts.searched) || 0} 篇 · 纳入 ${Number(counts.included) || 0} 篇 · 获取全文 ${Number(counts.fullText) || 0} 篇` : null,
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
  const pane = { ...secondary, padding: '12px 16px 24px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-secondary)' };

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

  function ProgressTab() {
    const live = useLive();
    const [now, setNow] = React.useState(() => Date.now());
    const running = live?.state === 'running';
    React.useEffect(() => {
      if (!running || typeof target.setInterval !== 'function') return undefined;
      const timer = target.setInterval(() => setNow(Date.now()), 1000);
      return () => target.clearInterval(timer);
    }, [running]);
    const model = kit.guarded('progress tab', () => progressModel(live, now, kit));
    if (!model) return h(Empty, { text: '这个任务还没有关联的研究运行。提交研究问题后，这里会显示每件交付物的进展。' });
    return h('div', { style: pane, 'data-evimed-tab': 'progress' },
      h('div', { style: line },
        model.title ? h('span', { style: { ...title, flex: '1 1 auto', whiteSpace: 'normal' } }, model.title) : null,
        h('span', { style: { ...pill(model.state.tone), marginLeft: 'auto' } }, model.state.text)),
      h('div', { style: quiet }, [model.elapsed ? `用时 ${model.elapsed}` : null, model.cost].filter(Boolean).join(' · ')),
      model.phases.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', margin: '10px 0 0' } },
        model.phases.map((/** @type {any} */ phase) => h('span', {
          key: phase.key, 'data-phase': phase.key, 'data-current': phase.current || undefined,
          style: { color: phase.current ? 'var(--dsw-alias-state-business-primary)' : phase.count ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)', fontWeight: phase.current ? 600 : 400 },
        }, `${phase.label} ${phase.count}`))) : null,
      model.sources || model.claims ? h('div', { style: { ...quiet, whiteSpace: 'normal', marginTop: '4px' } }, [model.sources, model.claims].filter(Boolean).join(' · ')) : null,
      h('div', { style: section }, `交付物 · ${model.deliverables.length} 件`),
      model.deliverables.length
        ? model.deliverables.map((/** @type {any} */ item) => h('div', { key: item.id, style: card, 'data-deliverable': item.id },
          h('div', { style: line },
            h('span', { style: { ...title, flex: '1 1 auto', whiteSpace: 'normal' } }, item.title),
            item.status ? h('span', { style: pill(item.tone) }, item.status) : null),
          h('div', { style: { ...line, marginTop: '2px' } },
            h('span', { style: quiet }, [item.capability, item.childState ? `子任务${item.childState}` : null, item.attempts ? `第 ${item.attempts} 次提交` : null].filter(Boolean).join(' · ')),
            item.verdict ? h('span', { style: pill(item.verdict.tone) }, item.verdict.text) : null,
            item.childSessionId ? h(ChildLink, { childSessionId: item.childSessionId }) : null)))
        : h('div', { style: quiet }, '计划写好后，交付物会列在这里。'));
  }

  function DeliverablesTab() {
    const live = useLive();
    const model = kit.guarded('deliverables tab', () => artifactModel(live));
    if (!model || !model.groups.length) return h(Empty, { text: '还没有交付物。报告和证据矩阵写成后会出现在这里。' });
    return h('div', { style: pane, 'data-evimed-tab': 'deliverables' },
      model.groups.map((/** @type {any} */ group) => h('div', { key: group.deliverableId ?? '', style: { marginBottom: '8px' } },
        h('div', { style: section }, group.title),
        group.files.map((/** @type {any} */ file) => h('div', { key: file.path, style: card, 'data-artifact': file.path },
          h('div', { style: line },
            h('span', { style: { ...pill(file.kind === 'report' ? 'active' : 'muted'), fontWeight: 500 } }, file.label),
            h('span', { style: { ...quiet, color: 'var(--dsw-alias-label-secondary)', flex: '1 1 auto' }, title: file.path }, file.name),
            file.verified ? null : h('span', { style: pill('warn'), title: '这件文件没有通过交付核验，内容照常保留' }, '未核验'),
            h('button', { type: 'button', style: button, onClick: () => openArtifact(model.runId, file.path) }, '打开')))))));
  }

  function EvidenceTab() {
    const live = useLive();
    const evidence = useEvidence();
    const [onlyAttention, setOnlyAttention] = React.useState(false);
    const model = kit.guarded('evidence tab', () => evidenceModel(evidence, live));
    if (!model || !model.claims.length) return h(Empty, { text: '报告写成后，这里逐条列出每条主张的引文是否在保存的原文中核对过。' });
    const shown = onlyAttention ? model.claims.filter((/** @type {any} */ claim) => claim.tone === 'warn') : model.claims;
    return h('div', { style: pane, 'data-evimed-tab': 'evidence' },
      h('div', { style: line },
        h('span', { style: { ...title, flex: '1 1 auto', whiteSpace: 'normal' } }, model.summary),
        model.attention ? h('button', { type: 'button', style: button, 'aria-pressed': onlyAttention, onClick: () => setOnlyAttention(!onlyAttention) }, onlyAttention ? '显示全部' : '只看需核对') : null),
      shown.map((/** @type {any} */ claim) => h('button', {
        key: claim.claimId, type: 'button', 'data-claim': claim.claimId, title: claim.text,
        onClick: () => { if (model.runId && model.reportPath) openArtifact(model.runId, model.reportPath, claim.claimId); },
        style: { ...card, display: 'block', width: '100%', textAlign: 'left', cursor: model.reportPath ? 'pointer' : 'default', font: 'inherit' },
      },
      h('div', { style: line },
        h('span', { style: pill(claim.tone), 'aria-label': claim.statusText }, claim.mark),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', minWidth: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, claim.text)),
      h('div', { style: { ...quiet, paddingLeft: '20px' } }, [claim.source, claim.tone !== 'ok' ? claim.statusText : null].filter(Boolean).join(' · ') || claim.claimId))));
  }

  function SourcesTab() {
    const live = useLive();
    const evidence = useEvidence();
    const model = kit.guarded('sources tab', () => sourcesModel(evidence, live, kit));
    if (!model || (!model.counts && !model.sources.length)) return h(Empty, { text: '检索开始后，这里显示纳入的文献、指南与说明书。' });
    return h('div', { style: pane, 'data-evimed-tab': 'sources' },
      model.counts ? h('div', { style: { ...title, whiteSpace: 'normal' } }, model.counts) : null,
      model.sources.length
        ? h('div', null,
          h('div', { style: section }, `报告引用的来源 · ${model.sources.length} 项`),
          model.sources.map((/** @type {any} */ source, /** @type {number} */ index) => h('div', { key: `${source.title}:${index}`, style: card },
            h('div', { style: line },
              source.type ? h('span', { style: pill('active') }, source.type) : null,
              source.url
                ? h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--dsw-alias-link)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, source.title)
                : h('span', { style: { color: 'var(--dsw-alias-label-primary)', minWidth: 0 } }, source.title)),
            h('div', { style: quiet }, [source.identifier, source.claims ? `支撑 ${source.claims} 条主张` : null].filter(Boolean).join(' · ')))))
        : h('div', { style: { ...quiet, whiteSpace: 'normal', marginTop: '8px' } }, '报告写成后，这里列出它引用的每一个来源。'));
  }

  const bodies = { 'evimed-progress': ProgressTab, 'evimed-deliverables': DeliverablesTab, 'evimed-evidence': EvidenceTab, 'evimed-sources': SourcesTab };
  for (const tab of tabs) {
    kit.guarded(`${tab.id} body`, () => kit.occupy({ slot: 'sidebar.right.pane.tab', key: tab.id }, /** @type {Record<string, any>} */ (bodies)[tab.id]));
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

  kit.withServices(['sidebarRight'], (/** @type {any} */ scope) => {
    /** @type {Set<string>} */
    const opened = new Set();
    /** @type {Set<string>} */
    const watchedWithout = new Set();
    /** @param {string} runId @param {string} kind */
    const open = (runId, kind) => {
      const key = `${runId}:${kind}`;
      if (opened.has(key)) return;
      try { scope.sidebarRight.openTab(kind); opened.add(key); } catch { /* no seat mounted yet; the next change tries again */ }
    };
    const check = () => {
      const state = kit.hub.getState();
      const live = liveRunFor(state.runState, state.session);
      if (!live || !live.runId) return;
      const runId = String(live.runId);
      const progress = live.progress && typeof live.progress === 'object' ? live.progress : {};
      const delegated = (Array.isArray(progress.children) && progress.children.length > 0)
        || (Array.isArray(progress.deliverables) && progress.deliverables.some((/** @type {any} */ item) => item && ['delegated', 'submitted', 'rejected'].includes(item.status)));
      if (live.state === 'running' && delegated) open(runId, 'evimed-progress');
      const produced = Boolean(artifactModel(live)?.produced);
      if (!produced) watchedWithout.add(runId);
      else if (watchedWithout.has(runId)) open(runId, 'evimed-deliverables');
    };
    scope.effect(() => kit.hub.subscribe(check), 'evimed-panels: automatic open');
    check();
  });
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({
  name: 'panels',
  inject,
  parts: Object.freeze([frameStyles, toolviewText, verdictText, liveRunFor, childLinkFor, panelTabs, runStateText, artifactKind, progressModel, artifactModel, evidenceModel, sourcesModel, apply]),
});
