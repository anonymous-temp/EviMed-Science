import { sanitizeRuntimeUiHistoryState } from "@/lib/runtimeUiNavigation";
import { GeoAnalysisEntry } from "../GeoAnalysisEntry";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import {
  chooseGeoActionSource,
  getGeoArticles,
  getGeoArticle,
  getGeoArticleCatalog,
  getGeoDistribution,
  skipGeoAction,
  type GeoAction,
  type GeoActionKind,
  type GeoArticle,
  type GeoProject,
} from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { Drawer } from "@/components/ui/Drawer";
import type { FilterOption } from "@/components/ui/FilterChips";
import { List } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Input, Select } from "@/components/ui/Input";
import { geoMayConverse, useGeoFrame, useGeoToolbar } from "../geoFrame";
import { geoVersionLabel } from "../geoVersionLabel";
import { LoadError } from "@/components/cards/LoadError";
import { readFailure, useGeoLoad, useGeoMonitoring, useSharedGeoLoad } from "../geoProjectData";
import { marketConnected } from "../geoOverviewModel";
import { scrollBlockToTop } from "../geoScroll";
import { geoDestinationPath, geoSectionId } from "../geoTabs";
import { ActionDrawer } from "../spine/ActionDrawer";
import { ActionRow } from "../spine/ActionRow";
import { BudgetLine, ControlGroups, EffectCard, netEffectInput, OtherArticles, ReviewBlock } from "../spine/ActionsParts";
import {
  ACTION_STAGE_LABELS,
  ACTION_STAGES,
  actionBlocks,
  filterActions,
  headlineParts,
  kindWord,
  stageCounts,
  type ActionFilter,
  type ActionStage,
} from "../spine/actionModel";
import { clusterName } from "../spine/clusterModel";
import { ClusterDrawerHost } from "../spine/ClusterDrawerHost";
import { ClusterLink } from "../spine/ClusterLink";
import { GEO_ARTICLE_PARAM, GEO_CLUSTER_FILTER_PARAM, useGeoDrawerAddress, useGeoSearchChange, useGeoSearchParam } from "../spine/drawerParams";
import { useGeoActions, useGeoClusters } from "../spine/spineData";
import { useArticleActions } from "../spine/useArticleActions";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { StepPending, TabError, TabSkeleton } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";
import { DistributionWorkbench } from './DistributionWorkbench';

/** Rows listed before 「显示更多」, and how many each press adds. */
const ROWS_SHOWN = 12;
const ROWS_STEP = 20;

/** The page's own filter on the stage, in the address so a link (and Back) means it. */
const STAGE_PARAM = "show";
const PROJECT_LEVEL = "-";
const ARTICLE_STATUS: Record<GeoArticle["status"], string> = { draft: "草稿", publishable: "可发布", placed: "已投放", published: "已发布", withdrawn: "已撤回" };
const articleUpdate = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)) : "未记录";

const KINDS: readonly GeoActionKind[] = ["correct_error", "fill_gap", "win_cluster", "maintain"];

/**
 * What the evidence cards wait for, said where the articles that cite them are: the server refuses to write them until the
 * project names its producer and a reviewing doctor, and the page said nothing (review 2026-10-10 D-28). Each says what to do
 * and the button does it.
 */
const CARDS_WAIT: Record<"producer" | "reviewer", { sentence: string; verb: string; panel: "producer" | "members" }> = {
  producer: { sentence: "设置出品方后，已核实的结论会成为证据卡片。", verb: "设置出品方", panel: "producer" },
  reviewer: { sentence: "添加审核医生后，已核实的结论会成为证据卡片。", verb: "添加审核医生", panel: "members" },
};

