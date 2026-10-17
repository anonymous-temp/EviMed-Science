import { useMemo, useState } from "react";
import { Link } from "react-router";
import { pythonRound } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import {
  cancelGeoOrder,
  type GeoAction,
  type GeoActionSource,
  type GeoArticle,
  type GeoClusterView,
  type GeoDistribution,
  type GeoEngine,
  type GeoProject,
} from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { EffectStrip } from "@/components/charts/EffectStrip";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { SeverityBadge, isSeverityLevel } from "@/components/ui/SeverityBadge";
import { Tag } from "@/components/ui/Tag";
import { useGeoDiagnosis } from "../geoProjectData";
import { geoDestinationPath } from "../geoTabs";
import {
  engineName,
  GEO_ORDER_CANCELLABLE,
  monthDay,
  orderStateWord,
  ownedPlatformName,
} from "../geoText";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { metricName, yuan } from "../tabs/geoTabText";
import { StatusMark } from "./ActionRow";
import {
  articleMeta,
  articleStatusLine,
  conditionsWord,
  expectedText,
  gapWord,
  priceWord,
  routeWord,
  sourceKinds,
  sourceName,
  unavailableWords,
  whatLines,
} from "./actionModel";
import { clusterContext, clusterName, effectMarkers, effectPoints } from "./clusterModel";
import { ClusterLink } from "./ClusterLink";
import { GEO_ERROR_PARAM } from "./drawerParams";
import { claimKeyOf } from "./errorModel";
import { OwnedLinkForm } from "./OwnedLinkForm";
import { QuestionRows } from "./QuestionRows";
import { useGeoCluster, useGeoClusters } from "./spineData";
import { useArticleActions } from "./useArticleActions";

/**
 * One action as a record (R19, audit C §2.5; owner 2026-10-14: 「行动里边并没有推荐匹配的信源和预期带来的效果」). It answers, in
 * the order a person asks, the four things the row only abbreviates:
 *
 *  1. 问了什么 — the questions of the group the action is for, and for each engine what its answer did;
 *  2. 要补什么 — the gap, the run's judgment of it, what an answer must say and the conclusions that say it stands on;
 *  3. 稿件 — what was written for it: read it, release it past the safety stop, or take it out;
 *  4. 发到哪 — the ranked sources with why, what they cost and whether the three conditions hold; send the action to another with
 *     「换到这里」 (reversible: 「恢复推荐」), or, for the brand's own channel, copy the article and paste the link;
 *  5. 预期与已发生 — what the platform expects, as the group stands now; and what happened: the pages that went out, the engines
 *     that cited them, and the arms' verdict.
 *
 * The number is the platform's and so is every status; the person's two words — skip, another source — are the only things
 * written, and both can be taken back. There is no approval step: the platform goes on by itself.
 */
export function ActionDrawer({
  geoId,
  project,
  action,
  articles,
  distribution,
  onChanged,
  onClose,
  onSwap,
  onSkip,
}: {
  geoId: string;
  project: GeoProject;
  action: GeoAction;
  articles: readonly GeoArticle[];
  distribution: GeoDistribution | null;
  /** Something the drawer did changes what the page reads: articles, orders, the actions themselves. */
  onChanged: () => void;
  onClose: () => void;
  onSwap: (action: GeoAction, domain: string | null) => void;
  onSkip: (action: GeoAction, skipped: boolean) => void;
}) {
  const groupId = action.group?.id ?? null;
  return groupId
    ? <WithCluster {...{ geoId, project, action, articles, distribution, onChanged, onClose, onSwap, onSkip }} groupId={groupId} />
    : <ActionBody {...{ geoId, project, action, articles, distribution, onChanged, onClose, onSwap, onSkip }} view={null} />;
}

function WithCluster(props: Parameters<typeof ActionDrawer>[0] & { groupId: string }) {
  const detail = useGeoCluster(props.geoId, props.groupId);
  return <ActionBody {...props} view={detail.state.kind === "ready" ? detail.state.data : null} />;
}

