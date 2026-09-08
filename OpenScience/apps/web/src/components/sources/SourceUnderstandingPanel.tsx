import { useEffect, useRef, useState } from "react";
import { FileSearch, FileX2 } from "lucide-react";
import { getWebProjectId } from "@/lib/apiClient";
import { getSourceUnderstanding, listSourceUnderstandingHistory, sourceFailureMessage,
  type SourceAnchor, type SourceUnderstanding, type SourceUnderstandingResult } from "@/lib/sourceClient";
import { productErrorMessage } from "@/lib/productClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/cards/EmptyState";
import { MemorySkeleton } from "@/components/cards/Skeletons";

const POLL_MS = 5000;
const DEPTH_LABELS = { skip: "仅保留指纹", index_only: "只建索引", structured: "结构化抽取", deep: "深度分析" };
const SLOT_LABELS: Record<string, string> = {
  purpose: "目的", applicability: "适用范围", scope: "适用范围", inputs: "输入", steps: "步骤", checks: "检查项",
  pitfalls: "常见问题", limitations: "局限", design: "研究设计", population: "研究人群", intervention: "干预或暴露",
  outcomes: "研究终点", outcome: "研究终点", results: "结果", doi: "DOI", title: "标题", topics: "主题", summary: "摘要",
  interventionExposure: "干预或暴露", effectEstimates: "效应估计", topic: "主题", decisions: "决定", actions: "行动",
  openQuestions: "待解决问题", keyInformation: "关键信息",
};

function active(status: string) { return status === "queued" || status === "parsing"; }
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间未记录";
}

export function SourceUnderstandingPanel({ projectId, sourceId, sourceName, generation, error: failure = null, onClose }: {
  projectId: string; sourceId: string; sourceName: string; generation?: number;
  /** The source row's stored failure, so a generation that died can say why.
   * The panel never fetches it: the page already holds the source record. */
  error?: { code: string; message: string } | null;
  onClose: () => void;
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
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: "nearest" });
  }, [sourceId]);

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

  return <Card title="资料理解" hint={sourceName} header={<div className="flex items-center justify-between gap-3">
    <div><h2 ref={heading} tabIndex={-1} className="font-serif text-body text-text">资料理解</h2><p className="text-ui-sm text-muted">{sourceName}</p></div>
    <Button size="sm" variant="ghost" onClick={onClose}>关闭理解详情</Button>
  </div>}>
    <div className="space-y-4">
      {error && <div role="alert" className="space-y-2 text-ui-sm text-error"><p>{error}</p>
        <Button size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试加载理解</Button></div>}
      {!detail && !error && <div role="status" aria-label="正在加载资料理解"><MemorySkeleton /></div>}
      {detail && <>
        <div className="flex flex-wrap items-center gap-3 text-ui-sm text-muted">
          <span>当前处理代次：第 {detail.generation} 代 · {DEPTH_LABELS[detail.depth]}</span>
          <Button size="sm" variant="ghost" onClick={() => historyVisible ? setHistoryVisible(false) : void loadHistory()}>{historyVisible ? "收起历史" : "查看历史"}</Button>
          {selected && <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>返回当前理解</Button>}
        </div>
        {historyVisible && <div className="space-y-3 rounded-input border border-border p-3" aria-label="理解历史">
          {historyError && <div role="alert" className="space-y-2 text-ui-sm text-error"><p>{historyError}</p>
            <Button size="sm" variant="ghost" onClick={() => void loadHistory(nextCursor)}>重试加载历史</Button></div>}
          {historyLoading && !history && <p role="status" className="text-ui-sm text-muted">正在加载理解历史…</p>}
          {history?.length === 0 && <p className="text-ui-sm text-muted">暂无历史理解</p>}
          {history && <div className="flex flex-wrap gap-2">{history.map(item => <Button key={item.id} size="sm" variant="ghost"
            aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}>第 {item.generation} 代 · {timestamp(item.createdAt)}</Button>)}</div>}
          {nextCursor && <Button size="sm" variant="ghost" loading={historyLoading} onClick={() => void loadHistory(nextCursor)}>加载更多历史</Button>}
        </div>}
        {/* A generation that FAILED and one that was never analysed both read
            「此代次尚无可用理解」 until 2026-09-08, so a researcher could not tell a
            dead parse from a queue — and re-uploaded the file, paying for the
            parse a second time. The source's own status is what separates the
            two; the stored error code is what names the cause. */}
        {!shown && (detail.status === "failed"
          ? <EmptyState icon={FileX2} title={`第 ${detail.generation} 代解析失败，因此这一代没有理解结果`}
            description={<><p title={failure?.code}>{sourceFailureMessage(failure) ?? "系统没有记下这次失败的原因。"}</p>
              <p className="mt-1">原件仍在知识库里。回到资料整理台点「重新分析」会新起一代，已完成的旧代次可在理解历史中查看。</p></>} />
          : <EmptyState icon={FileSearch}
            title={detail.depth === "skip" ? "此资料仅保留指纹" : detail.depth === "index_only" ? "此资料只建索引"
              : active(detail.status) ? `第 ${detail.generation} 代理解正在生成` : "此代次尚无可用理解"}
            description={detail.depth === "skip" || detail.depth === "index_only" ? "当前深度不生成结构化理解。可在整理台调整分析深度。"
              : "已完成的旧版本可在理解历史中查看。"} />)}
        {shown && <UnderstandingContent key={shown.id} understanding={shown} historical={selected != null} />}
      </>}
    </div>
  </Card>;
}

