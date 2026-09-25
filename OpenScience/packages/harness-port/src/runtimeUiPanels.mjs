/**
 * What a finished research run hands back, said in the conversation: its
 * files as cards at the end of the answer that delivered them, and the right
 * column opening on the kernel's own file tree the first time a run writes a
 * report.
 *
 * Until 2026-09-23 this was a card docked above the composer: 已交付 · 结论 N
 * 条，已核对 N 条 · N 个文件 · 用时 · 约 ¥. The owner's ruling (整改方案 §5.3)
 * is that the conversation shows what the reader acts on and none of the
 * machinery: each file, with its name, its type and size, and one way to open
 * it, after the answer — where DSH itself puts delivered files ("between the
 * closing message's body and its action footer") and where Manus ends a task.
 * Cost is on 设置 → 用量; whether a conclusion checked out is the report's own
 * 「依据」 marks.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client:
 *
 *  - Every answer is an `assistant-step` chat node in the keyed slot
 *    `conversation.chat.node`; `ui-chat` holds the key at priority 0 and the
 *    lowest priority renders. The reply-check body takes it over at -1; this
 *    body goes below that, at -2, renders the row it shadows (the reply
 *    check's, or the kernel's own when that body is off) and adds the cards
 *    after it. Taking over `turn-tail` instead would put the kernel's footer
 *    under our entry's props, and its `renderSlotChain` is bound per entry to
 *    the children that entry declared — which a second entry may not declare
 *    again (`SlotCore.register`: "is already declared").
 *  - Which step is the answer: the turn's own data. `ui-chat` publishes the
 *    `turn-tail` value at `turn/end` with the closing message it chose
 *    (`closing.finalNode.seq`); every chat node reads it through the slot's
 *    `useTurnData` hook, and a settled step is the answer when its
 *    `finalNode.seq` is that one.
 *  - Which turn: the frame knows one run, the one the shell binds to the
 *    conversation (the newest on its root session). Its files go on the
 *    conversation's newest turn (`useChat` → `timeline.turnOrder`), and only
 *    when that turn belongs to the run — it began before the run finished and
 *    ended after the run began — so a later question never wears an earlier
 *    run's files. A delegated child's view is the same run and shows none.
 *  - The size is the kernel's own `file` resource: `useResource`, a hook every
 *    slot component receives, on `dsh-resource://file/session/<id>/<path>`,
 *    which stats a workspace-relative path through `workspaceFiles.stat` (the
 *    proxy holds it to the workspace). Without it a card names the type alone.
 *  - `ctx.sidebarRight.openTab(kind)` acts through the mounted seat and throws
 *    when none is mounted, so an automatic open is attempted and retried on the
 *    next change rather than assumed. The kernel's file tree is kind `files`.
 *
 * Opening a file is a message to the shell, whose reader marks each
 * conclusion ✓/⚠, offers the download and goes through the control plane's own
 * file boundary.
 *
 * @module @evimed/harness-port/runtime-ui-panels
 */

import { frameStyles } from './runtimeUiStyles.mjs';
import { liveRunFor } from './runtimeUiToolviews.mjs';

/** Services this body needs outright: the slot registry and the sessions. */
export const inject = ['slots', 'sessions'];

/** The kernel's own file-tree tab, which the column opens on a delivered report. */
export const KERNEL_FILES_TAB = 'files';

/**
 * What a delivered file is, from its name: the type a reader knows it by, the
 * icon it wears, and where it sorts (the report first, then its evidence
 * table, then documents, sheets, pictures and the rest).
 * @param {string} path
 * @returns {{ name: string, type: string, icon: 'doc' | 'sheet' | 'data' | 'image' | 'file', rank: number }}
 */
