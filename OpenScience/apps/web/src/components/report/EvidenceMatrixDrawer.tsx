import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink, FileText } from "lucide-react";
import {
  CLAIM_STATUS_TEXT,
  claimCheckMark,
  claimGuidance,
  claimSources,
  claimTypeLabel,
  sourceCheckMark,
  sourceLocationText,
  type ClaimCheckMark,
  type ClaimCheckState,
  type ClaimEvidence,
  type ClaimSource,
} from "@/lib/claimCitations";
import { claimAppraisalDisplay } from "@/lib/claimAppraisal";
import { cn } from "@/lib/cn";
import { preservedSourceHref, type VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";
import { ClaimAppraisalSummary } from "@/components/markdown-viewer/ClaimAppraisal";
import { SourceUpdateBadges } from "@/components/markdown-viewer/SourceUpdateBadges";
import { StudyTypeBadge } from "@/components/markdown-viewer/StudyTypeBadge";
import { Drawer } from "@/components/ui/Drawer";

const ACCESS_LABEL: Record<string, string> = {
  full_text: "全文", official_page: "官方页面", abstract: "仅摘要", structured_record: "结构化记录",
};
const CONFIDENCE_LABEL: Record<string, string> = { high: "高", moderate: "中", low: "低" };
export const MARK_TONE_CLASS = { ok: "text-verify-ok", warn: "text-verify-pending", muted: "text-text-3" } as const;

/** The one sentence under a claim's mark: what the check found, or why there is nothing to say yet. */
function checkExplanation(claim: ClaimEvidence, check: VerifiedClaim | undefined, mark: ClaimCheckMark): string {
  if (check) return claimGuidance(claim, check) ?? CLAIM_STATUS_TEXT[String(check.status)]?.label ?? "这条结论还没有核对结果。";
  if (mark.kind === "derived") return CLAIM_STATUS_TEXT.derived.label;
  if (mark.kind === "checking") return "正在读取这条结论的核对结果。";
  if (mark.kind === "unavailable") return "这份报告的核对结果暂时读取不到，引文仍可逐条对照来源。";
  return "这条结论没有出现在核对结果里。";
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-caption text-text-3">{label}</h3>
      {children}
    </section>
  );
}

/**
 * One claim of the evidence matrix, in full (2026-10-07 audit K04): its
 * sentence and appraisal, every source with its own quotation, check and place
 * in the source, and what the check found. The matrix's rows only point here;
 * a reader compares the sentence with the quotation in this one panel.
 */
export function EvidenceMatrixDrawer({
  claim,
  check,
  verificationState,
  runId,
  onClose,
}: {
  claim: ClaimEvidence;
  check: VerifiedClaim | undefined;
  verificationState: ClaimCheckState;
  runId?: string | null;
  onClose: () => void;
}) {
  const sources = claimSources(claim);
  const mark = claimCheckMark(claim, check, verificationState);
  const appraisal = claimAppraisalDisplay(claim, check);
  const confidence = claim.confidence ? CONFIDENCE_LABEL[claim.confidence] ?? "未注明" : null;
  return (
    // The check is under the id, where it is seen before anything is scrolled: three quotations are a long panel.
    <Drawer
      title={claim.claimId}
      description={<span className={MARK_TONE_CLASS[mark.tone]}>{mark.text}</span>}
      onClose={onClose}
      widthClassName="max-w-2xl"
    >
      <div className="space-y-6">
        <Section label="内容">
          <p className="text-body text-text">{claim.claim}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-text-3">
            <span>{claimTypeLabel(claim.claimType)}</span>
            {claim.referenceNumber !== undefined && <span>文献 [{claim.referenceNumber}]</span>}
            {confidence && <span>把握度{confidence}</span>}
          </p>
          {appraisal && <ClaimAppraisalSummary display={appraisal} sourceCount={sources.length} />}
          {claim.claimType === "derived" && claim.method && <p className="text-caption text-text-3">方法：{claim.method}</p>}
          {claim.uncertainty && <p className="text-caption text-text-3">不确定性：{claim.uncertainty}</p>}
        </Section>

        <Section label="来源与引文">
          {sources.length === 0 ? (
            <p className="text-ui text-text-3">这条结论没有给出来源。</p>
          ) : (
            <ol className="space-y-5">
              {sources.map((source, index) => (
                <SourceBlock
                  key={index}
                  source={source}
                  index={index}
                  sourceCount={sources.length}
                  check={check?.sources[index]}
                  runId={runId}
                />
              ))}
            </ol>
          )}
        </Section>

        <Section label="核对">
          <p className="text-ui text-text-2">{checkExplanation(claim, check, mark)}</p>
        </Section>
      </div>
    </Drawer>
  );
}

function SourceBlock({ source, index, sourceCount, check, runId }: {
  source: ClaimSource;
  index: number;
  sourceCount: number;
  check: VerifiedClaim["sources"][number] | undefined;
  runId?: string | null;
}) {
  const place = sourceLocationText(check?.location);
  const own = check ? sourceCheckMark(check.status) : null;
  const href = source.sourceUrl && /^https?:\/\//i.test(source.sourceUrl) ? source.sourceUrl : null;
  return (
    <li data-quote-index={index} className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-1.5 text-caption text-text-3">
        <StudyTypeBadge sourceType={check?.sourceType ?? source.sourceType} />
        {source.accessLevel && ACCESS_LABEL[source.accessLevel] && <span>{ACCESS_LABEL[source.accessLevel]}</span>}
        <SourceUpdateBadges updates={check?.updates} updateStatus={check?.updateStatus} />
      </p>
      <p className="text-ui font-medium text-text">{source.sourceTitle ?? source.identifier ?? "来源未记录"}</p>
      {source.identifier && source.sourceTitle && <p className="break-all text-caption text-text-3">{source.identifier}</p>}
      {source.supportQuote ? (
        <blockquote className="border-l-2 border-strong pl-2 text-ui text-text">
          <mark className="bg-highlight text-text">“{source.supportQuote}”</mark>
        </blockquote>
      ) : (
        <p className="text-caption text-text-3">没有给出引文</p>
      )}
      {sourceCount > 1 && own && <p className={cn("text-caption", MARK_TONE_CLASS[own.tone])}>{own.text}</p>}
      {place && <p className="text-caption text-text-3" data-source-location>位置：{place}</p>}
      {source.supportQuote && runId && source.artifactPath ? (
        <Link
          to={preservedSourceHref(runId, source.artifactPath, source.supportQuote, source.resultVersionId)}
          className="inline-flex items-center gap-1 text-caption text-link hover:underline"
        >
          <FileText size={16} aria-hidden="true" />定位原文
        </Link>
      ) : href ? (
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-caption text-link hover:underline">
          <ExternalLink size={16} aria-hidden="true" />打开原始来源
        </a>
      ) : null}
    </li>
  );
}
