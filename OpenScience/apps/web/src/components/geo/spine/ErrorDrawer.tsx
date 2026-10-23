import { useGeoPath } from "../useGeoPath";
import { useGeoDestinationPath } from "../useGeoPath";
import { Link } from "react-router";
import { clusterName } from "./clusterModel";
import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { getGeoArticles, type GeoAction, type GeoArticle, type GeoProject } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { SeverityBadge, SEVERITY_WORDS } from "@/components/ui/SeverityBadge";
import { useGeoLoad } from "../geoProjectData";
import {
  engineName,
  GEO_ERROR_STATUS_WORDS,
  GEO_ERROR_TYPE_WORDS,
  GEO_STABILITY_WORDS,
} from "../geoText";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { answerPath } from "../tabs/geoTabText";
import { articleMeta, articleStatusLine, whatToDo } from "./actionModel";
import { ClusterLink } from "./ClusterLink";
import { StatusMark } from "./ActionRow";
import { GEO_ACTION_PARAM, GEO_SOURCE_PARAM } from "./drawerParams";
import { correctionBrief, errorTrace, ERROR_TRACE_WORDS, type ClaimRow } from "./errorModel";
import { useArticleActions } from "./useArticleActions";

/** The question group a question belongs to, from the question set. */
export type GroupOfQuestion = ReadonlyMap<string, { id: string; name: string; isControl: boolean }>;

/**
 * One wrong claim as a record (R19, audit C §2.3): what is said, what the label says instead, what every engine said of it in its
 * own words, where each engine took it from, and what is being done. Opened from a row of 准确与安全 (`?error=<claim>`); the
 * claim's question groups, its sources and its answers are each the way to their own record.
 *
 * The correction is the existing lifecycle — an action that names the claim's rows, with the article it wrote — and the button
 * starts the one a person asks for in the project's conversation, with the brief in it unsent.
 */
export function ErrorDrawer({
  geoId,
  project,
  claim,
  actions,
  groupOf,
  basis,
  onClose,
}: {
  geoId: string;
  project: GeoProject;
  claim: ClaimRow;
  /** The project's actions: the ones that name this claim's rows are its corrections. */
  actions: readonly GeoAction[];
  groupOf: GroupOfQuestion;
  /** The reader's name for the source the label's words come from (「玛仕度肽注射液说明书」), where the page knows it. */
  basis?: string | null;
  onClose: () => void;
}) {
  const path = useGeoPath();
  const destination = useGeoDestinationPath();
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const abilities = project.access?.abilities;
  const canRun = !abilities || abilities.includes("run");
  const corrections = useMemo(() => actions.filter((action) => action.need.errorIds.some((id) => claim.rows.some((row) => row.id === id))), [actions, claim.rows]);

  const correct = () => {
    setBusy(true);
    void open({ projectId: project.projectId, sessionId: project.sessionId }, correctionBrief(claim, product)).finally(() => setBusy(false));
  };

  return (
    <Drawer
      title="讲错的说法"
      widthClassName="max-w-2xl"
      description={(
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {claim.severity && <SeverityBadge level={claim.severity} label />}
          <span>{`${claim.engines.length} 个引擎`}</span>
          <span>{GEO_ERROR_STATUS_WORDS[claim.status] ?? ""}</span>
        </span>
      )}
      onClose={onClose}
      footer={canRun ? <Button data-geo-error-handoff="" loading={busy} onClick={correct}>{corrections.length > 0 ? "再写一篇纠错稿" : "写纠错稿"}</Button> : undefined}
    >
      <div data-geo-error-drawer={claim.key} className="flex flex-col gap-6">
        <Section title="这句话" level="sub">
          <p className="flex items-start gap-1.5 text-ui text-text">
            <X size={16} aria-hidden="true" className="mt-1 shrink-0 text-danger" />
            <span className="min-w-0 max-w-measure">“{claim.statement}”</span>
          </p>
          {claim.evidenceQuote && (
            <p data-geo-error-label="" className="mt-2 flex items-start gap-1.5 text-ui text-text-2">
              <Check size={16} aria-hidden="true" className="mt-1 shrink-0 text-accent" />
              <span className="min-w-0 max-w-measure">说明书：{claim.evidenceQuote}</span>
            </p>
          )}
          {basis && <p data-geo-error-basis="" className="mt-1 text-caption text-text-3">{`依据：${basis}`}</p>}
          {claim.severity && <p className="mt-2 text-caption text-text-3">{`${claim.severity}：${SEVERITY_WORDS[claim.severity]}`}</p>}
        </Section>

        <Section title="各引擎怎么说" count={`${claim.rows.length} 条`} level="sub">
          <List label="各引擎的原话" divided>
            {claim.rows.slice(0, 3).map((row) => {
              const answer = row.firstSnapshotId ?? row.snapshotId;
              const group = row.questionId ? groupOf.get(row.questionId) : undefined;
              return (
                <ListRow
                  key={row.id}
                  title={<span className="max-w-measure">“{row.statement}”</span>}
                  titleProps={{ "data-geo-error-row": row.id }}
                  to={answer ? path(answerPath(geoId, answer)) : undefined}
                  meta={(
                    <span className="inline-flex flex-wrap items-baseline gap-x-2">
                      <span className="text-text-2">{engineName(row.engine)}</span>
                      <span>{[GEO_ERROR_TYPE_WORDS[row.errorType], row.stability ? GEO_STABILITY_WORDS[row.stability] ?? null : null, GEO_ERROR_STATUS_WORDS[row.status]].filter(Boolean).join(" · ")}</span>
                      {group && <ClusterLink groupId={group.id} className="relative z-sticky">{clusterName(group)}</ClusterLink>}
                    </span>
                  )}
                  trailing={answer ? <span aria-hidden="true" className="max-sm:hidden">看回答</span> : undefined}
                />
              );
            })}
          </List>
        </Section>

        <div className="flex flex-col gap-2 text-ui text-text-2">
          {claim.rows.slice(0, 3).map(row => row.citedSource?.domain ? <Link key={row.id} data-geo-error-source={row.citedSource.domain} to={destination(geoId, { tab: "sources" }, { [GEO_SOURCE_PARAM]: row.citedSource.domain })} className="text-link">{row.citedSource.domain}</Link> : <span key={row.id} data-geo-error-trace={errorTrace(row)}>{ERROR_TRACE_WORDS[errorTrace(row)]}</span>)}
        </div>
        <ErrorCorrections geoId={geoId} project={project} corrections={corrections.slice(0, 1)} canRun={false} onAsk={correct} />
      </div>
    </Drawer>
  );
}

