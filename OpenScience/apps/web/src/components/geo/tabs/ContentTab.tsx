import { useState } from "react";
import { useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getGeoArticles,
  releaseGeoArticle,
  withdrawGeoArticle,
  type GeoArticle,
  type GeoArticleLayer,
  type GeoProject,
} from "@/lib/geoClient";
import { useProjectStore } from "@/lib/projects";
import { snapshotHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { GEO_ARTICLE_SAFETY_OPEN, GEO_ARTICLE_STATUS_WORDS, GEO_LAYER_NAMES, layerName } from "../geoText";
import { FilterRow, StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

type LayerFilter = "all" | GeoArticleLayer;
const LAYERS: readonly GeoArticleLayer[] = ["deep", "card", "popular", "qa", "correction"];

type Pending = { kind: "withdraw" | "release"; article: GeoArticle } | null;

/**
 * 内容 (plan §3.6, mockup g09): the articles, by layer, with where each one
 * stands. 「打开」 opens it in the report reader, in the run that wrote it;
 * 「撤回」 takes it out of distribution. An article held for an open safety
 * question is the one stop here: 「放行」, after a person has looked at it.
 */
export function ContentTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`articles:${geoId}`, () => getGeoArticles(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const articles = (Array.isArray(state.data?.articles) ? state.data.articles : []).filter((article) => article && article.id);
  if (articles.length === 0) return <StepPending geoId={geoId} project={project} step="content" />;
  return <Articles geoId={geoId} project={project} articles={articles} onChanged={reload} />;
}

function Articles({ geoId, project, articles, onChanged }: { geoId: string; project: GeoProject; articles: GeoArticle[]; onChanged: () => void }) {
  const navigate = useNavigate();
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const present = LAYERS.filter((key) => articles.some((article) => article.layer === key));
  const options: FilterOption<LayerFilter>[] = [
    { value: "all", label: "全部" },
    ...present.map((key) => ({ value: key, label: GEO_LAYER_NAMES[key] })),
  ];
  const current = layer === "all" || present.includes(layer) ? layer : "all";
  const shown = current === "all" ? articles : articles.filter((article) => article.layer === current);
  const published = articles.filter((article) => article.status === "published").length;

  /** The article is a file in the run that wrote it: the shell moves to the GEO project, then opens the reader. */
  const open = (article: GeoArticle) => {
    if (!article.runId || !article.path) return;
    const href = snapshotHref(article.runId, article.path);
    void useProjectStore.getState().select(project.projectId, () => navigate(href))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "稿件暂时无法打开，请稍后重试。" })));
  };

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
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: kind === "withdraw" ? "没有撤回，请稍后重试。" : "没有放行，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  return (
    <div data-geo-tab="content" className="flex flex-col gap-6">
      <Pipeline articles={articles} />
      <div>
      <FilterRow summary={`${articles.length} 篇 · 已发布 ${published}`}>
        <FilterChips label="稿件层级" options={options} value={current} onChange={setLayer} />
      </FilterRow>
      <List divided className="mt-3">
        {shown.map((article) => {
          const held = article.safety === "open";
          const withdrawn = article.status === "withdrawn";
          const canOpen = Boolean(article.runId && article.path);
          const withdraw = !withdrawn ? () => setPending({ kind: "withdraw", article }) : null;
          return (
            <ListRow
              key={article.id}
              title={article.title || article.question || "未命名稿件"}
              onOpen={canOpen ? () => open(article) : undefined}
              muted={withdrawn}
              meta={articleMeta(article)}
              trailing={held
                ? <Tag tone="safety">{GEO_ARTICLE_SAFETY_OPEN}</Tag>
                : <span data-geo-article-status={article.status}>{statusLine(article)}</span>}
              actions={(
                <>
                  {canOpen && <Button variant="text" size="sm" onClick={() => open(article)}>打开</Button>}
                  {held && <Button variant="text" size="sm" loading={busy === article.id} onClick={() => setPending({ kind: "release", article })}>放行</Button>}
                  {!held && withdraw && <Button variant="text" size="sm" loading={busy === article.id} onClick={withdraw}>撤回</Button>}
                </>
              )}
              menu={held && withdraw ? <Menu label="更多操作" items={[{ label: "撤回", onSelect: withdraw }]} /> : undefined}
            />
          );
        })}
      </List>
      </div>
      {pending?.kind === "withdraw" && (
        <ConfirmDialog
          title={`撤回「${pending.article.title || "这篇稿件"}」？`}
          body="撤回后这篇稿件不再投放。已经发布出去的不会被撤下。"
          confirmLabel="撤回"
          onConfirm={act}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === "release" && (
        <ConfirmDialog
          tone="primary"
          title={`放行「${pending.article.title || "这篇稿件"}」？`}
          body="确认这篇稿件的安全问题已经看过、可以对外发布。放行后它会进入投放。"
          confirmLabel="放行"
          onConfirm={act}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

/** 「科普稿件 · 投放 2 家」 */
function articleMeta(article: GeoArticle): string {
  return [
    layerName(article.layer) === "—" ? null : layerName(article.layer),
    article.title && article.question && article.question !== article.title ? article.question : null,
    article.placements > 0 ? `投放 ${article.placements} 家` : null,
  ].filter(Boolean).join(" · ");
}

/** 「已发布 · 已被 AI 引用」 */
function statusLine(article: GeoArticle): string {
  const word = GEO_ARTICLE_STATUS_WORDS[article.status] ?? "—";
  return article.cited ? `${word} · 已被 AI 引用` : word;
}

/**
 * The pipeline as four counts, left to right: written, ready to publish, live,
 * and quoted by an AI — the one place a reader can see whether the work turned
 * into anything (fusion plan §4.8, mockup m11). Each count is a fact about the
 * articles on file, never a percentage of a run.
 */
function Pipeline({ articles }: { articles: GeoArticle[] }) {
  const counts = [
    { key: "written", label: "已写好", value: articles.length },
    { key: "publishable", label: "可发布", value: articles.filter((article) => article.status === "publishable" || article.status === "placed" || article.status === "published").length },
    { key: "live", label: "已上线", value: articles.filter((article) => article.status === "published").length },
    { key: "cited", label: "被 AI 引用", value: articles.filter((article) => article.cited).length },
  ];
  const held = articles.filter((article) => article.safety === "open").length;
  return (
    <StatBand
      label="稿件流水线"
      columns={4}
      footnote={held > 0 ? `其中 ${held} 篇等你看过安全问题后才能投放` : null}
    >
      {counts.map((count) => (
        <StatTile key={count.key} label={count.label} value={String(count.value)} unit="篇" />
      ))}
    </StatBand>
  );
}
