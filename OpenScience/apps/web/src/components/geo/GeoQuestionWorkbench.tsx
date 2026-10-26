import { GEO_METRICS, knownErrorCodeMessage, previewGeoQuestionImport } from '@evimed/domain';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { getGeoQuestions, type GeoProject, type GeoQuestions } from '@/lib/geoClient';
import { fetchWebMe, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, webErrorMessage } from '@/lib/apiClient';
import { mapQuestionRows, readQuestionWorkbook, type QuestionWorkbook, type QuestionMapping } from '@/lib/geoQuestionImport';
import { getGeoDiagnosisProgress, importGeoQuestions, previewGeoQuestions, recoverGeoDiagnosis, startGeoDiagnosis, type GeoDiagnosisProgress, type GeoImportInput, type GeoImportPreview, type GeoMeasurementContract, type GeoQuestionImportRow } from '@/lib/geoQuestionWorkbenchClient';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, inputClasses } from '@/components/ui/Input';
import { Note } from '@/components/ui/Note';
import { Section } from '@/components/ui/Section';
import { AskAi } from './AskAi';
import { ShowMore, useShowMore } from './tabs/showMore';
import { engineName, GEO_DEFAULT_ENGINES } from './geoText';
import { answerPath } from './tabs/geoTabText';

const initialContract: GeoMeasurementContract = { samplingMode: 'one_shot', repeats: 1, engines: [...GEO_DEFAULT_ENGINES], metricIds: ['M-01S', 'M-06', 'M-08'], reportPresentation: 'summary', sourceBasis: 'answers_and_project_sources' };
// eslint-disable-next-line no-restricted-syntax -- Parser validation messages are owned Chinese text; HTTP refusals still use webErrorMessage.
const failure = (error: unknown) => webErrorMessage(error, { fallback: error instanceof Error ? error.message : '操作未完成，请重试。' });
const key = () => crypto.randomUUID();
/** Invalidate requests against the latest counter, including when an effect is disposed. */
const invalidateIdentity = (generation: { current: number }) => { generation.current++; };

/** One imported row with the key it is drawn by: an edit replaces that entry alone, so the other rows keep their elements. */
interface RowEntry { key: string; row: GeoQuestionImportRow }
const entriesOf = (rows: readonly GeoQuestionImportRow[]): RowEntry[] => rows.map(row => ({ key: key(), row }));
/** A set of up to 400 originals is drawn fifty rows at a time: every row is a dozen controls. */
const ROWS_SHOWN = 50;

/**
 * Why a diagnosis job did not answer, in a sentence. The dictionary's own sentence when it has one; the probe queue's outcomes that
 * only this table meets are said here; any other is said without its code.
 */
const JOB_FAILURES: Record<string, string> = {
  delivery_unknown_no_automatic_retry: '请求可能已经送达，但没有收到回答；为避免重复计费，没有自动重试。',
  question_missing: '这道题已不在这一版问句里。',
  probe_busy: '提问通道正忙，这一项没有排上。',
};
const jobFailure = (code: string) => knownErrorCodeMessage(code) ?? JOB_FAILURES[code] ?? '这一项没有取得回答。';