/**
 * 行动 — what we are doing for each question group, where it goes, what we expect and what actually happened (R19; the owner,
 * 2026-10-14: 「行动那，你的效果应该是跟具体的语义问题群和语义问题挂钩和对应吧，你别割裂了」). The old page was three sections by
 * artefact — the articles, the orders, the effect at the bottom — and none of them said which group a piece of work was for.
 *
 * It reads from the top as the question is asked:
 *
 *  1. **the result** — one sentence the platform assembles from the arms' verdict, and the picture it is about (the groups we
 *     worked on against the control groups we only watched, with the first publication and the first citation marked);
 *  2. **the one stop** — articles held for a safety finding, until a person has looked at them;
 *  3. **the work, by question group**, in the strategy's own order: each row says what is to be done, what is written for it,
 *     which source it goes to (and why, and whether the three conditions hold) and what is expected — counts, and a rate only
 *     where the platform sent one. A row opens the action's drawer; a group's name opens the group's.
 *
 * What a person may do is two reversible words — set an action aside, send it to another source — and, where the brand publishes
 * itself, paste the page's address. There is no approval step: the platform goes on by itself.
 *
 * The filters are the band's toolbar (`useGeoToolbar`); nothing on this page filters from below its list.
 */
export type GeoActionWorkbench = "all" | "content" | "distribution" | "monitoring";

