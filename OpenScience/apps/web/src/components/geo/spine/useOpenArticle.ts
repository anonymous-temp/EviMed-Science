import { useCallback } from "react";
import { useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import type { GeoProject } from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { snapshotHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";

/**
 * Open an article in the report reader. An article is a file in the run that wrote it: the shell moves to the GEO project first
 * (the reader reads the project's runs), then goes to the file. It answers whether it could: an article made from a card has no
 * file of its own (its text is read in a dialog), and a draft nobody wrote a file for has nothing to open.
 */
export function useOpenArticle(project: GeoProject): (article: { runId?: string | null; path?: string | null }) => boolean {
  const navigate = useNavigate();
  return useCallback((article) => {
    if (!article.runId || !article.path) return false;
    const href = snapshotHref(article.runId, article.path);
    void useProjectStore.getState().select(project.projectId, () => navigate(href))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "稿件暂时无法打开，请稍后重试。" })));
    return true;
  }, [navigate, project.projectId]);
}