/** Version editing and diagnosis are deliberate writes; viewing or importing never starts sampling. */
export function GeoQuestionWorkbench({ geoId, project, data, onSaved }: { geoId: string; project: GeoProject; data: GeoQuestions; onSaved: (version: number) => void }) {
  const [params, setParams] = useSearchParams();
  const editRevision = useRef(0);
  const working = useRef(false);
  const identityGeneration = useRef(0);
  const canEdit = !project.access || project.access.abilities.includes('edit');
  const editableNow = useRef(canEdit); editableNow.current = canEdit;
  const [identityVersion, setIdentityVersion] = useState(0);
  const [storageScope, setStorageScope] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [book, setBook] = useState<QuestionWorkbook | null>(null);
  const [sheet, setSheet] = useState(0);
  const [mapping, setMapping] = useState<QuestionMapping>({});
  const [entries, setEntries] = useState<RowEntry[]>([]);
  const rows = useMemo(() => entries.map(entry => entry.row), [entries]);
  const setRows = (next: readonly GeoQuestionImportRow[]) => setEntries(entriesOf(next));
  const [blank, setBlank] = useState(0);
  const [contract, setContract] = useState<GeoMeasurementContract>(data.contract ?? initialContract);
  const [preview, setPreview] = useState<GeoImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const pendingImport = useRef<(GeoImportInput & { requestKey: string }) | null>(null);
  useEffect(() => {
    const reset = () => { invalidateIdentity(identityGeneration); setStorageScope(null); pendingImport.current = null; setEntries([]); setPreview(null); setEditing(false); setSaved(null); };
    const started = () => { reset(); setIdentityVersion(value => value + 1); };
    window.addEventListener(WEB_SESSION_ENDED_EVENT, reset); window.addEventListener(WEB_SESSION_STARTED_EVENT, started);
    return () => { window.removeEventListener(WEB_SESSION_ENDED_EVENT, reset); window.removeEventListener(WEB_SESSION_STARTED_EVENT, started); };
  }, []);
  useEffect(() => {
    setStorageScope(null); pendingImport.current = null; setEntries([]); setPreview(null); setEditing(false);
    let live = true; const generation = ++identityGeneration.current;
    void fetchWebMe().then(me => {
      if (!live || generation !== identityGeneration.current || !me?.user?.id) return;
      const scoped = `geo-question-import:${me.tenant?.id ?? me.user.tenantId ?? me.user.id}:${me.user.id}:${project.projectId}:${geoId}`;
      setStorageScope(scoped);
      try {
        const raw = editableNow.current ? localStorage.getItem(scoped) : null;
        if (raw && editableNow.current) {
          try {
            const held: unknown = JSON.parse(raw);
            if (!held || typeof held !== 'object' || !('input' in held)) throw new Error('Invalid cached operation');
            const input = held.input;
            const checked = previewGeoQuestionImport(input);
            if (!checked.requestKey) throw new Error('Missing request identity');
            // Canonical validation checks the cache; send the exact original payload for idempotency.
            const original = input as GeoImportInput & { requestKey: string };
            pendingImport.current = original; setEntries(entriesOf(original.rows)); setContract(original.contract); setPreview(checked as GeoImportPreview); setEditing(true);
          } catch {
            localStorage.setItem(`${scoped}:invalid`, raw); localStorage.removeItem(scoped);
            setError('上次保存记录损坏，已隔离。请重新导入原表后核对预览。');
          }
        }
      } catch { setError('浏览器暂时无法读取保存记录；请检查本地存储可用空间后重试。'); }
    }).catch(() => { if (live) setError('账户或上次保存记录无法读取，请刷新后重试。'); });
    return () => { live = false; invalidateIdentity(identityGeneration); };
  }, [geoId, project.projectId, identityVersion, canEdit]);
  const pendingStart = useRef<{ version: number; requestKey: string } | null>(null);
  useEffect(() => { pendingStart.current = null; }, [storageScope]);
  const canRun = !project.access || project.access.abilities.includes('run');
  const version = saved ?? data.version;
  const activeContract = saved != null ? contract : data.contract;
  const round = params.get('diagnosisRound');
  const target = { geoId, projectId: project.projectId, sessionId: project.sessionId };
  const selectRound = (roundId: string) => { sessionStorage.setItem(`${storageScope}:diagnosis`, roundId); setParams(previous => { const next = new URLSearchParams(previous); next.set('diagnosisRound', roundId); return next; }, { replace: true }); };
  useEffect(() => { if (!storageScope) return; const prior = sessionStorage.getItem(`${storageScope}:diagnosis`); if (!round && prior) setParams(previous => { const next = new URLSearchParams(previous); next.set('diagnosisRound', prior); return next; }, { replace: true }); }, [storageScope, round, setParams]);
  useEffect(() => { if (!editing) setContract(data.contract ?? initialContract); }, [data.contract, editing]);
  const act = async (fn: () => Promise<void>) => { if (working.current) return; working.current = true; const generation = identityGeneration.current; setBusy(true); setError(''); try { await fn(); } catch (cause) { if (generation === identityGeneration.current) setError(failure(cause)); } finally { working.current = false; setBusy(false); } };
  const changed = useCallback(() => { editRevision.current++; setPreview(null); pendingImport.current = null; }, []);
  // An edit is one row's: the entry is replaced, every other keeps its identity and its memoised row is not drawn again.
  const updateRow = useCallback((rowKey: string, patch: Partial<GeoQuestionImportRow>) => {
    setEntries(previous => previous.map(entry => entry.key === rowKey ? { key: rowKey, row: { ...entry.row, ...patch } } : entry)); changed();
  }, [changed]);
  const shown = useShowMore(entries, { first: ROWS_SHOWN, step: ROWS_SHOWN, resetKey: entries[0]?.key ?? '' });
  const editExisting = () => { if (working.current || !editableNow.current || pendingImport.current) return; void act(async () => {
    if (!data.contract) throw new Error('这个历史题库不支持原表编辑，请导入完整原题创建新的采样版本。');
    if (data.version == null) throw new Error('请先选择一个问句版本再编辑。');
    const generation = identityGeneration.current, revision = editRevision.current;
    const complete = data.selection ? await getGeoQuestions(geoId, data.version) : data;
    if (!editableNow.current || generation !== identityGeneration.current || revision !== editRevision.current) return;
    setBook(null); setContract(complete.contract ?? initialContract);
    const originals = complete.groups.flatMap(group => group.questions.map(question => ({ group, question })));
    originals.sort((a, b) => (a.question.originalRowIndex ?? Number.MAX_SAFE_INTEGER) - (b.question.originalRowIndex ?? Number.MAX_SAFE_INTEGER));
    setRows(originals.map(({ group, question }) => ({ text: question.text, originalId: question.originalId, originalGroup: question.originalGroup, clientTags: question.clientTags, kind: question.kind, sourceUrl: question.sourceUrl, collectedAt: question.collectedAt, isMeasured: question.isMeasured, pool: group.pool, journeyStage: group.journeyStage, audience: group.audience, classificationStatus: question.classificationStatus })));
    changed(); setEditing(true); setSaved(null);
  }); };
  const loadFile = (file: File) => { void act(async () => {
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('请选择 Excel 或 CSV 文件。');
    if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请拆分后导入。');
    const generation = identityGeneration.current, revision = editRevision.current;
    const next = await readQuestionWorkbook(await file.arrayBuffer(), /\.csv$/i.test(file.name) ? 'csv' : 'excel'); if (!editableNow.current || generation !== identityGeneration.current || revision !== editRevision.current) return; setBook(next); setSheet(0); setMapping({}); setRows([]); changed();
  }); };
  const start = () => { void act(async () => {
    if (!storageScope) throw new Error('请等待账户确认后再开始。');
    if (version == null) throw new Error('请先保存问句版本。');
    // Keep the same opaque key on a lost response: the server returns the existing round.
    const candidate = pendingStart.current?.version === version ? pendingStart.current : { version, requestKey: sessionStorage.getItem(`${storageScope}:start:${version}`) ?? key() };
    sessionStorage.setItem(`${storageScope}:start:${version}`, candidate.requestKey); pendingStart.current = candidate;
    const generation = identityGeneration.current;
    const result = await startGeoDiagnosis(geoId, version, pendingStart.current.requestKey);
    await getGeoDiagnosisProgress(geoId, result.roundId);
    if (generation === identityGeneration.current) selectRound(result.roundId);
  }); };
  return <Section title="问句整理与诊断" level="sub">
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && <Button variant="secondary" size="sm" disabled={busy || !!pendingImport.current} onClick={() => { setEditing(true); setSaved(null); }}>导入问句</Button>}
      {canEdit && data.groups.length > 0 && data.version != null && data.contract != null && <Button size="sm" variant="text" disabled={busy || !!pendingImport.current} onClick={editExisting}>编辑为新版本</Button>}
      {version != null && <AskAi project={target} label="建议分类" draft={`/geo-insight 请读取第 ${version} 版完整原题，仅建议测量池、人群、阶段与分类状态。保留原题、编号、客户分组与原标签，输出带原编号的可导入表格，建议不覆盖客户原分类；用户采用后另存新版本。`} />}{version != null && <AskAi project={target} label="检查覆盖" draft={`/geo-insight 请检查第 ${version} 版问句覆盖，读取该版本原题、已有资料和旅程人群，指出具体缺口与依据，不编造配额。保留原分类，建议另列，输出可编辑的新版本问句表，不自动采样。`} />}
      {version != null && activeContract != null && canRun && <Button size="sm" disabled={busy || !storageScope} onClick={start}>{busy ? '正在处理' : `启动第 ${version} 版诊断`}</Button>}
    </div>
    {version != null && <Note className="my-3" result={['第 ', { n: version }, ` 版 · ${activeContract?.samplingMode === 'recurring' ? '重复采样' : '单次采样'} · ${(activeContract?.engines ?? contract.engines).map(engineName).join('、')}。单次结果描述本次回答，不代表稳定概率。`]} action={canEdit && data.contract ? <Button size="sm" variant="text" disabled={busy || !!pendingImport.current} onClick={editExisting}>调整口径</Button> : undefined} />}
    {editing && canEdit && <div className="my-4 flex flex-col gap-4">
      <Input type="file" label="选择 Excel / CSV（首行为列名，最多 400 题、10 MB）" accept=".xlsx,.xls,.csv" disabled={busy || !!pendingImport.current} onChange={event => { const file = event.target.files?.[0]; if (file) loadFile(file); }} />
      {book && <>
        <label className="text-ui text-text">工作表<select disabled={busy || !!pendingImport.current} aria-label="工作表" className={inputClasses()} value={sheet} onChange={event => { setSheet(Number(event.target.value)); setRows([]); setMapping({}); changed(); }}>{book.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label>
        <div className="grid gap-3 md:grid-cols-2">{(['text', 'originalId', 'originalGroup', 'clientTags', 'pool', 'audience', 'journeyStage', 'kind', 'sourceUrl', 'collectedAt', 'classificationStatus', 'isMeasured'] as const).map((field, index) => <label key={field} className="text-ui text-text">{['原题文本', '原编号', '客户原分类', '客户原标签', '测量池（P1–P4）', '人群（patient / physician 等）', '旅程阶段', '问句性质（client / typical / real / label_safety）', '来源链接', '采集日期', '分类状态（unclassified / suggested / confirmed）', '参与测量（true / false / 1 / 0）'][index]}<select disabled={busy || !!pendingImport.current} className={inputClasses()} value={mapping[field] ?? ''} onChange={event => { setMapping(previous => ({ ...previous, [field]: event.target.value === '' ? undefined : Number(event.target.value) })); changed(); setRows([]); }}><option value="">请选择列</option>{book.sheets[sheet].rows[0]?.map((name, column) => <option key={column} value={column}>{column + 1} · {name || '未命名'}</option>)}</select></label>)}</div>
        <Button variant="secondary" size="sm" disabled={busy || !!pendingImport.current} onClick={() => { void act(async () => { const mapped = mapQuestionRows(book.sheets[sheet].rows, mapping, book.sheets[sheet].typedRows); setRows(mapped.rows); setBlank(mapped.excludedBlankRows); changed(); }); }}>读取映射行</Button>
      </>}
      <ContractFields value={contract} disabled={busy || !!pendingImport.current} onChange={next => { setContract(next); changed(); }} />
      {rows.length > 0 && <>
        <Note result={[`实际 ${rows.length} 题 · 已排除全空行 `, { n: blank }, " 行。重复原题保留；客户标签与平台分类分列。"]} />
        <div className="max-h-96 overflow-auto"><table className="w-full text-caption"><thead><tr>{['原编号 / 客户分类 / 原标签', '原题（完整文本）', '平台补充分类', '参与测量'].map(title => <th key={title} className="p-2 text-left">{title}</th>)}</tr></thead><tbody>{shown.visible.map((entry, index) => <QuestionRow key={entry.key} entry={entry} index={index} disabled={busy || !!pendingImport.current} onChange={updateRow} />)}</tbody></table></div>
        <ShowMore remaining={shown.remaining} unit="题" onMore={shown.more} />
        <Button size="sm" disabled={busy} onClick={() => { void act(async () => { const revision = editRevision.current, generation = identityGeneration.current; const result = await previewGeoQuestions(geoId, { rows, contract }); if (revision === editRevision.current && generation === identityGeneration.current && editableNow.current) setPreview(result); }); }}>核对导入预览</Button>
        {preview && <div className="flex flex-col gap-3"><p className="text-ui text-text">实际 {preview.actualRows} 题 · 测量 {preview.measuredRows} 题 · 计划 {preview.plannedCalls} 次调用 · 疑似重复 {preview.duplicateCandidates.length} 组（全部保留）</p>{preview.duplicateCandidates.map((item, index) => <p key={index} className="text-caption text-text-2">疑似重复行：{item.rowIndexes.map(row => row + 1).join('、')}</p>)}<Button disabled={busy || !storageScope || preview.plannedCalls > 5000} onClick={() => { void act(async () => { if (!editableNow.current) throw new Error('你在这个项目里只有查看权限。'); if (!storageScope) throw new Error('请等待账户确认后再保存。'); const candidate = pendingImport.current ?? { rows, contract, requestKey: key() }; localStorage.setItem(storageScope, JSON.stringify({ input: candidate, preview })); pendingImport.current = candidate; const generation = identityGeneration.current; const result = await importGeoQuestions(geoId, pendingImport.current); if (!editableNow.current || generation !== identityGeneration.current) return; localStorage.removeItem(storageScope); pendingImport.current = null; setSaved(result.version); setEditing(false); onSaved(result.version); }); }}>保存为新版本</Button></div>}
      </>}
      <Button size="sm" variant="text" disabled={busy} onClick={() => setEditing(false)}>收起整理</Button>
    </div>}
    {error && <p role="alert" className="my-3 text-ui text-error">{error}</p>}
    {round && storageScope && <DiagnosisProgress storageScope={storageScope} key={round} geoId={geoId} round={round} canRun={canRun} onRound={selectRound} />}
  </Section>;
}

