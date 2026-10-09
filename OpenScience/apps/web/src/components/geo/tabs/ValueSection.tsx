import { geoValueText, GEO_VALUE_DOMAINS } from "@evimed/domain";
import { getGeoValue, type GeoProject } from "@/lib/geoClient";
import { Disclosure } from "@/components/ui/Disclosure";
import { safeWebHref } from "@/lib/readPages";
import { AskAi } from "../AskAi";
import { engineName } from "../geoText";
import { TabError, TabSection, TabSkeleton, useGeoLoad } from "./geoTabKit";

type Mode = "summary" | "profile" | "safety" | "decisions" | "actions" | "sources" | "coverage";
const TITLES: Record<Mode, string> = {
  summary: "药品价值与机会", profile: "药品价值分析", safety: "获益与风险", decisions: "问题背后的决策",
  actions: "下一步研究与内容", sources: "依据与传播", coverage: "AI 如何表达药品价值",
};
const text = (value: unknown): string => geoValueText(value);
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const STATUS: Record<string, string> = { represented: "表达完整", partial: "表达不完整", contradicted: "与依据冲突", not_addressed: "未涉及", not_applicable: "不适用", uncertain: "尚不能判断" };
const TASK: Record<string, string> = { pending: "等待研究", claimed: "正在研究", running: "正在研究", done: "可查看研究结果", failed: "查看已有结果与待补问题" };

