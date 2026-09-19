import * as Popover from "@radix-ui/react-popover";
import { Link } from "react-router";
import { EVIDENCE_SOURCE_TYPE_LABELS_ZH } from "@evimed/domain";
import { ExternalLink, FileText, ShieldAlert } from "lucide-react";
import {
  CLAIM_STATUS_TEXT,
  claimGuidance,
  claimSources,
  type ClaimEvidence,
  type ClaimSource,
  type ClaimVerification,
} from "@/lib/claimCitations";
import { claimAppraisalDisplay } from "@/lib/claimAppraisal";
import { cn } from "@/lib/cn";
import type { WebReadPage } from "@/lib/apiClient";
import { pageForSource } from "@/lib/readPages";
import { ReadPageCard } from "@/components/runs/ReadPages";
import { ClaimAppraisalSummary } from "./ClaimAppraisal";

const TYPE_LABEL: Record<string, string> = { direct: "直接证据", synthesized: "综合结论", derived: "推导结果" };
const ACCESS_LABEL: Record<string, string> = {
  full_text: "全文", official_page: "官方页面", abstract: "仅摘要", structured_record: "结构化记录",
};
const CONFIDENCE_LABEL: Record<string, string> = { high: "高", moderate: "中", low: "低" };
const TONE_CLASS = { ok: "text-verify-ok", warn: "text-verify-pending", muted: "text-muted" } as const;

export type VerifiedClaim = ClaimVerification["claims"][number];

/** What the reader around a report knows beyond the matrix itself. */
export interface ClaimReading {
  /** What `claim_verification` found for each claim, by id. */
  verified?: Map<string, VerifiedClaim>;
  /** The run the report belongs to: a preserved source opens in its reader. */
  runId?: string | null;
  /** Claims a clinical-safety finding names: marked in the text, and their
   *  evidence shown open above the report (the reader does that part). */
  safety?: Set<string>;
  /** Rendering for paper: a plain mark, no control. */
  print?: boolean;
  /** The web pages the run read (contract X5): a source read from one shows its card. */
  pagesRead?: readonly WebReadPage[];
}

/** A source link only for an http(s) address: the matrix is model-written text. */
function safeHref(url: string | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The reader route for a preserved source, with the quotation to find in it. */
export function preservedSourceHref(runId: string, artifactPath: string, quote?: string): string {
  const path = artifactPath.split("/").map(encodeURIComponent).join("/");
  return `/app/runs/${encodeURIComponent(runId)}/files/${path}${quote ? `?quote=${encodeURIComponent(quote.slice(0, 400))}` : ""}`;
}

function SourceBadge({ source }: { source: ClaimSource }) {
  // 「其他」 says nothing a reader can use; only a decided kind is drawn.
  if (source.sourceType === "other") return null;
  return (
    <span className="rounded-full border border-border bg-surface-2 px-1.5 text-caption text-text">
      {EVIDENCE_SOURCE_TYPE_LABELS_ZH[source.sourceType]}
    </span>
  );
}

function Source({ source, index, count, status, runId, pagesRead }: {
  source: ClaimSource;
  index: number;
  count: number;
  status?: string;
  runId?: string | null;
  pagesRead?: readonly WebReadPage[];
}) {
  const href = safeHref(source.sourceUrl);
  const page = pageForSource(pagesRead, source);
  const statusText = status ? CLAIM_STATUS_TEXT[status] : undefined;
  return (
    <div className="mt-2 space-y-1">
      <p className="flex flex-wrap items-center gap-1.5 text-caption text-muted">
        {count > 1 && <span>第 {index + 1} 段引文</span>}
        <SourceBadge source={source} />
        {statusText && count > 1 && <span className={TONE_CLASS[statusText.tone]}>{statusText.tone === "ok" ? "✓ 已核对" : "⚠ 未核对上"}</span>}
      </p>
      {source.supportQuote && (
        <blockquote className="border-l-2 border-strong pl-2 text-ui text-text">“{source.supportQuote}”</blockquote>
      )}
      <p className="text-caption text-muted">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-link hover:underline">
            {source.sourceTitle ?? source.identifier ?? "来源"}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : (
          <span>{source.sourceTitle ?? source.identifier ?? "来源未记录"}</span>
        )}
        {source.identifier && source.sourceTitle ? ` · ${source.identifier}` : ""}
        {source.accessLevel ? ` · ${ACCESS_LABEL[source.accessLevel] ?? "获取程度未注明"}` : ""}
      </p>
      {/* The page this quotation was read from, when the run read it on the
        * web: where, when, whether it is an authority's, and its snapshot. */}
      {page && <ReadPageCard page={page} runId={runId} compact showSnapshot={!source.artifactPath} />}
      {runId && source.artifactPath && (
        <Link
          to={preservedSourceHref(runId, source.artifactPath, source.supportQuote)}
          className="inline-flex items-center gap-1 text-caption text-link hover:underline"
        >
          <FileText size={12} aria-hidden="true" />在保存的原文中定位这段引文
        </Link>
      )}
    </div>
  );
}

