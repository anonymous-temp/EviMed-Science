import { useEffect, useId, useRef, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { getGeoArticleText, type GeoArticleText } from "@/lib/geoClient";
import { trapTab } from "@/lib/focusTrap";
import { Button } from "@/components/ui/Button";

/**
 * 「查看」 — an article that has no file of its own: the 证据卡片 layer is the card's public view, rendered from the card each time it is
 * read, so a corrected card is a corrected article. The text is what would leave the platform — the claim references taken off, the
 * author named, the relation to the product said and the AI label — shown as it is, never edited here.
 */
export function ArticleTextDialog({ geoId, articleId, title, onClose }: { geoId: string; articleId: string; title: string; onClose: () => void }) {
  const [data, setData] = useState<GeoArticleText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let live = true;
    void getGeoArticleText(geoId, articleId).then(
      (text) => { if (live) setData(text); },
      (caught: unknown) => { if (live) setError(webErrorMessage(caught, { fallback: "稿件暂时无法读取，请稍后重试。" })); },
    );
    return () => { live = false; };
  }, [geoId, articleId]);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") trapTab(dialogRef.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); trigger?.focus(); };
  }, []);

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-card border border-border bg-surface p-6 shadow-modal">
        <h2 id={titleId} className="text-ui font-semibold text-text">{title}</h2>
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {error ? <p role="alert" className="text-ui text-danger">{error}</p>
            : data ? <pre data-geo-article-text="" className="whitespace-pre-wrap break-words font-sans text-ui text-text">{data.markdown}</pre>
              : <p className="text-ui text-text-3">正在读取稿件</p>}
        </div>
        <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={onClose}>关闭</Button></div>
      </div>
    </div>
  );
}