function UnderstandingContent({ understanding: item, historical }: { understanding: SourceUnderstanding; historical: boolean }) {
  const cost = item.usage?.actualCost;
  return <div className="space-y-5 text-ui text-text">
    <div className="space-y-2">
      <h3 className="font-medium">{historical ? "历史理解" : "当前理解"} · 第 {item.generation} 代</h3>
      <p className="whitespace-pre-wrap">{item.summary}</p>
      <p className="text-ui-sm text-muted">{DEPTH_LABELS[item.depth]} · {timestamp(item.createdAt)}</p>
      <p className="text-ui-sm text-muted">{typeof cost === "number" && Number.isFinite(cost)
        ? `实际费用 ¥${cost.toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 8 })} CNY` : "实际费用尚未结算"}</p>
      {item.usage ? <p className="break-words text-ui-sm text-muted">模型：{item.usage.modelId} · 提供方：{item.usage.providerId}
        {item.usage.inputTokens != null && ` · 输入 ${item.usage.inputTokens} tokens`}{item.usage.outputTokens != null && ` · 输出 ${item.usage.outputTokens} tokens`}</p>
        : <p className="text-ui-sm text-muted">模型与用量尚未记录</p>}
      {item.run && <div className="flex flex-wrap items-center gap-2"><a className={buttonClasses({ variant: "ghost", size: "sm" })}
        href={`/app/chat/${encodeURIComponent(item.run.sessionId)}`}>查看研究会话</a><span className="break-all text-ui-sm text-muted">运行：{item.run.id}</span></div>}
    </div>
    <OmissionAudit audit={item.omissionAudit} />
    <div className="space-y-3"><h3 className="font-medium">结构化理解</h3>
      {Object.entries(item.slots).length === 0 && <p className="text-ui-sm text-muted">暂无结构化条目。</p>}
      <dl className="space-y-3">{Object.entries(item.slots).map(([key, slot]) => <div key={key} className="rounded-input border border-border p-3">
        <dt className="font-medium">{SLOT_LABELS[key] ?? key}</dt><dd className="mt-1 space-y-2">
          {slot.state === "known" ? <><p className="whitespace-pre-wrap">{slot.value}</p><Evidence anchors={slot.evidence} understanding={item} /></>
            : <><p className="text-ui-sm text-muted">尚不明确</p><p className="whitespace-pre-wrap">{slot.reason}</p></>}
        </dd></div>)}</dl>
    </div>
    <div className="space-y-3"><h3 className="font-medium">来源陈述（{item.claims.length}）</h3>
      {item.claims.length === 0 ? <p className="text-ui-sm text-muted">暂无已保存的来源陈述。</p>
        : item.claims.map(claim => <div key={claim.id} className="space-y-2 rounded-input border border-border p-3"><p>{claim.statement}</p><Evidence anchors={claim.evidence} understanding={item} /></div>)}
    </div>
    <div className="space-y-3"><h3 className="font-medium">方法草稿（{item.methods.length}）</h3><p className="text-ui-sm text-muted">方法草稿尚未发布为胶囊技能。</p>
      {item.methods.length === 0 ? <p className="text-ui-sm text-muted">暂无已保存的方法草稿。</p> : item.methods.map(method => <details key={method.id} className="rounded-input border border-border p-3">
        <summary className="cursor-pointer font-medium focus-visible:outline-accent">{method.title} · 草稿</summary>
        <div className="mt-3 space-y-3"><p>{method.description}</p><p>适用情境：{method.whenToUse}</p>
          <MethodList label="步骤" items={method.steps} /><MethodList label="检查项" items={method.checks} /><MethodList label="常见问题" items={method.pitfalls} />
          <Evidence anchors={method.evidence} understanding={item} /></div>
      </details>)}
    </div>
  </div>;
}

