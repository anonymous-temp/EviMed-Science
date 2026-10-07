import { useState, type ReactNode } from "react";
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
import { SearchInput } from "@/components/ui/SearchInput";
import { Tag } from "@/components/ui/Tag";
import { ArticleTextDialog } from "../ArticleTextDialog";
import { GEO_ARTICLE_SAFETY_OPEN, GEO_ARTICLE_STALE_NOTE, GEO_ARTICLE_STATUS_WORDS, GEO_ARTICLE_UNRESOLVED_NOTE, GEO_LAYER_NAMES, GEO_PLACEMENT_LABEL_WORDS, layerName } from "../geoText";
import { FilterRow, StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";

/** Articles listed before 「显示更多」, and how many each press adds. */
const ARTICLES_SHOWN = 10;
const ARTICLES_STEP = 20;

type LayerFilter = "all" | GeoArticleLayer;
const LAYERS: readonly GeoArticleLayer[] = ["deep", "card", "popular", "qa", "correction"];

type Pending = { kind: "withdraw" | "release"; article: GeoArticle } | null;

/**
 * 内容 (plan §3.6, mockup g09): the articles, by layer, with where each one
 * stands. The row's one action opens the article in the report reader, in the
 * run that wrote it; “撤回” (in the row's ⋯) takes it out of distribution. An
 * article held for an open safety question is the one stop here: “放行”, after
 * a person has looked at it.
 *
 * `notice` is a sentence about what placing waits for; it is said directly
 * under the stage counts, where the reader first wonders why nothing is live.
 */
export function ContentTab({ geoId, project, notice }: { geoId: string; project: GeoProject; notice?: ReactNode }) {
  const { state, reload } = useGeoLoad(`articles:${geoId}`, () => getGeoArticles(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const articles = (Array.isArray(state.data?.articles) ? state.data.articles : []).filter((article) => article && article.id);
  if (articles.length === 0) return <StepPending geoId={geoId} project={project} step="content" />;
  return <Articles geoId={geoId} project={project} articles={articles} notice={notice} onChanged={reload} />;
}

function Articles({ geoId, project, articles, notice, onChanged }: { geoId: string; project: GeoProject; articles: GeoArticle[]; notice?: ReactNode; onChanged: () => void }) {
  const navigate = useNavigate();
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The article whose text is open: one made from a card, which has no file for the report reader. */
  const [reading, setReading] = useState<GeoArticle | null>(null);
  const present = LAYERS.filter((key) => articles.some((article) => article.layer === key));
  const options: FilterOption<LayerFilter>[] = [
    { value: "all", label: "全部" },
    ...present.map((key) => ({ value: key, label: GEO_LAYER_NAMES[key] })),
  ];
  const current = layer === "all" || present.includes(layer) ? layer : "all";
  const needle = query.trim().toLowerCase();
  const matching = articles
    .filter((article) => current === "all" || article.layer === current)
    .filter((article) => !needle || `${article.title ?? ""} ${article.question ?? ""}`.toLowerCase().includes(needle));
  const { visible, remaining, more } = useShowMore(matching, { first: ARTICLES_SHOWN, step: ARTICLES_STEP, resetKey: `${current}|${needle}` });

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
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: kind === "withdraw" ? "这篇稿件无法撤回，请稍后重试。" : "这篇稿件无法放行，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  return (
    <div data-geo-tab="content" className="flex flex-col gap-6">
      <div>
        <Pipeline articles={articles} />
        {notice}
      </div>
      <div>
        <FilterRow summary={`${needle ? "匹配 " : ""}${matching.length} 篇`}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 max-sm:w-full">
            <FilterChips label="稿件层级" options={options} value={current} onChange={setLayer} />
            <SearchInput label="搜索稿件" size="sm" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} className="w-52 max-sm:w-full" />
          </div>
        </FilterRow>
        {matching.length === 0 ? (
          <p className="py-10 text-center text-ui text-text-3">{needle ? `没有包含“${query.trim()}”的稿件。` : "没有符合的稿件。"}</p>
        ) : (
          <>
            <List divided className="mt-3">
              {visible.map((article) => {
                const held = article.safety === "open";
                const withdrawn = article.status === "withdrawn";
                const canOpen = Boolean(article.runId && article.path);
                const canRead = !canOpen && Boolean(article.cardId);
                const withdraw = !withdrawn ? () => setPending({ kind: "withdraw", article }) : null;
                const title = article.title || article.question || "未命名稿件";
                return (
                  <ListRow
                    key={article.id}
                    title={title}
                    onOpen={canOpen ? () => open(article) : canRead ? () => setReading(article) : undefined}
                    muted={withdrawn}
                    // On a phone the status joins the line under the title: beside the action and the ⋯ it would leave the title a few words.
                    meta={held ? articleMeta(article) : (
                      <>
                        {articleMeta(article)}
                        <span className="sm:hidden">{articleMeta(article) ? " · " : ""}{statusLine(article)}</span>
                      </>
                    )}
                    trailing={held
                      ? <Tag tone="safety">{GEO_ARTICLE_SAFETY_OPEN}</Tag>
                      : <span data-geo-article-status={article.status} className="max-sm:hidden">{statusLine(article)}</span>}
                    // One visible action: the one that moves the article on. 撤回 is the row's ⋯.
                    actions={held
                      ? <Button variant="text" size="sm" loading={busy === article.id} onClick={() => setPending({ kind: "release", article })}>放行</Button>
                      : canOpen
                        ? <Button variant="text" size="sm" onClick={() => open(article)}>打开</Button>
                        : canRead ? <Button variant="text" size="sm" onClick={() => setReading(article)}>查看</Button> : undefined}
                    menu={withdraw ? <Menu label={`“${title}”的操作`} items={[{ label: "撤回", onSelect: withdraw }]} /> : undefined}
                  />
                );
              })}
            </List>
            <ShowMore remaining={remaining} unit="篇" onMore={more} />
          </>
        )}
      </div>
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
    </div>
  );
}

/** “科普稿件 · 投放 2 家” */
function articleMeta(article: GeoArticle): string {
  return [
    layerName(article.layer) === "—" ? null : layerName(article.layer),
    article.title && article.question && article.question !== article.title ? article.question : null,
    article.placements > 0 ? `投放 ${article.placements} 家` : null,
    article.placementLabel ? GEO_PLACEMENT_LABEL_WORDS[article.placementLabel] ?? null : null,
    (article.staleReferences?.length ?? 0) > 0 ? GEO_ARTICLE_STALE_NOTE : null,
    article.referenceStatus === "unresolved" ? GEO_ARTICLE_UNRESOLVED_NOTE : null,
  ].filter(Boolean).join(" · ");
}

/** “已发布 · 已被 AI 引用” */
function statusLine(article: GeoArticle): string {
  const word = GEO_ARTICLE_STATUS_WORDS[article.status] ?? "—";
  return article.cited ? `${word} · 已被 AI 引用` : word;
}

/**
 * The pipeline as four counts, one stage each: ready to publish, placed with an
 * outlet and waiting, live, and quoted by an AI — the one place a reader can
 * see whether the work turned into anything (fusion plan §4.8, mockup m11).
 * The stages do not overlap, so they never read as the same number twice: the
 * total is the list's own count. Each count is a fact about the articles on
 * file, never a percentage of a run.
 */
function Pipeline({ articles }: { articles: GeoArticle[] }) {
  const counts = [
    { key: "publishable", label: "可发布", value: articles.filter((article) => article.status === "publishable").length },
    { key: "placed", label: "投放中", value: articles.filter((article) => article.status === "placed").length },
    { key: "live", label: "已上线", value: articles.filter((article) => article.status === "published").length },
    { key: "cited", label: "被 AI 引用", value: articles.filter((article) => article.cited).length },
  ];
  const held = articles.filter((article) => article.safety === "open").length;
  return (
    <StatBand
      label="稿件流水线"
      columns={4}
      dense
      footnote={held > 0 ? `其中 ${held} 篇等你看过安全问题后才能投放` : null}
    >
      {counts.map((count) => (
        <StatTile key={count.key} label={count.label} value={String(count.value)} unit="篇" dense />
      ))}
    </StatBand>
  );
}
