import { GEO_METRICS } from '@evimed/domain';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { getGeoQuestions, type GeoProject, type GeoQuestions } from '@/lib/geoClient';
import { webErrorMessage } from '@/lib/apiClient';
import { mapQuestionRows, readQuestionWorkbook, type QuestionWorkbook, type QuestionMapping } from '@/lib/geoQuestionImport';
import { getGeoDiagnosisProgress, importGeoQuestions, previewGeoQuestions, recoverGeoDiagnosis, startGeoDiagnosis, type GeoDiagnosisProgress, type GeoImportInput, type GeoImportPreview, type GeoMeasurementContract, type GeoQuestionImportRow } from '@/lib/geoQuestionWorkbenchClient';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, inputClasses } from '@/components/ui/Input';
import { Note } from '@/components/ui/Note';
import { Section } from '@/components/ui/Section';
import { AskAi } from './AskAi';
import { engineName, GEO_DEFAULT_ENGINES } from './geoText';
import { answerPath } from './tabs/geoTabText';

const initialContract: GeoMeasurementContract = { samplingMode: 'one_shot', repeats: 1, engines: [...GEO_DEFAULT_ENGINES], metricIds: ['M-01S', 'M-06', 'M-08'], reportPresentation: 'summary', sourceBasis: 'answers_and_project_sources' };
// eslint-disable-next-line no-restricted-syntax -- Parser validation messages are owned Chinese text; HTTP refusals still use webErrorMessage.
const failure = (error: unknown) => webErrorMessage(error, { fallback: error instanceof Error ? error.message : '操作未完成，请重试。' });
const key = () => crypto.randomUUID();

