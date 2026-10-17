import { useState, type ReactNode } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { releaseGeoArticle, withdrawGeoArticle, type GeoArticle, type GeoProject } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ArticleTextDialog } from "../ArticleTextDialog";
import { useOpenArticle } from "./useOpenArticle";

/** What the page needs of an article to act on it: its identity and where its text is. */
export type ArticleRef = Pick<GeoArticle, "id" | "title" | "runId" | "path"> & { cardId?: string | null };

/**
 * What a person may do with an article, once, for every place that lists one (the actions page, an action's drawer, a group's
 * drawer): read it — in the report reader where it is a file, in a dialog where it is made from a card —, release it past the one
 * safety stop, or take it out of distribution. The two that change something confirm, as they always did; the dialogs are
 * returned to be drawn once by the page that owns the hook.
 */
export function useArticleActions(geoId: string, project: GeoProject, onChanged: () => void) {
  const openFile = useOpenArticle(project);
  const [pending, setPending] = useState<{ kind: "withdraw" | "release"; article: ArticleRef } | null>(null);
  const [reading, setReading] = useState<ArticleRef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = () => {
    if (!pending) return;
    const { kind, article } = pending;
    setPending(null);
    setBusy(article.id);
    const work = kind === "withdraw" ? withdrawGeoArticle(geoId, article.id) : releaseGeoArticle(geoId, article.id);
    void work
      .then(() => {
        toast.success(kind === "withdraw" ? "已撤回，这篇不再投放。" : "已放行，这篇可以投放了。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: kind === "withdraw" ? "这篇稿件无法撤回，请稍后重试。" : "这篇稿件无法放行，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  const dialogs: ReactNode = (
    <>
      {reading && <ArticleTextDialog geoId={geoId} articleId={reading.id} title={reading.title || "证据卡片"} onClose={() => setReading(null)} />}
      {pending?.kind === "withdraw" && (
        <ConfirmDialog
          title={`撤回“${pending.article.title || "这篇稿件"}”？`}
          body="撤回后这篇稿件不再投放。已经发布出去的不会被撤下。"
          confirmLabel="撤回"
          onConfirm={act}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === "release" && (
        <ConfirmDialog
          tone="primary"
          title={`放行“${pending.article.title || "这篇稿件"}”？`}
          body="确认这篇稿件的安全问题已经看过、可以对外发布。放行后它会进入投放。"
          confirmLabel="放行"
          onConfirm={act}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );

  return {
    /** Whether the article has anything to open, and the word for the button that opens it. */
    reachable: (article: ArticleRef): { label: string } | null => (article.runId && article.path ? { label: "打开稿件" } : article.cardId ? { label: "查看稿件" } : null),
    open: (article: ArticleRef) => {
      if (openFile(article)) return;
      if (article.cardId) setReading(article);
    },
    release: (article: ArticleRef) => setPending({ kind: "release", article }),
    withdraw: (article: ArticleRef) => setPending({ kind: "withdraw", article }),
    busy,
    dialogs,
  };
}