/** Each claim a sentence rests on: what it says, how it checked out, what to do, and its sources. */
export function ClaimEvidenceList({ ids, claims, statuses, reading }: {
  ids: string[];
  claims: Map<string, ClaimEvidence>;
  statuses?: Map<string, string>;
  reading?: ClaimReading;
}) {
  return (
    <ul className="space-y-3">
      {ids.map((id) => {
        const claim = claims.get(id);
        if (!claim) {
          return <li key={id} className="text-ui text-verify-pending">证据矩阵里没有这条主张（{id}）。</li>;
        }
        const sources = claimSources(claim);
        const verified = reading?.verified?.get(id);
        const status = verified?.status ?? statuses?.get(id);
        const statusText = status ? CLAIM_STATUS_TEXT[status] : undefined;
        const guidance = claimGuidance(claim, verified);
        const appraisal = claimAppraisalDisplay(claim, verified);
        return (
          <li key={id}>
            <p className="text-caption text-muted">
              {TYPE_LABEL[claim.claimType] ?? "主张"} · {id}
              {claim.confidence ? ` · 把握度${CONFIDENCE_LABEL[claim.confidence] ?? "未注明"}` : ""}
            </p>
            <p className="mt-0.5 text-ui text-text">{claim.claim}</p>
            {appraisal && <ClaimAppraisalSummary display={appraisal} sourceCount={sources.length} />}
            {status && (
              <p className={cn("mt-1 text-caption", TONE_CLASS[statusText?.tone ?? "muted"])}>
                {statusText?.label ?? "这条主张还没有被核对"}
              </p>
            )}
            {guidance && <p className="mt-1 text-caption font-medium text-verify-pending">⚠ {guidance}</p>}
            {sources.map((source, index) => (
              <Source
                key={index}
                source={source}
                index={index}
                count={sources.length}
                status={verified?.sources[index]?.status}
                runId={reading?.runId}
                pagesRead={reading?.pagesRead}
              />
            ))}
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
  );
}

/**
 * The claims one sentence of a report rests on, as a mark at the end of the
 * sentence (appendix D §10.6–§10.7): 「依据 ✓」 when every quotation was found
 * in its preserved source, 「依据 ⚠」 when one was not — a mark and a word,
 * never colour alone, and amber rather than red: an unchecked quotation is
 * something to check, not a clinical alarm. Opened, it shows each claim, its
 * verbatim quotes with the kind of source each comes from, what the check
 * found, and where to look (「请核对第 2 段引文」).
 *
 * A claim that a clinical-safety finding names carries a shield beside the
 * mark; the reader shows its evidence open above the report, where it cannot
 * be skimmed past (a paragraph cannot hold a block of evidence in place).
 *
 * A claim id the matrix does not hold is named, not skipped — a citation that
 * points at nothing is itself something to check.
 */
export function ClaimCitation({ ids, claims, statuses, reading }: {
  ids: string[];
  claims: Map<string, ClaimEvidence>;
  /** Whether each claim's quotation was found in its preserved source. */
  statuses?: Map<string, string>;
  reading?: ClaimReading;
}) {
  const statusOf = (id: string) => reading?.verified?.get(id)?.status ?? statuses?.get(id);
  // The sentence is flagged where it stands, not only inside the popover: a
  // reader skimming the page should see which sentences to look at twice.
  const attention = ids.some((id) => {
    const status = statusOf(id);
    return (status != null && CLAIM_STATUS_TEXT[status]?.tone === "warn") || !claims.has(id);
  });
  const allVerified = !attention && ids.every((id) => statusOf(id) === "verified" || statusOf(id) === "derived")
    && ids.some((id) => statusOf(id) === "verified");
  const safety = ids.some((id) => reading?.safety?.has(id));
  const mark = attention ? "依据 ⚠" : allVerified ? "依据 ✓" : "依据";
  const label = `查看这句话的依据（${ids.length} 条主张${attention ? "，其中有未核对上的引文" : allVerified ? "，引文均已核对" : ""}${safety ? "，涉及临床安全" : ""}）`;
  const tone = attention ? "text-verify-pending" : allVerified ? "text-verify-ok" : "text-link";

  if (reading?.print) {
    return <sup className={cn("mx-0.5 text-caption", tone)}>{mark}</sup>;
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          data-claims={ids.join(" ")}
          className={cn(
            "mx-0.5 inline-flex min-h-6 items-center gap-0.5 rounded-full border px-1.5 align-super text-caption font-medium leading-4",
            attention ? "border-warn bg-warn-soft" : "border-border bg-surface hover:bg-surface-2",
            tone,
          )}
        >
          {mark}
          {safety && <ShieldAlert size={11} className="text-danger" aria-hidden="true" />}
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
          <ClaimEvidenceList ids={ids} claims={claims} statuses={statuses} reading={reading} />
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
