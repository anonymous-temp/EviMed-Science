import { useEffect, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { getGeoArticleText, type GeoArticleText } from "@/lib/geoClient";
import { FormDialog } from "@/components/ui/FormDialog";

/**
 * 「查看」 — an article that has no file of its own: the 证据卡片 layer is the card's public view, rendered from the card each time it is
 * read, so a corrected card is a corrected article. The text is what would leave the platform — the claim references taken off, the
 * author named, the relation to the product said and the AI label — shown as it is, never edited here.
 */
export function ArticleTextDialog({ geoId, articleId, title, onClose }: { geoId: string; articleId: string; title: string; onClose: () => void }) {
  const [data, setData] = useState<GeoArticleText | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getGeoArticleText(geoId, articleId).then(
      (text) => { if (live) setData(text); },
      (caught: unknown) => { if (live) setError(webErrorMessage(caught, { fallback: "稿件暂时无法读取，请稍后重试。" })); },
    );
    return () => { live = false; };
  }, [geoId, articleId]);

  return (
    <FormDialog title={title} onClose={onClose}>
      {error ? <p role="alert" className="text-ui text-danger">{error}</p>
        : data ? <pre data-geo-article-text="" className="whitespace-pre-wrap break-words font-sans text-ui text-text">{data.markdown}</pre>
          : <p className="text-ui text-text-3">正在读取稿件</p>}
    </FormDialog>
  );
}
