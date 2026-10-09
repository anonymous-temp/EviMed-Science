import { lazy, Suspense, useEffect, useState } from "react";
import { getSourceQuoteExcerpt, type SourceQuoteExcerpt, type SourceRecord } from "@/lib/sourceClient";
import { SourceOriginal } from "./SourceOriginal";
import { originalPathOf } from "./sourceView";

const SourcePdf = lazy(() => import("./SourcePdf").then(module => ({ default: module.SourcePdf })));
export interface QuotationSpan { start: number; end: number; sha: string }

export function SourceQuotation({ source, span, page, onNoteSaved }: {
  source: SourceRecord; span: QuotationSpan; page?: number; onNoteSaved: (source: SourceRecord) => void;
}) {
  const [excerpt, setExcerpt] = useState<SourceQuoteExcerpt | null>(null);
  const [error, setError] = useState(false);
  const { start, end, sha } = span;
  useEffect(() => {
    let alive = true;
    setExcerpt(null); setError(false);
    void getSourceQuoteExcerpt(source.id, { start, end, sha }).then(value => { if (alive) setExcerpt(value); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [source.id, start, end, sha]);
  const path = originalPathOf(source);
  const available = excerpt?.status === "available" && excerpt.text !== null && excerpt.start !== null && excerpt.end !== null;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-border bg-surface p-4 text-ui text-text" aria-label="引用原文">
      {available ? <p className="whitespace-pre-wrap break-words">{excerpt.text!.slice(0, excerpt.start!)}<mark className="bg-accent-soft text-text">{excerpt.text!.slice(excerpt.start!, excerpt.end!)}</mark>{excerpt.text!.slice(excerpt.end!)}</p>
        : <p className="text-caption text-text-2">{error ? "引文暂时无法读取" : excerpt ? "资料版本已变化，原引文位置暂时无法显示" : "正在定位引文"}</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {available && path?.toLowerCase().endsWith(".pdf")
        ? <Suspense fallback={<p className="p-4 text-caption text-text-3">正在打开 PDF</p>}><SourcePdf path={path} projectId={source.projectId} initialPage={excerpt.page ?? page ?? 1} quote={excerpt.quote!} /></Suspense>
        : <SourceOriginal source={source} page={page} onNoteSaved={onNoteSaved} />}
    </div>
  </div>;
}
