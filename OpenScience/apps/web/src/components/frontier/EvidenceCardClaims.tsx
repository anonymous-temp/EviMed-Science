import { EVIDENCE_AI_STEP_LABELS_ZH } from "@evimed/domain";
import { Tag } from "@/components/ui/Tag";
import type { EvidenceCard, EvidenceClaim, EvidenceClaimMark } from "@/lib/evidenceZoneClient";
import { EvidenceReferences } from "./EvidenceContent";
import { evidenceDate } from "./evidenceDate";

/** What a ⚠ means for one quotation, in a sentence. */
const STATUS_TEXT: Record<string, string> = {
  quote_not_found: "来源里没有找到这段引文",
  source_unavailable: "来源原文不可用，无法核对",
  no_quote: "没有附引文，无法核对",
  author_excerpt_only: "摘录由作者提供，平台未读取原文",
};
const CONFIDENCE: Record<string, string> = { high: "高", moderate: "中", low: "低" };

function Mark({ mark }: { mark: EvidenceClaimMark | undefined }) {
  if (mark === "✓") return <span className="mr-1 text-verify-ok" aria-label="已核验">✓</span>;
  if (mark === "⚠") return <span className="mr-1 text-verify-pending" aria-label="未能核验">⚠</span>;
  return null;
}

/** One quotation and where it is from. A synthesis shows a mark for each of its sources; a direct claim's mark is the claim's own, shown once. */
function Quote({ evidence, index, quote, mark, status, showMark = false }: { evidence: EvidenceCard; index: number; quote?: string; mark: EvidenceClaimMark | undefined; status?: string; showMark?: boolean }) {
  return (
    <div className="mt-1 text-caption text-text-3">
      {quote && <blockquote className="border-l-2 border-border pl-3">“{quote}”</blockquote>}
      <p className="mt-1">
        {showMark && <Mark mark={mark} />}
        来源 {index}
        <EvidenceReferences evidence={evidence} indexes={[index]} />
        {mark === "⚠" && status && STATUS_TEXT[status] && <span className="ml-2 text-verify-pending">{STATUS_TEXT[status]}</span>}
      </p>
    </div>
  );
}

function ClaimItem({ evidence, claim }: { evidence: EvidenceCard; claim: EvidenceClaim }) {
  const verification = claim.verification;
  const type = claim.claimType ?? "direct";
  const statusOf = (index: number) => verification?.sources.find((entry) => entry.sourceIndex === index);
  return (
    <li className="text-ui leading-relaxed text-text-2" data-claim={claim.claimId}>
      <p className="whitespace-pre-wrap">
        <Mark mark={verification?.mark} />
        {claim.text}
        {type === "derived" && <Tag className="ml-2">推导结果</Tag>}
        {type === "synthesized" && <Tag className="ml-2">{`综合结论${claim.confidence ? ` · 把握程度${CONFIDENCE[claim.confidence]}` : ""}`}</Tag>}
      </p>
      {type === "direct" && claim.sourceIndexes?.[0] != null && (
        <Quote evidence={evidence} index={claim.sourceIndexes[0]} quote={claim.supportQuote} mark={verification?.mark} status={verification?.status} />
      )}
      {type === "synthesized" && claim.supportingSources?.map((bond) => (
        <Quote key={bond.sourceIndex} evidence={evidence} index={bond.sourceIndex} quote={bond.supportQuote} mark={statusOf(bond.sourceIndex)?.mark} status={statusOf(bond.sourceIndex)?.status} showMark />
      ))}
      {type === "derived" && (
        <div className="mt-1 space-y-1 text-caption text-text-3">
          {claim.method && <p>方法：{claim.method}</p>}
          {claim.assumptions && <p>假设：{claim.assumptions}</p>}
          {claim.sensitivity && <p>敏感性：{claim.sensitivity}</p>}
        </div>
      )}
      {(claim.applicability || claim.uncertainty) && (
        <p className="mt-1 text-caption text-text-3">{[claim.applicability && `适用：${claim.applicability}`, claim.uncertainty && `不确定性：${claim.uncertainty}`].filter(Boolean).join(" · ")}</p>
      )}
    </li>
  );
}

/**
 * The card's claims, each with ✓ (its quotation was found in the source it names) or ⚠ (not found, or not checkable) and
 * the quotation beside it. A claim from an older card — a statement and nothing else — is shown as a plain line.
 */
export function EvidenceClaims({ evidence }: { evidence: EvidenceCard }) {
  if (!evidence.claims.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-ui font-medium text-text">证据要点</h3>
      <ul className="space-y-3">
        {evidence.claims.map((claim, index) => claim.claimId
          ? <ClaimItem key={claim.claimId} evidence={evidence} claim={claim} />
          : <li key={index} className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">{claim.text}</li>)}
      </ul>
    </section>
  );
}

/** How the card was made and who stands behind it: model, dates, the steps an AI took, authors and reviewers. */
export function EvidenceDisclosure({ evidence }: { evidence: EvidenceCard }) {
  const disclosure = evidence.disclosure;
  if (!disclosure) return null;
  const people = (list: Array<{ name: string; affiliation?: string; title?: string }>) => list.map((person) => [person.name, person.title, person.affiliation].filter(Boolean).join("，")).join("；");
  const steps = disclosure.aiSteps.map((step) => (EVIDENCE_AI_STEP_LABELS_ZH as Record<string, string>)[step] ?? step).join("、");
  const rows: Array<[string, string]> = [];
  if (disclosure.model) rows.push(["AI 模型", `${disclosure.model}${disclosure.modelVersion ? ` ${disclosure.modelVersion}` : ""}`]);
  if (steps) rows.push(["AI 做了", steps]);
  if (disclosure.generatedAt) rows.push(["生成于", evidenceDate(disclosure.generatedAt)]);
  if (disclosure.lastCheckedAt) rows.push(["最后核对", evidenceDate(disclosure.lastCheckedAt)]);
  if (disclosure.authors.length) rows.push(["作者", people(disclosure.authors)]);
  if (disclosure.reviewers.length) rows.push(["审核", people(disclosure.reviewers)]);
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-ui font-medium text-text">披露</h3>
      <dl className="space-y-1 text-ui text-text-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4">
            <dt className="w-20 shrink-0 text-text-3">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
