import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { VCR_JOB_METHODS, VCR_ROW_RULE_COMPARATORS, VCR_ROW_RULE_OPS, VCR_SCENARIO_EXAMPLES, VCR_SCENARIO_SCHEMAS, validateScenario, whenHolds } from "@evimed/domain";
import { cancelVcrJob, getVcrHome, getVcrJob, getVcrMethodHistory, getVcrMethodConfiguration, queueVcrJob, type VcrMethodConfiguration, type VcrJob, type VcrModels } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { safeLink } from "@/lib/frontierClient";
import { Drawer } from "@/components/ui/Drawer";
import { Input, Select } from "@/components/ui/Input";
import { VcrSettingsDrawer } from "./VcrSettingsDrawer";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";

type Method = VcrModels["methods"][number];
type Schema = { t: string; fields?: Record<string, Schema>; items?: Schema; values?: string[] | Schema; variants?: Record<string, Record<string, Schema>>; on?: string; default?: unknown; req?: boolean; min?: number; max?: number; gt?: number; lt?: number; maxLength?: number; pattern?: string; when?: unknown; unit?: string };
const schemas = VCR_SCENARIO_SCHEMAS as unknown as Record<string, Schema>;
const examples = VCR_SCENARIO_EXAMPLES as unknown as Record<string, Array<{ label: string; scenario: Record<string, unknown> }>>;
const titles: Record<string, string> = { n: "样本量", population: "人群", variables: "变量", name: "名称", label: "显示名称", family: "分布", mean: "均值", sd: "标准差", min: "最小值", max: "最大值", prob: "概率", probs: "各类别概率", baselineTable: "基线表", variable: "变量", proportion: "比例", proportions: "各类别比例", levels: "类别", distribution: "分布", correlation: "相关矩阵", parameterDraws: "参数抽样次数", design: "试验设计", kind: "类型", endpoint: "终点", type: "类型", alpha: "显著性水平", power: "把握度", allocation: "分配比例", truth: "效应假设", effect: "效应", analysis: "分析", method: "方法", columns: "列名", covariates: "协变量", treatment: "治疗列", outcome: "结局列", time: "时间列", event: "事件列", holdoutShare: "留出比例", m: "生成份数", tau: "截断时间", ratio: "比值", lower: "下限", upper: "上限", confidence: "置信水平", targetPower: "目标把握度", dropoutAnnual: "年脱落率", timeUnit: "时间单位" };
const label = (key: string) => titles[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
export const methodTask = (method: string) => ({ profile: "数据与队列", cohort: "数据与队列", population: "构建研究人群", patients: "生成患者结局", evidence: "整理研究证据", comparator: "比较与敏感性分析", design: "设计试验", accrual: "预测招募", matching: "匹配入排标准" })[method.split(".")[0]] ?? "其他分析";
export function methodKind(method: string) { if (["matching.evaluate", "evidence.reconstruct_km"].includes(method)) return null; return Object.entries(VCR_JOB_METHODS).find(([, value]) => value === method)?.[0] ?? null; }
export function schemaDefault(schema: Schema): unknown {
  if (schema.t === "variant") { const choice = String(schema.default ?? Object.keys(schema.variants ?? {})[0]); return { [schema.on ?? "type"]: choice }; }
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.t === "object") return Object.fromEntries(Object.entries(schema.fields ?? {}).filter(([, field]) => field.req && !field.when).map(([key, field]) => [key, schemaDefault(field)]));
  if (schema.t === "array" || schema.t === "matrix" || schema.t === "rules") return [];
  if (schema.t === "map") return {};
  if (schema.t === "boolean") return false;
  return "";
}