export function fileTypeOf(path) {
  const name = String(path ?? '').split('/').pop() ?? '';
  const lower = name.toLowerCase();
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  /** @type {Record<string, [string, 'doc' | 'sheet' | 'data' | 'image' | 'file']>} */
  const types = {
    md: ['Markdown', 'doc'], markdown: ['Markdown', 'doc'], txt: ['文本', 'doc'],
    docx: ['Word', 'doc'], doc: ['Word', 'doc'], pdf: ['PDF', 'doc'], pptx: ['PPT', 'doc'], ppt: ['PPT', 'doc'],
    html: ['网页', 'doc'], htm: ['网页', 'doc'],
    xlsx: ['Excel', 'sheet'], xls: ['Excel', 'sheet'], csv: ['CSV', 'sheet'], tsv: ['TSV', 'sheet'],
    json: ['JSON', 'data'], jsonl: ['JSON', 'data'], xml: ['XML', 'data'], ris: ['RIS', 'data'], bib: ['BibTeX', 'data'],
    png: ['图片', 'image'], jpg: ['图片', 'image'], jpeg: ['图片', 'image'], gif: ['图片', 'image'], svg: ['图片', 'image'], webp: ['图片', 'image'],
    zip: ['压缩包', 'file'],
  };
  const [type, icon] = types[extension] ?? ['文件', 'file'];
  // A deliverable's completed reporting checklist (CONSORT 2025, TRIPOD+AI…)
  // matches `report` and is not the report: it lists where the report says
  // each item. The name is @evimed/domain's REPORTING_CHECKLIST_FILE, written
  // out because this function is shipped into the frame on its own.
  const report = icon === 'doc' && /report/.test(lower) && lower !== 'reporting-checklist.md';
  // A delivery summary says what the answer above it already says, once per
  // run and once per deliverable; it waits behind 「显示全部」 (production,
  // 2026-09-24: three 「交付摘要」 took three of four cards from a manuscript
  // run whose two sections and two checklists were the delivery).
  const rank = report ? 0
    : /matrix.*\.json$/.test(lower) ? 1
      : lower === 'delivery-summary.md' ? 5
        : icon === 'doc' ? 2 : icon === 'sheet' ? 3 : icon === 'image' ? 4 : 5;
  return { name, type, icon, rank };
}

/**
 * What a researcher calls a delivered document, or null for a file known by
 * its name alone. These are the shell's own names — the report reader's title
 * (`apps/web/src/lib/artifactNames.ts`) — written out because this function
 * is shipped into the frame on its own; a test holds the two tables equal, so
 * a card and the reader it opens name one document one way.
 * @param {string} path
 * @returns {string | null}
 */
export function documentNameOf(path) {
  /** @type {Record<string, string>} */
  const names = {
    'clinical-evidence-report.md': '证据分析报告',
    'clinical-evidence-matrix.json': '证据矩阵',
    'safety-report.md': '安全性分析报告',
    'signals.csv': '信号数据表',
    'revision-notes.md': '修订说明',
    'reporting-checklist.md': '报告规范清单',
    'delivery-summary.md': '交付摘要',
    'comprehensive-evaluation-report.md': '综合评价报告',
    'drug-selection-report.md': '遴选评价报告',
    'off-label-report.md': '超说明书用药分析报告',
    'meta-analysis-report.md': 'Meta 分析报告',
    'mendelian-randomization-report.md': '孟德尔随机化报告',
    'bibliometric-analysis-report.md': '文献计量分析报告',
    'peer-review-report.md': '审稿报告',
    'research-topic-report.md': '科研选题报告',
    'research-portfolio.md': '研究选题组合',
    'manuscript-section.md': '论文章节',
    'specific-aims.md': '具体目标',
    'proposal-outline.md': '申报书大纲',
    'grant-audit.md': '申报书自查',
    'study-protocol.md': '研究方案',
    'feasibility-matrix.md': '可行性矩阵',
    'data-profile.md': '数据剖析',
    'data-quality.md': '数据质量说明',
    'evidence-map.md': '证据图谱',
    'appraisal-table.md': '证据评价表',
    'geo-content-pack.md': '内容包',
    'geo-measurement.md': '答案引擎测量',
    'geo-insight.md': '证据与问题地图',
    'journey.md': '患者旅程矩阵',
    'geo-strategy.md': '信源与目标',
    'geo-content.md': '稿件清单',
    'geo-proposal.md': '提案资料包说明',
  };
  const name = String(path ?? '').split('/').pop() ?? '';
  return Object.hasOwn(names, name) ? names[name] : null;
}

/**
 * The files a finished run hands back, in the order a reader looks for them,
 * each under the name a reader knows it by, or null while it runs or when it
 * wrote nothing. Accepted and unchecked files are both the run's output (a
 * gate verdict never withholds a delivery), and neither says which it is.
 * Revision notes are the run's answer to its reviewer — a backstage file
 * (principle 10a) — and stay in the file tree. Two files of one name — one
 * per deliverable — say which deliverable's folder each is in (`where`), the
 * folder the answer names them by.
 * @param {any} live
 * @returns {{ runId: string, files: { path: string, name: string, label: string, type: string, icon: string, rank: number, where: string | null }[] } | null}
 */