function ActionBody({
  geoId,
  project,
  action,
  articles,
  distribution,
  view,
  onChanged,
  onClose,
  onSwap,
  onSkip,
}: Parameters<typeof ActionDrawer>[0] & { view: GeoClusterView | null }) {
  const open = useOpenGeoConversation();
  const clusters = useGeoClusters(geoId);
  const [asking, setAsking] = useState(false);
  const [cancelling, setCancelling] = useState<{ id: string; title: string } | null>(null);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const articleActions = useArticleActions(geoId, project, onChanged);
  const abilities = project.access?.abilities;
  const can = (ability: string) => !abilities || abilities.includes(ability);
  const what = whatLines(action);
  const group = action.group;
  const engines = (clusters.state.kind === "ready" && clusters.state.data.engines.length > 0 ? clusters.state.data.engines : project.engines) as GeoEngine[];
  const mine = useMemo(() => articles.filter((article) => action.articleIds.includes(article.id)), [articles, action.articleIds]);
  const orders = useMemo(() => (distribution?.orders ?? []).filter((order) => action.orderIds.includes(order.id)), [distribution, action.orderIds]);
  const links = useMemo(() => (distribution?.ownedLinks ?? []).filter((link) => action.ownedLinkIds.includes(link.id)), [distribution, action.ownedLinkIds]);
  const expected = expectedText(action);
  const skipped = action.status === "skipped";
  const questionIds = new Set(action.questions.map((question) => question.id));
  const questions = (view?.questions ?? []).filter((question) => questionIds.has(question.id));
  const claims = view?.claims ?? {};

  const ask = () => {
    setAsking(true);
    const product = project.product?.brandName || project.product?.genericName || project.name;
    const target = group ? `问题群“${clusterName(group)}”` : "全项目";
    const draft = `调整${target}的这条行动（${what.title}）：${expected.now}${expected.goal ? `，${expected.goal}` : ""}。${what.detail ? `要补的是：${what.detail}。` : ""}${product}的稿件和信源怎么调？`;
    // A question about an action opens a fresh conversation (r19-geos hand-off §9.5c).
    void open({ projectId: project.projectId, sessionId: null }, draft).finally(() => setAsking(false));
  };

  const cancelOrder = () => {
    const order = cancelling;
    if (!order) return;
    setCancelling(null);
    setBusyOrder(order.id);
    void cancelGeoOrder(geoId, order.id)
      .then(() => {
        toast.success("已撤单，预留的钱会退回预算。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一单无法撤下，请稍后重试。" })))
      .finally(() => setBusyOrder(null));
  };

  const series = effectPoints(action.observed.series);
  const markers = effectMarkers(action.observed.series.map((point) => point.date), view?.effect.events ?? []);
  const arm = action.observed.arm;
  const armSize = arm && arm.netEffect != null ? pythonRound(Math.abs(arm.netEffect), 1) : null;
  const armBand = arm?.noiseBand != null ? `（波动 ±${pythonRound(arm.noiseBand, 1)}）` : "";

  return (
    <Drawer
      title={what.title}
      widthClassName="max-w-2xl"
      description={(
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <ClusterLink groupId={group?.id} className="text-link">{group ? clusterName(group) : "全项目"}</ClusterLink>
          {group && <span>{clusterContext(group)}</span>}
          <StatusMark status={action.status} />
        </span>
      )}
      actions={can("edit") ? (
        <Menu label="这条行动的更多操作" items={[{ label: skipped ? "恢复这条行动" : "跳过这条行动", onSelect: () => onSkip(action, !skipped) }]} />
      ) : undefined}
      onClose={onClose}
      footer={<Button data-geo-action-handoff="" loading={asking} onClick={ask}>在对话中调整</Button>}
    >
      <div data-geo-action-drawer={action.key} className="flex flex-col gap-6">
        {questions.length > 0 && (
          <Section title="问了什么" count={`${questions.length} 问`} level="sub">
            <QuestionRows geoId={geoId} questions={questions} engines={engines} label="这条行动对应的问句" />
          </Section>
        )}
        {action.questions.length > 0 && questions.length === 0 && (
          <Section title="问了什么" level="sub">
            <ul aria-label="这条行动对应的问句" className="flex flex-col gap-1">
              {action.questions.map((question) => <li key={question.id} className="text-ui text-text">{question.text}</li>)}
            </ul>
          </Section>
        )}

        <Gap action={action} claims={claims} geoId={geoId} />

        <Section title="稿件" count={mine.length > 0 ? `${mine.length} 篇` : undefined} level="sub">
          {mine.length === 0 ? (
            <Note action={can("run") ? <Button variant="secondary" size="sm" loading={asking} onClick={ask}>让 AI 写这一篇</Button> : undefined}>
              {action.what.title ? `还没有稿件：${action.what.title}` : "还没有稿件。"}
            </Note>
          ) : (
            <List label="这条行动的稿件" divided>
              {mine.map((article) => {
                const reach = articleActions.reachable(article);
                const held = article.safety === "open";
                const withdrawn = article.status === "withdrawn";
                return (
                  <ListRow
                    key={article.id}
                    title={article.title || article.question || "未命名稿件"}
                    titleProps={{ "data-geo-article": article.id }}
                    onOpen={reach ? () => articleActions.open(article) : undefined}
                    muted={withdrawn}
                    meta={[articleMeta(article), articleStatusLine(article)].filter(Boolean).join(" · ")}
                    trailing={held ? <Tag tone="safety">安全待复核</Tag> : undefined}
                    actions={held && can("review")
                      ? <Button variant="text" size="sm" loading={articleActions.busy === article.id} onClick={() => articleActions.release(article)}>放行</Button>
                      : undefined}
                    menu={!withdrawn && can("edit")
                      ? <Menu label={`“${article.title || "这篇稿件"}”的操作`} items={[{ label: "撤回", onSelect: () => articleActions.withdraw(article) }]} />
                      : undefined}
                  />
                );
              })}
            </List>
          )}
        </Section>

        <Section title="发到哪" count={action.sources.length > 0 ? `${action.sources.length} 个` : undefined} level="sub">
          {action.sources.length === 0 ? (
            <Note action={can("run") ? <Button variant="secondary" size="sm" onClick={ask}>让 AI 找信源</Button> : undefined}>这条行动还没有推荐的信源。</Note>
          ) : (
            <List label="推荐的信源" divided>
              {action.sources.map((source, index) => (
                <SourceRow
                  key={`${source.domain ?? source.channel ?? index}`}
                  geoId={geoId}
                  action={action}
                  source={source}
                  articles={mine}
                  canEdit={can("edit")}
                  onSwap={(domain) => onSwap(action, domain)}
                  onChanged={onChanged}
                />
              ))}
            </List>
          )}
        </Section>

        <Section title="预期与已发生" level="sub">
          <p data-geo-expected="" className="text-ui text-text">
            <span className="tabular-nums">{expected.now}</span>
            {expected.sample && <span className="text-text-3">{`（${expected.sample}）`}</span>}
          </p>
          {expected.goal && <p className="mt-1 text-ui text-text-2">{expected.goal}</p>}
          {action.expected.basis.note && <p className="mt-1 max-w-measure-body text-ui text-text-2">{action.expected.basis.note}</p>}
          {series.length > 0 && (
            <div className="mt-3">
              <EffectStrip label={`${metricName(action.expected.primaryMetricId) ?? "被提到"}：每轮被提到的回答数`} points={series} markers={markers} />
            </div>
          )}
          {action.observed.citedBy.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-caption text-text-3">引擎引用了这条行动的稿件</p>
              <ul aria-label="直接的引用" className="flex flex-col gap-1">
                {action.observed.citedBy.map((cited, index) => (
                  <li key={`${cited.engine}-${index}`} data-geo-cited="" className="text-ui text-text">
                    {engineName(cited.engine)}
                    {monthDay(cited.askedAt) && <span className="ml-2 text-text-2">{`${monthDay(cited.askedAt)}起`}</span>}
                    {cited.articleId && mine.find((article) => article.id === cited.articleId) && (
                      <span className="ml-2 text-text-3">{mine.find((article) => article.id === cited.articleId)?.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {orders.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-caption text-text-3">订单</p>
              <List label="这条行动的订单" divided>
                {orders.map((order) => {
                  const href = safeWebHref(order.publishedUrl);
                  const cancellable = GEO_ORDER_CANCELLABLE.has(order.state);
                  return (
                    <li key={order.id} data-geo-order={order.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-ui text-text">
                      <span className="min-w-0 flex-1">{order.media || order.domain || "—"}</span>
                      <span className="text-text-2">{orderStateWord(order.state)}</span>
                      <span className="tabular-nums text-text-2">{yuan(order.priceCny)}</span>
                      {href && <a href={href} target="_blank" rel="noreferrer" className="text-caption text-link hover:underline">查看<span className="sr-only">（在新标签页打开）</span></a>}
                      {cancellable && (
                        <Button variant="text" size="sm" loading={busyOrder === order.id} onClick={() => setCancelling({ id: order.id, title: order.articleTitle || "这一单" })}>撤单</Button>
                      )}
                    </li>
                  );
                })}
              </List>
            </div>
          )}
          {links.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-caption text-text-3">自己发布的页面</p>
              <List label="这条行动自己发布的页面" divided>
                {links.map((link) => {
                  const href = safeWebHref(link.url);
                  const cited = link.citedBy.map((entry) => engineName(entry.engine));
                  return (
                    <li key={link.id} data-geo-owned-link={link.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-ui text-text">
                      <span className="text-text-2">{ownedPlatformName(link.platform)}</span>
                      <span className="min-w-0 flex-1">{href ? <a href={href} target="_blank" rel="noreferrer" className="hover:underline">{link.title || link.url}</a> : link.title || "—"}</span>
                      {link.status === "retired" ? <span className="text-caption text-text-3">已下线</span>
                        : cited.length > 0 ? <span className="text-caption text-accent">{`被 ${cited.join("、")} 引用`}</span>
                          : <span className="text-caption text-text-3">还没有被引用</span>}
                    </li>
                  );
                })}
              </List>
            </div>
          )}
          {arm && arm.comparable && armSize !== null && arm.verdict && (
            <Note className="mt-3" result={[
              `${arm.scope === "pool" ? "这一类问题里" : "整个项目里"}，做了行动的群比对照群${arm.verdict === "up" ? "多涨 " : arm.verdict === "down" ? "少 " : "只差 "}`,
              { n: armSize },
              ` 个点${armBand}${arm.verdict === "flat" ? "，没有超出波动" : ""}。`,
            ]} />
          )}
        </Section>
      </div>
      {articleActions.dialogs}
      {cancelling && (
        <ConfirmDialog
          title={`撤下“${cancelling.title}”？`}
          body="这一单还没有被媒体接单，撤单后不会发布，预留的钱退回预算。"
          confirmLabel="撤单"
          onConfirm={cancelOrder}
          onCancel={() => setCancelling(null)}
        />
      )}
    </Drawer>
  );
}

/* --------------------------------------------------------------------- gap */

function Gap({ action, claims, geoId }: { action: GeoAction; claims: GeoClusterView["claims"]; geoId: string }) {
  // A wrong statement the action closes is the way to the claim's record, where the diagnosis holds the row that names its claim.
  const diagnosis = useGeoDiagnosis(geoId);
  const claimOfError = useMemo(() => new Map((diagnosis.state.kind === "ready" && Array.isArray(diagnosis.state.data?.errors) ? diagnosis.state.data.errors : []).map((row) => [row.id, claimKeyOf(row)])), [diagnosis.state]);
  const word = gapWord(action.need.gapClass);
  const points = action.need.expectedPoints;
  const evidence = action.need.evidence;
  const consequence = action.need.consequence?.basis ?? null;
  if (!word && !action.need.judgment && points.length === 0 && evidence.length === 0) return null;
  return (
    <Section title="要补什么" level="sub">
      {action.need.judgment && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-ui text-text">
          {word && <Tag>{word}</Tag>}
          <span className="min-w-0 max-w-measure-body">{action.need.judgment}</span>
        </p>
      )}
      {consequence && <p className="mt-2 max-w-measure-body text-ui text-text-2">{consequence}</p>}
      {evidence.length > 0 && (
        <ul aria-label="这条行动的依据" className="mt-3 flex flex-col gap-1">
          {evidence.map((entry, index) => entry.kind === "error" ? (
            <li key={`${entry.errorId}-${index}`} className="flex flex-wrap items-center gap-x-2 text-ui text-text">
              {isSeverityLevel(entry.severity) && <SeverityBadge level={entry.severity} />}
              <span className="text-text-2">{engineName(entry.engine)}</span>
              {claimOfError.has(entry.errorId) ? (
                <Link
                  to={geoDestinationPath(geoId, { tab: "accuracy" }, { [GEO_ERROR_PARAM]: claimOfError.get(entry.errorId) })}
                  data-geo-action-error={entry.errorId}
                  className="min-w-0 flex-1 rounded text-link hover:underline hover:underline-offset-4"
                >
                  {`“${entry.statement ?? ""}”`}
                </Link>
              ) : <span className="min-w-0 flex-1">{`“${entry.statement ?? ""}”`}</span>}
            </li>
          ) : null)}
        </ul>
      )}
      {points.length > 0 && (
        <ul aria-label="回答该说的" className="mt-3 flex flex-col gap-1 border-l-2 border-border pl-3">
          {points.map((point) => {
            const claim = point.claimIds.map((id) => claims[id]).find(Boolean) ?? null;
            return (
              <li key={point.id} className="text-ui text-text-2">
                {point.statement}
                {claim && (
                  <Link to={geoDestinationPath(geoId, { tab: "evidence" })} className="ml-2 text-caption text-link hover:underline">
                    {`依据：${claim.sourceLabel || "结论库"}`}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ source */

function SourceRow({
  geoId,
  action,
  source,
  articles,
  canEdit,
  onSwap,
  onChanged,
}: {
  geoId: string;
  action: GeoAction;
  source: GeoActionSource;
  articles: readonly GeoArticle[];
  canEdit: boolean;
  onSwap: (domain: string | null) => void;
  onChanged: () => void;
}) {
  const conditions = conditionsWord(source.conditions);
  const price = priceWord(source);
  const route = routeWord(source.route);
  const why = unavailableWords(source.unavailableBecause);
  const own = source.domain === null;
  // The article written for this channel: the one the pasted page is.
  const channelArticle = own ? articles.find((article) => source.articleIds.includes(article.id)) ?? articles.find((article) => article.channel === source.channel) ?? null : null;
  const placed = source.chosen === "placed";
  const swapped = source.chosen === "swapped";
  const tag = placed ? "已投放" : swapped ? "你换的" : own ? "自有渠道" : null;
  return (
    <li data-geo-source={source.domain ?? source.channel ?? undefined} data-geo-source-chosen={source.chosen} className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0 text-ui text-text">{sourceName(source)}</span>
        {source.name && source.domain && <span className="text-caption text-text-3">{source.domain}</span>}
        {sourceKinds(source).map((word) => <Tag key={word}>{word}</Tag>)}
        {tag && <Tag tone="accent">{tag}</Tag>}
        {route && source.route !== "market" && source.route !== "own" && <Tag>{route}</Tag>}
        <span className="flex-1" />
        {canEdit && !own && !placed && !swapped && action.sources.some((entry) => entry.chosen === "placed") === false && (
          <Button variant="text" size="sm" onClick={() => onSwap(source.domain)}>换到这里</Button>
        )}
        {canEdit && swapped && <Button variant="text" size="sm" onClick={() => onSwap(null)}>恢复推荐</Button>}
      </div>
      {source.why && <p className="max-w-measure-body text-ui text-text-2">{source.why}</p>}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-text-3">
        {conditions && <span className={cn(conditions.met ? "text-accent" : "text-warn-strong")}>{`${conditions.met ? "✓" : "✗"} ${conditions.text}`}</span>}
        {price && <span className="tabular-nums">{`单篇 ${price}`}</span>}
        {Object.keys(source.citedFor).length > 0 && (
          <span>{`被引用：${Object.entries(source.citedFor).map(([engine, count]) => `${engineName(engine)} ${count}`).join("、")}`}</span>
        )}
        {source.available === false && why.length > 0 && <span className="text-warn-strong">{`现在投不了：${why.join("、")}`}</span>}
        {own && route && <span>{route}</span>}
      </p>
      {own && <OwnedLinkForm geoId={geoId} action={action} source={source} articleId={channelArticle?.id ?? null} onRegistered={onChanged} />}
    </li>
  );
}
