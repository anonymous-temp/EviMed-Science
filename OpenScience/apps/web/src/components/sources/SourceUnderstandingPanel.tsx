import { useEffect, useRef, useState } from "react";
import { FileSearch, FileX2 } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { getSourceUnderstanding, listSourceUnderstandingHistory, sourceFailureMessage,
  type SourceAnchor, type SourceUnderstanding, type SourceUnderstandingResult } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { formatClock, formatDay } from "@/lib/format";
import { labelFor } from "@/lib/statusLabel";
import { useOperator } from "@/lib/useOperator";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";

const POLL_MS = 5000;
const SLOT_LABELS: Record<string, string> = {
  purpose: "目的", applicability: "适用范围", scope: "适用范围", inputs: "输入", steps: "步骤", checks: "检查项",
  pitfalls: "常见问题", limitations: "局限", design: "研究设计", population: "研究人群", intervention: "干预或暴露",
  outcomes: "研究终点", outcome: "研究终点", results: "结果", doi: "DOI", title: "标题", topics: "主题", summary: "摘要",
  interventionExposure: "干预或暴露", effectEstimates: "效应估计", topic: "主题", decisions: "决定", actions: "行动",
  openQuestions: "待解决问题", keyInformation: "关键信息",
};

function active(status: string) { return status === "queued" || status === "parsing"; }
/** When an understanding was written, as a list dates it: 「9月22日 14:05」. */
function writtenAt(value: string) {
  const day = formatDay(value);
  return day ? `${day} ${formatClock(value)}` : "时间未记录";
}

/**
 * What EviMed understood from one document: the summary, the structured
 * slots, the statements it kept and the methods it drafted, each with the
 * passage of the document it rests on. Earlier understandings are one click
 * away in the history.
 *
 * It renders inside 「查看理解」, which names the document and closes itself,
 * so it carries no heading, no close button and no bookkeeping of its own —
 * which analysis number this is, what it cost and which model wrote it are the
 * platform's records (the cost is in 设置 → 用量), not the reader's (plan §5.5).
 */
