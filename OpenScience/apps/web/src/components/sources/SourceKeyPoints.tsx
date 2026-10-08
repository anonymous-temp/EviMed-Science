import { useEffect, useState } from "react";
import { sourcePageForOffset } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { LoadError } from "@/components/cards/LoadError";
import { productErrorMessage } from "@/lib/productClient";
import { getSourceUnderstanding, sourceFailureMessage, type SourceAnchor, type SourceRecord, type SourceUnderstanding, type SourceUnderstandingResult } from "@/lib/sourceClient";
import { labelFor } from "@/lib/statusLabel";
import { DatasetMeaningPanel } from "./DatasetMeaningPanel";
import { isReading } from "./sourceView";

/** The most key points a drawer lists: what the document says, not everything it says. */
const KEY_POINTS = 8;

/** The study slots of a paper, as a researcher names them. Only a paper has them, and only the ones it states are shown. */
const SLOT_LABELS: Record<string, string> = {
  design: "研究设计", population: "研究人群", interventionExposure: "干预或暴露", outcomes: "研究终点",
  effectEstimates: "效应估计", doi: "DOI", limitations: "局限",
};
const PAPER_SLOTS = ["design", "population", "interventionExposure", "outcomes", "effectEstimates", "doi"];

/** The pages a claim rests on, in order, from where its anchors fall in the text. */
function pagesOf(anchors: readonly SourceAnchor[], pageMap: SourceUnderstandingResult["pageMap"]): number[] {
  const pages = anchors.map((anchor) => sourcePageForOffset(pageMap, anchor.start)).filter((page): page is number => page != null);
  return [...new Set(pages)].sort((left, right) => left - right).slice(0, 2);
}

/**
 * 「内容」: what the document says — its summary, then up to eight key points, each with the page it rests on. A
 * page of a PDF opens that page in 「原文」; a document with no pages to open on names the page in plain text. A table
 * has its columns and what each one means instead of key points. Nothing about how it was read: no slots the
 * document's type does not have, no 「尚不明确」, no audit.
 */
export function SourceContent({ source, onShowPage, onRetry, busy }: {
  source: SourceRecord;
  onShowPage: (page: number) => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const [detail, setDetail] = useState<SourceUnderstandingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { generation, currentUnderstandingId, status } = source.payload;
  useEffect(() => {
    let active = true;
    setError(null);
    getSourceUnderstanding(source.id).then(
      (value) => { if (active) setDetail(value); },
      (failure) => { if (active) setError(`无法加载内容：${productErrorMessage(failure)}`); },
    );
    return () => { active = false; };
  }, [source.id, generation, currentUnderstandingId, status, attempt]);

  const table = source.display.kind === "table";
  const meaning = table ? (
    <DatasetMeaningPanel projectId={source.projectId} path={source.payload.paths[0] ?? ""} sha256={source.payload.fingerprint?.sha256 ?? null} />
  ) : null;
  if (error) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!detail) return <div role="status" aria-label="正在加载内容" className="animate-pulse space-y-2"><div className="h-4 w-2/3 rounded bg-surface-2" /><div className="h-4 w-full rounded bg-surface-2" /><div className="h-4 w-1/2 rounded bg-surface-2" /></div>;
  const current = detail.current;
  if (!current) {
    if (isReading(source)) return <><p className="text-ui text-text-3">正在读取</p>{meaning}</>;
    if (status === "failed" || status === "needs_attention") {
      return (
        <div className="space-y-3">
          <p className="max-w-measure text-ui text-text-2">{sourceFailureMessage(source.payload.error) ?? "这份资料没能读取。"}</p>
          <Button variant="secondary" disabled={busy} onClick={onRetry}>重新读取</Button>
          {meaning}
        </div>
      );
    }
    return meaning ?? <p className="text-ui text-text-3">没有可以显示的内容。</p>;
  }
  return <UnderstoodContent source={source} understanding={current} pageMap={detail.pageMap ?? null} meaning={meaning} onShowPage={onShowPage} />;
}

function UnderstoodContent({ source, understanding, pageMap, meaning, onShowPage }: {
  source: SourceRecord; understanding: SourceUnderstanding; pageMap: SourceUnderstandingResult["pageMap"]; meaning: React.ReactNode;
  onShowPage: (page: number) => void;
}) {
  const authors = source.payload.metadata?.authors?.filter(Boolean) ?? [];
  const known = PAPER_SLOTS.flatMap((key) => {
    const slot = understanding.slots[key];
    return slot?.state === "known" ? [[key, slot.value] as const] : [];
  });
  const openable = source.display.format === "pdf";
  return (
    <div className="space-y-6 text-ui text-text">
      <section className="space-y-2">
        <h3 className="text-caption text-text-3">讲了什么</h3>
        <p className="max-w-measure-body whitespace-pre-wrap">{understanding.summary}</p>
        {source.display.kind === "literature" && authors.length > 0 && (
          <p className="text-caption text-text-3">{authors.slice(0, 3).join("、")}{authors.length > 3 ? " 等" : ""}</p>
        )}
      </section>
      {known.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-caption text-text-3">研究信息</h3>
          <dl className="space-y-2">
            {known.map(([key, value]) => (
              <div key={key} className="flex gap-3">
                <dt className="w-24 shrink-0 text-text-3">{labelFor(SLOT_LABELS, key, "其他")}</dt>
                <dd className="min-w-0 max-w-measure whitespace-pre-wrap">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {source.display.kind === "table" ? meaning : (
        understanding.claims.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-caption text-text-3">要点</h3>
            <ol className="space-y-3">
              {understanding.claims.slice(0, KEY_POINTS).map((claim, index) => {
                const pages = pagesOf(claim.evidence, pageMap);
                return (
                  <li key={claim.id} className="flex gap-2">
                    <span className="w-5 shrink-0 text-text-3 tabular-nums">{index + 1}.</span>
                    <span className="min-w-0 max-w-measure">
                      {claim.statement}
                      {pages.map((page) => openable
                        ? <Button key={page} variant="text" size="sm" className="ml-1 px-1 text-accent" onClick={() => onShowPage(page)}>第 {page} 页</Button>
                        : <span key={page} className="ml-2 text-text-3">第 {page} 页</span>)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )
      )}
    </div>
  );
}
