import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { VCR_JOB_METHODS, VCR_ROW_RULE_COMPARATORS, VCR_ROW_RULE_OPS, VCR_SCENARIO_EXAMPLES, VCR_SCENARIO_SCHEMAS, validateScenario, whenHolds } from "@evimed/domain";
import { cancelVcrJob, getVcrHome, getVcrJob, getVcrMethodHistory, getVcrMethodConfiguration, queueVcrJob, type VcrMethodConfiguration, type VcrJob, type VcrModels } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { Disclosure } from "@/components/ui/Disclosure";
import { safeLink } from "@/lib/frontierClient";
import { Drawer } from "@/components/ui/Drawer";
import { Input, Select } from "@/components/ui/Input";
import { VcrSettingsDrawer } from "./VcrSettingsDrawer";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";
import { methodFieldText } from "./vcrMethodFieldText";

type Method = VcrModels["methods"][number];
type Schema = { t: string; fields?: Record<string, Schema>; items?: Schema; values?: string[] | Schema; variants?: Record<string, Record<string, Schema>>; on?: string; default?: unknown; req?: boolean; min?: number; max?: number; gt?: number; lt?: number; maxLength?: number; pattern?: string; when?: unknown; unit?: string };
const schemas = VCR_SCENARIO_SCHEMAS as unknown as Record<string, Schema>;
const examples = VCR_SCENARIO_EXAMPLES as unknown as Record<string, Array<{ label: string; scenario: Record<string, unknown> }>>;
const titles: Record<string, string> = { n: "样本量", population: "人群", variables: "变量", name: "名称", label: "显示名称", family: "分布", mean: "均值", sd: "标准差", min: "最小值", max: "最大值", prob: "概率", probs: "各类别概率", baselineTable: "基线表", variable: "变量", proportion: "比例", proportions: "各类别比例", levels: "类别", distribution: "分布", correlation: "相关矩阵", parameterDraws: "参数抽样次数", design: "试验设计", kind: "类型", endpoint: "终点", type: "类型", alpha: "参数 α", power: "把握度", allocation: "分配比例", truth: "效应假设", effect: "效应", analysis: "分析", method: "方法", columns: "列名", covariates: "协变量", treatment: "治疗列", outcome: "结局列", time: "时间列", event: "事件列", holdoutShare: "留出比例", m: "生成份数", tau: "参数 τ", ratio: "比值", lower: "下限", upper: "上限", confidence: "置信水平", targetPower: "目标把握度", dropoutAnnual: "年脱落率", timeUnit: "时间单位" };
Object.assign(titles, { sites: "研究中心", target: "目标参数", eventTarget: "目标事件数", screenFailure: "筛选失败率", duration: "持续时间", startTime: "起始时间", followup: "随访时间", maxFollowup: "最长随访", accrual: "招募设置", costs: "成本", nTreat: "干预组人数", nControl: "对照组人数", nTreatment: "干预组人数", controlRate: "对照发生率", treatmentRate: "干预发生率", hazardRatio: "风险比", oddsRatio: "优势比", riskRatio: "风险比值", riskDifference: "风险差", controlMedian: "对照中位时间", controlDistribution: "对照分布", rate: "速率", rates: "分段速率", shape: "形状参数", scale: "尺度", breaks: "分段时间点", truth: "效应假设", control: "对照", historical: "历史数据", prior: "先验", covariateEffects: "协变量效应", baselineCorrelation: "基线相关性", covariateLogit: "协变量系数", eventHazard: "事件风险", enrolled: "已入组人数", confidenceLimit: "置信限", seed: "随机种子", replicates: "重复次数", performance: "性能指标", constraints: "约束条件", criteria: "入排条件", horizon: "评估时限", visits: "访视时间", randomEffects: "随机效应", intercept: "截距", slope: "斜率", sdIntercept: "截距标准差", sdSlope: "斜率标准差", dropoutPerVisit: "每次访视脱落率", nullRate: "零假设发生率", responseRate: "应答率", alternativeRate: "备择发生率", sided: "检验侧数", estimand: "估计目标", sensitivityDrifts: "敏感性漂移", parameterCode: "参数代码", weighting: "加权方法", weightColumn: "权重列", treatmentColumn: "治疗列", outcomeColumn: "结局列", sourcePrevalence: "来源发生率", targetPrevalence: "目标发生率", null: "零效应情景", targetMcse: "目标蒙特卡洛标准误" });
Object.assign(titles, { byTimes: "评估时间点", perMonth: "每月成本", perPatient: "每位受试者成本", perSite: "每中心成本", aggregateEstimate: "汇总估计", aggregateOutcome: "汇总结局", aggregateSe: "汇总标准误", alternative: "备择方向", analyses: "分析项目", anchored: "是否锚定", atRisk: "风险集人数", basis: "分析依据", basisOverride: "依据补充", benchmark: "比较基准", beta: "参数 β", cohortRules: "队列条件", column: "数据列", compare: "比较项", components: "组成部分", controlRates: "对照分层发生率", controls: "对照设置", correlationScale: "相关性尺度", correlationSource: "相关性来源", counts: "计数", covariateSets: "协变量集合", current: "当前设置", curve: "曲线", deltaApplies: "差异适用范围", deltas: "差异假设", designPrior: "设计先验", designs: "设计方案", direction: "方向", drifts: "漂移设置", effectScale: "效应尺度", emulation: "目标试验模拟", estimate: "估计值", events: "事件数", exit: "出组", exposureTime: "暴露时间", external: "外部对照", gamma: "先验参数", generator: "生成设置", holdoutInputId: "验证数据引用", id: "记录引用", idColumn: "编号列", informationRates: "信息比例", item: "项目", lambda: "速率参数", level: "水平", link: "链接函数", logOddsDrift: "对数优势漂移", maxN: "最大样本量", meanlog: "对数均值", missing: "缺失设置", missingHandling: "缺失处理", moments: "分布矩", n1: "第一阶段样本量", notApplicable: "不适用项", on: "依据变量", operatingCharacteristics: "设计性能" });
Object.assign(titles, { outcomeCovariates: "结局协变量", paramSd: "参数标准差", parameterInformation: "参数信息", phAlpha: "比例风险检验水平", phTransform: "比例风险变换", predictors: "预测变量", primary: "主要指标", prognostic: "预后调整", prognosticScoreColumn: "预后评分列", propensityCovariates: "倾向评分协变量", provenance: "来源凭据", pseudoIpdInputId: "重建数据引用", pseudoTreatmentColumn: "重建数据治疗列", r: "决策界值", r1: "第一阶段界值", rare: "罕见事件处理", reason: "原因", reportedLogHazardRatio: "报告对数风险比", reportedMedian: "报告中位数", responders: "应答人数", rho: "相关系数", rhoOrdinary: "常规相关系数", riskTable: "风险集表", robustWeight: "稳健权重", robustWeights: "稳健权重集", rule: "条件", rules: "条件集", sdlog: "对数标准差", se: "标准误", spending: "支出函数", state: "状态", studies: "研究集", studyId: "研究引用", surv: "生存概率", syntheticInputId: "合成数据引用", tail: "末段时长", targetTrial: "目标试验", targets: "评估目标", tauPrior: "异质性先验", ties: "并列值处理", timeZero: "时间零点", tool: "测量工具", toolVersion: "工具版本", totalEvents: "总事件数", trainingInputId: "训练数据引用", treatmentArm: "干预组", treatmentRates: "干预分层发生率", truths: "效应情景集", tstrOutcome: "合成训练评估结局", unadjustedEffectModifiers: "未调整效应修饰因素", unitVariance: "单位方差", unknownAs: "未知值处理" });
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
function ScenarioField({ schema, value, change, title, root, method = "", path = "", customLabel = false }: { schema: Schema; value: unknown; change: (value: unknown) => void; title: string; root: Record<string, unknown>; method?: string; path?: string; customLabel?: boolean }) {
  const text = methodFieldText(method, path, schema, root, title, customLabel);
  const fieldTitle = text.label;
  if (schema.t === "object" || schema.t === "variant") {
    const object = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const discriminator = schema.on ?? "type";
    const variant = String(object[discriminator] ?? schema.default ?? Object.keys(schema.variants ?? {})[0]);
    const fields = schema.t === "variant" ? schema.variants?.[variant] ?? {} : schema.fields ?? {};
    return <fieldset className="flex min-w-0 flex-col gap-3 rounded border border-border p-3"><legend className="text-caption">{fieldTitle}</legend>
      {schema.t === "variant" && <Select label="类型" value={variant} onChange={(event) => change({ [discriminator]: event.target.value })}>{Object.keys(schema.variants ?? {}).map((option) => <option key={option}>{option}</option>)}</Select>}
      {Object.entries(fields).filter(([key, field]) => key !== (schema.t === "variant" ? discriminator : "") && (!field.when || whenHolds(field.when, root))).map(([key, field]) => {
        const childPath = path ? `${path}.${key}` : key;
        const childTitle = methodFieldText(method, childPath, field, root, label(key)).label;
        return <div key={key} className="flex flex-col gap-1">
        {object[key] === undefined && !field.req ? <Button size="sm" variant="ghost" onClick={() => change({ ...object, [key]: schemaDefault(field) })}>添加{childTitle}</Button> : <><ScenarioField schema={field} value={object[key]} root={root} title={childTitle} method={method} path={childPath} change={(next) => change({ ...object, [key]: next })} />{!field.req && <Button size="sm" variant="ghost" onClick={() => { const next = { ...object }; delete next[key]; change(next); }}>移除{childTitle}</Button>}</>}
      </div>; })}
    </fieldset>;
  }
  if (schema.t === "array" || schema.t === "matrix") {
    const list = Array.isArray(value) ? value : [];
    const item: Schema = schema.t === "matrix" ? { t: "array", items: { t: "number", min: schema.min, max: schema.max } } : schema.items ?? { t: "string" };
    return <fieldset className="flex flex-col gap-2 rounded border border-border p-3"><legend>{fieldTitle}</legend>{list.map((entry, index) => <div key={index} className="flex flex-col gap-1"><ScenarioField schema={item} value={entry} root={root} title={`${fieldTitle} ${index + 1}`} method={method} path={`${path}[${index}]`} change={(next) => change(list.map((old, at) => at === index ? next : old))} /><Button variant="ghost" size="sm" onClick={() => change(list.filter((_, at) => at !== index))}>移除此项</Button></div>)}<Button variant="secondary" size="sm" disabled={schema.t === "array" && schema.max !== undefined && list.length >= schema.max} onClick={() => change([...list, schemaDefault(item)])}>添加一项</Button></fieldset>;
  }
  if (schema.t === "rules") {
    const rows = (Array.isArray(value) ? value : []) as Array<{ name: string; rule: Record<string, unknown> }>;
    return <fieldset className="flex flex-col gap-3"><legend>{fieldTitle}</legend>{rows.map((row, index) => <div className="flex flex-col gap-2" key={index}><Input label="规则名称" value={row.name} onChange={(event) => change(rows.map((old, at) => at === index ? { ...old, name: event.target.value } : old))} /><RowRule value={row.rule} depth={0} change={(rule) => change(rows.map((old, at) => at === index ? { ...old, rule } : old))} /><Button variant="ghost" size="sm" onClick={() => change(rows.filter((_, at) => at !== index))}>移除规则</Button></div>)}<Button variant="secondary" size="sm" onClick={() => change([...rows, { name: "", rule: { op: "compare", column: "", comparator: "gte", value: 0 } }])}>添加规则</Button></fieldset>;
  }
  if (schema.t === "map") {
    const object = (value ?? {}) as Record<string, unknown>;
    return <fieldset className="flex flex-col gap-2"><legend>{fieldTitle}</legend>{Object.entries(object).map(([key, entry]) => <ScenarioField key={key} title={key} method={method} path={`${path}.${key}`} customLabel schema={schema.values as Schema} value={entry} root={root} change={(next) => change({ ...object, [key]: next })} />)}<Input label="添加列名" onKeyDown={(event) => { if (event.key === "Enter" && event.currentTarget.value.trim()) { event.preventDefault(); change({ ...object, [event.currentTarget.value.trim()]: schemaDefault(schema.values as Schema) }); event.currentTarget.value = ""; } }} hint="输入列名后按回车" /></fieldset>;
  }
  if (Array.isArray(schema.values) || schema.t === "boolean") {
    const options = schema.t === "boolean" ? ["true", "false"] : schema.values as string[];
    return <Select label={fieldTitle} value={value === undefined ? "" : String(value)} onChange={(event) => change(schema.t === "boolean" ? event.target.value === "true" : event.target.value)}><option value="">请选择</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</Select>;
  }
  const numeric = schema.t === "number" || schema.t === "integer";
  return <Input label={text.unit ? `${fieldTitle}（${text.unit}）` : fieldTitle} hint={text.hint} value={typeof value === "string" || typeof value === "number" ? value : ""} type={numeric ? "number" : "text"} min={schema.min} max={schema.max} step={schema.t === "integer" ? 1 : "any"} maxLength={schema.maxLength} pattern={schema.pattern} onChange={(event) => change(numeric && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />;
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
    {state.kind === "loading" ? <VcrTabSkeleton rows={2} /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <ul className="flex flex-col gap-3">{state.data.jobs.filter((entry) => entry.kind === kind).map((entry) => <li key={entry.id} className="flex flex-col gap-1"><span>{entry.label || "方法运行"} · {entry.createdAt ?? entry.updatedAt ?? "日期未记录"}</span><Button size="sm" variant="secondary" disabled={disabled || loading !== null} onClick={() => { void reuse(entry); }}>{loading === entry.id ? "正在读取" : "复用此配置"}</Button></li>)}{!state.data.jobs.some((entry) => entry.kind === kind) && <li>还没有此方法的历史配置。</li>}</ul>}
    {problem && <p role="alert" className="text-error">{problem}</p>}
  </Disclosure>;
}

export function VcrMethodRunner({ method, onClose, sourceModel }: { method: Method; onClose: () => void; sourceModel?: { id: string; version?: string | null; studyId?: string | null; scenario: Record<string, unknown> } }) {
  const engineMethod = method.method ?? method.id;
  const schema = schemas[engineMethod];
  const kind = methodKind(engineMethod);
  const { state, reload } = useVcrLoad("method:studies", getVcrHome);
  const [studyId, setStudyId] = useState(sourceModel?.studyId ?? "");
  const [scenario, setScenario] = useState<Record<string, unknown>>(sourceModel ? structuredClone(sourceModel.scenario) : {});
  const [seed, setSeed] = useState("42");
  const [replicates, setReplicates] = useState("");
  const [baseline, setBaseline] = useState<VcrMethodConfiguration | null>(null);
  const [activeModel, setActiveModel] = useState<{ id: string; version: string | null } | null>(sourceModel ? { id: sourceModel.id, version: sourceModel.version ?? null } : null);
  const [snapshots, setSnapshots] = useState("");
  const [job, setJob] = useState<VcrJob | null>(null);
  const [jobStudy, setJobStudy] = useState("");
  const [frozen, setFrozen] = useState<{ scenario: Record<string, unknown>; seed: string; snapshots: string; replicates: string; model: { id: string; version: string | null } | null } | null>(null);
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
      const next = await queueVcrJob(studyId, { kind, scenario, ...(activeModel ? { modelId: activeModel.id } : {}), seed: Number(seed), ...(replicates ? { replicates: Number(replicates) } : {}), inputs: snapshots.split(",").map((id) => id.trim()).filter(Boolean).map((id) => ({ kind: "snapshot", id })) });
      setJobStudy(studyId); setJob(next); setFrozen({ scenario: structuredClone(scenario), seed, snapshots, replicates, model: activeModel });
    } catch (failure) { setError(webErrorMessage(failure, { fallback: "运行未能开始，请检查输入后重试。" })); }
    finally { holding.current = false; setBusy(false); }
  }
  const cardKind = engineMethod.startsWith("population.") ? "population" : engineMethod === "matching.evaluate" ? "criteria" : null;
  return <Drawer title={method.name} onClose={onClose} widthClassName="max-w-2xl"><div className="flex flex-col gap-4">
    <p className="text-caption text-text-2">{methodTask(engineMethod)} · {method.endpoints ?? "终点要求未说明"}</p>
    {method.assumptions?.length ? <ul className="list-disc pl-5 text-caption">{method.assumptions.map((item, index) => <li key={index}>{item.text}（{item.source}）</li>)}</ul> : <p>适用假设尚未说明。</p>}
    <Note action={<Disclosure summary="版本与数值参考">
      <p>{method.version ?? "版本未说明"} · {method.numeric ?? "未提供数值参考用例"}</p>
      {method.validation?.ciUrl && safeLink(method.validation.ciUrl) && <a href={safeLink(method.validation.ciUrl) ?? undefined} target="_blank" rel="noreferrer" className="text-link hover:underline">查看验证来源</a>}
    </Disclosure>}>
      {activeModel && <span>来源模型版本：{activeModel.version ?? "未记录"}。文献参数在提交时重新核对；修改参数请先登记新版本。</span>}
      数值参考用例不代表临床适用性。运行结果与配置保留在所选研究中。
    </Note>
    {!schema || !kind ? <><p>此方法暂不支持直接运行。</p>{["matching.evaluate", "evidence.reconstruct_km"].includes(engineMethod) && <>
      <p>{engineMethod === "matching.evaluate" ? "从研究中选择已有记录与入排条件进行匹配。" : "从研究的证据流程读取曲线来源并取得重建凭证。"}</p>
      {state.kind === "ready" && state.data.studies.map(study => <Link key={study.id} className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(study.id)}/${engineMethod === "matching.evaluate" ? "matching" : "data"}`}>{study.name}</Link>)}
    </>}</> : <>
      {state.kind === "loading" ? <VcrTabSkeleton rows={2} /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : state.data.studies.length === 0 ? <p>请先建立研究，再配置方法。</p> : <Select label="用于现有研究" value={studyId} disabled={Boolean(live)} onChange={(event) => { setStudyId(event.target.value); setBaseline(null); setSnapshots(""); setJob(null); setFrozen(null); setActiveModel(sourceModel ? { id: sourceModel.id, version: sourceModel.version ?? null } : null); }}><option value="">选择研究</option>{state.data.studies.map((study) => <option key={study.id} value={study.id}>{study.name}</option>)}</Select>}
      {studyId && kind && <MethodHistory key={`${studyId}:${kind}`} studyId={studyId} kind={kind} revision={job?.id ?? ""} disabled={busy || Boolean(live)} onReuse={(previous, configuration) => {
        setBaseline(configuration); setActiveModel(configuration.sourceModel ?? null); setScenario(structuredClone(configuration.scenario)); setSeed(String(configuration.seed)); setReplicates(configuration.replicates == null ? "" : String(configuration.replicates)); setSnapshots(configuration.inputRefs.map((input) => input.id).join(", ")); setJob(previous); setJobStudy(studyId); setError(null);
        setFrozen({ scenario: structuredClone(configuration.scenario), seed: String(configuration.seed), snapshots: configuration.inputRefs.map((input) => input.id).join(", "), replicates: configuration.replicates == null ? "" : String(configuration.replicates), model: configuration.sourceModel ?? null });
      }} />}
      {baseline && <Disclosure summary="复用版本记录"><p>方法版本：{baseline.methodVersion ?? "未记录"}</p><p className="break-all">配置指纹：{baseline.scenarioHash ?? "未记录"}</p></Disclosure>}
      {cardKind && studyId && <Button variant="secondary" onClick={() => setSettings(true)}>修改研究{cardKind === "population" ? "人群" : "入排标准"}设定</Button>}
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        {examples[engineMethod]?.map((example, index) => <Button key={index} variant="secondary" onClick={() => setScenario(structuredClone(example.scenario))}>载入示例 {index + 1}（需按研究修改）</Button>)}
        <ScenarioField title="方法参数" method={engineMethod} schema={schema} value={scenario} root={scenario} change={(next) => setScenario(next as Record<string, unknown>)} />
        <Input label="研究数据快照引用" hint="多个已保存快照用逗号分隔；无需数据的方法可留空。" value={snapshots} onChange={(event) => setSnapshots(event.target.value)} />
        <Input label="随机种子" type="number" min={0} max={2147483647} step={1} value={seed} error={!validSeed ? "填写 0 至 2147483647 的整数" : undefined} onChange={(event) => setSeed(event.target.value)} />
        <Input label="重复计算次数" type="number" min={1} step={1} value={replicates} hint="留空时使用方法默认值。" error={!validReplicates ? "填写正整数" : undefined} onChange={(event) => setReplicates(event.target.value)} />
        {problems.length > 0 && <ul className="text-caption text-error" aria-label="参数问题">{problems.slice(0, 12).map((problem, index) => <li key={index}>{methodFieldText(engineMethod, problem.field.replace(/^scenario\.?/, ""), {}, scenario, problem.field.replace(/^scenario\.?/, "").split(".").map(part => label(part)).join(" / ")).label}：{problem.code === "scenario_field_missing" ? "请补充此参数或选择其中一项。" : "请检查此参数的取值、范围和适用条件。"}</li>)}</ul>}
        <Button type="submit" disabled={busy || Boolean(live) || !studyId || problems.length > 0 || !validSeed || !validReplicates}>{busy ? "正在提交" : "保存配置并运行"}</Button>
      </form>
    </>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {job && <section className="flex flex-col gap-2" aria-label="方法运行"><p>{job.label} · {({ queued: "等待运行", running: "运行中", succeeded: "运行完成", failed: "运行失败", canceled: "已取消", awaiting_budget: "等待计算预算" })[job.state]}</p>{job.progress && <p>{job.progress.done} / {job.progress.total}</p>}{job.error && <p role="alert">{job.error.message ?? "计算未完成"}{job.error.partial ? "，保留已有部分结果。" : ""}</p>}<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(jobStudy)}/${engineMethod.startsWith("population.") ? "population" : engineMethod.startsWith("patients.") ? "patients" : engineMethod.startsWith("comparator.") ? "comparator" : engineMethod.startsWith("design.") || engineMethod.startsWith("accrual.") ? "trial" : "data"}`}>查看研究结果</Link>{frozen && <Button variant="secondary" disabled={Boolean(live)} onClick={() => { setScenario(structuredClone(frozen.scenario)); setSeed(frozen.seed); setSnapshots(frozen.snapshots); setReplicates(frozen.replicates); setActiveModel(frozen.model); }}>复用本次配置</Button>}{live && <Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); void cancelVcrJob(jobStudy, job.id).then(setJob).catch((failure: unknown) => setError(webErrorMessage(failure, { fallback: "取消失败，请重试。" }))).finally(() => setBusy(false)); }}>取消运行</Button>}</section>}
    {settings && cardKind && <VcrSettingsDrawer studyId={studyId} kind={cardKind} title="修改研究设定" onClose={() => setSettings(false)} onSaved={() => setSettings(false)} />}
  </div></Drawer>;
}
