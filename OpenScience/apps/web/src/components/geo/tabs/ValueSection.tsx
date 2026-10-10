import { geoValueText, GEO_VALUE_DOMAINS } from "@evimed/domain";
import { getGeoValue, type GeoProject, type GeoValue } from "@/lib/geoClient";
import { Disclosure } from "@/components/ui/Disclosure";
import { safeWebHref } from "@/lib/readPages";
import { AskAi } from "../AskAi";
import { engineName } from "../geoText";
import { TabError, TabSection, useGeoLoad } from "./geoTabKit";

export type ValueMode = "summary" | "profile" | "safety" | "decisions" | "actions" | "sources" | "coverage";
const TITLES: Record<ValueMode, string> = {
  summary: "药品价值与机会", profile: "药品价值分析", safety: "获益与风险", decisions: "问题背后的决策",
  actions: "下一步研究与内容", sources: "依据与传播", coverage: "AI 如何表达药品价值",
};
const text = (value: unknown): string => geoValueText(value);
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const STATUS: Record<string, string> = { represented: "表达完整", partial: "表达不完整", contradicted: "与依据冲突", not_addressed: "未涉及", not_applicable: "不适用", uncertain: "尚不能判断" };
const TASK: Record<string, string> = { pending: "等待研究", claimed: "正在研究", running: "正在研究", done: "可查看研究结果", failed: "查看已有结果与待补问题" };

/** The rows of the profile that still stand: a retired or superseded one is history, not a finding. */
const standing = (entry: unknown): boolean => !["retired", "superseded"].includes(String(record(entry).status));

/** The rows a mode lists, each with words in it. */
function entriesOf(value: GeoValue, mode: ValueMode): unknown[] {
  const data = value.data ?? {};
  const findings = rows(data.findings).filter(standing);
  const entries = mode === "decisions" ? rows(data.decisions)
    : mode === "actions" ? rows(data.opportunities)
    : mode === "safety" ? findings.filter(entry => ["safety", "effectiveness"].includes(String(record(entry).dimension)))
    : mode === "sources" ? rows(data.sourceChanges)
    : mode === "coverage" ? [] : findings;
  return entries.filter(entry => text(entry));
}

/** Whether the mode has anything of its own to say. A section with nothing in it is not drawn. */
function hasContent(value: GeoValue, mode: ValueMode): boolean {
  if (entriesOf(value, mode).length) return true;
  if (mode === "summary" || mode === "profile") return Boolean(text(value.data?.summary)) || hasScope(value.data?.scope);
  if (mode === "actions") return !!value.research?.length;
  if (mode === "coverage") return !!(value.coverage?.assessed || value.coverage?.uncertain || value.coverage?.notApplicable || value.observations?.length);
  return false;
}

/** Whether a value analysis was ever begun: a version, or anything written under version 0. */
function begun(value: GeoValue): boolean {
  const written = (entry: unknown): boolean => Array.isArray(entry) ? entry.length > 0 : entry !== null && typeof entry === "object" ? Object.keys(entry).length > 0 : Boolean(entry);
  return value.version > 0 || Object.values(value.data ?? {}).some(written);
}

/**
 * The drug-value analysis as one tab sees it. Findings first; applicability and provenance are optional detail, never a form.
 *
 * It is drawn only when the analysis has something for this tab: no box with nothing in it, and nothing at all while it is read,
 * so a tab does not jump when the answer arrives. On 方案, where the analysis is started, a project that has none gets the one
 * way to start it; everywhere else the conversation (「对话」 in the header) is the way in.
 */
