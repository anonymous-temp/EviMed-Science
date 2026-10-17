import { ArrowUpRight } from "lucide-react";
import { EVIDENCE_CALCULATION_LABEL_ZH } from "@evimed/domain";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import type { EvidenceCard, EvidenceClaim, EvidenceClaimMark } from "@/lib/evidenceZoneClient";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";
import { EvidenceChallenge } from "./EvidenceChallenge";
import { EvidenceReferences } from "./EvidenceContent";

/**
 * What a card's drawer reads (R19, audit D C2): the quotation a conclusion stands on, and the excerpt a source was read from. They
 * used to be drawn under every row of two lists, which made an evidence card forty thousand pixels tall; they are here now, opened by
 * the row that names them. The words are the page's own and unchanged: ✓ and ⚠ are the product's marks for a quotation that was
 * found or was not.
 */

/** What a ⚠ means for one quotation, in a sentence. */
export const CLAIM_STATUS_TEXT: Record<string, string> = {
  quote_not_found: "来源里没有找到这段引文",
  source_unavailable: "来源原文不可用，无法核对",
  no_quote: "没有附引文，无法核对",
  author_excerpt_only: "摘录由作者提供，平台未读取原文",
};
const CONFIDENCE: Record<string, string> = { high: "高", moderate: "中", low: "低" };

/** How much of a source the card read. */
export const COVERAGE_WORDS: Record<string, string> = { "full-text": "依据全文", abstract: "依据摘要", excerpt: "依据原文片段" };

export const publicationLabel = (kind: "retracted" | "corrected" | "concern") => (kind === "retracted" ? "存在撤稿记录" : kind === "concern" ? "存在关注声明" : "存在更正记录");

/** Source text stays text: imported cards never supply HTML or navigation code. */
export const safeUrl = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

export function ClaimMark({ mark }: { mark: EvidenceClaimMark | undefined }) {
  if (mark === "✓") return <span role="img" className="mr-1 text-verify-ok" aria-label="引文已核对">✓</span>;
  if (mark === "⚠") return <span role="img" className="mr-1 text-verify-pending" aria-label="未核对上">⚠</span>;
  return null;
}

/** One quotation and where it is from. A synthesis shows a mark for each of its sources; a direct claim's mark is the claim's own, shown once. */
function Quote({ evidence, index, quote, mark, status, showMark = false }: { evidence: EvidenceCard; index: number; quote?: string; mark: EvidenceClaimMark | undefined; status?: string; showMark?: boolean }) {
  return (
    <div className="text-caption text-text-3">
      {quote && <blockquote className="border-l-2 border-border pl-3 text-ui text-text-2">“{quote}”</blockquote>}
      <p className="mt-1">
        {showMark && <ClaimMark mark={mark} />}
        来源 {index}
        <EvidenceReferences evidence={evidence} indexes={[index]} />
        {mark === "⚠" && status && CLAIM_STATUS_TEXT[status] && <span className="ml-2 text-verify-pending">{CLAIM_STATUS_TEXT[status]}</span>}
      </p>
    </div>
  );
}

