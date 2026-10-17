import { useMemo, useState } from "react";
import { Link } from "react-router";
import { pythonRound } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import { unmeasureGeoQuestion, type GeoClusterRow, type GeoClusterView, type GeoEngine, type GeoProject } from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { EffectStrip } from "@/components/charts/EffectStrip";
import { ClusterEngineGrid } from "@/components/charts/ClusterEngineGrid";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { geoDestinationPath } from "../geoTabs";
import {
  engineName,
  GEO_ARTICLE_STATUS_WORDS,
  layerName,
  orderStateWord,
  ownedPlatformName,
  platformName,
} from "../geoText";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { metricName, sourceKindWord, yuan } from "../tabs/geoTabText";
import { TabError } from "../tabs/geoTabKit";
import { expectedText, gapWord, statusWord, whatToDo } from "./actionModel";
import {
  clusterContext,
  clusterName,
  effectMarkers,
  effectPoints,
  groupTally,
  mentionText,
  tallyOf,
} from "./clusterModel";
import { QuestionRows } from "./QuestionRows";
import { useGeoCluster, useGeoClusters } from "./spineData";
import { useOpenArticle } from "./useOpenArticle";

/** Real phrasings listed before 「还有 N 条」. */
const PHRASINGS_SHOWN = 6;

/**
 * The question group as one record (R19, audit C §2.4: 「群为脊」). Every place a group's name appears in 循证 GEO is a link that opens
 * this drawer over the page the person is on (`?group=<id>`): an action's row, a wrong statement, an article, a gap in the plan, a
 * cell of the matrix. It answers what the owner asked, in the order they ask it:
 *
 *  1. 问了什么 — the measured questions, and for each engine what its latest answer did (named us ✓, misstated us ✗, did not name
 *     us –, not asked ·); each mark is the way to that answer;
 *  2. AI 现在怎么答 — the engines in counts, the sites cited most for this group, the gaps the strategy found and what an answer
 *     is expected to say;
 *  3. 我们在做什么 — its actions, articles, orders and the pages the brand published itself;
 *  4. 效果 — the answers that named us over the rounds, with what we did marked on them, and the arms' verdict.
 *
 * The group's own numbers are counts: about a dozen answers a round, under the platform's floor for a percentage, so `k/n` and 「样本不足」,
 * and a rate only from a reading the server sent as one. A control group has no actions: it is measured and never worked on.
 */
export function ClusterDrawer({
  geoId,
  project,
  groupId,
  engine,
  onClose,
}: {
  geoId: string;
  project: GeoProject;
  groupId: string;
  /** The engine the drawer rests on (a matrix cell was pressed). */
  engine?: GeoEngine | null;
  onClose: () => void;
}) {
  const detail = useGeoCluster(geoId, groupId);
  const clusters = useGeoClusters(geoId);
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const view = detail.state.kind === "ready" ? detail.state.data : null;
  const listed = clusters.state.kind === "ready" ? clusters.state.data.groups.find((group) => group.id === groupId) ?? null : null;
  const group = view?.group ?? listed;
  const engines = (clusters.state.kind === "ready" && clusters.state.data.engines.length > 0 ? clusters.state.data.engines : project.engines) as GeoEngine[];
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const abilities = project.access?.abilities;
  const canEdit = !abilities || abilities.includes("edit");

  const handoff = () => {
    setBusy(true);
    const tally = group ? groupTally(group) : null;
    const gaps = (view?.gaps ?? []).map((gap) => gapWord(gap.class)).filter((word): word is string => Boolean(word));
    const draft = group
      ? `处理问题群“${clusterName(group)}”（${clusterContext(group) || "未标阶段"}）：最近一轮 ${tally?.answered ?? 0} 个回答里 ${tally?.mentioned ?? 0} 个提到了${product}${tally && tally.wrong > 0 ? `，${tally.wrong} 个讲错` : ""}。${gaps.length > 0 ? `要补的缺口：${gaps.join("、")}。` : ""}接下来怎么做？`
      : "处理这个问题群：看一下它现在的回答，说说接下来怎么做。";
    // A question about a group opens a fresh conversation: the project's latest one may be a strategy run's own session, and a question asked in it is judged as that run (r19-geos hand-off §9.5c).
    void open({ projectId: project.projectId, sessionId: null }, draft).finally(() => setBusy(false));
  };

  return (
    <Drawer
      title={group ? clusterName(group) : "问题群"}
      description={group ? <ClusterHead group={group} /> : undefined}
      widthClassName="max-w-2xl"
      onClose={onClose}
      footer={<Button data-geo-cluster-handoff="" loading={busy} onClick={handoff}>在对话中处理</Button>}
    >
      <div data-geo-cluster-drawer={groupId} className="flex flex-col gap-6">
        {detail.state.kind === "loading" && <p role="status" className="text-ui text-text-3">正在读取这个问题群</p>}
        {detail.state.kind === "error" && (
          detail.state.missing
            ? <Note action={<Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>}>这个问题群不存在，或者已被新的问句集替换。</Note>
            : <TabError message={detail.state.message} onRetry={detail.reload} />
        )}
        {view && (
          <>
            <Questions geoId={geoId} view={view} engines={engines} focus={engine ?? null} canEdit={canEdit} onChanged={detail.reload} />
            <Answering geoId={geoId} view={view} engines={engines} focus={engine ?? null} />
            <Doing geoId={geoId} project={project} view={view} />
            <Effect view={view} />
          </>
        )}
      </div>
    </Drawer>
  );
}

