import { Link } from "react-router";
import { geoValueText, GEO_VALUE_DOMAINS } from "@evimed/domain";
import { getGeoValue, type GeoProject, type GeoValue } from "@/lib/geoClient";
import { CLAIM_TYPE_LABEL } from "@/lib/claimCitations";
import { formatDay } from "@/lib/format";
import { Disclosure } from "@/components/ui/Disclosure";
import { safeWebHref } from "@/lib/readPages";
import { AskAi } from "../AskAi";
import { engineName } from "../geoText";
import { TabError, TabSection, useGeoLoad } from "./geoTabKit";
import { tabPath } from "./geoTabText";
import { readableSourceRef } from "./EvidenceTab";
import { ShowMore, useShowMore } from "./showMore";

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

/**
 * Rows listed before 「显示更多」: three in the excerpt on 总览, which links to the whole list on 方案, and three on 行动, where the
 * next work is a footnote to the articles and the placements and not a page of its own; twelve anywhere else.
 */
const firstOf = (mode: ValueMode): number => (mode === "summary" || mode === "actions" ? 3 : 12);
/** How many each press of 「显示更多」 adds, and how many of the answers a round was judged on 可见度 lists to begin with. */
const STEP = 20;
const OBSERVATIONS_SHOWN = 20;

/** The rows of the profile that still stand: a retired or superseded one is history, not a finding. */
const standing = (entry: unknown): boolean => !["retired", "superseded"].includes(String(record(entry).status));

/** The rows a mode lists, each with words in it. */
function entriesOf(value: GeoValue, mode: ValueMode): unknown[] {
  const data = value.data ?? {};
  const findings = rows(data.findings).filter(standing);
  const entries = mode === "decisions" ? rows(data.decisions)
    : mode === "actions" ? rows(data.opportunities)
    : mode === "safety" ? findings.filter(entry => ["safety", "effectiveness"].includes(String(record(entry).dimension)))
    : mode === "sources" ? rows(data.sourceChanges).filter(standing)
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
  return <ValueBody geoId={geoId} value={value} mode={mode} className={className} />;
}

function ValueBody({ geoId, value, mode, className }: { geoId: string; value: GeoValue; mode: ValueMode; className?: string }) {
  const data = value.data ?? {};
  const entries = entriesOf(value, mode);
  const listed = useShowMore(entries, { first: firstOf(mode), step: STEP, resetKey: `${geoId}:${mode}` });
  const observed = useShowMore(value.observations ?? [], { first: OBSERVATIONS_SHOWN, step: STEP, resetKey: geoId });
  const excerpt = mode === "summary";
  // What is not listed is counted: the heading says how many there are, and the rest is one press away — on the excerpt, one link.
  const meta = entries.length > firstOf(mode)
    ? excerpt ? <Link to={tabPath(geoId, "plan")} className="text-link hover:underline">{`查看全部 ${entries.length} 条`}</Link> : `共 ${entries.length} 条`
    : undefined;
  return (
    <TabSection title={TITLES[mode]} meta={meta} level={["decisions", "sources"].includes(mode) ? "compact" : mode === "profile" ? "ui" : "section"} className={className}>
      {["summary", "profile"].includes(mode) && <ScopeDetail scope={data.scope} />}
      {text(data.summary) && ["summary", "profile"].includes(mode) && <p className="mb-3 max-w-measure text-ui leading-relaxed text-text-2">{text(data.summary)}</p>}
      {mode === "coverage" ? <>
        <p className="text-ui text-text-2">{value.coverage?.assessed
          ? `${value.coverage.represented} / ${value.coverage.assessed} 次相关结论被完整表达，${value.coverage.partial} 次不完整，${value.coverage.contradicted} 次存在冲突，${value.coverage.notAddressed} 次未涉及。`
          : "还没有足够的回答判断药品价值是否被准确表达。"}</p>
        {Boolean(value.coverage?.uncertain || value.coverage?.notApplicable) && <p className="mt-2 text-caption text-text-3">尚不能判断 {value.coverage.uncertain} 条，不适用 {value.coverage.notApplicable} 条。</p>}
        {Boolean(value.coverage?.assessed && value.coverage?.basisVersion && value.coverage.basisVersion !== value.version) && <p className="mt-2 text-caption text-text-3">以上按第 {value.coverage.basisVersion} 版药品价值分析测得；分析已更新到第 {value.version} 版，下一轮测量后按新版本判断。</p>}
        {!!value.observations?.length && <Disclosure summary={value.observations.length > OBSERVATIONS_SHOWN ? `查看回答中的表达 · 共 ${value.observations.length} 条` : "查看回答中的表达"} className="mt-3">
          <ul className="divide-y divide-border">
            {observed.visible.map((observation, index) => <li key={`${observation.findingId}:${index}`} className="py-3 text-ui">
              <p className="text-text-2">{engineName(observation.engine)} · {STATUS[observation.status] ?? "尚不能判断"}</p>
              {observation.quote && <blockquote className="mt-1 max-w-measure break-words text-text">{observation.quote}</blockquote>}
              {observation.reason && <p className="mt-1 max-w-measure text-caption text-text-3">{observation.reason}</p>}
            </li>)}
          </ul>
          <ShowMore remaining={observed.remaining} unit="条" onMore={observed.more} />
        </Disclosure>}
      </> : <>
        {!!listed.visible.length && <ul className="divide-y divide-border">
          {listed.visible.map((entry, index) => <li key={String(record(entry).id ?? index)} className="py-3">
            <p className="max-w-measure break-words text-ui leading-relaxed text-text">{text(entry)}</p>
            <FindingDetail entry={record(entry)} />
          </li>)}
        </ul>}
        {!excerpt && <ShowMore remaining={listed.remaining} unit="条" onMore={listed.more} />}
        {mode === "actions" && !!value.research?.length && <Disclosure summary="查看相关研究" className="mt-3">
          <ul className="space-y-3">{value.research.map(task => <li key={task.id} className="text-ui">
            <p className="max-w-measure text-text">{task.question}</p><span className="text-caption text-text-3">{TASK[task.status] ?? "研究中"}</span>
          </li>)}</ul>
        </Disclosure>}
        {/* On 信源 the changes are the list above; elsewhere the count leads to them. */}
        {!!value.impacts?.length && (mode === "actions" || mode === "profile") && <p className="mt-3 text-ui text-text-2">
          有 {value.impacts.length} 项依据变化，可检查相关结论和内容。
          <Link to={tabPath(geoId, "sources")} className="ml-2 text-link hover:underline">去信源查看</Link>
        </p>}
      </>}
      <BasisLine version={value.version} updatedAt={value.updatedAt} />
    </TabSection>
  );
}