/** The reader's latest challenge on a claim, when they have made one. */
const latestChallenge = (challenges: EvidenceChallengeView[], claimId: string) =>
  challenges.filter((challenge) => challenge.claimId === claimId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;

/** The sources a claim names, whatever its type: the direct quotation's, a synthesis's each. */
export function claimSourceIndexes(claim: EvidenceClaim): number[] {
  const own = claim.sourceIndexes ?? [];
  const bonds = (claim.supportingSources ?? []).map((bond) => bond.sourceIndex);
  return [...new Set([...own, ...bonds])];
}

/** A conclusion in the drawer: the statement, its mark, the quotation it stands on in each source, and the estimate's working. */
export function ClaimDetail({ evidence, claim, challenges }: { evidence: EvidenceCard; claim: EvidenceClaim; challenges?: EvidenceChallengeView[] }) {
  const verification = claim.verification;
  const type = claim.claimType ?? "direct";
  const statusOf = (index: number) => verification?.sources.find((entry) => entry.sourceIndex === index);
  return (
    <div className="space-y-4 text-ui leading-relaxed text-text-2" data-claim={claim.claimId}>
      <p className="whitespace-pre-wrap text-body text-text">
        <ClaimMark mark={verification?.mark} />
        {claim.text}
        {type === "derived" && <Tag className="ml-2">推导结果</Tag>}
        {type === "calculated" && <Tag className="ml-2">{EVIDENCE_CALCULATION_LABEL_ZH}</Tag>}
        {type === "synthesized" && <Tag className="ml-2">{`综合结论${claim.confidence ? ` · 把握程度${CONFIDENCE[claim.confidence]}` : ""}`}</Tag>}
      </p>
      {type === "direct" && claim.sourceIndexes?.[0] != null && (
        <Quote evidence={evidence} index={claim.sourceIndexes[0]} quote={claim.supportQuote} mark={verification?.mark} status={verification?.status} />
      )}
      {type === "synthesized" && claim.supportingSources?.map((bond) => (
        <Quote key={bond.sourceIndex} evidence={evidence} index={bond.sourceIndex} quote={bond.supportQuote} mark={statusOf(bond.sourceIndex)?.mark} status={statusOf(bond.sourceIndex)?.status} showMark />
      ))}
      {type === "derived" && (
        <div className="space-y-1 text-caption text-text-3">
          {claim.method && <p>方法：{claim.method}</p>}
          {claim.assumptions && <p>假设：{claim.assumptions}</p>}
          {claim.sensitivity && <p>敏感性：{claim.sensitivity}</p>}
        </div>
      )}
      {(claim.applicability || claim.uncertainty) && (
        <p className="text-caption text-text-3">{[claim.applicability && `适用：${claim.applicability}`, claim.uncertainty && `不确定性：${claim.uncertainty}`].filter(Boolean).join(" · ")}</p>
      )}
      {challenges && claim.claimId && (
        <div>
          <EvidenceChallenge cardId={evidence.id} claimId={claim.claimId} existing={latestChallenge(challenges, claim.claimId)} />
        </div>
      )}
    </div>
  );
}

/** A source in the drawer: where to read it, how much of it the card read, whether it has since been retracted, the excerpt, and what stands on it. */
export function SourceDetail({ source, citedBy, onOpenClaim }: {
  source: EvidenceCard["sources"][number];
  /** The conclusions that name this source, in the order the card lists them. */
  citedBy: ReadonlyArray<{ key: string; text: string }>;
  onOpenClaim: (key: string) => void;
}) {
  const url = safeUrl(source.url);
  const coverage = source.coverage ? COVERAGE_WORDS[source.coverage] : undefined;
  return (
    <div className="space-y-4 text-ui text-text-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-link hover:underline">
            打开原文<ArrowUpRight size={16} aria-hidden="true" />
          </a>
        )}
        {coverage && <span className="text-caption text-text-3">{coverage}</span>}
      </div>
      {source.publicationStatus && (
        <div className="space-y-1 text-caption text-warn">
          <p>{publicationLabel(source.publicationStatus.kind)} · 待核查对结论的影响</p>
          {source.publicationStatus.notices.map((notice, index) => <p key={index}>{notice}</p>)}
        </div>
      )}
      {source.excerpt && (
        <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3 text-ui leading-relaxed text-text-2">{source.excerpt}</blockquote>
      )}
      {citedBy.length > 0 && (
        <section aria-label="依据这个来源的结论">
          <h3 className="mb-1 text-ui font-semibold text-text">依据这个来源的结论 · {citedBy.length}</h3>
          <List divided label="依据这个来源的结论">
            {citedBy.map((entry) => (
              <ListRow key={entry.key} title={<span className="line-clamp-2">{entry.text}</span>} onOpen={() => onOpenClaim(entry.key)} />
            ))}
          </List>
        </section>
      )}
    </div>
  );
}