export function ValueSection({ geoId, project, mode = "profile", className }: { geoId: string; project: GeoProject; mode?: ValueMode; className?: string }) {
  const { state, reload } = useGeoLoad(`value:${geoId}`, () => getGeoValue(geoId));
  if (state.kind === "loading") return null;
  if (state.kind === "error") return <TabError message="药品价值分析暂时无法读取。" onRetry={reload} />;
  const value = state.data;
  if (!value || !hasContent(value, mode)) return mode === "profile" && (!value || !begun(value)) ? <StartAnalysis project={project} className={className} /> : null;
  const data = value.data ?? {};
  const shown = entriesOf(value, mode).slice(0, mode === "summary" ? 3 : 12);
  return (
    <TabSection title={TITLES[mode]} level={["decisions", "sources"].includes(mode) ? "compact" : mode === "profile" ? "ui" : "section"} className={className}>
      {["summary", "profile"].includes(mode) && <ScopeDetail scope={data.scope} />}
      {text(data.summary) && ["summary", "profile"].includes(mode) && <p className="mb-3 max-w-measure text-ui leading-relaxed text-text-2">{text(data.summary)}</p>}
      {mode === "coverage" ? <>
        <p className="text-ui text-text-2">{value.coverage?.assessed
          ? `${value.coverage.represented} / ${value.coverage.assessed} 次相关结论被完整表达，${value.coverage.partial} 次不完整，${value.coverage.contradicted} 次存在冲突。`
          : "还没有足够的回答判断药品价值是否被准确表达。"}</p>
        {Boolean(value.coverage?.uncertain || value.coverage?.notApplicable) && <p className="mt-2 text-caption text-text-3">尚不能判断 {value.coverage.uncertain} 条，不适用 {value.coverage.notApplicable} 条。</p>}
        {Boolean(value.coverage?.assessed && value.coverage?.basisVersion && value.coverage.basisVersion !== value.version) && <p className="mt-2 text-caption text-text-3">以上按第 {value.coverage.basisVersion} 版药品价值分析测得；分析已更新到第 {value.version} 版，下一轮测量后按新版本判断。</p>}
        {!!value.observations?.length && <Disclosure summary="查看回答中的表达" className="mt-3">
          <ul className="divide-y divide-border">
            {value.observations.slice(0, 20).map((observation, index) => <li key={`${observation.findingId}:${index}`} className="py-3 text-ui">
              <p className="text-text-2">{engineName(observation.engine)} · {STATUS[observation.status] ?? "尚不能判断"}</p>
              {observation.quote && <blockquote className="mt-1 max-w-measure break-words text-text">{observation.quote}</blockquote>}
              {observation.reason && <p className="mt-1 max-w-measure text-caption text-text-3">{observation.reason}</p>}
            </li>)}
          </ul>
        </Disclosure>}
      </> : <>
        {!!shown.length && <ul className="divide-y divide-border">
          {shown.map((entry, index) => <li key={String(record(entry).id ?? index)} className="py-3">
            <p className="max-w-measure break-words text-ui leading-relaxed text-text">{text(entry)}</p>
            <FindingDetail entry={record(entry)} />
          </li>)}
        </ul>}
        {mode === "actions" && !!value.research?.length && <Disclosure summary="查看相关研究" className="mt-3">
          <ul className="space-y-3">{value.research.map(task => <li key={task.id} className="text-ui">
            <p className="max-w-measure text-text">{task.question}</p><span className="text-caption text-text-3">{TASK[task.status] ?? "研究中"}</span>
          </li>)}</ul>
        </Disclosure>}
        {!!value.impacts?.length && ["actions", "sources", "profile"].includes(mode) && <p className="mt-3 text-ui text-text-2">有 {value.impacts.length} 项依据变化，可检查相关结论和内容。</p>}
      </>}
    </TabSection>
  );
}

const START_DRAFT = "请结合现有资料开始药品价值分析，说明与本项目决策相关的获益、风险、适用性、费用与可及性；资料不足的部分保留未知。";

/** The one way to begin a value analysis, for a project that has none: it opens the project's conversation with the brief, unsent. */
function StartAnalysis({ project, className }: { project: GeoProject; className?: string }) {
  return (
    <TabSection title={TITLES.profile} level="ui" className={className}>
      <p className="max-w-measure text-ui text-text-2">从已有资料开始，整理这个药的获益、风险、适用性、费用与可及性。</p>
      <AskAi project={project} label="开始药品价值分析" draft={START_DRAFT} className="mt-2" />
    </TabSection>
  );
}