/** Version editing and diagnosis are deliberate writes; viewing or importing never starts sampling. */
export function GeoQuestionWorkbench({ geoId, project, data, onSaved }: { geoId: string; project: GeoProject; data: GeoQuestions; onSaved: (version: number) => void }) {
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [book, setBook] = useState<QuestionWorkbook | null>(null);
  const [sheet, setSheet] = useState(0);
  const [mapping, setMapping] = useState<QuestionMapping>({});
  const [rows, setRows] = useState<GeoQuestionImportRow[]>([]);
  const [blank, setBlank] = useState(0);
  const [contract, setContract] = useState<GeoMeasurementContract>(data.contract ?? initialContract);
  const [preview, setPreview] = useState<GeoImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const pendingImport = useRef<(GeoImportInput & { requestKey: string }) | null>(null);
  const pendingStart = useRef<{ version: number; requestKey: string } | null>(null);
  const canEdit = !project.access || project.access.abilities.includes('edit');
  const canRun = !project.access || project.access.abilities.includes('run');
  const version = saved ?? data.version;
  const round = params.get('diagnosisRound');
  const target = { geoId, projectId: project.projectId, sessionId: project.sessionId };
  const selectRound = (roundId: string) => { sessionStorage.setItem(`geo-diagnosis:${geoId}`, roundId); setParams(previous => { const next = new URLSearchParams(previous); next.set('diagnosisRound', roundId); return next; }, { replace: true }); };
  useEffect(() => { const prior = sessionStorage.getItem(`geo-diagnosis:${geoId}`); if (!round && prior) setParams(previous => { const next = new URLSearchParams(previous); next.set('diagnosisRound', prior); return next; }, { replace: true }); }, [geoId, round, setParams]);
  useEffect(() => { if (!editing) setContract(data.contract ?? initialContract); }, [data.contract, editing]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); } };
  const updateRow = (index: number, patch: Partial<GeoQuestionImportRow>) => { setRows(previous => previous.map((row, at) => at === index ? { ...row, ...patch } : row)); changed(); };
  const changed = () => { setPreview(null); pendingImport.current = null; };
  const editExisting = () => { void act(async () => {
    if (data.version == null) throw new Error('请先选择一个问句版本再编辑。');
    const complete = data.selection ? await getGeoQuestions(geoId, data.version) : data;
    setBook(null); setContract(complete.contract ?? initialContract);
    const originals = complete.groups.flatMap(group => group.questions.map(question => ({ group, question })));
    originals.sort((a, b) => (a.question.originalRowIndex ?? Number.MAX_SAFE_INTEGER) - (b.question.originalRowIndex ?? Number.MAX_SAFE_INTEGER));
    setRows(originals.map(({ group, question }) => ({ text: question.text, originalId: question.originalId, originalGroup: question.originalGroup, clientTags: question.clientTags, kind: question.kind, sourceUrl: question.sourceUrl, collectedAt: question.collectedAt, isMeasured: question.isMeasured, pool: group.pool, journeyStage: group.journeyStage, audience: group.audience, classificationStatus: question.classificationStatus })));
    changed(); setEditing(true); setSaved(null);
  }); };
  const loadFile = (file: File) => { void act(async () => {
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('请选择 Excel 或 CSV 文件。');
    if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请拆分后导入。');
    const next = await readQuestionWorkbook(await file.arrayBuffer()); setBook(next); setSheet(0); setMapping({}); setRows([]); changed();
  }); };
  const start = () => { void act(async () => {
    if (version == null) throw new Error('请先保存问句版本。');
    // Keep the same opaque key on a lost response: the server returns the existing round.
    if (!pendingStart.current || pendingStart.current.version !== version) { const stored = sessionStorage.getItem(`geo-diagnosis-start:${geoId}:${version}`); pendingStart.current = { version, requestKey: stored ?? key() }; sessionStorage.setItem(`geo-diagnosis-start:${geoId}:${version}`, pendingStart.current.requestKey); }
    const result = await startGeoDiagnosis(geoId, version, pendingStart.current.requestKey);
    await getGeoDiagnosisProgress(geoId, result.roundId);
    selectRound(result.roundId);
  }); };
  return <Section title="问句整理与诊断" level="sub">
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && <Button size="sm" onClick={() => { setEditing(true); setSaved(null); }}>导入问句</Button>}
      {canEdit && data.groups.length > 0 && data.version != null && <Button size="sm" variant="text" onClick={editExisting}>编辑为新版本</Button>}
      {version != null && <AskAi project={target} label="建议分类" draft={`/geo-insight 请读取第 ${version} 版完整原题，仅建议测量池、人群、阶段与分类状态。保留原题、编号、客户分组与原标签，输出带原编号的可导入表格，建议不覆盖客户原分类；用户采用后另存新版本。`} />}{version != null && <AskAi project={target} label="检查覆盖" draft={`/geo-insight 请检查第 ${version} 版问句覆盖，读取该版本原题、已有资料和旅程人群，指出具体缺口与依据，不编造配额。保留原分类，建议另列，输出可编辑的新版本问句表，不自动采样。`} />}
      {version != null && canRun && <Button size="sm" disabled={busy} onClick={start}>{busy ? '正在处理' : `启动第 ${version} 版诊断`}</Button>}
    </div>
    {version != null && <Note className="my-3" result={['第 ', { n: version }, ` 版 · ${data.contract?.samplingMode === 'recurring' ? '重复采样' : '单次采样'} · ${(data.contract?.engines ?? contract.engines).map(engineName).join('、')}。单次结果描述本次回答，不代表稳定概率。`]} action={canEdit ? <Button size="sm" variant="text" onClick={editExisting}>调整口径</Button> : undefined} />}
    {editing && <div className="my-4 flex flex-col gap-4">
      <Input type="file" label="选择 Excel / CSV（首行为列名，最多 400 题、10 MB）" accept=".xlsx,.xls,.csv" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) loadFile(file); }} />
      {book && <>
        <label className="text-ui text-text">工作表<select aria-label="工作表" className={inputClasses()} value={sheet} onChange={event => { setSheet(Number(event.target.value)); setRows([]); setMapping({}); changed(); }}>{book.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label>
        <div className="grid gap-3 md:grid-cols-2">{(['text', 'originalId', 'originalGroup', 'clientTags'] as const).map((field, index) => <label key={field} className="text-ui text-text">{['原题文本', '原编号', '客户原分类', '客户原标签'][index]}<select className={inputClasses()} value={mapping[field] ?? ''} onChange={event => { setMapping(previous => ({ ...previous, [field]: event.target.value === '' ? undefined : Number(event.target.value) })); changed(); setRows([]); }}><option value="">请选择列</option>{book.sheets[sheet].rows[0]?.map((name, column) => <option key={column} value={column}>{column + 1} · {name || '未命名'}</option>)}</select></label>)}</div>
        <Button size="sm" disabled={busy} onClick={() => { void act(async () => { const mapped = mapQuestionRows(book.sheets[sheet].rows, mapping); setRows(mapped.rows); setBlank(mapped.excludedBlankRows); changed(); }); }}>读取映射行</Button>
      </>}
      <ContractFields value={contract} disabled={busy || !!pendingImport.current} onChange={next => { setContract(next); changed(); }} />
      {rows.length > 0 && <>
        <Note result={[`实际 ${rows.length} 题 · 已排除全空行 `, { n: blank }, " 行。重复原题保留；客户标签与平台分类分列。"]} />
        <div className="max-h-96 overflow-auto"><table className="w-full text-caption"><thead><tr>{['原编号 / 客户分类 / 原标签', '原题（完整文本）', '平台补充分类', '参与测量'].map(title => <th key={title} className="p-2 text-left">{title}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>
          <td className="p-2 align-top whitespace-pre-wrap">{row.originalId ?? '—'} / {row.originalGroup ?? '—'} / {row.clientTags?.join('、') || '—'}</td>
          <td className="p-2"><Textarea aria-label={`第 ${index + 1} 题文本`} value={row.text} disabled={busy || !!pendingImport.current} onChange={event => { setRows(previous => previous.map((item, at) => at === index ? { ...item, text: event.target.value } : item)); changed(); }} /></td>
          <td className="p-2"><select aria-label={`第 ${index + 1} 题测量池`} className={inputClasses()} value={row.pool ?? ''} disabled={busy || !!pendingImport.current} onChange={event => { const pool = (event.target.value || null) as GeoQuestionImportRow['pool']; setRows(previous => previous.map((item, at) => at === index ? { ...item, pool, classificationStatus: 'confirmed' } : item)); changed(); }}><option value="">未分类</option>{['P1', 'P2', 'P3', 'P4'].map(pool => <option key={pool}>{pool}</option>)}</select><details><summary>人群、阶段与来源</summary><fieldset disabled={busy || !!pendingImport.current}><Input label={`第 ${index + 1} 题旅程阶段`} value={row.journeyStage ?? ''} onChange={event => updateRow(index, { journeyStage: event.target.value || null, classificationStatus: 'confirmed' })} /><label>人群<select className={inputClasses()} value={row.audience ?? ''} onChange={event => updateRow(index, { audience: (event.target.value || null) as GeoQuestionImportRow['audience'], classificationStatus: 'confirmed' })}><option value="">未分类</option>{Object.entries({ patient: '患者', physician: '医生', caregiver: '照护者', pharmacist: '药师', institution: '机构', other: '其他' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>问句性质<select className={inputClasses()} value={row.kind ?? 'client'} onChange={event => updateRow(index, { kind: event.target.value as GeoQuestionImportRow['kind'] })}><option value="client">客户原题</option><option value="typical">典型 / 模型建议</option><option value="real">有来源真实问法</option><option value="label_safety">说明书安全题</option></select></label><Input label={`第 ${index + 1} 题来源链接`} value={row.sourceUrl ?? ''} onChange={event => updateRow(index, { sourceUrl: event.target.value || null })} /><Input label={`第 ${index + 1} 题采集日期`} value={row.collectedAt ?? ''} onChange={event => updateRow(index, { collectedAt: event.target.value || null })} /><label>分类状态<select className={inputClasses()} value={row.classificationStatus ?? 'unclassified'} onChange={event => updateRow(index, { classificationStatus: event.target.value as GeoQuestionImportRow['classificationStatus'] })}><option value="unclassified">未分类</option><option value="suggested">建议，待采用</option><option value="confirmed">已采用</option></select></label></fieldset></details></td>
          <td className="p-2"><input type="checkbox" aria-label={`测量第 ${index + 1} 题`} checked={row.isMeasured !== false} disabled={busy || !!pendingImport.current} onChange={event => { setRows(previous => previous.map((item, at) => at === index ? { ...item, isMeasured: event.target.checked } : item)); changed(); }} /></td>
        </tr>)}</tbody></table></div>
        <Button size="sm" disabled={busy} onClick={() => { void act(async () => { setPreview(await previewGeoQuestions(geoId, { rows, contract })); }); }}>核对导入预览</Button>
        {preview && <div className="flex flex-col gap-3"><p className="text-ui text-text">实际 {preview.actualRows} 题 · 测量 {preview.measuredRows} 题 · 计划 {preview.plannedCalls} 次调用 · 疑似重复 {preview.duplicateCandidates.length} 组（全部保留）</p>{preview.duplicateCandidates.map((item, index) => <p key={index} className="text-caption text-text-2">疑似重复行：{item.rowIndexes.map(row => row + 1).join('、')}</p>)}<Button disabled={busy || preview.plannedCalls > 5000} onClick={() => { void act(async () => { pendingImport.current ??= { rows, contract, requestKey: key() }; const result = await importGeoQuestions(geoId, pendingImport.current); pendingImport.current = null; setSaved(result.version); setEditing(false); onSaved(result.version); }); }}>保存为新版本</Button></div>}
      </>}
      <Button size="sm" variant="text" disabled={busy} onClick={() => setEditing(false)}>收起整理</Button>
    </div>}
    {error && <p role="alert" className="my-3 text-ui text-error">{error}</p>}
    {round && <DiagnosisProgress key={round} geoId={geoId} round={round} canRun={canRun} onRound={selectRound} />}
  </Section>;
}

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

function DiagnosisProgress({ geoId, round, canRun, onRound }: { geoId: string; round: string; canRun: boolean; onRound: (round: string) => void }) {
  const location = useLocation();
  const [progress, setProgress] = useState<GeoDiagnosisProgress | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const storageKey = `geo-diagnosis-recover:${geoId}:${round}`;
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
  const recover = async () => {
    setBusy(true); setError('');
    try {
      const current = await getGeoDiagnosisProgress(geoId, round, offset); setProgress(current);
      if (!pending.current) {
        const eligible = current.cells.filter(cell => selected.includes(cell.jobId) && cell.recoverable);
        if (eligible.length !== selected.length) throw new Error('所选任务状态已改变，请重新选择。');
        if (eligible.some(cell => cell.deliveryUnknown) && !ack) throw new Error('请确认可能已有计费后再恢复。');
        pending.current = { requestKey: key(), jobIds: [...selected], acknowledgeUnknown: ack };
        sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
      }
      const result = await recoverGeoDiagnosis(geoId, round, pending.current); sessionStorage.removeItem(storageKey); onRound(result.roundId);
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
        <td className="p-2 whitespace-pre-wrap">{cell.originalId} {cell.originalGroup} {cell.text}</td><td className="p-2">{engineName(cell.engine)}</td><td className="p-2">{cell.answerStatus === 'refusal' ? '拒答' : cell.deliveryUnknown ? '结果未知，可能已有计费' : ({ queued: '等待', leased: '正在处理', done: '已完成', failed: '失败', skipped: '跳过' }[cell.status] ?? '状态待确认')}{cell.errorCode && <details><summary>失败信息</summary>{cell.errorCode} · 已尝试 {cell.attempts} 次</details>}</td>
        <td className="p-2">{cell.snapshotId && <Link className="text-accent hover:underline" to={`${answerPath(geoId, cell.snapshotId)}${location.search}`}>查看回答</Link>}</td>
      </tr>)}</tbody></table></div>
      <div className="my-3 flex flex-wrap gap-3"><Button size="sm" disabled={offset === 0 || busy || !!pending.current} onClick={() => { setOffset(Math.max(0, offset - 100)); setSelected([]); }}>上一页</Button><span className="text-caption">{offset + 1}–{offset + progress.page.shown} / {progress.page.total}</span><Button size="sm" disabled={!progress.page.more || busy || !!pending.current} onClick={() => { setOffset(progress.page.nextOffset ?? offset); setSelected([]); }}>下一页</Button></div>
      {canRun && selected.length > 0 && <div className="flex flex-col gap-3"><label className="text-ui"><input type="checkbox" disabled={busy || !!pending.current} checked={ack} onChange={event => setAck(event.target.checked)} /> 我确认结果未知的任务可能已产生计费，再次调用可能重复计费。</label><Button disabled={busy} onClick={() => { void recover(); }}>仅恢复所选 {selected.length} 项</Button></div>}
    </>}
  </Section>;
}