/**
 * The one line that says which analysis the section stands on: the profile's version and the day it was last written (「依据版本 3 · 更新于
 * 10月8日」). The version is the backend's counter, kept so a reader can tell a section from last week from this week's; there is no picker
 * for an older one. A profile never written has no version to name, and one whose time did not come says the version alone.
 */
function BasisLine({ version, updatedAt }: { version: number; updatedAt: string | null }) {
  if (!(version > 0)) return null;
  const day = formatDay(updatedAt);
  return <p className="mt-3 text-caption text-text-3">{day ? `依据版本 ${version} · 更新于 ${day}` : `依据版本 ${version}`}</p>;
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
  // Each field keeps the shape it was written in (`fieldLines`): a list, an object, a number and a basis all reach the reader.
  const fields: Array<[string, unknown]> = [
    ["评价维度", GEO_VALUE_DOMAINS[String(entry.dimension) as keyof typeof GEO_VALUE_DOMAINS]], ["类型", basisLabel(entry.basis)],
    ["适用人群", entry.population], ["比较对象", entry.comparator], ["结局指标", entry.outcomes], ["确定性", entry.certainty], ["适用地区", entry.region],
    ["评价日期", entry.asOf], ["观察时间", entry.timeframe || entry.time], ["适用起始日期", entry.validFrom],
    ["适用截止日期", entry.validUntil], ["依据版本", entry.sourceVersion], ["研究方法", entry.methods], ["假设条件", entry.assumptions],
    ["局限", entry.limitations], ["判断理由", entry.rationale], ["下一步", entry.nextAction],
  ];
  const known = fields.map(([label, value]): [string, string[]] => [label, fieldLines(value)]).filter(([, lines]) => lines.length > 0);
  // A source is named by its title; failing that by a reference a reader can use (a PMID, a DOI, a name someone wrote). A
  // content-addressed id and a digest say nothing to a reader, so a source with neither is left out, as 方案's claims leave them out.
  const sources = rows(entry.sources ?? entry.sourceRefs).map(source => ({
    label: typeof source === "string" ? readableSourceRef(source)
      : text(source) || readableSourceRef(String(record(source).sourceRef ?? "")) || readableSourceRef(String(record(source).sourceId ?? "")),
    version: typeof source === "string" ? "" : String(record(source).version ?? record(source).sourceVersion ?? ""),
    href: safeWebHref(typeof source === "string" ? source : String(record(source).url ?? record(source).sourceRef ?? "")),
  })).filter((source): source is typeof source & { label: string } => Boolean(source.label));
  if (!known.length && !sources.length && !hasScope(entry.scope)) return null;
  return <Disclosure summary="依据与适用条件" className="mt-2">
    <ScopeDetail scope={entry.scope} />
    <dl className="space-y-2 text-caption text-text-2">{known.map(([label, lines]) => <div key={label}><dt>{label}</dt><dd className="max-w-measure break-words">{lines.length === 1 ? lines[0] : <ul className="space-y-1">{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}</dd></div>)}</dl>
    {!!sources.length && <ul className="mt-2 space-y-1 text-caption">{sources.map((source, index) => <li key={index} className="break-words">{source.href ? <a href={source.href} target="_blank" rel="noreferrer" className="text-accent underline">{source.label}</a> : source.label}{source.version && <span className="ml-2 text-text-3">版本 {source.version}</span>}</li>)}</ul>}
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

/**
 * A key's label: its SCOPE_LABELS name, else the key itself when the key is written in Chinese. An English key with no name is a code
 * (DESIGN: no enum codes in the body), so it has no label; an inherited name such as `constructor` is not a label either.
 */
const labelOf = (key: string): string | null => {
  if (Object.prototype.hasOwnProperty.call(SCOPE_LABELS, key)) return SCOPE_LABELS[key];
  return /[\u4e00-\u9fff]/.test(key) ? key : null;
};

/**
 * A finding's field as the lines a reader sees: text and numbers as they are, yes and no as 是 and 否, a list as its items, and an
 * object as its fields, each under its label where it has one (`labelOf`). Nothing is printed as `[object Object]` or as JSON.
 */
function fieldLines(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number") return Number.isFinite(value) ? [String(value)] : [];
  if (typeof value === "boolean") return [value ? "是" : "否"];
  if (Array.isArray(value)) return value.flatMap((item) => fieldLines(item));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const lines = fieldLines(item);
      if (!lines.length) return [];
      const label = labelOf(key);
      return [label ? `${label}：${lines.join("、")}` : lines.join("、")];
    });
  }
  return [];
}

/** A finding's basis under the label the claim lists use (`CLAIM_TYPE_LABEL`); a value that is none of the three is not shown. */
function basisLabel(value: unknown): string | undefined {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CLAIM_TYPE_LABEL, value) ? CLAIM_TYPE_LABEL[value] : undefined;
}
