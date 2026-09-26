import { useState } from "react";
import { Link } from "react-router";
import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import { EVIDENCE_SOURCE_TYPES, EVIDENCE_SOURCE_TYPE_LABELS_ZH } from "@evimed/domain";
import { claimSources, type ClaimEvidence, type ClaimSource, type SourceUpdate } from "@/lib/claimCitations";
import { cn } from "@/lib/cn";
import { tagClasses } from "@/components/ui/Tag";
import { preservedSourceHref, type VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";
import { SourceUpdateBadges } from "@/components/markdown-viewer/SourceUpdateBadges";
import { StudyTypeBadge } from "@/components/markdown-viewer/StudyTypeBadge";

/** The identifier, and one click to take it away. */
function IdentifierCopy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => { /* it is still on screen to select */ });
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`复制 ${value}`}
      className="inline-flex min-h-6 items-center gap-1 rounded px-1 text-caption text-text-3 hover:bg-surface-2"
    >
      <span className="tabular-nums">{value}</span>
      {copied ? <Check size={16} className="text-verify-ok" aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      <span className="sr-only">{copied ? "已复制" : "复制"}</span>
    </button>
  );
}

/** One source, as the trust design's 来源级 layer asks for it. */
export interface SourceCardEntry {
  key: string;
  /** Its number in the list, which is the number the prose cites. */
  index: number;
  title: string;
  sourceType?: string;
  /** The journal or issuing body, and the year or version, when the package recorded them. */
  journal?: string;
  year?: string;
  url?: string;
  identifier?: string;
  /** Industry funding, when the package recorded it. */
  funding?: string;
  /** The source's own words this report rests on. */
  quote?: string;
  /** What `claim_verification` found for that quotation. */
  status?: string;
  updates?: readonly SourceUpdate[];
  /** How many of the report's claims stand on it. */
  claims: number;
  /** Where to read the quotation in the preserved source. */
  artifactPath?: string;
}

const STATUS_MARK: Record<string, { mark: string; label: string; className: string }> = {
  verified: { mark: "✓", label: "引文已核对", className: "text-verify-ok" },
  quote_not_found: { mark: "⚠", label: "引文未在原文中找到", className: "text-verify-pending" },
  source_unavailable: { mark: "⚠", label: "原文未保存，无法核对", className: "text-verify-pending" },
  no_quote: { mark: "⚠", label: "没有可核对的引文", className: "text-verify-pending" },
};

/**
 * The distinct sources a set of claims stands on, numbered, deduplicated and
 * carrying their verdicts — the list a source-card list is drawn from.
 *
 * Dedupe is by identifier, then address, then title, the same key
 * `frameEvidenceFrom` uses, so the conversation's cards and the report's are
 * one list in two places. The verdict of a source is the one
 * `claim_verification` reported for it at its own index in the claim it
 * belongs to.
 */
export function sourceCardEntries(
  claims: Iterable<ClaimEvidence>,
  verified?: ReadonlyMap<string, VerifiedClaim>,
): SourceCardEntry[] {
  const entries = new Map<string, SourceCardEntry>();
  for (const claim of claims) {
    const record = verified?.get(claim.claimId);
    claimSources(claim).forEach((source: ClaimSource, index: number) => {
      const key = source.identifier || source.sourceUrl || source.sourceTitle;
      if (!key) return;
      const known = entries.get(key);
      if (known) { known.claims += 1; return; }
      const checked = record?.sources?.[index];
      entries.set(key, {
        key,
        index: entries.size + 1,
        title: source.sourceTitle || source.identifier || key,
        sourceType: checked?.sourceType ?? source.sourceType,
        ...(source.sourceUrl ? { url: source.sourceUrl } : {}),
        ...(source.identifier ?? checked?.doi ? { identifier: source.identifier ?? `DOI ${checked?.doi}` } : {}),
        ...(source.supportQuote ? { quote: source.supportQuote } : {}),
        ...(checked?.status ? { status: checked.status } : {}),
        ...(checked?.updates?.length ? { updates: checked.updates } : {}),
        ...(source.artifactPath ? { artifactPath: source.artifactPath } : {}),
        claims: 1,
      });
    });
  }
  return [...entries.values()];
}