/** Findings first; applicability and provenance are optional detail, never a form. */
export function ValueSection({ geoId, project, mode = "profile" }: { geoId: string; project: GeoProject; mode?: Mode }) {
  const { state, reload } = useGeoLoad(`value:${geoId}`, () => getGeoValue(geoId));
  if (state.kind === "loading") return <TabSkeleton rows={2} />;
  if (state.kind === "error") return <TabError message="药品价值分析暂时无法读取。" onRetry={reload} />;
  const value = state.data;
  const data = value?.data ?? {};
  const findings = rows(data.findings).filter(entry => !["retired", "superseded"].includes(String(record(entry).status)));
  const entries = mode === "decisions" ? rows(data.decisions)
    : mode === "actions" ? rows(data.opportunities)
    : mode === "safety" ? findings.filter(entry => ["safety", "effectiveness"].includes(String(record(entry).dimension)))
    : mode === "sources" ? rows(data.sourceChanges) : findings;
  const shown = entries.filter(entry => text(entry)).slice(0, mode === "summary" ? 3 : 12);
  const draft = mode === "actions" ? "请从药品价值和现有研究出发，推进优先机会；先复用已有成果，必要时安排专项研究，并继续完成有依据的内容。"
    : mode === "coverage" ? "请结合本轮原始回答、药品价值及适用条件，分析哪些内容被正确表达、遗漏或误解，并区分证据、传播、检索和测量问题。"
    : `请结合现有资料完善${TITLES[mode]}，说明与本项目决策相关的获益、风险、适用性、费用与可及性；资料不足的部分保留未知。`;
  return (
    <TabSection title={TITLES[mode]} level={mode === "decisions" ? "compact" : mode === "profile" ? "ui" : "section"} className="mb-6">
      {text(data.summary) && ["summary", "profile"].includes(mode) && <p className="mb-3 max-w-body text-ui leading-relaxed text-text-2">{text(data.summary)}</p>}
      {mode === "coverage" ? <>
        <p className="text-ui text-text-2">{value?.coverage?.assessed
          ? `${value?.coverage.represented} / ${value?.coverage.assessed} 次相关结论被完整表达，${value?.coverage.partial} 次不完整，${value?.coverage.contradicted} 次存在冲突。`
          : "还没有足够的回答判断药品价值是否被准确表达。"}</p>
        {Boolean(value?.coverage?.uncertain || value?.coverage?.notApplicable) && <p className="mt-2 text-caption text-text-3">尚不能判断 {value?.coverage.uncertain} 条，不适用 {value?.coverage.notApplicable} 条。</p>}
        {!!value?.observations?.length && <Disclosure summary="查看回答中的表达" className="mt-3">
          <ul className="divide-y divide-border">
            {value?.observations.slice(0, 20).map((observation, index) => <li key={`${observation.findingId}:${index}`} className="py-3 text-ui">
              <p className="text-text-2">{engineName(observation.engine)} · {STATUS[observation.status] ?? "尚不能判断"}</p>
              {observation.quote && <blockquote className="mt-1 max-w-body break-words text-text">{observation.quote}</blockquote>}
              {observation.reason && <p className="mt-1 max-w-body text-caption text-text-3">{observation.reason}</p>}
            </li>)}
          </ul>
        </Disclosure>}
      </> : <>
        {!shown.length && <p className="text-ui text-text-3">{mode === "sources" ? "有依据变化时，在这里查看受影响的分析与内容。" : "可以先从已有资料和当前最重要的问题开始分析。"}</p>}
        <ul className="divide-y divide-border">
          {shown.map((entry, index) => <li key={String(record(entry).id ?? index)} className="py-3">
            <p className="max-w-body break-words text-ui leading-relaxed text-text">{text(entry)}</p>
            <FindingDetail entry={record(entry)} />
            {mode === "actions" && <AskAi project={project} label="推进这个问题" draft={`请推进这项 GEO 机会：${text(entry)}。先读取已有价值分析与研究结果，再选择需要的科研方法，保留不确定性并完成可支持的内容。`} />}
          </li>)}
        </ul>
        {mode === "actions" && !!value?.research?.length && <Disclosure summary="查看相关研究" className="mt-3">
          <ul className="space-y-3">{value?.research.map(task => <li key={task.id} className="text-ui">
            <p className="max-w-body text-text">{task.question}</p><span className="text-caption text-text-3">{TASK[task.status] ?? "研究中"}</span>
            <AskAi project={project} label="继续分析" draft={`请查看这项研究的已有结果并用于 GEO：${task.question ?? "药品价值分析"}。先读现有报告，只补确有必要的缺口。`} />
          </li>)}</ul>
        </Disclosure>}
        {!!value?.impacts?.length && ["actions", "sources", "profile"].includes(mode) && <p className="mt-3 text-ui text-text-2">有 {value?.impacts.length} 项依据变化，可检查相关结论和内容。</p>}
      </>}
      <AskAi project={project} label={mode === "coverage" ? "分析表达效果" : "继续分析"} draft={draft} className="mt-3" />
    </TabSection>
  );
}

function FindingDetail({ entry }: { entry: Record<string, unknown> }) {
  const known = [
    ["评价维度", GEO_VALUE_DOMAINS[String(entry.dimension) as keyof typeof GEO_VALUE_DOMAINS]], ["适用人群", entry.population],
    ["比较对象", entry.comparator], ["局限", entry.limitations], ["判断理由", entry.rationale], ["下一步", entry.nextAction],
  ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && Boolean(pair[1]));
  const sources = rows(entry.sources ?? entry.sourceRefs).map(source => ({
    label: typeof source === "string" ? source : text(source),
    href: safeWebHref(typeof source === "string" ? source : String(record(source).url ?? record(source).sourceRef ?? "")),
  })).filter(source => source.label);
  if (!known.length && !sources.length) return null;
  return <Disclosure summary="依据与适用条件" className="mt-2">
    <dl className="space-y-2 text-caption text-text-2">{known.map(([label, content]) => <div key={label}><dt>{label}</dt><dd className="max-w-body break-words">{content}</dd></div>)}</dl>
    {!!sources.length && <ul className="mt-2 space-y-1 text-caption">{sources.map((source, index) => <li key={index} className="break-words">{source.href ? <a href={source.href} target="_blank" rel="noreferrer" className="text-accent underline">{source.label}</a> : source.label}</li>)}</ul>}
  </Disclosure>;
}