/** What is being done about the claim: the actions that name it, and the articles they wrote. */
export function ErrorCorrections({
  geoId,
  project,
  corrections,
  canRun,
  onAsk,
}: {
  geoId: string;
  project: GeoProject;
  corrections: readonly GeoAction[];
  canRun: boolean;
  onAsk: () => void;
}) {
  if (corrections.length === 0) {
    return (
      <Section title="纠错稿" level="sub">
        <Note action={canRun ? <Button variant="secondary" size="sm" onClick={onAsk}>写纠错稿</Button> : undefined}>
          这条说法还没有纠错稿。
        </Note>
      </Section>
    );
  }
  return (
    <Section title="纠错稿" count={`${corrections.length} 条行动`} level="sub">
      <CorrectionList geoId={geoId} project={project} corrections={corrections} />
    </Section>
  );
}

function CorrectionList({ geoId, project, corrections }: { geoId: string; project: GeoProject; corrections: readonly GeoAction[] }) {
  const geoDestinationPath = useGeoDestinationPath();
  const articles = useGeoLoad(`articles:${geoId}`, () => getGeoArticles(geoId));
  const articleActions = useArticleActions(geoId, project, articles.reload);
  const list: GeoArticle[] = articles.state.kind === "ready" && Array.isArray(articles.state.data?.articles) ? articles.state.data.articles : [];
  return (
    <>
      <List label="这条说法的纠错行动" divided>
        {corrections.flatMap((action) => {
          const mine = list.filter((article) => action.articleIds.includes(article.id) && article.status !== "withdrawn");
          const to = geoDestinationPath(geoId, { tab: "actions" }, { [GEO_ACTION_PARAM]: action.key });
          return [
            <ListRow
              key={action.key}
              title={whatToDo(action)}
              titleProps={{ "data-geo-error-action": action.key }}
              to={to}
              trailing={<StatusMark status={action.status} />}
            />,
            ...mine.map((article) => {
              const reach = articleActions.reachable(article);
              return (
                <ListRow
                  key={`${action.key}:${article.id}`}
                  title={article.title || "未命名稿件"}
                  titleProps={{ "data-geo-article": article.id }}
                  onOpen={reach ? () => articleActions.open(article) : undefined}
                  meta={[articleMeta(article), articleStatusLine(article)].filter(Boolean).join(" · ")}
                />
              );
            }),
          ];
        })}
      </List>
      {articleActions.dialogs}
    </>
  );
}