function FindingDetail({ entry }: { entry: Record<string, unknown> }) {
  const known = [
    ["评价维度", GEO_VALUE_DOMAINS[String(entry.dimension) as keyof typeof GEO_VALUE_DOMAINS]], ["适用人群", entry.population],
    ["比较对象", entry.comparator], ["确定性", entry.certainty], ["适用地区", entry.region],
    ["评价日期", entry.asOf], ["观察时间", entry.timeframe ?? entry.time], ["适用起始日期", entry.validFrom],
    ["适用截止日期", entry.validUntil], ["依据版本", typeof entry.sourceVersion === "number" ? String(entry.sourceVersion) : entry.sourceVersion], ["局限", entry.limitations], ["判断理由", entry.rationale], ["下一步", entry.nextAction],
  ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && Boolean(pair[1]));
  const sources = rows(entry.sources ?? entry.sourceRefs).map(source => ({
    label: typeof source === "string" ? source : text(source) || String(record(source).sourceId ?? record(source).sourceRef ?? ""),
    version: typeof source === "string" ? "" : String(record(source).version ?? record(source).sourceVersion ?? ""),
    digest: typeof source === "string" ? "" : String(record(source).sha256 ?? ""),
    href: safeWebHref(typeof source === "string" ? source : String(record(source).url ?? record(source).sourceRef ?? "")),
  })).filter(source => source.label);
  if (!known.length && !sources.length && !hasScope(entry.scope)) return null;
  return <Disclosure summary="依据与适用条件" className="mt-2">
    <ScopeDetail scope={entry.scope} />
    <dl className="space-y-2 text-caption text-text-2">{known.map(([label, content], index) => <div key={`${label}:${index}`}><dt>{label}</dt><dd className="max-w-measure break-words">{content}</dd></div>)}</dl>
    {!!sources.length && <ul className="mt-2 space-y-1 text-caption">{sources.map((source, index) => <li key={index} className="break-words">{source.href ? <a href={source.href} target="_blank" rel="noreferrer" className="text-accent underline">{source.label}</a> : source.label}{source.version && <span className="ml-2 text-text-3">版本 {source.version}</span>}{source.digest && <span className="block break-all text-text-3">SHA-256 {source.digest}</span>}</li>)}</ul>}
  </Disclosure>;
}


const SCOPE_LABELS: Record<string, string> = {
  medicine: "药品", brandName: "商品名", genericName: "通用名", form: "剂型", formulation: "剂型",
  strength: "规格", indication: "适应证", population: "适用人群", comparator: "比较对象", setting: "使用场景",
  region: "适用地区", asOf: "评价日期", audience: "面向对象", objective: "评价目的", lifecycle: "生命周期",
  decisionContext: "决策背景",
};
function scopeRows(scope: unknown): [string, string][] {
  const value = record(scope);
  return Object.entries(SCOPE_LABELS).flatMap(([key, label]) => typeof value[key] === "string" && value[key].trim()
    ? [[label, value[key]] as [string, string]] : []);
}
function hasScope(scope: unknown): boolean { return Boolean(text(scope) || scopeRows(scope).length); }
function ScopeDetail({ scope }: { scope: unknown }) {
  const known = scopeRows(scope);
  if (!known.length && !text(scope)) return null;
  return <Disclosure summary="分析范围" className="mb-3">
    {text(scope) && <p className="max-w-measure break-words text-caption text-text-2">{text(scope)}</p>}
    <dl className="space-y-2 text-caption text-text-2">{known.map(([label, content], index) => <div key={`${label}:${index}`}><dt>{label}</dt><dd className="max-w-measure break-words">{content}</dd></div>)}</dl>
  </Disclosure>;
}