/**
 * What a body of evidence is made of, counted from the cards themselves:
 * 「指南 2 · 系统综述 3 · RCT 4 · 观察性研究 3」. In the domain's order, most
 * authoritative form first, so two reports read the same way.
 */
export function sourceCompositionOf(entries: readonly SourceCardEntry[]): { type: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const type = entry.sourceType && entry.sourceType in EVIDENCE_SOURCE_TYPE_LABELS_ZH ? entry.sourceType : "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return (EVIDENCE_SOURCE_TYPES as readonly string[])
    .filter((type) => counts.has(type))
    .map((type) => ({ type, label: EVIDENCE_SOURCE_TYPE_LABELS_ZH[type as keyof typeof EVIDENCE_SOURCE_TYPE_LABELS_ZH], count: counts.get(type)! }));
}

/** One source card. */
export function SourceCard({ entry, runId }: { entry: SourceCardEntry; runId?: string | null }) {
  const verdict = entry.status ? STATUS_MARK[entry.status] : undefined;
  const facts = [entry.journal, entry.year].filter(Boolean);
  return (
    <li className="rounded-card border border-border bg-surface p-3" data-source-index={entry.index}>
      <div className="flex gap-2">
        <span className="shrink-0 tabular-nums text-caption text-text-3">{entry.index}</span>
        <div className="min-w-0 flex-1 space-y-1">
          {entry.url ? (
            <a href={entry.url} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 text-ui font-medium text-link hover:underline">
              {entry.title}
              <ExternalLink size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            </a>
          ) : (
            <p className="text-ui font-medium text-text">{entry.title}</p>
          )}
          <p className="flex flex-wrap items-center gap-1.5 text-caption text-text-3">
            <StudyTypeBadge sourceType={entry.sourceType} />
            {facts.map((fact) => <span key={fact}>{fact}</span>)}
            {entry.identifier && <IdentifierCopy value={entry.identifier} />}
            {/* Industry funding is a fact a reader weighs, not a verdict. */}
            {entry.funding === "industry" && <span className={tagClasses({ tone: "warn" })}>企业资助</span>}
          </p>
          {/* A work that no longer stands as published is the one thing on a
            * card a reader must not miss, so it is a strip of its own. */}
          {entry.updates && entry.updates.length > 0 && <SourceUpdateBadges updates={entry.updates} />}
          {entry.quote && (
            <blockquote className="border-l-2 border-strong pl-2 text-ui text-text">
              {verdict && <span className={cn("mr-1", verdict.className)} aria-label={verdict.label}>{verdict.mark}</span>}
              <mark className="bg-highlight text-text">“{entry.quote}”</mark>
            </blockquote>
          )}
          {runId && entry.artifactPath && (
            <Link
              to={preservedSourceHref(runId, entry.artifactPath, entry.quote)}
              className="inline-flex items-center gap-1 text-caption text-link hover:underline"
            >
              <FileText size={16} aria-hidden="true" />定位原文
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The source list of a report: one line of composition, then one card per
 * distinct source (融合方案 §8.3, m02).
 *
 * It replaces nothing the model wrote — the report's own 参考文献 section is
 * its prose — and adds the reading a reference list cannot give: what kind of
 * study each source is, whether the quotation it was cited for is in it, and
 * whether it has since been retracted.
 */
export function SourceCardList({
  claims,
  verified,
  runId,
  className,
}: {
  claims: Map<string, ClaimEvidence>;
  verified?: Map<string, VerifiedClaim>;
  runId?: string | null;
  className?: string;
}) {
  const entries = sourceCardEntries(claims.values(), verified);
  if (entries.length === 0) return null;
  const composition = sourceCompositionOf(entries);
  return (
    <section aria-labelledby="report-sources" className={cn("space-y-2", className)} data-source-count={entries.length}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="report-sources" className="text-section font-semibold text-text">来源 {entries.length}</h2>
        {composition.length > 0 && (
          <p className="text-caption text-text-3">{composition.map((entry) => `${entry.label} ${entry.count}`).join(" · ")}</p>
        )}
      </div>
      <ul className="space-y-2">
        {entries.map((entry) => <SourceCard key={entry.key} entry={entry} runId={runId} />)}
      </ul>
    </section>
  );
}
