import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { validateScenario, validateLongitudinalScenario } from "@evimed/domain";
import { cancelVcrJob, createVcrStudy, getVcrData, getVcrHome, getVcrJob, getVcrMethodHistory, getVcrMethodConfiguration, getVcrPopulation, getVcrModels, saveVcrMethodConfiguration, queueVcrJob, type VcrJob, type VcrQualityBasis } from "@/lib/vcrClient";
import { getVcrLongitudinal } from "@/lib/vcrLongitudinalClient";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input, Select } from "@/components/ui/Input";
import { Toolbar } from "@/components/ui/Toolbar";
import { STICKY_BELOW_BAND } from "@/components/layout/chrome";
import { Section } from "@/components/ui/Section";
import { safeLink } from "@/lib/frontierClient";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";
import { ScenarioField, examples, schemas, fieldLabel } from "./VcrScenarioEditor";
import { methodKind, methodPurpose, methodTitle, patientModes, methodNeedsSnapshot, stripMethodScopeRefs, unboundMethodScenario, initialMethodScenario, fixedMethodEndpoint, knownJobProgress, type VcrMethod } from "@/lib/vcrMethodDisplay";
import { methodFieldText } from "./vcrMethodFieldText";
import { VcrForecastMethodInputs, forecastPrerequisite } from "./VcrForecastMethodInputs";
import { VcrModelAdoptDialog } from "./VcrModelAdoptDialog";
import { VcrUseMethodInStudy } from "./VcrUseMethodInStudy";
import { VcrBoundSourceRecord } from "./VcrBoundSourceRecord";
import { VcrPopulationQualityInputs, qualityInputProblem } from "./VcrPopulationQualityInputs";
import { VcrReconstructionInput, reconstructionProblem } from "./VcrReconstructionInput";
import { VcrMethodResult } from "./VcrMethodResult";
export { schemaDefault } from "./VcrScenarioEditor";
export { methodKind, methodTask } from "@/lib/vcrMethodDisplay";

export interface MethodSourceModel { id: string; version?: string | null; studyId?: string | null; scenario: Record<string, unknown> }
export interface VcrMethodRunnerProps {
  method: VcrMethod;
  methods?: VcrMethod[];
  onClose?: () => void;
  initialJobId?: string;
  initialStudyId?: string;
  initialScenario?: Record<string, unknown>;
  showTitle?: boolean;
  sourceModel?: MethodSourceModel;
  studyId?: string;
  projectId?: string;
  onUse?: (configuration: { studyId: string; subjectId: string | null; scenario: Record<string, unknown> }) => void;
}
interface InputAdmission { scope: string; reason: string | null; loading: boolean }
interface Frozen { reconstructionResultId: string | null; reconstructionResultAvailable: boolean | null; studyId: string; method: string; qualityBasis: VcrQualityBasis | null; qualityBasisAvailable: boolean | null; scenario: Record<string, unknown>; seed: string; snapshots: string[]; replicates: string; model: { id: string; version: string | null } | null; subjectId: string | null }
const liveJob = (job: VcrJob | null) => Boolean(job && ["queued", "running", "awaiting_budget"].includes(job.state));

