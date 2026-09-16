import * as Popover from "@radix-ui/react-popover";
import { ExternalLink } from "lucide-react";
import type { ClaimEvidence, ClaimSource } from "@/lib/claimCitations";

const TYPE_LABEL: Record<string, string> = { direct: "直接证据", synthesized: "综合结论", derived: "推导结果" };
const ACCESS_LABEL: Record<string, string> = {
  full_text: "全文", official_page: "官方页面", abstract: "仅摘要", structured_record: "结构化记录",
};

/** A source link only for an http(s) address: the matrix is model-written text. */
function safeHref(url: string | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function Source({ source }: { source: ClaimSource }) {
  const href = safeHref(source.sourceUrl);
  return (
    <div className="mt-2">
      {source.supportQuote && (
        <blockquote className="border-l-2 border-border pl-2 text-ui-sm text-text">“{source.supportQuote}”</blockquote>
      )}
      <p className="mt-1 text-caption text-muted">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-link hover:underline">
            {source.sourceTitle ?? source.identifier ?? "来源"}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : (
          <span>{source.sourceTitle ?? source.identifier ?? "来源未记录"}</span>
        )}
        {source.identifier && source.sourceTitle ? ` · ${source.identifier}` : ""}
        {source.accessLevel ? ` · ${ACCESS_LABEL[source.accessLevel] ?? source.accessLevel}` : ""}
      </p>
    </div>
  );
}

/**
 * The claims one sentence of a report rests on, opened in place: what the
 * claim says, the verbatim quote from each source, and where it came from. A
 * claim id the matrix does not hold is named, not skipped — a citation that
 * points at nothing is itself something to check.
 */
export function ClaimCitation({ ids, claims }: { ids: string[]; claims: Map<string, ClaimEvidence> }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`查看这句话的依据（${ids.length} 条主张）`}
          className="mx-0.5 inline-flex min-h-6 items-center rounded-input px-1 align-super text-caption font-medium text-accent hover:bg-surface-2"
        >
          依据
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-h-96 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-card border border-border bg-surface p-3 text-left shadow-pop"
        >
          <ul className="space-y-3">
            {ids.map((id) => {
              const claim = claims.get(id);
              if (!claim) {
                return <li key={id} className="text-ui-sm text-warn">证据矩阵里没有这条主张（{id}）。</li>;
              }
              const sources = claim.claimType === "synthesized" && claim.supportingSources?.length
                ? claim.supportingSources
                : claim.claimType === "derived" ? [] : [claim];
              return (
                <li key={id}>
                  <p className="text-caption text-muted">
                    {TYPE_LABEL[claim.claimType] ?? "主张"} · {id}
                    {claim.confidence ? ` · 把握度 ${claim.confidence}` : ""}
                  </p>
                  <p className="mt-0.5 text-ui text-text">{claim.claim}</p>
                  {sources.map((source, index) => <Source key={index} source={source} />)}
                  {claim.claimType === "derived" && (
                    <p className="mt-1 text-caption text-muted">
                      由 {claim.derivedFrom?.join("、") || "其他主张"} 推导{claim.method ? `：${claim.method}` : ""}
                    </p>
                  )}
                  {claim.uncertainty && <p className="mt-1 text-caption text-muted">不确定性：{claim.uncertainty}</p>}
                </li>
              );
            })}
          </ul>
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