/** The domain validates every value; this is only its typed editor, never an executor. */
function ScenarioField({ schema, value, change, title, root }: { schema: Schema; value: unknown; change: (value: unknown) => void; title: string; root: Record<string, unknown> }) {
  if (schema.t === "object" || schema.t === "variant") {
    const object = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const discriminator = schema.on ?? "type";
    const variant = String(object[discriminator] ?? schema.default ?? Object.keys(schema.variants ?? {})[0]);
    const fields = schema.t === "variant" ? schema.variants?.[variant] ?? {} : schema.fields ?? {};
    return <fieldset className="flex min-w-0 flex-col gap-3 rounded border border-border p-3"><legend className="text-caption">{title}</legend>
      {schema.t === "variant" && <Select label="类型" value={variant} onChange={(event) => change({ [discriminator]: event.target.value })}>{Object.keys(schema.variants ?? {}).map((option) => <option key={option}>{option}</option>)}</Select>}
      {Object.entries(fields).filter(([key, field]) => key !== (schema.t === "variant" ? discriminator : "") && (!field.when || whenHolds(field.when, root))).map(([key, field]) => <div key={key} className="flex flex-col gap-1">
        {object[key] === undefined && !field.req ? <Button size="sm" variant="ghost" onClick={() => change({ ...object, [key]: schemaDefault(field) })}>添加{label(key)}</Button> : <><ScenarioField schema={field} value={object[key]} root={root} title={label(key)} change={(next) => change({ ...object, [key]: next })} />{!field.req && <Button size="sm" variant="ghost" onClick={() => { const next = { ...object }; delete next[key]; change(next); }}>移除{label(key)}</Button>}</>}
      </div>)}
    </fieldset>;
  }
  if (schema.t === "array" || schema.t === "matrix") {
    const list = Array.isArray(value) ? value : [];
    const item: Schema = schema.t === "matrix" ? { t: "array", items: { t: "number", min: schema.min, max: schema.max } } : schema.items ?? { t: "string" };
    return <fieldset className="flex flex-col gap-2 rounded border border-border p-3"><legend>{title}</legend>{list.map((entry, index) => <div key={index} className="flex flex-col gap-1"><ScenarioField schema={item} value={entry} root={root} title={`${title} ${index + 1}`} change={(next) => change(list.map((old, at) => at === index ? next : old))} /><Button variant="ghost" size="sm" onClick={() => change(list.filter((_, at) => at !== index))}>移除此项</Button></div>)}<Button variant="secondary" size="sm" disabled={schema.t === "array" && schema.max !== undefined && list.length >= schema.max} onClick={() => change([...list, schemaDefault(item)])}>添加一项</Button></fieldset>;
  }
  if (schema.t === "rules") {
    const rows = (Array.isArray(value) ? value : []) as Array<{ name: string; rule: Record<string, unknown> }>;
    return <fieldset className="flex flex-col gap-3"><legend>{title}</legend>{rows.map((row, index) => <div className="flex flex-col gap-2" key={index}><Input label="规则名称" value={row.name} onChange={(event) => change(rows.map((old, at) => at === index ? { ...old, name: event.target.value } : old))} /><RowRule value={row.rule} depth={0} change={(rule) => change(rows.map((old, at) => at === index ? { ...old, rule } : old))} /><Button variant="ghost" size="sm" onClick={() => change(rows.filter((_, at) => at !== index))}>移除规则</Button></div>)}<Button variant="secondary" size="sm" onClick={() => change([...rows, { name: "", rule: { op: "compare", column: "", comparator: "gte", value: 0 } }])}>添加规则</Button></fieldset>;
  }
  if (schema.t === "map") {
    const object = (value ?? {}) as Record<string, unknown>;
    return <fieldset className="flex flex-col gap-2"><legend>{title}</legend>{Object.entries(object).map(([key, entry]) => <ScenarioField key={key} title={key} schema={schema.values as Schema} value={entry} root={root} change={(next) => change({ ...object, [key]: next })} />)}<Input label="添加列名" onKeyDown={(event) => { if (event.key === "Enter" && event.currentTarget.value.trim()) { event.preventDefault(); change({ ...object, [event.currentTarget.value.trim()]: schemaDefault(schema.values as Schema) }); event.currentTarget.value = ""; } }} hint="输入列名后按回车" /></fieldset>;
  }
  if (Array.isArray(schema.values) || schema.t === "boolean") {
    const options = schema.t === "boolean" ? ["true", "false"] : schema.values as string[];
    return <Select label={title} value={value === undefined ? "" : String(value)} onChange={(event) => change(schema.t === "boolean" ? event.target.value === "true" : event.target.value)}><option value="">请选择</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</Select>;
  }
  const numeric = schema.t === "number" || schema.t === "integer";
  return <Input label={schema.unit ? `${title}（${schema.unit}）` : title} value={typeof value === "string" || typeof value === "number" ? value : ""} type={numeric ? "number" : "text"} min={schema.min} max={schema.max} step={schema.t === "integer" ? 1 : "any"} maxLength={schema.maxLength} pattern={schema.pattern} onChange={(event) => change(numeric && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />;
}

function RowRule({ value, change, depth }: { value: Record<string, unknown>; change: (rule: Record<string, unknown>) => void; depth: number }) {
  const op = String(value.op ?? "compare");
  const numeric = (key: string, title: string) => <Input label={title} type="number" value={typeof value[key] === "number" ? value[key] : ""} onChange={(event) => change({ ...value, [key]: event.target.value === "" ? "" : Number(event.target.value) })} />;
  return <fieldset className="flex flex-col gap-2 rounded border border-border p-3"><legend>条件</legend>
    <Select label="运算" value={op} onChange={(event) => change({ op: event.target.value })}>{VCR_ROW_RULE_OPS.map((item) => <option key={item}>{item}</option>)}</Select>
    {["all", "any"].includes(op) ? <>{((value.operands ?? []) as Record<string, unknown>[]).map((rule, index, list) => <RowRule key={index} depth={depth + 1} value={rule} change={(next) => change({ ...value, operands: list.map((old, at) => at === index ? next : old) })} />)}<Button size="sm" variant="secondary" disabled={depth >= 7} onClick={() => change({ ...value, operands: [...(value.operands as unknown[] ?? []), { op: "present", column: "" }] })}>添加子条件</Button></>
      : op === "not" ? depth < 8 && <RowRule value={(value.operand ?? { op: "present" }) as Record<string, unknown>} change={(operand) => change({ ...value, operand })} depth={depth + 1} />
        : <><Input label="数据列" value={String(value.column ?? "")} onChange={(event) => change({ ...value, column: event.target.value })} />
          {op === "compare" && <><Select label="比较方式" value={String(value.comparator ?? "")} onChange={(event) => change({ ...value, comparator: event.target.value })}><option value="">请选择</option>{VCR_ROW_RULE_COMPARATORS.map((item) => <option key={item}>{item}</option>)}</Select><Select label="比较值类型" value={typeof value.value} onChange={(event) => change({ ...value, value: event.target.value === "number" ? 0 : event.target.value === "boolean" ? false : "" })}><option value="number">数字</option><option value="string">文本</option><option value="boolean">布尔值</option></Select><ScenarioField title="比较值" schema={{ t: typeof value.value === "number" ? "number" : typeof value.value === "boolean" ? "boolean" : "string" }} value={value.value} change={(next) => change({ ...value, value: next })} root={{}} /></>}
          {op === "between" && <>{numeric("low", "下限")}{numeric("high", "上限")}</>}
          {["in", "not_in"].includes(op) && <ScenarioField title="匹配值" schema={{ t: "array", items: { t: "string" } }} value={value.values ?? []} change={(values) => change({ ...value, values })} root={{}} />}
        </>}
  </fieldset>;
}

function MethodHistory({ studyId, kind, revision, disabled, onReuse }: { studyId: string; kind: string; revision: string; disabled: boolean; onReuse: (job: VcrJob, config: VcrMethodConfiguration) => void }) {
  const { state, reload } = useVcrLoad(`method-history:${studyId}:${revision}`, () => getVcrMethodHistory(studyId));
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const holding = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function reuse(job: VcrJob) {
    if (holding.current || disabled) return;
    holding.current = true; setLoading(job.id); setProblem(null);
    try {
      const configuration = await getVcrMethodConfiguration(studyId, job.id);
      if (!active.current) return;
      if (configuration.kind !== kind || configuration.unavailableInputs > 0) {
        setProblem(configuration.unavailableInputs > 0 ? "此配置依赖的部分数据无法直接复用，请在研究中重新选择数据。" : "此运行使用其他方法，不能在此复用。");
        return;
      }
      onReuse(job, configuration);
    } catch (failure) { if (active.current) setProblem(webErrorMessage(failure, { fallback: "无法读取此配置，请重试。" })); }
    finally { holding.current = false; if (active.current) setLoading(null); }
  }
  return <Disclosure summary="复用历史配置">
    {state.kind === "loading" ? <VcrTabSkeleton rows={2} /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <ul className="flex flex-col gap-3">{state.data.jobs.filter((entry) => entry.kind === kind).map((entry) => <li key={entry.id} className="flex flex-col gap-1"><span>{entry.label || "方法运行"} · {entry.createdAt ?? entry.updatedAt ?? "日期未记录"}</span><Button size="sm" variant="secondary" disabled={disabled || loading !== null} onClick={() => { void reuse(entry); }}>{loading === entry.id ? "正在读取…" : "复用此配置"}</Button></li>)}{!state.data.jobs.some((entry) => entry.kind === kind) && <li>还没有此方法的历史配置。</li>}</ul>}
    {problem && <p role="alert" className="text-error">{problem}</p>}
  </Disclosure>;
}

export function VcrMethodRunner({ method, onClose }: { method: Method; onClose: () => void }) {
  const engineMethod = method.method ?? method.id;
  const schema = schemas[engineMethod];
  const kind = methodKind(engineMethod);
  const { state, reload } = useVcrLoad("method:studies", getVcrHome);
  const [studyId, setStudyId] = useState("");
  const [scenario, setScenario] = useState<Record<string, unknown>>({});
  const [seed, setSeed] = useState("42");
  const [replicates, setReplicates] = useState("");
  const [baseline, setBaseline] = useState<VcrMethodConfiguration | null>(null);
  const [snapshots, setSnapshots] = useState("");
  const [job, setJob] = useState<VcrJob | null>(null);
  const [jobStudy, setJobStudy] = useState("");
  const [frozen, setFrozen] = useState<{ scenario: Record<string, unknown>; seed: string; snapshots: string; replicates: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const holding = useRef(false);
  const jobId = job?.id;
  const live = job && ["queued", "running", "awaiting_budget"].includes(job.state);
  useEffect(() => {
    if (!live || !jobId) return;
    let disposed = false;
    const timer = window.setInterval(() => { void getVcrJob(jobStudy, jobId).then((next) => { if (!disposed) { setJob(next); setError(null); } }).catch((failure: unknown) => { if (!disposed) setError(webErrorMessage(failure, { fallback: "无法读取运行进度，请重试。" })); }); }, 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [live, jobId, jobStudy]);
  const problems = schema ? validateScenario(engineMethod, scenario) : [];
  const validReplicates = replicates === "" || (/^\d+$/.test(replicates) && Number(replicates) > 0);
  const validSeed = /^\d+$/.test(seed) && Number(seed) <= 2147483647;
  async function run() {
    if (holding.current || !kind || !studyId || problems.length || !validSeed || !validReplicates) return;
    holding.current = true; setBusy(true); setError(null);
    try {
      const next = await queueVcrJob(studyId, { kind, scenario, seed: Number(seed), ...(replicates ? { replicates: Number(replicates) } : {}), inputs: snapshots.split(",").map((id) => id.trim()).filter(Boolean).map((id) => ({ kind: "snapshot", id })) });
      setJobStudy(studyId); setJob(next); setFrozen({ scenario: structuredClone(scenario), seed, snapshots, replicates });
    } catch (failure) { setError(webErrorMessage(failure, { fallback: "运行未能开始，请检查输入后重试。" })); }
    finally { holding.current = false; setBusy(false); }
  }
  const cardKind = engineMethod.startsWith("population.") ? "population" : engineMethod === "matching.evaluate" ? "criteria" : null;
  return <Drawer title={method.name} onClose={onClose} widthClassName="max-w-2xl"><div className="flex flex-col gap-4">
    <p className="text-caption text-text-2">{methodTask(engineMethod)} · {method.endpoints ?? "终点要求未说明"}</p>
    {method.assumptions?.length ? <ul className="list-disc pl-5 text-caption">{method.assumptions.map((item, index) => <li key={index}>{item.text}（{item.source}）</li>)}</ul> : <p>适用假设尚未说明。</p>}
    <p className="text-caption text-text-3">数值参考用例不代表临床适用性。运行结果与配置保留在所选研究中。</p>
    <Disclosure summary="版本与数值参考">
      <p>{method.version ?? "版本未说明"} · {method.numeric ?? "未提供数值参考用例"}</p>
      {method.validation?.ciUrl && safeLink(method.validation.ciUrl) && <a href={safeLink(method.validation.ciUrl) ?? undefined} target="_blank" rel="noreferrer" className="text-link hover:underline">查看验证来源</a>}
    </Disclosure>
    {!schema || !kind ? <><p>此方法暂不支持直接运行。</p>{["matching.evaluate", "evidence.reconstruct_km"].includes(engineMethod) && <>
      <p>{engineMethod === "matching.evaluate" ? "从研究中选择已有记录与入排条件进行匹配。" : "从研究的证据流程读取曲线来源并取得重建凭证。"}</p>
      {state.kind === "ready" && state.data.studies.map(study => <Link key={study.id} className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(study.id)}/${engineMethod === "matching.evaluate" ? "matching" : "data"}`}>{study.name}</Link>)}
    </>}</> : <>
      {state.kind === "loading" ? <VcrTabSkeleton rows={2} /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : state.data.studies.length === 0 ? <p>请先建立研究，再配置方法。</p> : <Select label="用于现有研究" value={studyId} disabled={Boolean(live)} onChange={(event) => { setStudyId(event.target.value); setBaseline(null); setSnapshots(""); setJob(null); setFrozen(null); }}><option value="">选择研究</option>{state.data.studies.map((study) => <option key={study.id} value={study.id}>{study.name}</option>)}</Select>}
      {studyId && kind && <MethodHistory key={`${studyId}:${kind}`} studyId={studyId} kind={kind} revision={job?.id ?? ""} disabled={busy || Boolean(live)} onReuse={(previous, configuration) => {
        setBaseline(configuration); setScenario(structuredClone(configuration.scenario)); setSeed(String(configuration.seed)); setReplicates(configuration.replicates == null ? "" : String(configuration.replicates)); setSnapshots(configuration.inputRefs.map((input) => input.id).join(", ")); setJob(previous); setJobStudy(studyId); setError(null);
        setFrozen({ scenario: structuredClone(configuration.scenario), seed: String(configuration.seed), snapshots: configuration.inputRefs.map((input) => input.id).join(", "), replicates: configuration.replicates == null ? "" : String(configuration.replicates) });
      }} />}
      {baseline && <Disclosure summary="复用版本记录"><p>方法版本：{baseline.methodVersion ?? "未记录"}</p><p className="break-all">配置指纹：{baseline.scenarioHash ?? "未记录"}</p></Disclosure>}
      {cardKind && studyId && <Button variant="secondary" onClick={() => setSettings(true)}>修改研究{cardKind === "population" ? "人群" : "入排标准"}设定</Button>}
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        {examples[engineMethod]?.map((example, index) => <Button key={index} variant="secondary" onClick={() => setScenario(structuredClone(example.scenario))}>载入示例 {index + 1}（需按研究修改）</Button>)}
        <ScenarioField title="方法参数" schema={schema} value={scenario} root={scenario} change={(next) => setScenario(next as Record<string, unknown>)} />
        <Input label="研究数据快照引用" hint="多个已保存快照用逗号分隔；无需数据的方法可留空。" value={snapshots} onChange={(event) => setSnapshots(event.target.value)} />
        <Input label="随机种子" type="number" min={0} max={2147483647} step={1} value={seed} error={!validSeed ? "填写 0 至 2147483647 的整数" : undefined} onChange={(event) => setSeed(event.target.value)} />
        <Input label="重复计算次数" type="number" min={1} step={1} value={replicates} hint="留空时使用方法默认值。" error={!validReplicates ? "填写正整数" : undefined} onChange={(event) => setReplicates(event.target.value)} />
        {problems.length > 0 && <ul className="text-caption text-error" aria-label="参数问题">{problems.slice(0, 12).map((problem, index) => <li key={index}>{problem.field}: {problem.detail}</li>)}</ul>}
        <Button type="submit" disabled={busy || Boolean(live) || !studyId || problems.length > 0 || !validSeed || !validReplicates}>{busy ? "正在提交…" : "保存配置并运行"}</Button>
      </form>
    </>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {job && <section className="flex flex-col gap-2" aria-label="方法运行"><p>{job.label} · {({ queued: "等待运行", running: "运行中", succeeded: "运行完成", failed: "运行失败", canceled: "已取消", awaiting_budget: "等待计算预算" })[job.state]}</p>{job.progress && <p>{job.progress.done} / {job.progress.total}</p>}{job.error && <p role="alert">{job.error.message ?? "计算未完成"}{job.error.partial ? "，保留已有部分结果。" : ""}</p>}<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(jobStudy)}/${engineMethod.startsWith("population.") ? "population" : engineMethod.startsWith("patients.") ? "patients" : engineMethod.startsWith("comparator.") ? "comparator" : engineMethod.startsWith("design.") || engineMethod.startsWith("accrual.") ? "trial" : "data"}`}>查看研究结果</Link>{frozen && <Button variant="secondary" disabled={Boolean(live)} onClick={() => { setScenario(structuredClone(frozen.scenario)); setSeed(frozen.seed); setSnapshots(frozen.snapshots); setReplicates(frozen.replicates); }}>复用本次配置</Button>}{live && <Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); void cancelVcrJob(jobStudy, job.id).then(setJob).catch((failure: unknown) => setError(webErrorMessage(failure, { fallback: "取消失败，请重试。" }))).finally(() => setBusy(false)); }}>取消运行</Button>}</section>}
    {settings && cardKind && <VcrSettingsDrawer studyId={studyId} kind={cardKind} title="修改研究设定" onClose={() => setSettings(false)} onSaved={() => setSettings(false)} />}
  </div></Drawer>;
}