/** One imported original, drawn again only when it or its controls' state changes. */
const QuestionRow = memo(function QuestionRow({ entry, index, disabled, onChange }: { entry: RowEntry; index: number; disabled: boolean; onChange: (rowKey: string, patch: Partial<GeoQuestionImportRow>) => void }) {
  const { row } = entry;
  const update = (patch: Partial<GeoQuestionImportRow>) => onChange(entry.key, patch);
  return <tr>
          <td className="p-2 align-top whitespace-pre-wrap"><fieldset disabled={disabled}><Input label={`第 ${index + 1} 题原编号`} value={row.originalId ?? ''} onChange={event => update({ originalId: event.target.value || null })} /><Input label={`第 ${index + 1} 题客户原分类`} value={row.originalGroup ?? ''} onChange={event => update({ originalGroup: event.target.value || null })} />{row.clientTags?.map((tag, at) => <Textarea key={at} label={`第 ${index + 1} 题原标签 ${at + 1}`} value={tag} onChange={event => update({ clientTags: row.clientTags?.map((item, position) => position === at ? event.target.value : item) })} />)}</fieldset></td>
          <td className="p-2"><Textarea aria-label={`第 ${index + 1} 题文本`} value={row.text} disabled={disabled} onChange={event => update({ text: event.target.value })} /></td>
          <td className="p-2"><select aria-label={`第 ${index + 1} 题测量池`} className={inputClasses()} value={row.pool ?? ''} disabled={disabled} onChange={event => update({ pool: (event.target.value || null) as GeoQuestionImportRow['pool'], classificationStatus: 'confirmed' })}><option value="">未分类</option>{['P1', 'P2', 'P3', 'P4'].map(pool => <option key={pool}>{pool}</option>)}</select><details><summary>人群、阶段与来源</summary><fieldset disabled={disabled}><Input label={`第 ${index + 1} 题旅程阶段`} value={row.journeyStage ?? ''} onChange={event => update({ journeyStage: event.target.value || null, classificationStatus: 'confirmed' })} /><label>人群<select className={inputClasses()} value={row.audience ?? ''} onChange={event => update({ audience: (event.target.value || null) as GeoQuestionImportRow['audience'], classificationStatus: 'confirmed' })}><option value="">未分类</option>{Object.entries({ patient: '患者', physician: '医生', caregiver: '照护者', pharmacist: '药师', institution: '机构', other: '其他' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>问句性质<select className={inputClasses()} value={row.kind ?? 'client'} onChange={event => update({ kind: event.target.value as GeoQuestionImportRow['kind'] })}><option value="client">客户原题</option><option value="typical">典型 / 模型建议</option><option value="real">有来源真实问法</option><option value="label_safety">说明书安全题</option></select></label><Input label={`第 ${index + 1} 题来源链接`} value={row.sourceUrl ?? ''} onChange={event => update({ sourceUrl: event.target.value || null })} /><Input label={`第 ${index + 1} 题采集日期`} value={row.collectedAt ?? ''} onChange={event => update({ collectedAt: event.target.value || null })} /><label>分类状态<select className={inputClasses()} value={row.classificationStatus ?? 'unclassified'} onChange={event => update({ classificationStatus: event.target.value as GeoQuestionImportRow['classificationStatus'] })}><option value="unclassified">未分类</option><option value="suggested">建议，待采用</option><option value="confirmed">已采用</option></select></label></fieldset></details></td>
          <td className="p-2"><input type="checkbox" aria-label={`测量第 ${index + 1} 题`} checked={row.isMeasured !== false} disabled={disabled} onChange={event => update({ isMeasured: event.target.checked })} /></td>
        </tr>;
});

function ContractFields({ value, onChange, disabled }: { value: GeoMeasurementContract; onChange: (next: GeoMeasurementContract) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="flex flex-col gap-3"><legend className="text-ui font-semibold">这一版本的采样与报告口径</legend>
    <div className="flex flex-wrap gap-3">{[...GEO_DEFAULT_ENGINES, 'baidu'].map(engine => <label key={engine} className="text-ui"><input type="checkbox" checked={value.engines.includes(engine)} onChange={event => onChange({ ...value, engines: event.target.checked ? [...value.engines, engine] : value.engines.filter(item => item !== engine) })} /> {engineName(engine)}</label>)}</div>
    <label className="text-ui">采样方式<select className={inputClasses()} value={value.samplingMode} onChange={event => onChange({ ...value, samplingMode: event.target.value as GeoMeasurementContract['samplingMode'], repeats: 1 })}><option value="one_shot">单次，每题每平台一次</option><option value="recurring">重复采样</option></select></label>
    {value.samplingMode === 'recurring' && <Input label="每题每平台次数（1–20）" type="number" min={1} max={20} value={value.repeats} onChange={event => onChange({ ...value, repeats: Number(event.target.value) })} />}
    <details><summary>选择报告指标（已选 {value.metricIds.length} 项）</summary><div className="grid gap-2 md:grid-cols-2">{GEO_METRICS.metrics.map((metric: { id: string; name: string }) => <label key={metric.id} className="text-caption"><input type="checkbox" checked={value.metricIds.includes(metric.id)} onChange={event => onChange({ ...value, metricIds: event.target.checked ? [...value.metricIds, metric.id] : value.metricIds.filter(id => id !== metric.id) })} /> {metric.name}</label>)}</div></details>
    <label className="text-ui">报告展示<select className={inputClasses()} value={value.reportPresentation} onChange={event => onChange({ ...value, reportPresentation: event.target.value as GeoMeasurementContract['reportPresentation'] })}><option value="summary">简要</option><option value="detailed">详细</option></select></label>
    <label className="text-ui">判断依据<select className={inputClasses()} value={value.sourceBasis} onChange={event => onChange({ ...value, sourceBasis: event.target.value as GeoMeasurementContract['sourceBasis'] })}><option value="answers">本次回答</option><option value="answers_and_project_sources">回答与项目资料</option></select></label>
  </fieldset>;
}

type RecoveryRequest = { requestKey: string; jobIds: string[]; acknowledgeUnknown?: boolean };
function storedRecovery(storageKey: string): RecoveryRequest | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const row = value as Partial<RecoveryRequest>;
    return typeof row.requestKey === 'string' && Array.isArray(row.jobIds) && row.jobIds.length > 0 && row.jobIds.every(id => typeof id === 'string') ? { requestKey: row.requestKey, jobIds: row.jobIds, acknowledgeUnknown: row.acknowledgeUnknown === true } : null;
  } catch { return null; }
}

function DiagnosisProgress({ storageScope, geoId, round, canRun, onRound }: { storageScope: string; geoId: string; round: string; canRun: boolean; onRound: (round: string) => void }) {
  const location = useLocation();
  const recoveryGeneration = useRef({ generation: 0 });
  const runnableNow = useRef(canRun); runnableNow.current = canRun;
  useEffect(() => { const state = recoveryGeneration.current; state.generation++; return () => { state.generation++; }; }, [storageScope, geoId, round, canRun]);
  const [progress, setProgress] = useState<GeoDiagnosisProgress | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const storageKey = `${storageScope}:recover:${round}`;
  const pending = useRef<RecoveryRequest | null>(storedRecovery(storageKey));
  const [selected, setSelected] = useState<string[]>(pending.current?.jobIds ?? []);
  const [ack, setAck] = useState(pending.current?.acknowledgeUnknown ?? false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => { void getGeoDiagnosisProgress(geoId, round, offset).then(value => { if (live) { setProgress(value); setError(''); } }).catch(cause => { if (live) setError(failure(cause)); }); };
    read(); const timer = window.setInterval(read, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [geoId, round, offset]);
  const selectedUnknown = progress?.cells.some(cell => selected.includes(cell.jobId) && cell.deliveryUnknown) || pending.current?.acknowledgeUnknown === true;
  const recover = async () => {
    if (!runnableNow.current) return;
    const generation = recoveryGeneration.current.generation;
    setBusy(true); setError('');
    try {
      const current = await getGeoDiagnosisProgress(geoId, round, offset);
      if (generation !== recoveryGeneration.current.generation || !runnableNow.current) return;
      setProgress(current);
      let candidate = pending.current;
      if (!candidate) {
        const eligible = current.cells.filter(cell => selected.includes(cell.jobId) && cell.recoverable);
        if (eligible.length !== selected.length) throw new Error('所选任务状态已改变，请重新选择。');
        if (eligible.some(cell => cell.deliveryUnknown) && !ack) throw new Error('请确认可能已有计费后再恢复。');
        candidate = { requestKey: key(), jobIds: [...selected], ...(eligible.some(cell => cell.deliveryUnknown) ? { acknowledgeUnknown: ack } : {}) };
      }
      sessionStorage.setItem(storageKey, JSON.stringify(candidate)); pending.current = candidate;
      const result = await recoverGeoDiagnosis(geoId, round, pending.current);
      if (generation !== recoveryGeneration.current.generation || !runnableNow.current) return;
      onRound(result.roundId); sessionStorage.removeItem(storageKey);
    } catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  };
  return <Section title="当前诊断进度" level="sub">
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    {!progress && !error && <p role="status">正在读取进度</p>}
    {progress && <>
      <Note className="my-3" result={['第 ', { n: progress.version }, ` 版 · 总任务 ${progress.counts.total} / 计划 ${progress.planned} · 已完成 ${progress.counts.done} · 等待 ${progress.counts.queued} · 正在处理 ${progress.counts.leased} · 失败 ${progress.counts.failed} · 跳过 ${progress.counts.skipped} · 可恢复 ${progress.counts.recoverable} · 结果未知 ${progress.counts.deliveryUnknown}`]} />
      {progress.recoveryOf && <p className="text-caption text-text-2">本轮为所选失败任务的恢复轮。</p>}
      {progress.absentEngines.length > 0 && <p className="text-caption text-text-2">未取得任务的平台：{progress.absentEngines.map(engineName).join('、')}</p>}
      <div className="overflow-auto"><table className="w-full text-ui"><thead><tr>{['恢复', '原题', '平台', '状态', '回答'].map(title => <th key={title} className="p-2 text-left">{title}</th>)}</tr></thead><tbody>{progress.cells.map(cell => <tr key={cell.jobId}>
        <td className="p-2">{canRun && cell.recoverable && <input type="checkbox" aria-label={`恢复 ${cell.originalId ?? cell.text} ${engineName(cell.engine)}`} disabled={busy || !!pending.current} checked={selected.includes(cell.jobId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, cell.jobId] : previous.filter(id => id !== cell.jobId))} />}</td>
        <td className="p-2 whitespace-pre-wrap">{cell.originalId} {cell.originalGroup} {cell.text}</td><td className="p-2">{engineName(cell.engine)}</td><td className="p-2">{cell.answerStatus === 'refusal' ? '拒答' : cell.deliveryUnknown ? '结果未知，可能已有计费' : ({ queued: '等待', leased: '正在处理', done: '已完成', failed: '失败', skipped: '跳过' }[cell.status] ?? '状态待确认')}{cell.errorCode && <details><summary>失败信息</summary>{jobFailure(cell.errorCode)} · 已尝试 {cell.attempts} 次</details>}</td>
        <td className="p-2">{cell.snapshotId && <Link className="text-accent hover:underline" to={`${answerPath(geoId, cell.snapshotId)}${location.search}`}>查看回答</Link>}</td>
      </tr>)}</tbody></table></div>
      <div className="my-3 flex flex-wrap gap-3"><Button size="sm" disabled={offset === 0 || busy || !!pending.current} onClick={() => { setOffset(Math.max(0, offset - 100)); setSelected([]); }}>上一页</Button><span className="text-caption">{offset + 1}–{offset + progress.page.shown} / {progress.page.total}</span><Button size="sm" disabled={!progress.page.more || busy || !!pending.current} onClick={() => { setOffset(progress.page.nextOffset ?? offset); setSelected([]); }}>下一页</Button></div>
      {canRun && selected.length > 0 && <div className="flex flex-col gap-3">{selectedUnknown && <label className="text-ui"><input type="checkbox" disabled={busy || !!pending.current} checked={ack} onChange={event => setAck(event.target.checked)} /> 我确认结果未知的任务可能已产生计费，再次调用可能重复计费。</label>}<Button disabled={busy} onClick={() => { void recover(); }}>仅恢复所选 {selected.length} 项</Button></div>}
    </>}
  </Section>;
}
