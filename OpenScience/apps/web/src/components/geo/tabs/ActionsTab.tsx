import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import {
  chooseGeoActionSource,
  getGeoArticles,
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
import { Note } from "@/components/ui/Note";
import { Button } from "@/components/ui/Button";
import { useGeoFrame, useGeoToolbar } from "../geoFrame";
import { useGeoMonitoring } from "../geoProjectData";
import { marketConnected } from "../geoOverviewModel";
import { scrollBlockToTop } from "../geoScroll";
import { geoSectionId } from "../geoTabs";
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
import { GEO_CLUSTER_FILTER_PARAM, useGeoDrawerAddress, useGeoSearchChange, useGeoSearchParam } from "../spine/drawerParams";
import { useGeoActions, useGeoClusters } from "../spine/spineData";
import { useArticleActions } from "../spine/useArticleActions";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";

/** Rows listed before 「显示更多」, and how many each press adds. */
const ROWS_SHOWN = 12;
const ROWS_STEP = 20;

/** The page's own filter on the stage, in the address so a link (and Back) means it. */
const STAGE_PARAM = "show";
const PROJECT_LEVEL = "-";

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
export function ActionsTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const frame = useGeoFrame();
  const actions = useGeoActions(geoId);
  const clusters = useGeoClusters(geoId);
  const monitoring = useGeoMonitoring(geoId);
  const articles = useGeoLoad(`articles:${geoId}`, () => getGeoArticles(geoId));
  const distribution = useGeoLoad(`distribution:${geoId}`, () => getGeoDistribution(geoId));
  const drawer = useGeoDrawerAddress();
  const navigate = useNavigate();
  const openConversation = useOpenGeoConversation();
  const [stageParam, setStageParam] = useGeoSearchParam(STAGE_PARAM);
  const [cluster, setCluster] = useGeoSearchParam(GEO_CLUSTER_FILTER_PARAM);
  const change = useGeoSearchChange();
  const [kind, setKind] = useState<GeoActionKind | null>(null);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<"acted" | "waiting" | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const view = actions.state.kind === "ready" ? actions.state.data : null;
  const articleList = useMemo(() => (articles.state.kind === "ready" && Array.isArray(articles.state.data?.articles) ? articles.state.data.articles : []).filter((article) => article && article.id), [articles.state]);
  const distributionData = distribution.state.kind === "ready" ? distribution.state.data : null;
  const clusterRows = clusters.state.kind === "ready" ? clusters.state.data.groups : [];
  const abilities = project.access?.abilities;
  const can = (ability: string) => !abilities || abilities.includes(ability);

  const reloadAll = useCallback(() => {
    actions.reload();
    articles.reload();
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
  useGeoToolbar(view && all.length > 0
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
      onClear: narrowed ? () => { change({ [STAGE_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null }); setKind(null); setQuery(""); setFocus(null); } : undefined,
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
    setFocus(target);
  };

  // ---- what the page says first
  if (actions.state.kind === "loading") return <TabSkeleton />;
  if (actions.state.kind === "error") return <TabError message={actions.state.message} onRetry={actions.reload} />;
  if (!view) return null;

  const held = articleList.filter((article) => article.safety === "open" && article.status !== "withdrawn");
  const listed = new Set(all.flatMap((action) => action.articleIds));
  const others = articleList.filter((article) => !listed.has(article.id) && article.status !== "withdrawn" && article.safety !== "open");
  const nothing = all.length === 0 && articleList.length === 0 && view.control.length === 0;
  if (nothing) return <StepPending geoId={geoId} project={project} step="content" />;

  const openAction = drawer.action ? all.find((action) => action.key === drawer.action) ?? null : null;
  const input = netEffectInput(monitoring.state.kind === "ready" ? monitoring.state.data : null, distributionData);
  const parts = headlineParts(view.headline);

  return (
    <div data-geo-tab="actions" className="flex flex-col gap-6">
      <EffectCard parts={parts} input={input} loading={monitoring.state.kind === "loading"} onOpen={headlineTarget} />
      <ReviewBlock
        articles={held}
        groupOf={groupOf}
        canReview={can("review")}
        busy={articleActions.busy}
        reachable={articleActions.reachable}
        onOpen={articleActions.open}
        onRelease={articleActions.release}
      />
      <BudgetLine distribution={marketConnected(project) || distributionData?.budget ? distributionData : null} canManage={can("manage_money")} onEdit={() => frame?.openPanel("budget")} />
      {project.cards?.blockedBy && can("edit") && (
        <Note action={<Button variant="secondary" size="sm" onClick={() => frame?.openPanel(CARDS_WAIT[project.cards?.blockedBy as "producer" | "reviewer"].panel)}>{CARDS_WAIT[project.cards.blockedBy].verb}</Button>}>
          {CARDS_WAIT[project.cards.blockedBy].sentence}
        </Note>
      )}

      {all.length > 0 && (
        // The rail's 「投放」 lands here (`GEO_TAB_SECTIONS`): where each piece of work goes, and how far it got, is a row of this list.
        <section id={geoSectionId("delivery")} aria-label="行动" data-geo-actions="">
          {rows === 0 ? (
            <Note action={<Button variant="secondary" size="sm" onClick={() => { change({ [STAGE_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null }); setKind(null); setQuery(""); setFocus(null); }}>清除筛选</Button>}>
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
                    <ul aria-label={`${block.name}的行动`} className="flex flex-col divide-y divide-border [&>li]:rounded-none">
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
                    </ul>
                  </div>
                ))}
              </div>
              <ShowMore remaining={remaining} unit="个问题群" onMore={more} />
            </>
          )}
        </section>
      )}

      <ControlGroups view={view} clusters={clusterRows} />
      <OtherArticles
        articles={others}
        groupOf={groupOf}
        reachable={articleActions.reachable}
        onOpen={articleActions.open}
        onWithdraw={articleActions.withdraw}
        canEdit={can("edit")}
      />

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
          <Note action={<Button variant="secondary" size="sm" onClick={() => { drawer.close(); navigate(`/app/geo/${encodeURIComponent(geoId)}/actions`, { replace: true }); }}>回到行动</Button>}>
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