export function SourceUnderstandingPanel({ projectId, sourceId, generation, error: failure = null }: {
  projectId: string; sourceId: string; generation?: number;
  /** The source row's stored failure, so a generation that died can say why.
   * The panel never fetches it: the page already holds the source record. */
  error?: { code: string; message: string } | null;
}) {
  const [detail, setDetail] = useState<SourceUnderstandingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<SourceUnderstanding[] | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<SourceUnderstanding | null>(null);
  const identity = useRef(0);

  useEffect(() => {
    const requestIdentity = ++identity.current;
    let disposed = false;
    let inFlight = false;
    let processing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !disposed && identity.current === requestIdentity && getWebProjectId() === projectId;
    setDetail(null); setError(null); setHistory(null); setHistoryVisible(false); setSelected(null);
    setHistoryLoading(false); setHistoryError(null); setNextCursor(null);
    const load = async () => {
      if (inFlight || !current()) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const value = await getSourceUnderstanding(sourceId);
        if (!current()) return;
        if (value.sourceId !== sourceId || (generation != null && value.generation < generation)
          || (value.current && (value.current.sourceId !== sourceId || value.current.generation !== value.generation))) {
          throw new Error("Source understanding identity changed.");
        }
        setDetail(value); setError(null);
        processing = active(value.status);
        if (processing && !document.hidden) timer = setTimeout(() => { void load(); }, POLL_MS);
      } catch (loadError) {
        if (current()) setError(`无法加载资料理解：${productErrorMessage(loadError)}`);
        processing = false;
      } finally { inFlight = false; }
    };
    const visibilityChanged = () => {
      if (document.hidden) clearTimeout(timer);
      else if (processing) void load();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void load();
    return () => { disposed = true; clearTimeout(timer); identity.current += 1; document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [projectId, sourceId, generation, attempt]);

  const loadHistory = async (cursor: string | null = null) => {
    if (historyLoading || getWebProjectId() !== projectId) return;
    const requestIdentity = identity.current;
    setHistoryVisible(true); setHistoryLoading(true); setHistoryError(null);
    const current = () => requestIdentity === identity.current && getWebProjectId() === projectId;
    try {
      const page = await listSourceUnderstandingHistory(sourceId, cursor);
      if (!current()) return;
      if (page.items.some(item => item.sourceId !== sourceId)) throw new Error("Source history identity changed.");
      setHistory(previous => {
        const entries = cursor ? [...(previous ?? []), ...page.items] : page.items;
        return entries.filter((item, index) => entries.findIndex(other => other.id === item.id) === index);
      });
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (current()) setHistoryError(`无法加载理解历史：${productErrorMessage(loadError)}`);
    } finally { if (current()) setHistoryLoading(false); }
  };
  const shown = selected ?? detail?.current;

  if (error) return <LoadError message={error} onRetry={() => setAttempt(value => value + 1)} />;
  if (!detail) {
    return <div role="status" aria-label="正在加载资料理解" className="animate-pulse space-y-2">
      <div className="h-4 w-2/3 rounded bg-surface-2" /><div className="h-4 w-full rounded bg-surface-2" /><div className="h-4 w-1/2 rounded bg-surface-2" />
    </div>;
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => historyVisible ? setHistoryVisible(false) : void loadHistory()}>{historyVisible ? "收起历史" : "查看历史"}</Button>
      {selected && <Button size="sm" variant="text" onClick={() => setSelected(null)}>返回当前理解</Button>}
    </div>
    {historyVisible && <div className="space-y-2" aria-label="理解历史">
      {historyError && <LoadError message={historyError} onRetry={() => void loadHistory(nextCursor)} />}
      {historyLoading && !history && <p role="status" className="text-ui text-text-3">正在加载理解历史…</p>}
      {history?.length === 0 && <p className="text-ui text-text-3">暂无历史理解</p>}
      {history && history.length > 0 && <div className="flex flex-wrap gap-1">{history.map(item => <Button key={item.id} size="sm" variant="text"
        aria-pressed={selected?.id === item.id} className={selected?.id === item.id ? "bg-surface-2 text-text" : undefined}
        onClick={() => setSelected(item)}>{writtenAt(item.createdAt)}</Button>)}</div>}
      {nextCursor && <Button size="sm" variant="text" loading={historyLoading} onClick={() => void loadHistory(nextCursor)}>加载更多历史</Button>}
    </div>}
    {/* A generation that FAILED and one that was never analysed both read
        「此代次尚无可用理解」 until 2026-09-08, so a researcher could not tell a
        dead parse from a queue — and re-uploaded the file, paying for the
        parse a second time. The source's own status is what separates the
        two; the stored error code is what names the cause. */}
    {!shown && (detail.status === "failed"
      ? <EmptyState icon={FileX2} title="这次解析失败，没有理解结果"
        description={<><p>{sourceFailureMessage(failure) ?? "系统没有记下这次失败的原因。"}</p>
          <p className="mt-1">原件仍在知识库里，可以重新分析。</p></>} />
      : <EmptyState icon={FileSearch}
        title={detail.depth === "skip" ? "此资料仅保留指纹" : detail.depth === "index_only" ? "此资料只建索引"
          : active(detail.status) ? "正在生成理解" : "这一次分析尚无可用理解"}
        description={detail.depth === "skip" || detail.depth === "index_only" ? "可在「调整分析」里提高分析深度。"
          : active(detail.status) ? undefined : "已完成的旧版本可在理解历史中查看。"} />)}
    {shown && <UnderstandingContent key={shown.id} understanding={shown} historical={selected != null} />}
  </div>;
}

function UnderstandingContent({ understanding: item, historical }: { understanding: SourceUnderstanding; historical: boolean }) {
  const operator = useOperator();
  const slots = Object.entries(item.slots);
  return <div className="space-y-6 text-ui text-text">
    <div className="space-y-2">
      {historical && <h3 className="font-medium">历史理解 · {writtenAt(item.createdAt)}</h3>}
      <p className="max-w-measure whitespace-pre-wrap">{item.summary}</p>
    </div>
    {/* The audit is the pipeline checking itself; support reads it, a
        researcher is told only what they can act on (the page's notice). */}
    {operator && <OmissionAudit audit={item.omissionAudit} />}
    <section className="space-y-2"><h3 className="font-semibold">结构化理解</h3>
      {slots.length === 0 && <p className="text-text-3">暂无结构化条目。</p>}
      <dl className="space-y-4">{slots.map(([key, slot]) => <div key={key}>
        <dt className="font-medium">{labelFor(SLOT_LABELS, key, "其他条目")}</dt><dd className="mt-1 max-w-measure space-y-1">
          {slot.state === "known" ? <><p className="whitespace-pre-wrap">{slot.value}</p><Evidence anchors={slot.evidence} understanding={item} /></>
            : <><p className="text-text-3">尚不明确</p><p className="whitespace-pre-wrap">{slot.reason}</p></>}
        </dd></div>)}</dl>
    </section>
    <section className="space-y-2"><h3 className="font-semibold">来源陈述（{item.claims.length}）</h3>
      {item.claims.length === 0 ? <p className="text-text-3">暂无已保存的来源陈述。</p>
        : <ul className="space-y-4">{item.claims.map(claim => <li key={claim.id} className="max-w-measure space-y-1"><p>{claim.statement}</p><Evidence anchors={claim.evidence} understanding={item} /></li>)}</ul>}
    </section>
    <section className="space-y-2"><h3 className="font-semibold">方法草稿（{item.methods.length}）</h3>
      {item.methods.length === 0 ? <p className="text-text-3">暂无已保存的方法草稿。</p> : item.methods.map(method => <Disclosure key={method.id} summary={method.title} summaryClassName="text-text">
        <div className="max-w-measure space-y-3 pl-5"><p>{method.description}</p><p>适用情境：{method.whenToUse}</p>
          <MethodList label="步骤" items={method.steps} /><MethodList label="检查项" items={method.checks} /><MethodList label="常见问题" items={method.pitfalls} />
          <Evidence anchors={method.evidence} understanding={item} /></div>
      </Disclosure>)}
    </section>
  </div>;
}

function MethodList({ label, items }: { label: string; items: string[] }) {
  return <div><h4 className="font-medium">{label}</h4>{items.length ? <ol className="mt-1 list-decimal space-y-1 pl-5">{items.map((item, index) => <li key={index}>{item}</li>)}</ol>
    : <p className="text-text-3">资料未提供。</p>}</div>;
}

/** The audit answers "what did the analysis miss", which a coverage percentage
 *  cannot: coverage counts the units that parsed, not the ones nothing said
 *  anything about. A record written before the audit existed, and any run that
 *  did not sample, still reads `not_run` — which is not the same as zero. */
function OmissionAudit({ audit }: { audit: SourceUnderstanding["omissionAudit"] }) {
  if (audit.status !== "audited") {
    return <div className="rounded bg-surface-1 p-3"><p className="font-medium">遗漏尚未审计</p>
      {audit.reason && <p className="mt-1 text-text-3">{audit.reason}</p>}</div>;
  }
  const missed = audit.samples.filter((sample) => !sample.represented);
  const rate = audit.omissionRate;
  return <div className="rounded bg-surface-1 p-3">
    <p className="font-medium">遗漏审计：抽查 {audit.samples.length} 个片段，{missed.length} 个未被理解覆盖
      {typeof rate === "number" ? ` · 遗漏率 ${Math.round(rate * 1000) / 10}%` : ""}</p>
    {audit.reason && <p className="mt-1 text-text-3">{audit.reason}</p>}
    {missed.length > 0 && <ul className="mt-2 space-y-1 text-text-3">
      {missed.map((sample) => <li key={sample.unitId}>未覆盖片段 {sample.unitId}{sample.note ? `：${sample.note}` : ""}</li>)}
    </ul>}
  </div>;
}

function Evidence({ anchors, understanding }: { anchors: SourceAnchor[]; understanding: SourceUnderstanding }) {
  if (!anchors.length) return <p className="text-text-3">暂无可展示的原文依据。</p>;
  return <Disclosure summary={`查看原文依据（${anchors.length}）`} summaryClassName="text-caption">
    <div className="space-y-2">{anchors.map((anchor, index) => {
      const unit = understanding.units.find(candidate => candidate.id === anchor.unitId);
      const verified = unit && anchor.sourceId === understanding.sourceId && anchor.generation === understanding.generation
        && Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start >= unit.start && anchor.end <= unit.end
        && anchor.end > anchor.start && unit.text.slice(anchor.start - unit.start, anchor.end - unit.start) === anchor.quote;
      return <div key={index} className="rounded bg-surface-1 p-3">
        <p className="text-caption text-text-3">原文片段 {index + 1}</p>
        {verified ? <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-accent pl-3">{anchor.quote}</blockquote>
          : <p className="mt-1 text-text-3">此原文片段暂不可用，请重新加载理解详情。</p>}
      </div>;
    })}</div>
  </Disclosure>;
}