/** Shared main-area workbench: domain form, existing queue, immutable job result. */
export function VcrMethodRunner(props: VcrMethodRunnerProps) { return <MethodWorkbench key={props.studyId ?? "global"} {...props} />; }
function MethodWorkbench({ method, methods = [], onClose, sourceModel, studyId: embeddedStudy, onUse, initialJobId, initialStudyId, initialScenario, showTitle = true }: VcrMethodRunnerProps) {
  const [selectedMethod, setSelectedMethod] = useState(method);
  const engineMethod = selectedMethod.method ?? selectedMethod.id;
  const schema = schemas[engineMethod];
  const forecast = engineMethod.startsWith("forecast.");
  const kind = methodKind(engineMethod);
  const studies = useVcrLoad("method:studies", getVcrHome);
  const [studyId, setStudyId] = useState(embeddedStudy ?? initialStudyId ?? "");
  const [extraStudy, setExtraStudy] = useState<{ id: string; name: string } | null>(null);
  const [scenario, setScenario] = useState<Record<string, unknown>>(initialMethodScenario(engineMethod, initialScenario ?? sourceModel?.scenario ?? {}));
  const [seed, setSeed] = useState("42");
  const [replicates, setReplicates] = useState("");
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<Frozen["model"]>(sourceModel ? { id: sourceModel.id, version: sourceModel.version ?? null } : null);
  const [reconstructionResultId, setReconstructionResultId] = useState<string | null>(null);
  const [reconstructionResultAvailable, setReconstructionResultAvailable] = useState<boolean | null>(null);
  const [qualityBasis, setQualityBasis] = useState<VcrQualityBasis | null>(null);
  const [qualityBasisAvailable, setQualityBasisAvailable] = useState<boolean | null>(null);
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [job, setJob] = useState<VcrJob | null>(null);
  const [jobStudy, setJobStudy] = useState("");
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [usingLiterature, setUsingLiterature] = useState(false);
  const modeDrafts = useRef<Record<string, Frozen>>({});
  const [inputAdmission, setInputAdmission] = useState<InputAdmission>({ scope: "", reason: null, loading: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"configuration" | "result">("configuration");
  const holding = useRef(false);
  const openedHistory = useRef("");
  const mounted = useRef(true);
  const sourceRequest = useRef(0);
  const editEpoch = useRef(0);
  const currentScope = useRef({ studyId, method: engineMethod });
  currentScope.current = { studyId, method: engineMethod };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sourceRequest.current += 1; }; }, []);
  const live = liveJob(job);
  const jobId = job?.id;
  const modes = patientModes(methods);
  const isPatientEntry = patientModes([method]).length > 0;
  const description = methodPurpose(selectedMethod);
  useEffect(() => {
    if (!live || !jobId || !jobStudy) return;
    let disposed = false;
    const timer = window.setInterval(() => { void getVcrJob(jobStudy, jobId).then(next => { if (!disposed) { setJob(next); setError(null); } }).catch(failure => { if (!disposed) setError(webErrorMessage(failure, { fallback: "无法读取运行进度，请重试。" })); }); }, 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [live, jobId, jobStudy]);
  const boundReconstructionPending = engineMethod === "comparator.maic_time_to_event" && Boolean(reconstructionResultId) && reconstructionResultAvailable !== false;
  const problems = (forecast ? validateLongitudinalScenario(engineMethod, scenario) : schema ? validateScenario(engineMethod, scenario) : []).filter(problem => !(boundReconstructionPending && problem.code === "scenario_field_missing" && problem.field === "scenario.pseudoIpdInputId"));
  const validReplicates = replicates === "" || (/^\d+$/.test(replicates) && Number(replicates) > 0);
  const validSeed = /^\d+$/.test(seed) && Number(seed) <= 2147483647;
  const admissionMatches = inputAdmission.scope === `${studyId}:${engineMethod}`;
  const runReason = usingLiterature ? "保存并应用文献参数后再运行。" : !studyId ? "先选择保存位置或新建独立计算。" : !admissionMatches || inputAdmission.loading ? "正在读取此配置的可用输入。" : inputAdmission.reason ?? (problems.length ? "请补齐或修正下方标记的参数。" : !validSeed || !validReplicates ? "请修正随机与重复设置。" : null);
  function editScenario(next: Record<string, unknown>) {
    if (holding.current || live) return;
    editEpoch.current += 1;
    setScenario(unboundMethodScenario(engineMethod, next));
    // Edited parameters are a user scenario, never a quotation from a model version.
    if (activeModel) setActiveModel(null);
  }
  function currentDraft(): Frozen { return { reconstructionResultId, reconstructionResultAvailable, studyId, method: engineMethod, qualityBasis, qualityBasisAvailable, scenario: structuredClone(scenario), seed, snapshots: [...snapshots], replicates, model: activeModel, subjectId }; }
  function restore(config: Frozen, targetStudy = studyId, targetMethod = engineMethod) {
    if (config.method !== targetMethod) { setError("此配置属于其他终点方法，请从对应方法的历史记录打开。"); return; }
    const sameStudy = config.studyId === targetStudy;
    setScenario(unboundMethodScenario(config.method, sameStudy ? config.scenario : stripMethodScopeRefs(config.scenario) as Record<string, unknown>));
    setSeed(config.seed); setSnapshots(sameStudy ? [...config.snapshots] : []); setReplicates(config.replicates); setActiveModel(config.model);
    setReconstructionResultId(sameStudy ? config.reconstructionResultId : null); setReconstructionResultAvailable(sameStudy ? config.reconstructionResultAvailable : null);
    setSubjectId(sameStudy ? config.subjectId : null); setQualityBasis(sameStudy ? config.qualityBasis : null); setQualityBasisAvailable(sameStudy ? config.qualityBasisAvailable : null);
  }
  function chooseStudy(next: string) {
    editEpoch.current += 1;
    modeDrafts.current[`${studyId}:${engineMethod}`] = currentDraft();
    const held = modeDrafts.current[`${next}:${engineMethod}`];
    setStudyId(next);
    if (held) restore(held, next); else restore(currentDraft(), next);
    setJob(null); setFrozen(null); setJobStudy("");
  }
  async function createCalculation() {
    if (holding.current || live) return;
    holding.current = true; setBusy(true); setError(null);
    try { const created = await createVcrStudy({ name: "独立计算", purpose: "calculation" }); setExtraStudy({ id: created.id, name: "独立计算" }); chooseStudy(created.id); studies.reload(); }
    catch (failure) { setError(webErrorMessage(failure, { fallback: "计算空间未能创建，请重试。" })); }
    finally { holding.current = false; setBusy(false); }
  }
  async function run() {
    if (holding.current || live || !kind || runReason) return;
    holding.current = true; setBusy(true); setError(null);
    try {
      const configuration = await saveVcrMethodConfiguration(studyId, { method: engineMethod, name: selectedMethod.name, scenario, ...(subjectId ? { subjectId } : {}), ...(activeModel ? { modelId: activeModel.id } : {}), ...(engineMethod === "comparator.maic_time_to_event" && reconstructionResultId ? { reconstructionResultId } : {}) });
      if (reconstructionResultId && (configuration.reconstructionResultId !== reconstructionResultId || !configuration.scenario)) throw new Error("无法确认所选重建结果，当前参数已保留，请重新读取后再试。");
      const preparedScenario = configuration.scenario ?? scenario;
      setScenario(preparedScenario);
      setSubjectId(configuration.subjectId);
      const next = await queueVcrJob(studyId, { kind, scenario: preparedScenario, ...(engineMethod === "comparator.maic_time_to_event" && reconstructionResultId ? { reconstructionResultId } : {}), ...(configuration.subjectId ? { subjectId: configuration.subjectId } : {}), ...(activeModel ? { modelId: activeModel.id } : {}), seed: Number(seed), ...(replicates ? { replicates: Number(replicates) } : {}), ...(qualityBasis && engineMethod === "population.quality" ? { qualityBasis } : {}), inputs: snapshots.map(id => ({ kind: "snapshot" as const, id })) });
      setJobStudy(studyId); setJob(next); setFrozen({ reconstructionResultId, reconstructionResultAvailable, studyId, method: engineMethod, qualityBasis, qualityBasisAvailable, scenario: structuredClone(preparedScenario), seed, snapshots: [...snapshots], replicates, model: activeModel, subjectId: configuration.subjectId }); setPanel("result");
    } catch (failure) { setError(webErrorMessage(failure, { fallback: "运行未能开始，请检查输入后重试。" })); }
    finally { holding.current = false; setBusy(false); }
  }
  async function openHistory(previous: VcrJob) {
    if (holding.current || live) return;
    holding.current = true; setBusy(true); setError(null);
    try {
      const config = await getVcrMethodConfiguration(studyId, previous.id);
      if (config.kind !== kind) throw new Error("请选择此方法的历史运行。");
      const saved: Frozen = { reconstructionResultId: config.reconstructionResultId ?? null, reconstructionResultAvailable: config.reconstructionResultAvailable ?? null, studyId, method: engineMethod, qualityBasis: config.qualityBasis ?? null, qualityBasisAvailable: config.qualityBasisAvailable ?? null, scenario: structuredClone(config.scenario), seed: String(config.seed ?? 42), replicates: config.replicates == null ? "" : String(config.replicates), snapshots: config.inputRefs.map(input => input.id), model: config.sourceModel ?? null, subjectId: config.subjectId ?? null };
      restore(saved); setFrozen(saved); setJob(previous); setJobStudy(studyId); setPanel("result");
      if (config.reconstructionResultAvailable === false) setError("历史所用重建结果已不可复用。原结果保留，请明确选择重建版本后再运行。");
      if (config.qualityBasisAvailable === false) setError("历史人群生成依据已不可复用。原结果保留，请明确重新选择人群生成版本后再运行。");
      if (config.unavailableInputs > 0) setError("已打开原始结果；部分原始数据无法复用，请在配置中重新选择数据后运行。");
    } catch (failure) { setError(webErrorMessage(failure, { fallback: "无法读取此运行，请重试。" })); }
    finally { holding.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!initialJobId || !studyId || studyId !== (initialStudyId ?? embeddedStudy) || openedHistory.current === `${studyId}:${initialJobId}`) return;
    openedHistory.current = `${studyId}:${initialJobId}`;
    let active = true;
    void getVcrJob(studyId, initialJobId).then(previous => { if (active) return openHistory(previous); }).catch(failure => { if (active) setError(webErrorMessage(failure, { fallback: "无法读取历史运行，请重试。" })); });
    return () => { active = false; openedHistory.current = ""; };
    // The addressed job is loaded once; editing its restored form must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJobId, studyId, initialStudyId, embeddedStudy]);
  const applySavedLiterature = async (saved?: { id: string }) => {
    if (!saved || holding.current) return;
    const request = ++sourceRequest.current;
    const origin = { studyId, method: engineMethod, edit: editEpoch.current };
    holding.current = true; setBusy(true); setError(null);
    try {
      const library = await getVcrModels();
      if (!mounted.current || request !== sourceRequest.current || currentScope.current.studyId !== origin.studyId || currentScope.current.method !== origin.method || editEpoch.current !== origin.edit) return;
      const model = library.models.find(row => row.id === saved.id);
      if (!model?.executionSpec) { setError("文献来源已保存，尚缺可运行的参数映射；当前配置已保留。"); return; }
      const matched = library.methods.find(row => row.method === model.executionSpec?.method);
      if (model.executionSpec.method !== engineMethod && !(isPatientEntry && matched && patientModes([matched]).length)) { setError("文献参数已保存；其参考场景与当前方法不同，当前输入已保留，可从文献参数库选择相应方法。"); return; }
      if (matched) setSelectedMethod(matched);
      setScenario({ ...structuredClone(model.executionSpec.scenario), ...(scenario.design ? { design: structuredClone(scenario.design) } : {}) }); setSubjectId(null); setActiveModel({ id: model.id, version: model.version ?? null });
    } catch (failure) { if (mounted.current && request === sourceRequest.current) setError(webErrorMessage(failure, { fallback: "来源已保存，但参数暂时未能载入；当前输入已保留。" })); }
    finally { if (mounted.current && request === sourceRequest.current) { holding.current = false; setBusy(false); } }
  };
  const configuration = usingLiterature ? <VcrModelAdoptDialog submitLabel="保存并用于当前配置" initialStudyId={studyId || undefined} onClose={() => setUsingLiterature(false)} onSaved={saved => { void applySavedLiterature(saved); }} /> : <div className="flex min-w-0 flex-col gap-4">
    {!embeddedStudy && <>
      {studies.state.kind === "loading" ? <VcrTabSkeleton rows={1} /> : studies.state.kind === "error" ? <VcrTabError message={studies.state.message} onRetry={studies.reload} /> : <Select label="保存到研究或独立计算" value={studyId} disabled={live || busy} onChange={event => chooseStudy(event.target.value)}><option value="">请选择保存位置</option>{studies.state.data.studies.map(study => <option key={study.id} value={study.id}>{study.name}</option>)}{extraStudy && !studies.state.data.studies.some(study => study.id === extraStudy.id) && <option value={extraStudy.id}>{extraStudy.name}</option>}</Select>}
      <Button size="sm" className="self-start" variant="text" loading={busy} disabled={busy || live} onClick={() => void createCalculation()}>新建独立计算</Button>
    </>}
    {isPatientEntry && modes.length > 1 && <Select label="模拟结局类型" disabled={live || busy} value={engineMethod} onChange={event => { const next = modes.find(row => row.method === event.target.value); if (next) { modeDrafts.current[`${studyId}:${engineMethod}`] = currentDraft();
      editEpoch.current += 1; setSelectedMethod(next); const nextMethod = next.method ?? next.id; const held = modeDrafts.current[`${studyId}:${nextMethod}`];
      if (held) restore(held, studyId, nextMethod); else { setReconstructionResultId(null); setReconstructionResultAvailable(null); setQualityBasis(null); setQualityBasisAvailable(null); setSubjectId(null); setActiveModel(null); setScenario(initialMethodScenario(nextMethod)); setSnapshots([]); }
      setJob(null); setFrozen(null); setJobStudy(""); } }} >{modes.map(row => <option key={row.id} value={row.method}>{({ "patients.binary": "二分类结局", "patients.continuous": "连续结局", "patients.time_to_event": "生存结局", "patients.longitudinal": "纵向结局" })[row.method ?? ""] ?? row.name}</option>)}</Select>}
    <Button size="sm" className="self-start" variant="text" disabled={live || busy} onClick={() => setUsingLiterature(true)}>使用文献参数</Button>
    {!kind || (!schema && !forecast) ? <Note action={null}>{description.purpose}{studyId && <Link className="ml-2 text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(studyId)}/${engineMethod === "matching.evaluate" ? "matching" : "data"}`}>{description.action}</Link>}{!studyId && <Link className="ml-2 text-link hover:underline" to="/app/virtual-research">选择或建立研究</Link>}</Note> : <>
      <form className="flex flex-col gap-4" onSubmit={event => event.preventDefault()}>
        {examples[engineMethod]?.length > 0 && <Disclosure summary="载入可编辑示例"><Note action={<div className="flex flex-col items-start gap-2">{examples[engineMethod].map((example, index) => <Button key={index} type="button" variant="secondary" disabled={busy || live} onClick={() => editScenario(structuredClone(example.scenario))}>{example.label}</Button>)}</div>}>载入后可修改每项输入，点击运行才会计算。</Note></Disclosure>}
        {activeModel && <><Note action={null}>正在使用文献参数版本 {activeModel.version ?? "未记录"}。编辑数值后将保存为用户情景。</Note><VcrBoundSourceRecord modelId={activeModel.id} version={activeModel.version} /></>}
        {schema && engineMethod !== "population.quality" && <fieldset disabled={busy || live} className="min-w-0"><ScenarioField title="方法参数" method={engineMethod} schema={schema} hiddenFields={engineMethod === "comparator.maic_time_to_event" ? ["pseudoIpdInputId"] : fixedMethodEndpoint(engineMethod) && (scenario.endpoint as Record<string, unknown> | undefined)?.type === fixedMethodEndpoint(engineMethod) ? ["endpoint"] : []} value={scenario} root={scenario} change={next => editScenario(next as Record<string, unknown>)} /></fieldset>}
        {studyId && <MethodInputs key={`${studyId}:${engineMethod}`} studyId={studyId} method={engineMethod} scenario={scenario} change={editScenario} snapshots={snapshots} setSnapshots={setSnapshots} reconstructionResultId={reconstructionResultId} reconstructionResultAvailable={reconstructionResultAvailable} setReconstructionResultId={id => { setReconstructionResultId(id); setReconstructionResultAvailable(id ? true : null); }} qualityBasis={qualityBasis} qualityBasisAvailable={qualityBasisAvailable} setQualityBasis={basis => { setQualityBasis(basis); setQualityBasisAvailable(basis ? true : null); }} setSubjectId={setSubjectId} disabled={busy || live} onAdmissionChange={setInputAdmission} />}
        {!studyId && <Note action={null}>选择保存位置或新建独立计算后即可运行；当前输入会保留。</Note>}
        <Disclosure summary="随机与重复设置"><div className="flex flex-col gap-3"><Input label="随机种子" type="number" min={0} max={2147483647} step={1} disabled={busy || live} value={seed} error={!validSeed ? "填写 0 至 2147483647 的整数" : undefined} onChange={event => { if (!holding.current && !live) { editEpoch.current += 1; setSeed(event.target.value); } }} /><Input label="重复计算次数" type="number" min={1} step={1} disabled={busy || live} value={replicates} hint="留空时使用方法默认值。" error={!validReplicates ? "填写正整数" : undefined} onChange={event => { if (!holding.current && !live) { editEpoch.current += 1; setReplicates(event.target.value); } }} /></div></Disclosure>
        {problems.length > 0 && <ul className="text-caption text-error" aria-label="参数问题">{problems.slice(0, 12).map((problem, index) => <li key={index}>{methodFieldText(engineMethod, problem.field.replace(/^scenario\.?/, ""), {}, scenario, problem.field.replace(/^scenario\.?/, "").split(".").map(fieldLabel).join(" / ")).label}：{["scenario_field_missing", "scenario_field_required"].includes(problem.code) ? "请补充此参数或选择其中一项。" : "请检查此参数的取值、范围和适用条件。"}</li>)}</ul>}
      </form>
    </>}
    {kind && (schema || forecast) && <VcrUseMethodInStudy method={engineMethod} name={selectedMethod.name} scenario={scenario} modelId={activeModel?.id} valid={!problems.length} disabled={busy || live} onUse={onUse} />}
    <Disclosure summary="科学假设与方法依据"><div className="space-y-3 text-caption text-text-2">{selectedMethod.assumptions?.length ? <ul className="list-disc pl-5">{selectedMethod.assumptions.map((item, index) => <li key={index}>{item.text}（{item.source}）</li>)}</ul> : <p>适用假设尚未说明。</p>}<p>方法版本：{selectedMethod.version ?? "未说明"}。{selectedMethod.numeric ? `${selectedMethod.numeric}。` : ""}数值参考用例不代表临床适用性。</p>{selectedMethod.validation?.ciUrl && safeLink(selectedMethod.validation.ciUrl) && <a href={safeLink(selectedMethod.validation.ciUrl) ?? undefined} target="_blank" rel="noreferrer" className="text-link hover:underline">查看验证来源</a>}</div></Disclosure>
    {studyId && kind && <MethodHistory studyId={studyId} kind={kind} revision={job?.id ?? ""} title={selectedMethod.name} disabled={busy || live} onOpen={openHistory} />}
  </div>;
  const editedSinceRun = Boolean(job && frozen && (frozen.studyId !== studyId || frozen.method !== engineMethod || JSON.stringify(frozen.scenario) !== JSON.stringify(scenario) || frozen.seed !== seed || frozen.replicates !== replicates || JSON.stringify(frozen.snapshots) !== JSON.stringify(snapshots) || JSON.stringify(frozen.qualityBasis) !== JSON.stringify(qualityBasis) || frozen.reconstructionResultId !== reconstructionResultId));
  const progress = knownJobProgress(job?.progress);
  const result = job ? <div className="flex min-w-0 flex-col gap-4">{editedSinceRun && <Note action={<Button size="sm" variant="secondary" disabled={busy || live} onClick={() => { if (frozen) restore(frozen); }}>恢复本次运行配置</Button>}>参数已修改，下方仍为上次运行结果。再次运行后会生成新的计算记录。</Note>}<div data-vcr-job-status="" className="flex flex-wrap items-center gap-3"><p role="status" className="text-ui">{job.label || selectedMethod.name} · {({ queued: "等待运行", running: "运行中", succeeded: "运行完成", failed: "运行失败", canceled: "已取消", awaiting_budget: "等待计算预算" })[job.state]}</p>{progress && <p className="text-caption tabular-nums">{progress.done} / {progress.total}</p>}{live && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setBusy(true); void cancelVcrJob(jobStudy, job.id).then(setJob).catch(failure => setError(webErrorMessage(failure))).finally(() => setBusy(false)); }}>取消运行</Button>}</div>{job.error && job.state !== "canceled" && <p role="alert" className="text-error">{job.error.message ?? "计算未完成"}</p>}<VcrMethodResult studyId={jobStudy} job={job} />{frozen && <Button size="sm" variant="secondary" disabled={busy || live} onClick={() => { restore(frozen); setPanel("configuration"); }}>复用本次配置</Button>}</div> : <Note action={null}>配置并运行后，可在这里查看本次结果，也可打开下方历史运行。</Note>;
  return <section className="min-w-0" aria-label={methodTitle(method)} data-vcr-method-workbench="">
    {showTitle && <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-section font-semibold">{methodTitle(method)}</h2>{onClose && <Button size="sm" variant="text" disabled={busy} onClick={onClose}>返回方法列表</Button>}</div>}
    <p className="mb-3 max-w-measure text-ui text-text-2">{description.purpose}</p>
    <dl className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-caption text-text-2"><div><dt className="text-text-3">需要</dt><dd>{description.inputs}</dd></div><div><dt className="text-text-3">得到</dt><dd>{description.outputs}</dd></div></dl>
    {error && <p role="alert" className="mb-4 text-ui text-error">{error}</p>}
    <div className="mb-4 lg:hidden"><Toolbar label="方法工作台导航" views={{ label: "方法工作台", value: panel, onChange: next => setPanel(next as "configuration" | "result"), items: [{ value: "configuration", label: "配置与历史" }, { value: "result", label: "运行与结果" }] }} /></div>
    {kind && (schema || forecast) && !usingLiterature && <div data-vcr-run-actions="" className={`sticky ${STICKY_BELOW_BAND} z-sticky mb-4 flex flex-wrap items-center gap-3 border-b border-border-hairline bg-bg py-2`}><Button type="button" size="lg" loading={busy} disabled={busy || live || Boolean(runReason)} onClick={() => { void run(); }}>{live ? "正在运行" : "保存配置并运行"}</Button><span role="status" className="min-w-0 flex-1 text-caption text-text-2">{live ? "可在运行与结果中查看进度或取消。" : runReason ?? "将按当前参数计算。"}</span></div>}
    <div className="grid min-w-0 gap-6 lg:grid-cols-2"><div className={panel === "configuration" ? "min-w-0" : "hidden min-w-0 lg:block"}>{configuration}</div><div className={panel === "result" ? "min-w-0 lg:border-l lg:border-border-hairline lg:pl-6" : "hidden min-w-0 lg:block lg:border-l lg:border-border-hairline lg:pl-6"}><Section title="运行与结果" level="sub">{result}</Section></div></div>
  </section>;
}
function MethodHistory({ studyId, kind, revision, title, disabled, onOpen }: { studyId: string; kind: string; revision: string; title: string; disabled: boolean; onOpen: (job: VcrJob) => void }) {
  const { state, reload } = useVcrLoad(`method-history:${studyId}:${revision}`, () => getVcrMethodHistory(studyId));
  return <Disclosure summary="历史运行与原始配置">{state.kind === "loading" ? <VcrTabSkeleton rows={1} /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <ul className="flex flex-col gap-3">{state.data.jobs.filter(entry => entry.kind === kind).map(entry => <li key={entry.id} className="flex flex-wrap items-center gap-2 text-caption"><span>{entry.label || title} · {entry.updatedAt ?? "日期未记录"}</span><Button size="sm" variant="secondary" disabled={disabled} onClick={() => onOpen(entry)}>打开原始配置与结果</Button></li>)}{!state.data.jobs.some(entry => entry.kind === kind) && <li>还没有此方法的运行。</li>}</ul>}</Disclosure>;
}
function MethodInputs({ studyId, method, scenario, change, snapshots, setSnapshots, reconstructionResultId, reconstructionResultAvailable, setReconstructionResultId, qualityBasis, qualityBasisAvailable, setQualityBasis, setSubjectId, disabled, onAdmissionChange }: { studyId: string; method: string; scenario: Record<string, unknown>; change: (scenario: Record<string, unknown>) => void; snapshots: string[]; setSnapshots: (ids: string[]) => void; reconstructionResultId: string | null; reconstructionResultAvailable: boolean | null; setReconstructionResultId: (id: string | null) => void; qualityBasis: VcrQualityBasis | null; qualityBasisAvailable: boolean | null; setQualityBasis: (basis: VcrQualityBasis | null) => void; setSubjectId: (id: string | null) => void; disabled: boolean; onAdmissionChange: (state: InputAdmission) => void }) {
  const forecast = method.startsWith("forecast.");
  const needsSnapshot = methodNeedsSnapshot(method, scenario);
  const { state, reload } = useVcrLoad(`method-inputs:${studyId}:${method}`, async () => {
    if (forecast) return { longitudinal: await getVcrLongitudinal(studyId), data: null, population: null, reconstructionResults: [] };
    return { longitudinal: null, data: await getVcrData(studyId), population: method === "population.quality" ? await getVcrPopulation(studyId) : null, reconstructionResults: method === "comparator.maic_time_to_event" ? (await getVcrMethodHistory(studyId)).reconstructionResults ?? [] : [] };
  });
  const { data, longitudinal, population, reconstructionResults } = state.kind === "ready" ? state.data : { data: null, longitudinal: null, population: null, reconstructionResults: [] };

  const reconstructionIssue = method === "comparator.maic_time_to_event" ? reconstructionProblem(scenario, reconstructionResultId, reconstructionResultAvailable, reconstructionResults) : null;
  const prerequisite = longitudinal ? forecastPrerequisite(method, longitudinal) : needsSnapshot && !snapshots.length && method !== "population.quality" ? "请选择可读取的数据快照；还没有数据时，可先在研究中导入。" : method === "population.quality" && data && population ? qualityInputProblem(data, population, scenario, qualityBasis, qualityBasisAvailable) : null;
  const unavailableSnapshots = Boolean(data && snapshots.some(id => !data.snapshots.some(snapshot => snapshot.id === id)));
  const reason = state.kind === "error" ? "所需输入暂时无法读取，请在配置中重试。" : reconstructionIssue ?? prerequisite ?? (unavailableSnapshots ? "原始配置的部分数据无法读取，请重新选择。" : null);
  const scope = `${studyId}:${method}`;
  const loading = state.kind === "loading";
  useEffect(() => { onAdmissionChange({ scope, reason, loading }); }, [scope, reason, loading, onAdmissionChange]);
  if (state.kind === "loading") return <VcrTabSkeleton rows={1} />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  return <div className="flex flex-col gap-3">
    {longitudinal && <fieldset disabled={disabled}><VcrForecastMethodInputs method={method} data={longitudinal} value={scenario} onChange={change} /></fieldset>}
    {data && method !== "population.quality" && <fieldset disabled={disabled} className="flex flex-col gap-2"><legend className="mb-2 text-ui">研究数据快照</legend>{data.snapshots.length > 0 ? data.snapshots.map(snapshot => <label key={snapshot.id} className="flex items-center gap-2 text-ui"><input type="checkbox" checked={snapshots.includes(snapshot.id)} onChange={event => setSnapshots(event.target.checked ? [...snapshots, snapshot.id] : snapshots.filter(id => id !== snapshot.id))} />{snapshot.label}{snapshot.rows != null ? ` · ${snapshot.rows} 行` : ""}</label>) : <Note action={<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(studyId)}/data`}>导入研究数据</Link>}>还没有已保存数据；仅需参数的方法可以直接运行。</Note>}{snapshots.some(id => !data.snapshots.some(snapshot => snapshot.id === id)) && <p role="alert" className="text-caption text-warn-strong">原始配置的部分数据已无法读取，请重新选择数据。</p>}</fieldset>}
    {method === "comparator.maic_time_to_event" && <VcrReconstructionInput studyId={studyId} scenario={scenario} selected={reconstructionResultId} available={reconstructionResultAvailable} choices={reconstructionResults} onChange={setReconstructionResultId} onRefresh={reload} disabled={disabled} />}
    {population && data && <VcrPopulationQualityInputs studyId={studyId} population={population} data={data} scenario={scenario} change={change} basis={qualityBasis} basisAvailable={qualityBasisAvailable} setBasis={setQualityBasis} setSubjectId={setSubjectId} setSnapshots={setSnapshots} disabled={disabled} />}
    {reconstructionIssue && <Note action={<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(studyId)}/data`}>选择曲线来源与重建</Link>}>{reconstructionIssue}</Note>}
    {prerequisite && <Note action={<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(studyId)}/${forecast ? "patients" : "data"}`}>补充所需输入</Link>}>{prerequisite}</Note>}
  </div>;
}