export function ActionsTab({ geoId, project, mode = "all" }: { geoId: string; project: GeoProject; mode?: GeoActionWorkbench }) {
  const frame = useGeoFrame();
  const actions = useGeoActions(geoId);
  const clusters = useGeoClusters(geoId);
  const monitoring = useGeoMonitoring(geoId);
  const articles = useSharedGeoLoad(`articles:${geoId}`, () => getGeoArticles(geoId));
  const distribution = useSharedGeoLoad(`distribution:${geoId}`, () => getGeoDistribution(geoId));
  const drawer = useGeoDrawerAddress();
  const navigate = useNavigate();
  const location = useLocation();
  const openConversation = useOpenGeoConversation();
  const [stageParam, setStageParam] = useGeoSearchParam(STAGE_PARAM);
  const [cluster, setCluster] = useGeoSearchParam(GEO_CLUSTER_FILTER_PARAM);
  const [addressedArticle] = useGeoSearchParam(GEO_ARTICLE_PARAM);
  const change = useGeoSearchChange();
  const [kind, setKind] = useState<GeoActionKind | null>(null);
  const [query, setQuery] = useState("");
  const [focusParam, setFocus] = useGeoSearchParam("focus");
  const focus = focusParam === "acted" || focusParam === "waiting" ? focusParam : null;
  const [articleQuery, setArticleQuery] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [articleStatus, setArticleStatus] = useState("all");
  const [articleSort, setArticleSort] = useState("title");
  const [articlePage, setArticlePage] = useState(0);
  const [reviewPage, setReviewPage] = useState(0);
  const [articleSnapshot, setArticleSnapshot] = useState<string | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<string | null>(null);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (articleQuery.trim() === catalogSearch) return undefined;
    const timer = window.setTimeout(() => { setArticlePage(0); setArticleSnapshot(null); setCatalogSearch(articleQuery.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [articleQuery, catalogSearch]);
  const catalogInput = { search: catalogSearch, status: articleStatus, sort: articleSort, limit: 20, offset: articlePage * 20, ...(articleSnapshot ? { snapshot: articleSnapshot } : {}) };
  const catalog = useGeoLoad(`article-catalog:${geoId}:${mode}:${catalogEpoch}:${JSON.stringify(catalogInput)}`,
    () => mode === "content" ? getGeoArticleCatalog(geoId, catalogInput) : Promise.resolve(null));
  const reviewInput = { search: "", status: "all", sort: "updated", limit: 20, offset: reviewPage * 20, review: true, ...(reviewSnapshot ? { snapshot: reviewSnapshot } : {}) };
  const review = useGeoLoad(`article-review:${geoId}:${mode}:${catalogEpoch}:${JSON.stringify(reviewInput)}`,
    () => mode === "content" ? getGeoArticleCatalog(geoId, reviewInput) : Promise.resolve(null));
  const addressed = useGeoLoad(`article-address:${geoId}:${mode}:${catalogEpoch}:${addressedArticle ?? ""}`,
    () => mode === "content" && addressedArticle ? getGeoArticle(geoId, addressedArticle) : Promise.resolve(null));

  const view = actions.state.kind === "ready" ? actions.state.data : null;
  const articleList = useMemo(() => (articles.state.kind === "ready" && Array.isArray(articles.state.data?.articles) ? articles.state.data.articles : []).filter((article) => article && article.id), [articles.state]);
  const articleRows = useMemo(() => mode === "content" && catalog.state.kind === "ready" ? catalog.state.data?.articles ?? [] : [], [mode, catalog.state]);
  const visibleVersionIds = useMemo(() => [...articleList, ...articleRows].map(article => article.currentResultVersionId), [articleList, articleRows]);
  const versionLabel = (id: string) => geoVersionLabel(id, visibleVersionIds);
  const catalogPending = articleQuery.trim() !== catalogSearch;
  const catalogData = catalog.state.kind === "ready" ? catalog.state.data : null;
  const distributionData = distribution.state.kind === "ready" ? distribution.state.data : null;
  const clusterRows = clusters.state.kind === "ready" ? clusters.state.data.groups : [];
  const abilities = project.access?.abilities;
  const can = (ability: string) => !abilities || abilities.includes(ability);

  const reloadAll = useCallback(() => {
    actions.reload();
    articles.reload();
    setArticlePage(0); setReviewPage(0); setArticleSnapshot(null); setReviewSnapshot(null); setCatalogEpoch(value => value + 1);
    distribution.reload();
    clusters.reload();
    frame?.reload();
  }, [actions, articles, distribution, clusters, frame]);
  const articleActions = useArticleActions(geoId, project, reloadAll);

  const all = useMemo(() => view?.actions ?? [], [view]);
  const counts = useMemo(() => stageCounts(all), [all]);
  const stage: ActionStage | "all" = ACTION_STAGES.find((entry) => entry === stageParam && counts[entry] > 0) ?? "all";
  const filter = useMemo<ActionFilter>(() => ({ stage, kind, cluster, query }), [stage, kind, cluster, query]);
  const focused = useMemo(() => {
    if (!focus) return all;
    const acted = new Set(["placed", "live", "cited", "verified", "stale"]);
    const waiting = new Set(["proposed", "writing", "ready"]);
    return all.filter((action) => (focus === "acted"
      ? Boolean(action.group) && acted.has(action.status)
      : Boolean(action.group) && action.kind !== "maintain" && waiting.has(action.status) && Boolean(action.need.gapClass || action.need.errorIds.length)));
  }, [all, focus]);
  const shown = useMemo(() => filterActions(focused, filter), [focused, filter]);
  const blocks = useMemo(() => actionBlocks(shown), [shown]);
  const rows = shown.length;
  const { visible: visibleBlocks, remaining, more } = useBlocksWindow(blocks, `${stage}|${kind}|${cluster}|${query.trim()}|${focus}`);

  // ---- what the toolbar carries: the stage chips (a stage nobody is in is not drawn), the type, the group, the search
  const stageOptions: FilterOption<string>[] = [
    { value: "all", label: "全部", count: all.length },
    ...ACTION_STAGES.filter((entry) => counts[entry] > 0).map((entry) => ({ value: entry, label: ACTION_STAGE_LABELS[entry], count: counts[entry] })),
  ];
  const kindsPresent = KINDS.filter((entry) => all.some((action) => action.kind === entry));
  const groupsPresent = useMemo(() => {
    const seen = new Map<string, string>();
    for (const action of all) seen.set(action.group?.id ?? PROJECT_LEVEL, action.group ? clusterName(action.group) : "全项目");
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [all]);
  const narrowed = stage !== "all" || kind !== null || cluster !== null || query.trim() !== "" || focus !== null;
  useGeoToolbar(mode === "all" && view && all.length > 0
    ? {
      filters: [
        { kind: "chips", label: "进展", options: stageOptions, value: stage, onChange: (value) => setStageParam(value === "all" ? null : value) },
        ...(kindsPresent.length > 1 ? [{
          kind: "select" as const,
          label: "类型",
          allLabel: "全部类型",
          options: kindsPresent.map((entry) => ({ value: entry, label: kindWord(entry) })),
          value: kind,
          onChange: (value: string | null) => setKind(value as GeoActionKind | null),
        }] : []),
        ...(groupsPresent.length > 1 ? [{
          kind: "select" as const,
          label: "问题群",
          allLabel: "全部问题群",
          options: groupsPresent,
          value: cluster,
          onChange: setCluster,
        }] : []),
        ...(focus ? [{
          kind: "toggle" as const,
          label: focus === "acted" ? "只看已行动的群 ×" : "只看还没行动的群 ×",
          pressed: true,
          onChange: () => setFocus(null),
        }] : []),
      ],
      onClear: narrowed ? () => { change({ [STAGE_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null, focus: null }); setKind(null); setQuery(""); } : undefined,
      search: { label: "搜索行动", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
      summary: narrowed ? `${rows} / ${all.length} 条行动` : `${all.length} 条行动`,
    }
    : null);

  // ---- what a row does
  const groupOf = (article: GeoArticle) => (article.groupId ? clusterRows.find((row) => row.id === article.groupId || article.groupId === row.id) ?? null : null);
  const articleOf = (action: GeoAction): GeoArticle | null => {
    const mine = articleList.filter((article) => action.articleIds.includes(article.id) && article.status !== "withdrawn");
    return mine.find((article) => articleActions.reachable(article)) ?? null;
  };
  const swap = (action: GeoAction, domain: string | null) => {
    setBusyKey(action.key);
    void chooseGeoActionSource(geoId, action.key, domain)
      .then(() => {
        toast.success(domain ? "已换信源，之后的投放按它排。" : "已恢复推荐的信源。");
        actions.reload();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "信源暂时无法更换，请稍后重试。" })))
      .finally(() => setBusyKey(null));
  };
  const skip = (action: GeoAction, skipped: boolean) => {
    setBusyKey(action.key);
    void skipGeoAction(geoId, action.key, skipped)
      .then(() => {
        toast.success(skipped ? "已跳过，这一群不会再按这条行动写稿。" : "已恢复这条行动。");
        reloadAll();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这条行动暂时无法修改，请稍后重试。" })))
      .finally(() => setBusyKey(null));
  };
  const ask = (action: GeoAction) => {
    const name = action.group ? `问题群“${clusterName(action.group)}”` : "全项目";
    // A request about one action opens a fresh conversation (r19-geos hand-off §9.5c): the project's latest may be a strategy run's own session.
    void openConversation({ projectId: project.projectId, sessionId: null }, `请重写${name}这条行动的稿件，并告诉我改了什么。`);
  };
  const headlineTarget = (target: "acted" | "waiting" | "effect") => {
    if (target === "effect") {
      // The page's own ground moves, not the app shell (`scrollBlockToTop`).
      const element = document.getElementById(geoSectionId("effect"));
      if (element) scrollBlockToTop(element);
      return;
    }
    if (mode === "monitoring") {
      const query = new URLSearchParams(location.search);
      query.set("step", target === "acted" ? "distribution" : "content");
      query.set("focus", target);
      navigate(geoDestinationPath(geoId, { tab: "actions" }, query), { state: sanitizeRuntimeUiHistoryState(location.state) });
      return;
    }
    setFocus(target);
  };

  // ---- what the page says first
  if (actions.state.kind === "loading" && (mode === "all" || mode === "monitoring")) return <TabSkeleton />;
  if (actions.state.kind === "error" && (mode === "all" || mode === "monitoring")) return <TabError message={actions.state.message} onRetry={actions.reload} />;

  const listed = new Set(all.flatMap((action) => action.articleIds));
  const others = articleList.filter((article) => !listed.has(article.id) && article.status !== "withdrawn" && article.safety !== "open");
  const reviewData = review.state.kind === "ready" ? review.state.data : null;
  const addressedData = addressed.state.kind === "ready" ? addressed.state.data : null;
  const selectedReview = addressedData && addressedData.safety === "open" && addressedData.status !== "withdrawn" ? addressedData : null;
  const reviewRows = reviewData?.articles ?? [];
  const held = mode === "content" ? selectedReview && !reviewRows.some(article => article.id === selectedReview.id) ? [selectedReview, ...reviewRows] : reviewRows
    : articleList.filter((article) => article.safety === "open" && article.status !== "withdrawn");
  // 「还没有稿件」 is said only once the articles were read: a read still on its way, or one that failed, is not an empty list.
  const articlesFailed = readFailure(articles);
  const nothing = all.length === 0 && articleList.length === 0 && (view?.control.length ?? 0) === 0;
  if (nothing && articles.state.kind === "loading" && mode !== "distribution") return <TabSkeleton />;
  if (nothing && !articlesFailed && mode === "all") {
    return <><StepPending geoId={geoId} project={project} step="content" /><GeoAnalysisEntry geoId={geoId} project={project} initialView="V23" embedded titleLevel="section" /></>;
  }
  // The other reads of the page, each said where it failed with its own 重试; the articles' stands where 「需要你」 sends a person
  // to release them (`#geo-review`), so that link lands on what went wrong rather than on nothing.
  const distributionFailed = readFailure(distribution);
  const clustersFailed = readFailure(clusters);

  const openAction = drawer.action ? all.find((action) => action.key === drawer.action) ?? null : null;
  const input = netEffectInput(monitoring.state.kind === "ready" ? monitoring.state.data : null, distributionData);
  const parts = view ? headlineParts(view.headline) : null;

  return (
    <div data-geo-tab="actions" aria-busy={location.hash === `#${geoSectionId("delivery")}` && actions.state.kind === "loading" || undefined} className="flex flex-col gap-6">
      {(mode === "all" || mode === "monitoring") && parts && (
        <EffectCard parts={parts} input={input} loading={monitoring.state.kind === "loading"} onOpen={headlineTarget} error={readFailure(monitoring)} />
      )}
      {actions.state.kind === "error" && mode !== "all" && mode !== "monitoring" && <LoadError message={`行动计划没有读到：${actions.state.message}`} onRetry={actions.reload} />}
      {articlesFailed && (mode === "all" || mode === "content") && (
        <section id={geoSectionId("review")} aria-label="稿件">
          <LoadError message={`稿件没有读到：${articlesFailed.message}`} onRetry={articlesFailed.retry} />
        </section>
      )}
      {distributionFailed && (mode === "all" || mode === "distribution") && (
        <LoadError message={`投放记录没有读到：${distributionFailed.message}`} onRetry={distributionFailed.retry} />
      )}
      {clustersFailed && mode !== "monitoring" && <LoadError message={`问题群没有读到：${clustersFailed.message}`} onRetry={clustersFailed.retry} />}
      {mode === "content" && <section aria-label="稿件列表" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input label="搜索稿件" maxLength={200} value={articleQuery} onChange={(event) => setArticleQuery(event.target.value)} />
          <Select label="状态" value={articleStatus} onChange={(event) => { setArticlePage(0); setArticleSnapshot(null); setArticleStatus(event.target.value); }}><option value="all">全部状态</option>{Object.entries(ARTICLE_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
          <Select label="排序" value={articleSort} onChange={(event) => { setArticlePage(0); setArticleSnapshot(null); setArticleSort(event.target.value); }}><option value="title">标题</option><option value="status">状态</option><option value="updated">最近更新</option></Select>
          {!catalogPending && catalogData && <span className="text-caption text-text-3">{catalogData.total} 篇稿件</span>}
        </div>
        {(catalogPending || catalog.state.kind === "loading") && <TabSkeleton />}
        {!catalogPending && catalog.state.kind === "error" && <LoadError message={`稿件列表没有读到：${catalog.state.message}`} onRetry={() => { setArticlePage(0); setArticleSnapshot(null); setCatalogEpoch(value => value + 1); }} />}
        {!catalogPending && catalog.state.kind === "ready" && catalogData && <>
          {catalog.state.refreshError && <Note tone="warn" action={<Button size="sm" onClick={catalog.reload}>重试</Button>}>{catalog.state.refreshError}</Note>}
          <DataTable<GeoArticle> label="稿件列表" rowKey={article => article.id} minWidth="min-w-[52rem]"
            rows={articleRows}
            emptyText={articleQuery.trim() || articleStatus !== "all" ? "没有符合筛选条件的稿件，请调整搜索或状态。" : articlePage > 0 ? "这一页没有稿件，请返回上一页。" : "还没有稿件。行动计划中的待写事项不计入稿件。"}
            columns={[
              { key: "title", header: "稿件", rowHeader: true, cell: article => <>{articleActions.reachable(article) ? <Button size="sm" variant="text" onClick={() => articleActions.open(article)}>{article.title || "未命名稿件"}</Button> : article.title || "未命名稿件"}{article.safety === "open" && <span className="ml-2 text-text-3">待安全审核</span>}</> },
              { key: "status", header: "状态", cell: article => ARTICLE_STATUS[article.status] },
              { key: "question", header: "关联问题", cell: article => article.question || (groupOf(article) ? clusterName(groupOf(article)!) : "未记录") },
              { key: "version", header: "版本", cell: article => article.layer === "card" ? (article.cardRevision != null ? `卡片修订 ${article.cardRevision}` : "未记录") : article.currentResultVersionId ? versionLabel(article.currentResultVersionId) : "未记录" },
              { key: "updated", header: "记录更新", cell: article => articleUpdate(article.updatedAt), isEmpty: article => !article.updatedAt || !Number.isFinite(Date.parse(article.updatedAt)) },
              { key: "actions", header: "操作", cell: article => <div className="flex flex-wrap gap-1">{geoMayConverse(project) && article.currentResultVersionId && article.contentSha256 && <><Button size="sm" variant="text" onClick={() => articleActions.continueInConversation(article)}>在对话中修改</Button><Button size="sm" variant="text" onClick={() => articleActions.humanizeInConversation(article)}>润色语言</Button></>}{can("edit") && article.status !== "withdrawn" && <Button size="sm" variant="text" onClick={() => articleActions.withdraw(article)}>撤回</Button>}</div> },
            ]} />
          {(catalogData.total > catalogInput.limit || articlePage > 0) && <div className="flex items-center gap-2" aria-label="稿件分页">
            <Button size="sm" variant="secondary" disabled={articlePage === 0} onClick={() => setArticlePage(value => Math.max(0, value - 1))}>上一页</Button>
            <span className="text-caption text-text-2">第 {articlePage + 1} 页</span>
            <Button size="sm" variant="secondary" disabled={catalogInput.offset + articleRows.length >= catalogData.total} onClick={() => { setArticleSnapshot(catalogData.snapshot); setArticlePage(value => value + 1); }}>下一页</Button>
          </div>}
        </>}
      </section>}
      {mode === "content" && review.state.kind === "loading" && <TabSkeleton rows={2} />}
      {mode === "content" && review.state.kind === "error" && <LoadError message={`待复核稿件没有读到：${review.state.message}`} onRetry={() => { setReviewPage(0); setReviewSnapshot(null); setCatalogEpoch(value => value + 1); }} />}
      {mode === "content" && addressedArticle && addressed.state.kind === "error" && <LoadError message={`指定稿件没有读到：${addressed.state.message}`} onRetry={addressed.reload} />}
      {mode === "content" && addressedData && !selectedReview && <Note action={null}>指定稿件当前不在待复核列表中。</Note>}
      {(mode === "all" || mode === "content") && <ReviewBlock
        articles={held}
        total={mode === "content" ? reviewData?.total ?? null : undefined}
        groupOf={groupOf}
        canReview={can("review")}
        busy={articleActions.busy}
        reachable={articleActions.reachable}
        onOpen={articleActions.open}
        onRelease={articleActions.release}
        addressed={addressedArticle}
      />}
      {mode === "content" && reviewData && (reviewData.total > reviewInput.limit || reviewPage > 0) && <div className="flex items-center gap-2" aria-label="待复核稿件分页">
        <Button size="sm" variant="secondary" disabled={reviewPage === 0} onClick={() => setReviewPage(value => Math.max(0, value - 1))}>上一页待复核</Button>
        <span className="text-caption text-text-2">第 {reviewPage + 1} 页</span>
        <Button size="sm" variant="secondary" disabled={reviewInput.offset + reviewRows.length >= reviewData.total} onClick={() => { setReviewSnapshot(reviewData.snapshot); setReviewPage(value => value + 1); }}>下一页待复核</Button>
      </div>}
      {(mode === "all" || mode === "distribution") && <BudgetLine distribution={marketConnected(project) || distributionData?.budget ? distributionData : null} canManage={can("manage_money")} onEdit={() => frame?.openPanel("budget")} />}
      {mode === "distribution" && <DistributionWorkbench key={geoId} geoId={geoId} project={project} />}
      {mode==="all"&&<GeoAnalysisEntry key={`${geoId}:${mode}`} geoId={geoId} project={project} initialView="V23" embedded titleLevel="section"/>}
      {(mode === "all" || mode === "content") && project.cards?.blockedBy && can("edit") && (
        <Note action={<Button variant="secondary" size="sm" onClick={() => frame?.openPanel(CARDS_WAIT[project.cards?.blockedBy as "producer" | "reviewer"].panel)}>{CARDS_WAIT[project.cards.blockedBy].verb}</Button>}>
          {CARDS_WAIT[project.cards.blockedBy].sentence}
        </Note>
      )}

      {mode !== "monitoring" && all.length > 0 && (
        <details open={mode === "all" || Boolean(drawer.action) || Boolean(focus) || location.hash === `#${geoSectionId("delivery")}`}><summary className="cursor-pointer text-ui">行动计划 · {all.length} 条行动</summary>
        <section id={geoSectionId("delivery")} aria-label="行动" data-geo-actions="">
          {rows === 0 ? (
            <Note action={<Button variant="secondary" size="sm" onClick={() => { change({ [STAGE_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null, focus: null }); setKind(null); setQuery(""); }}>清除筛选</Button>}>
              没有符合的行动。
            </Note>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                {visibleBlocks.map((block) => (
                  <div key={block.groupId ?? PROJECT_LEVEL} data-geo-cluster-block={block.groupId ?? PROJECT_LEVEL} className="flex flex-col">
                    {block.actions.length > 1 && (
                      <div className="flex items-baseline gap-x-3 px-2 pt-3 text-ui">
                        {block.groupId
                          ? <ClusterLink groupId={block.groupId} className="min-w-0 truncate">{block.name}</ClusterLink>
                          : <span className="text-text">{block.name}</span>}
                        <span className="text-caption tabular-nums text-text-3">{`${block.actions.length} 条行动`}</span>
                      </div>
                    )}
                    <List label={`${block.name}的行动`} divided>
                      {block.actions.map((action) => {
                        const article = articleOf(action);
                        const reach = article ? articleActions.reachable(article) : null;
                        return (
                          <ActionRow
                            key={action.key}
                            action={action}
                            showCluster={block.actions.length === 1}
                            article={reach}
                            busy={busyKey === action.key}
                            canRun={can("run")}
                            canEdit={can("edit")}
                            onOpen={() => drawer.open({ action: action.key })}
                            onOpenArticle={() => article && articleActions.open(article)}
                            onSkip={(skipped) => skip(action, skipped)}
                            onSwap={(domain) => swap(action, domain)}
                            onAsk={() => ask(action)}
                          />
                        );
                      })}
                    </List>
                  </div>
                ))}
              </div>
              <ShowMore remaining={remaining} unit="个问题群" onMore={more} />
            </>
          )}
        </section>
        </details>
      )}

      {(mode === "all" || mode === "monitoring") && view && <ControlGroups view={view} clusters={clusterRows} />}


      {mode === "all" && <OtherArticles articles={others} groupOf={groupOf} reachable={articleActions.reachable} onOpen={articleActions.open} onWithdraw={articleActions.withdraw} onContinue={geoMayConverse(project) ? articleActions.continueInConversation : undefined} onHumanize={geoMayConverse(project) ? articleActions.humanizeInConversation : undefined} canEdit={can("edit")} />}

      {openAction && (
        <ActionDrawer
          geoId={geoId}
          project={project}
          action={openAction}
          articles={articleList}
          distribution={distributionData}
          onChanged={reloadAll}
          onClose={drawer.close}
          onSwap={swap}
          onSkip={skip}
        />
      )}
      {drawer.action && !openAction && (
        <Drawer title="这条行动已经不在了" onClose={drawer.close}>
          <Note action={<Button variant="secondary" size="sm" onClick={drawer.close}>回到行动</Button>}>
            新的策略替换了它；它做过的稿件和订单仍在对应的问题群里。
          </Note>
        </Drawer>
      )}
      <ClusterDrawerHost geoId={geoId} project={project} />
      {articleActions.dialogs}
    </div>
  );
}

/**
 * The blocks a page draws: the first twelve groups, then 「显示更多」. A window over groups and not over rows, so a group's actions
 * are never cut apart.
 */
function useBlocksWindow<T>(blocks: readonly T[], resetKey: string) {
  const { visible, remaining, more } = useShowMore(blocks, { first: ROWS_SHOWN, step: ROWS_STEP, resetKey });
  return { visible, remaining, more };
}