function MethodList({ label, items }: { label: string; items: string[] }) {
  return <div><h4 className="text-ui-sm font-medium">{label}</h4>{items.length ? <ol className="mt-1 list-decimal space-y-1 pl-5">{items.map((item, index) => <li key={index}>{item}</li>)}</ol>
    : <p className="text-ui-sm text-muted">资料未提供。</p>}</div>;
}

/** The audit answers "what did the analysis miss", which a coverage percentage
 *  cannot: coverage counts the units that parsed, not the ones nothing said
 *  anything about. A record written before the audit existed, and any run that
 *  did not sample, still reads `not_run` — which is not the same as zero. */
function OmissionAudit({ audit }: { audit: SourceUnderstanding["omissionAudit"] }) {
  if (audit.status !== "audited") {
    return <div className="rounded-input bg-surface-2 p-3 text-ui-sm"><p className="font-medium">遗漏尚未审计</p>
      <p className="mt-1 text-muted">{audit.reason}</p></div>;
  }
  const missed = audit.samples.filter((sample) => !sample.represented);
  const rate = audit.omissionRate;
  return <div className="rounded-input bg-surface-2 p-3 text-ui-sm">
    <p className="font-medium">遗漏审计：抽查 {audit.samples.length} 个单元，{missed.length} 个未被理解覆盖
      {typeof rate === "number" ? ` · 遗漏率 ${Math.round(rate * 1000) / 10}%` : ""}</p>
    {audit.reason && <p className="mt-1 text-muted">{audit.reason}</p>}
    {missed.length > 0 && <ul className="mt-2 space-y-1 text-muted">
      {missed.map((sample) => <li key={sample.unitId}>未覆盖单元 {sample.unitId}{sample.note ? `：${sample.note}` : ""}</li>)}
    </ul>}
  </div>;
}

function Evidence({ anchors, understanding }: { anchors: SourceAnchor[]; understanding: SourceUnderstanding }) {
  if (!anchors.length) return <p className="text-ui-sm text-muted">暂无可展示的原文依据。</p>;
  return <details className="text-ui-sm"><summary className="cursor-pointer text-accent focus-visible:outline-accent">查看原文依据（{anchors.length}）</summary>
    <div className="mt-2 space-y-3">{anchors.map((anchor, index) => {
      const unit = understanding.units.find(candidate => candidate.id === anchor.unitId);
      const verified = unit && anchor.sourceId === understanding.sourceId && anchor.generation === understanding.generation
        && Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start >= unit.start && anchor.end <= unit.end
        && anchor.end > anchor.start && unit.text.slice(anchor.start - unit.start, anchor.end - unit.start) === anchor.quote;
      return <div key={index} className="rounded-input bg-surface-2 p-3">
        <p className="text-muted">解析文本 · 第 {anchor.generation} 代 · {anchor.unitId} · 字符 {anchor.start}–{anchor.end}</p>
        {verified ? <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-accent pl-3">{anchor.quote}</blockquote>
          : <p className="mt-2 text-muted">此原文片段暂不可用，请重新加载理解详情。</p>}
      </div>;
    })}</div>
  </details>;
}
