import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { previewUrl } from "@/lib/artifactFile";
import { Button } from "@/components/ui/Button";
import { markPdfQuotation } from "@/lib/pdfQuotation";
import "./sourcePdf.css";

GlobalWorkerOptions.workerSrc = workerUrl;

/** One page at a time bounds canvas memory, including long documents on phones. */
export function SourcePdf({ path, projectId, initialPage, quote }: { path: string; projectId: string; initialPage: number; quote: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [error, setError] = useState(false);
  const [marked, setMarked] = useState<boolean | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(1, entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    let loading: ReturnType<typeof getDocument> | undefined;
    setError(false);
    setPdf(null);
    void previewUrl(path, "base", projectId).then(async url => {
      if (!alive) return;
      if (!url) throw new Error("Preview unavailable");
      loading = getDocument({ url, withCredentials: true });
      const document = await loading.promise;
      if (alive) setPdf(document);
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; void loading?.destroy(); };
  }, [path, projectId]);
  useEffect(() => {
    const element = root.current;
    if (!element || !pdf) return;
    let alive = true;
    let rendering: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let textLayer: TextLayer | undefined;
    setMarked(null);
    setError(false);
    void (async () => {
      const current = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages));
      if (!alive) return;
      const natural = current.getViewport({ scale: 1 });
      const scale = width / natural.width;
      const viewport = current.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("aria-label", `第 ${page} 页`);
      const layer = document.createElement("div");
      layer.className = "evimed-pdf-text";
      layer.style.setProperty("--total-scale-factor", String(scale));
      element.replaceChildren(canvas, layer);
      rendering = current.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      const textContent = await current.getTextContent();
      if (!alive) return;
      textLayer = new TextLayer({ textContentSource: textContent, container: layer, viewport });
      await Promise.all([rendering.promise, textLayer.render()]);
      if (alive) setMarked(markPdfQuotation(textLayer.textDivs, textLayer.textContentItemsStr, quote));
    })().catch(() => { if (alive) setError(true); });
    return () => { alive = false; rendering?.cancel(); textLayer?.cancel(); element.replaceChildren(); };
  }, [pdf, page, width, quote]);
  return <div className="min-h-0 overflow-y-auto bg-surface-2">
    <div className="sticky top-0 z-sticky flex items-center justify-center gap-3 border-b border-border bg-surface p-2">
      <Button variant="text" size="sm" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button>
      <span className="text-caption text-text-2">{pdf ? `${Math.min(page, pdf.numPages)} / ${pdf.numPages}` : "正在打开 PDF"}</span>
      <Button variant="text" size="sm" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}>下一页</Button>
    </div>
    {error && <p role="alert" className="p-3 text-caption text-text-2">PDF 暂时无法显示，可下载原件核对上方引文。</p>}
    {!error && marked === false && <p className="p-3 text-caption text-text-2">这一页未能标出引文，请对照上方原文摘录。</p>}
    <div ref={root} className="relative w-full" />
  </div>;
}
