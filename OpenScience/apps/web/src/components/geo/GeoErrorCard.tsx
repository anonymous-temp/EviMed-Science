import { useState } from "react";
import { Check, PenLine, X } from "lucide-react";
import { Link } from "react-router";
import type { GeoErrorRow, GeoProject } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { SeverityBadge, isSeverityLevel } from "@/components/ui/SeverityBadge";
import { engineName, GEO_ERROR_STATUS_WORDS, GEO_ERROR_TYPE_WORDS } from "./geoText";
import { answerPath, CITED_ATTRIBUTE_WORDS } from "./tabs/geoTabText";
import { useOpenGeoConversation } from "./useOpenGeoConversation";

/**
 * One thing an AI says wrong about the medicine (fusion plan §4.8, appendix E
 * §2.4 — the pattern every accuracy product converged on).
 *
 * The card is the whole finding at a glance: how badly it would land, which
 * engines said it, the sentence itself, what the label actually says, where
 * the engine took it from, and where it stands. Red is spent on the severity
 * badge and the ✗ alone — the sentence is body text, because a page of red
 * sentences is a page a reader stops reading, and that is what the old board
 * was.
 *
 * Two actions, both real: read the answer it was said in, and have the
 * correction written — which, like everything else here, happens in the
 * project's own conversation.
 */
export function GeoErrorCard({
  geoId,
  project,
  error,
  className,
}: {
  geoId: string;
  project: GeoProject;
  error: GeoErrorRow;
  className?: string;
}) {
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const severity = isSeverityLevel(error.severity) ? error.severity : null;
  const cited = error.citedSource;
  const source = cited?.domain
    ? `出处 ${cited.domain}${cited.attribute && CITED_ATTRIBUTE_WORDS[cited.attribute] ? `（${CITED_ATTRIBUTE_WORDS[cited.attribute]}）` : ""}`
    : cited?.attribute === "none" ? CITED_ATTRIBUTE_WORDS.none : null;
  const closed = error.status === "closed";
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const draft = `${engineName(error.engine)}在回答里说「${error.statement}」，和${product}的说明书不一致${error.evidenceQuote ? `（说明书：${error.evidenceQuote}）` : ""}。写一篇纠错稿，把正确的说法讲清楚。`;
  const correct = () => {
    setBusy(true);
    void open({ projectId: project.projectId, sessionId: project.sessionId }, draft)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <article data-geo-error={error.id} className={cn("border-b border-faint py-3 last:border-b-0", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {severity && <SeverityBadge level={severity} />}
        <span className="text-caption font-medium text-text">{GEO_ERROR_TYPE_WORDS[error.errorType] ?? "讲错我方"}</span>
        <span className="text-caption text-text-2">{engineName(error.engine)}</span>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" loading={busy} onClick={correct}>
          {!busy && <PenLine size={16} aria-hidden="true" />}
          写纠错稿
        </Button>
        {error.snapshotId && (
          <Link to={answerPath(geoId, error.snapshotId)} className="inline-flex h-6 items-center rounded px-2 text-ui text-accent hover:bg-surface-2">
            看回答
          </Link>
        )}
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-ui text-text">
        <X size={16} aria-hidden="true" className="mt-1 shrink-0 text-danger" />
        <span className="min-w-0 max-w-measure">「{error.statement}」</span>
      </p>
      {error.evidenceQuote && (
        <p className="mt-1 flex items-start gap-1.5 text-ui text-text-2">
          <Check size={16} aria-hidden="true" className="mt-1 shrink-0 text-accent" />
          <span className="min-w-0 max-w-measure">说明书：{error.evidenceQuote}</span>
        </p>
      )}
      {/* The round's denominator belongs to the block above, said once; the
          card carries only what is true of this finding. */}
      <p className="mt-1.5 text-caption text-text-3">
        {source}
        {GEO_ERROR_STATUS_WORDS[error.status] && (
          <>
            {source && " · "}
            <span className={closed ? undefined : "text-warn-strong"}>{GEO_ERROR_STATUS_WORDS[error.status]}</span>
          </>
        )}
      </p>
    </article>
  );
}