/** 「存量 · 认知与选药 · 患者 · 权重 6%」 and the control group's tag. */
function ClusterHead({ group }: { group: GeoClusterRow }) {
  const weight = typeof group.weight === "number" ? `权重 ${Math.round(group.weight * 100)}%` : null;
  const audience = group.audience === "patient" ? "患者" : group.audience === "physician" ? "医生" : group.audience === "caregiver" ? "照护者" : group.audience === "pharmacist" ? "药师" : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{[clusterContext(group), audience, weight].filter(Boolean).join(" · ")}</span>
      {group.isControl && <Tag title="只监测、不写稿：给它写稿会让它退出对照组">对照组 · 只监测</Tag>}
    </span>
  );
}

/* --------------------------------------------------------------- questions */

function Questions({
  geoId,
  view,
  engines,
  focus,
  canEdit,
  onChanged,
}: {
  geoId: string;
  view: GeoClusterView;
  engines: readonly GeoEngine[];
  focus: string | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const measured = view.questions.filter((question) => question.isMeasured);
  const phrasings = view.questions.filter((question) => !question.isMeasured && question.kind === "real");
  const [all, setAll] = useState(false);
  const shown = all ? phrasings : phrasings.slice(0, PHRASINGS_SHOWN);
  const remove = (id: string) => {
    void unmeasureGeoQuestion(geoId, id)
      .then(() => {
        toast.success("已移出，之后的测量不再问这一句。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一句无法移出，请稍后重试。" })));
  };
  if (measured.length === 0 && phrasings.length === 0) return null;
  return (
    <Section title="问了什么" count={measured.length > 0 ? `${measured.length} 问` : undefined} level="sub">
      <QuestionRows
        geoId={geoId}
        questions={measured}
        engines={engines}
        focus={focus}
        menuFor={canEdit ? (question) => [{ label: "移出测量问句", onSelect: () => remove(question.id) }] : undefined}
      />
      {phrasings.length > 0 && (
        <div className={cn(measured.length > 0 && "mt-4")}>
          <p className="mb-1 text-caption text-text-3">{`真实问法 ${phrasings.length} 条`}</p>
          <ul aria-label="真实问法" className="flex flex-col gap-1">
            {shown.map((question) => {
              const href = safeWebHref(question.sourceUrl);
              const platform = platformName(question.platform);
              return (
                <li key={question.id} className="flex items-baseline gap-2 text-ui text-text-2">
                  <span className="min-w-0 flex-1">{question.text}</span>
                  {platform && (href
                    ? <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-caption text-text-3 underline decoration-border underline-offset-2 hover:text-text">{platform}</a>
                    : <span className="shrink-0 text-caption text-text-3">{platform}</span>)}
                </li>
              );
            })}
          </ul>
          {phrasings.length > PHRASINGS_SHOWN && (
            <Button variant="text" size="sm" className="mt-1" onClick={() => setAll((value) => !value)}>
              {all ? "收起" : `还有 ${phrasings.length - PHRASINGS_SHOWN} 条`}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

/* --------------------------------------------------------------- answering */

function Answering({ geoId, view, engines, focus }: { geoId: string; view: GeoClusterView; engines: readonly GeoEngine[]; focus: string | null }) {
  const group = view.group;
  const reading = mentionText(group);
  const wrong = groupTally(group).wrong;
  const rows = [{
    key: group.id,
    header: <span>提到我们</span>,
    name: clusterName(group),
    tallies: Object.fromEntries(engines.map((engine) => [engine, tallyOf(group, engine)])),
  }];
  const sources = view.sources.filter((source) => !source.impostor);
  const gaps = view.gaps;
  const hasAnswers = engines.some((engine) => tallyOf(group, engine) !== null);
  return (
    <Section title="AI 现在怎么答" level="sub">
      {hasAnswers && (
        <>
          <p data-geo-cluster-reading="" className="mb-2 text-ui text-text">
            <span className="tabular-nums">{reading.counts}</span>
            {" 个回答提到了我们"}
            {reading.rate && <span className="ml-1 tabular-nums text-text-2">{`（${reading.rate}）`}</span>}
            {reading.sample && <span className="ml-1 text-text-3">{reading.sample}</span>}
            {wrong > 0 && <span className="ml-2 text-danger">{`${wrong} 个讲错`}</span>}
          </p>
          <ClusterEngineGrid label="各引擎提到我们的回答数" engines={engines} engineName={engineName} rows={rows} legend={false} />
          {focus && <p className="sr-only">{`当前看的是${engineName(focus)}`}</p>}
        </>
      )}
      {sources.length > 0 && (
        <div className={cn(hasAnswers && "mt-5")}>
          <p className="mb-1 text-caption text-text-3">这一群的回答引用最多的站</p>
          <List label="被引用最多的信源" divided>
            {sources.map((source) => (
              <ListRow
                key={source.domain}
                title={source.name || source.domain}
                titleProps={{ "data-geo-cluster-source": source.domain }}
                to={geoDestinationPath(geoId, { tab: "sources" }, { source: source.domain })}
                meta={[sourceKindWord(source.kind), source.name ? source.domain : null].filter(Boolean).join(" · ")}
                columns={[
                  { key: "cited", label: "被引用", value: source.cited.total.toLocaleString("zh-CN") },
                  ...(source.wrongOurs > 0 ? [{ key: "wrong", label: "讲错的回答", value: source.wrongOurs.toLocaleString("zh-CN"), tone: "danger" as const }] : []),
                ]}
              />
            ))}
          </List>
        </div>
      )}
      {gaps.length > 0 && (
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-caption text-text-3">缺口和回答该说的</p>
          {gaps.map((gap, index) => {
            const word = gapWord(gap.class);
            return (
              <div key={gap.gapId ?? index} data-geo-gap={gap.gapId ?? undefined} className="flex flex-col gap-2">
                <p className="flex flex-wrap items-baseline gap-x-2 text-ui text-text">
                  {word && <Tag>{word}</Tag>}
                  <span className="min-w-0 max-w-measure-body">{gap.judgment}</span>
                </p>
                {gap.expectedPoints.length > 0 && (
                  <ul aria-label="回答该说的" className="flex flex-col gap-1 border-l-2 border-border pl-3">
                    {gap.expectedPoints.map((point, pointIndex) => {
                      const claim = (point.refs ?? []).map((ref) => view.claims[ref.id]).find(Boolean) ?? null;
                      return (
                        <li key={point.pointId ?? pointIndex} className="text-ui text-text-2">
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
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------- doing */

function Doing({ geoId, project, view }: { geoId: string; project: GeoProject; view: GeoClusterView }) {
  const openArticle = useOpenArticle(project);
  const { actions, articles, orders, ownedLinks } = view;
  const control = view.group.isControl;
  const hasWork = actions.length + articles.length + orders.length + ownedLinks.length > 0;
  if (!hasWork && !control) return null;
  return (
    <Section title="我们在做什么" level="sub">
      {control && articles.length > 0 && (
        <Note tone="warn" result={[{ n: articles.length }, " 篇稿件是为它写的：它已经不再是干净的对照。"]} />
      )}
      {actions.length > 0 && (
        <List label="这一群的行动" divided>
          {actions.map((action) => {
            const expected = expectedText(action);
            return (
              <ListRow
                key={action.key}
                title={whatToDo(action)}
                titleProps={{ "data-geo-action-link": action.key }}
                to={geoDestinationPath(geoId, { tab: "actions" }, { action: action.key })}
                meta={[expected.now, expected.goal].filter(Boolean).join(" · ")}
                trailing={<span data-geo-action-status={action.status}>{statusWord(action.status)}</span>}
              />
            );
          })}
        </List>
      )}
      {articles.length > 0 && (
        <div className={cn(actions.length > 0 && "mt-4")}>
          <p className="mb-1 text-caption text-text-3">稿件</p>
          <List label="这一群的稿件" divided>
            {articles.map((article) => {
              const canOpen = Boolean(article.runId && article.path);
              return (
                <ListRow
                  key={article.id}
                  title={article.title || "未命名稿件"}
                  titleProps={{ "data-geo-article": article.id }}
                  onOpen={canOpen ? () => openArticle(article) : undefined}
                  meta={[layerName(article.layer) === "—" ? null : layerName(article.layer), GEO_ARTICLE_STATUS_WORDS[article.status] ?? null].filter(Boolean).join(" · ")}
                />
              );
            })}
          </List>
        </div>
      )}
      {orders.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-caption text-text-3">投放的订单</p>
          <List label="这一群的订单" divided>
            {orders.map((order) => {
              const href = safeWebHref(order.publishedUrl);
              return (
                <li key={order.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-ui text-text">
                  <span className="min-w-0 flex-1">{order.domain ?? "—"}</span>
                  <span className="text-text-2">{orderStateWord(order.state)}</span>
                  <span className="tabular-nums text-text-2">{yuan(order.priceCny)}</span>
                  {href && <a href={href} target="_blank" rel="noreferrer" className="text-caption text-link hover:underline">查看<span className="sr-only">（在新标签页打开）</span></a>}
                </li>
              );
            })}
          </List>
        </div>
      )}
      {ownedLinks.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-caption text-text-3">自己发布的页面</p>
          <List label="这一群自己发布的页面" divided>
            {ownedLinks.map((link) => {
              const href = safeWebHref(link.url);
              const engines = link.citedBy.map((entry) => engineName(entry.engine));
              return (
                <li key={link.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-ui text-text">
                  <span className="text-text-2">{ownedPlatformName(link.platform)}</span>
                  <span className="min-w-0 flex-1">{href ? <a href={href} target="_blank" rel="noreferrer" className="hover:underline">{link.title || link.url}</a> : link.title || "—"}</span>
                  {link.status === "retired" ? <span className="text-caption text-text-3">已下线</span>
                    : engines.length > 0 ? <span className="text-caption text-accent-strong">{`被 ${engines.join("、")} 引用`}</span>
                      : <span className="text-caption text-text-3">还没有被引用</span>}
                </li>
              );
            })}
          </List>
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ effect */

function Effect({ view }: { view: GeoClusterView }) {
  const points = useMemo(() => effectPoints(view.effect.series), [view.effect.series]);
  const markers = useMemo(() => effectMarkers(view.effect.series.map((point) => point.date), view.effect.events), [view]);
  const arm = view.effect.arm;
  const metric = metricName(view.effect.metricId) ?? "被提到的回答";
  if (points.length === 0 && !arm) return null;
  const size = arm && arm.netEffect != null ? pythonRound(Math.abs(arm.netEffect), 1) : null;
  const band = arm?.noiseBand != null ? `（波动 ±${pythonRound(arm.noiseBand, 1)}）` : "";
  const where = arm?.scope === "pool" ? "这一类问题里" : "整个项目里";
  return (
    <Section title="效果" level="sub">
      {points.length > 0 && (
        <>
          <EffectStrip label={`${metric}：这一群每轮被提到的回答数`} points={points} markers={markers} />
        </>
      )}
      {arm && arm.comparable && size !== null && arm.verdict && (
        <Note className={cn(points.length > 0 && "mt-3")} result={[
          `${where}，做了行动的群比对照群${arm.verdict === "up" ? "多涨 " : arm.verdict === "down" ? "少 " : "只差 "}`,
          { n: size },
          ` 个点${band}${arm.verdict === "flat" ? "，没有超出波动" : ""}。`,
        ]} />
      )}
    </Section>
  );
}