export function fileCardsModel(live) {
  const state = String(live?.state ?? '');
  if (!live || !live.runId || !['succeeded', 'failed', 'canceled', 'cancelled'].includes(state)) return null;
  /** @type {Set<string>} */
  const seen = new Set();
  const files = [];
  for (const path of [...(Array.isArray(live.artifacts) ? live.artifacts : []), ...(Array.isArray(live.unverifiedArtifacts) ? live.unverifiedArtifacts : [])]) {
    // The shell opens what the bridge lets through: a relative path that climbs nowhere.
    if (typeof path !== 'string' || !path || seen.has(path) || path.startsWith('/') || path.includes('\\')
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')) continue;
    seen.add(path);
    const type = fileTypeOf(path);
    if (/^revision-notes?\.md$/i.test(type.name)) continue;
    files.push({ path, ...type, label: documentNameOf(path) ?? type.name, where: /** @type {string | null} */ (null) });
  }
  /** @type {Map<string, number>} */
  const named = new Map();
  for (const file of files) named.set(file.label, (named.get(file.label) ?? 0) + 1);
  for (const file of files) {
    const folders = file.path.split('/');
    if ((named.get(file.label) ?? 0) > 1 && folders.length > 1) file.where = folders[folders.length - 2];
  }
  files.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return files.length ? { runId: String(live.runId), files } : null;
}

/**
 * Whether the run wrote a report or its evidence table — what the right
 * column opens itself for.
 * @param {any} live
 */
export function hasReport(live) {
  const paths = [...(Array.isArray(live?.artifacts) ? live.artifacts : []), ...(Array.isArray(live?.unverifiedArtifacts) ? live.unverifiedArtifacts : [])];
  return paths.some((path) => typeof path === 'string' && fileTypeOf(path).rank <= 1);
}

/**
 * Whether a turn belongs to the run: it began before the run finished and
 * ended after the run began, give or take a clock's worth of slack between the
 * kernel's event times and the ledger's. A time either side does not know
 * does not decide.
 * @param {{ start?: number, end?: number }} turn epoch ms
 * @param {any} live
 */
export function turnCarriesRun(turn, live) {
  const slack = 120_000;
  const began = Number(turn?.start);
  const ended = Number(turn?.end);
  const runStart = Date.parse(String(live?.progress?.startedAt ?? ''));
  const runEnd = Date.parse(String(live?.progress?.updatedAt ?? live?.updatedAt ?? ''));
  if (Number.isFinite(began) && Number.isFinite(runEnd) && began > runEnd + slack) return false;
  if (Number.isFinite(ended) && Number.isFinite(runStart) && ended < runStart - slack) return false;
  return true;
}

/**
 * A byte count the way a file list says it.
 * @param {unknown} bytes
 * @returns {string | null}
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The kernel's resource address of a workspace file, as its own file tree
 * names one: the session, then the workspace-relative path, each segment
 * encoded.
 * @param {string} sessionId @param {string} path
 */
export function fileAddress(sessionId, path) {
  return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} _target Browser global (unused: the cards read nothing off the window).
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, _target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours || !kit.h || !kit.react) return;
  const h = kit.h;
  const React = kit.react;
  const slot = 'conversation.chat.node';
  const { text, meta, title, textButton } = frameStyles();

  function useLive() {
    const runState = kit.useFrameState((/** @type {any} */ state) => state.runState);
    const session = kit.useFrameState((/** @type {any} */ state) => state.session);
    return liveRunFor(runState, session);
  }

  /** The newest turn of the conversation on screen, from the chat's own timeline. */
  function latestTurn(/** @type {any} */ snapshot) {
    const order = snapshot?.timeline?.turnOrder;
    return Array.isArray(order) && order.length ? order[order.length - 1] : null;
  }

  /** @param {{ kind: string }} props */
  const FileIcon = ({ kind }) => {
    const marks = /** @type {Record<string, string[]>} */ ({
      doc: ['M10 9H8', 'M16 13H8', 'M16 17H8'],
      sheet: ['M8 13h2', 'M14 13h2', 'M8 17h2', 'M14 17h2'],
      data: ['M10 12.5 8 15l2 2.5', 'm14 12.5 2 2.5-2 2.5'],
      image: ['m20 17-3.1-3.1a2 2 0 0 0-2.8 0L8 20', 'M9 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z'],
    })[kind] ?? [];
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }),
      h('path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }),
      ...marks.map((d, index) => h('path', { key: index, d })));
  };
  const OpenIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M7 7h10v10' }), h('path', { d: 'M7 17 17 7' }));

  /**
   * One delivered file: its name, 「类型 · 大小」 (「文件夹 · 类型」 when two
   * files share the name), and the one way to open it.
   * The name is the document's (the reader's title); the file's own name is
   * the tooltip, as it is in the file tree.
   * @param {{ file: any, runId: string, sessionId: string | null, useResource?: (address: string) => any }} props
   */
  const FileCard = ({ file, runId, sessionId, useResource }) => {
    // Always the same hook call for one card; an address the resource model
    // does not recognise reads as `none`, not as a failure.
    const resource = typeof useResource === 'function' ? useResource(sessionId ? fileAddress(sessionId, file.path) : '') : null;
    const size = resource && resource.status === 'live' ? formatBytes(resource.value?.bytes) : null;
    const facts = [file.where, file.type, size].filter(Boolean).join(' · ');
    return h('button', {
      type: 'button', 'data-evimed-file': file.path, 'aria-label': `打开${file.label}`, title: file.name,
      onClick: () => { kit.hub.send('open-artifact', { runId, path: file.path }); },
      style: {
        display: 'flex', alignItems: 'center', gap: '10px', width: '100%', minWidth: 0, boxSizing: 'border-box',
        padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px',
        background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
      },
    },
    h('span', { 'aria-hidden': true, style: { flex: 'none', width: '32px', height: '32px', borderRadius: '8px', display: 'grid', placeItems: 'center', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' } },
      h(FileIcon, { kind: file.icon })),
    h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } },
      h('span', { style: { ...text, ...title } }, file.label),
      h('span', { style: { ...meta, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, facts)),
    h('span', { 'aria-hidden': true, style: { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)' } }, h(OpenIcon)));
  };

  /**
   * The run's files, two to a row: its readable files first, at most four;
   * the rest behind one control, as the kernel's own delivery cards do.
   * @param {{ model: { runId: string, files: any[] }, sessionId: string | null, useResource?: any }} props
   */
  const FileCards = ({ model, sessionId, useResource }) => {
    const [all, setAll] = React.useState(false);
    // Cards are for what a reader opens — documents, tables, data, figures.
    // A helper script the run left beside its report (build_tables.py) waits
    // behind 「显示全部」 with everything else (production, 2026-09-24: two
    // scripts took half the cards of a finished review).
    const readable = model.files.filter((/** @type {any} */ file) => file.rank <= 4);
    const lead = (readable.length ? readable : model.files).slice(0, 4);
    const shown = all ? model.files : lead;
    return h('div', { 'data-evimed-files': model.runId, style: { marginTop: '16px', minWidth: 0 } },
      h('div', { style: { display: 'grid', gridTemplateColumns: model.files.length > 1 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)', gap: '8px' } },
        shown.map((file) => h(FileCard, { key: file.path, file, runId: model.runId, sessionId, useResource }))),
      model.files.length > lead.length
        ? h('button', { type: 'button', 'aria-expanded': all, onClick: () => setAll(!all), style: { ...textButton, ...meta, marginTop: '4px' } },
          all ? '收起' : `显示全部 ${model.files.length} 个文件`)
        : null);
  };

  /**
   * The files of the bound run, when the turn they follow belongs to it.
   * Mounted after one answer only, so one row follows the run state as it
   * changes rather than every step of the transcript.
   * @param {{ turn: { start?: number, end?: number }, useResource?: any }} props
   */
  const TurnFiles = ({ turn, useResource }) => {
    const live = useLive();
    const session = kit.useFrameState((/** @type {any} */ state) => state.session);
    const model = kit.guarded('file cards', () => {
      if (session?.subagent === true) return null;
      const cards = fileCardsModel(live);
      return cards && turnCarriesRun(turn, live) ? cards : null;
    });
    if (!model) return null;
    return h(FileCards, { model, sessionId: typeof session?.sessionId === 'string' ? session.sessionId : null, useResource });
  };

  /**
   * The answer row: whatever this takeover shadows, then — when this is the
   * closing answer of the conversation's newest turn — the files that turn
   * delivered.
   * @param {any} props
   */
  function AnswerWithFiles(props) {
    const Shadowed = kit.shadowed(slot, 'assistant-step', AnswerWithFiles);
    // The slot's own hooks: the closing answer the turn chose (the kernel's own
    // answer row reads it the same way), and the chat's newest turn. Present
    // on every chat node; read unconditionally per instance, which is what the
    // rules of hooks ask.
    const tail = typeof props?.useTurnData === 'function' ? props.useTurnData('turn-tail') : undefined;
    const newest = typeof props?.useChat === 'function' ? props.useChat(latestTurn) : undefined;
    const own = Shadowed ? h(Shadowed, props) : null;
    const node = props?.node;
    const seq = node?.data?.finalNode?.seq;
    const closing = Number.isInteger(seq) && tail?.closing?.finalNode?.seq === seq && (newest === undefined || newest === node.data.turn);
    if (!closing) return own;
    return h(React.Fragment, null, own, h(TurnFiles, { turn: { start: node?.location?.turn?.start?.time, end: tail?.time }, useResource: props?.useResource }));
  }
  kit.guarded('file cards', () => kit.occupy({ slot, key: 'assistant-step', priority: -2, locale: 'chat' }, AnswerWithFiles));

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
      if (!hasReport(live)) { watchedWithout.add(runId); return; }
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
  parts: Object.freeze([frameStyles, liveRunFor, fileTypeOf, documentNameOf, fileCardsModel, hasReport, turnCarriesRun, formatBytes, fileAddress, apply]),
});
