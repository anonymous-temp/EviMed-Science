import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import {
  EvidenceContent,
  EvidenceReferences,
  evidenceSourceId,
} from "./EvidenceContent";
import { EvidenceCardHeader } from "./EvidenceCardHeader";
import { EvidenceCardViews } from "./EvidenceCardViews";
import { EvidenceClaims, EvidenceDisclosure } from "./EvidenceCardClaims";
import { evidenceDate, evidenceDay } from "./evidenceDate";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";

/** Source text stays text: imported cards never supply HTML or navigation code. */
const safeUrl = (value: string | null) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

export { evidenceDate, evidenceDay };
/** Only omit an exact repeated answer; additional authored prose remains visible. */
const redundantBody = (evidence: EvidenceCard) =>
  !!evidence.content &&
  evidence.body.trim() === evidence.content.answer?.trim();
export const evidenceReviewLabel = (evidence: EvidenceCard) =>
  !evidence.editorial
    ? null
    : !evidence.sources.some(source=>source.publicationStatus) && evidence.editorial.status === "ai-reviewed" &&
        evidence.editorial.reviewRevision === evidence.revision &&
        evidence.editorial.reviewer
      ? "AI 已评议"
      : "AI 待评议";
/** The day the card last changed: its newest revision, else the day it was made. */
export const evidenceUpdatedAt = (evidence: Pick<EvidenceCard, "revisions" | "createdAt">) =>
  evidence.revisions?.[0]?.recordedAt ?? evidence.createdAt ?? null;

/**
 * Who wrote and checked the card, in the one fold under the answer — 「编写与核查」. A reader weighs a card by what it says and by its
 * labels, not by who typed it; the rest is here for the one who wants it. What is wrong or unfinished is not here but above, in
 * warning colour: a retraction, a source that was not re-read, a card waiting for its review.
 */
function EvidenceAuthoring({ evidence }: { evidence: EvidenceCard }) {
  const editorial = evidence.editorial;
  const lines: string[] = [];
  if (editorial?.author) lines.push(`${editorial.author.kind === "ai" ? "AI 编写" : "编写"} · ${editorial.author.name}`);
  else if (evidence.creator) lines.push(`创作者 ${evidence.creator}`);
  if (editorial?.lastEditor) lines.push(`用户修订记录 · ${editorial.lastEditor.name} · ${evidenceDay(editorial.lastEditor.editedAt)}`);
  if (evidence.reviewer) lines.push(`评议者 ${evidence.reviewer}`);
  if (evidenceReviewLabel(evidence)) lines.push(evidenceReviewLabel(evidence)!);
  if (evidence.reviewedAt) lines.push(`评议于 ${evidenceDay(evidence.reviewedAt)}`);
  if (editorial?.sourceCheckedAt) lines.push(`全部来源上次核查于 ${evidenceDay(editorial.sourceCheckedAt)}`);
  // A source change that left the card waiting for its review is above, as a warning; the same fact, settled, is a line here.
  if (editorial?.sourceChangedAt && editorial.status !== "review-pending") lines.push(`依据来源更新于 ${evidenceDay(editorial.sourceChangedAt)}`);
  const disclosure = evidence.disclosure;
  const hasDisclosure = !!disclosure && (disclosure.aiSteps.length > 0 || !!disclosure.generatedAt || !!disclosure.lastCheckedAt || disclosure.authors.length > 0 || disclosure.reviewers.length > 0);
  if (!lines.length && !hasDisclosure) return null;
  return (
    <Disclosure summary="编写与核查" className="min-w-0 flex-1 open:basis-full">
      <div className="space-y-4">
        {lines.length > 0 && (
          <ul className="space-y-1 text-caption text-text-3">
            {lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
        <EvidenceDisclosure evidence={evidence} />
      </div>
    </Disclosure>
  );
}

export function EvidenceReading({
  evidence,
  challenges,
  afterAnswer,
}: {
  evidence: EvidenceCard;
  /** The reader's own challenges on this card; given (even empty), each claim offers 「质疑」. Absent where the deployment keeps no upkeep. */
  challenges?: EvidenceChallengeView[];
  /** The action that goes with the answer — 「用这张卡继续研究」 — set beside 「编写与核查」 directly under it. */
  afterAnswer?: ReactNode;
}) {
  const retainedSources = evidence.editorial?.sourceChecks?.filter(
    (check) => check.status === "retained",
  ) || [];
  const publicationSources = evidence.sources.flatMap((source,index)=>source.publicationStatus ? [{source,index:index+1}] : []);
  const publicationLabel = (kind: "retracted" | "corrected" | "concern") => kind === "retracted" ? "存在撤稿记录" : kind === "concern" ? "存在关注声明" : "存在更正记录";
  return (
    <article className="min-w-0 max-w-measure-body space-y-6 break-words">
      <header className="space-y-2">
        <EvidenceCardHeader evidence={evidence} updatedAt={evidenceUpdatedAt(evidence)} />
        {publicationSources.length > 0 && (
          <div role="alert" className="space-y-2 text-ui text-warn">
            <p>来源状态有警示，原有结论需要重新核查。以下内容保留供追溯，不能作为已完成核验的临床或科研依据。</p>
            {publicationSources.map(({source,index})=><p key={index}>{publicationLabel(source.publicationStatus!.kind)}<EvidenceReferences evidence={evidence} indexes={[index]} /></p>)}
          </div>
        )}
        {retainedSources.length > 0 && (
          <p className="text-caption text-warn">
            部分来源本轮尚未完成复核，沿用上次保留内容。
            <EvidenceReferences
              evidence={evidence}
              indexes={retainedSources.map((check) => check.sourceIndex)}
            />
          </p>
        )}
        {evidence.editorial?.sourceChangedAt && evidence.editorial.status === "review-pending" && (
          <p className="text-caption text-warn">
            依据来源更新于 {evidenceDay(evidence.editorial.sourceChangedAt)} · 等待复核
          </p>
        )}
      </header>
      {(evidence.content?.answer || evidence.summary) && (
        <section className="rounded-card bg-accent-soft p-4">
          <h3 className="mb-2 text-ui font-medium text-text">核心回答</h3>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
            {evidence.content?.answer || evidence.summary}
          </p>
        </section>
      )}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 empty:hidden">
        {afterAnswer}
        <EvidenceAuthoring evidence={evidence} />
      </div>
      <EvidenceCardViews evidence={evidence} />
      <EvidenceContent evidence={evidence} />
      {evidence.body && !redundantBody(evidence) && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">
            {evidence.content ? "补充说明" : "证据正文"}
          </h3>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
            {evidence.body}
          </p>
        </section>
      )}
      <EvidenceClaims evidence={evidence} challenges={challenges} />
      {evidence.limitations && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">适用范围与局限</h3>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
            {evidence.limitations}
          </p>
        </section>
      )}
      {evidence.content?.nextStep && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">下一步怎么用</h3>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
            {evidence.content.nextStep}
          </p>
        </section>
      )}
      {evidence.sources.length > 0 && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">来源与引用</h3>
          <ol className="space-y-3">
            {evidence.sources.map((source, index) => {
              const sourceCheck = evidence.editorial?.sourceChecks?.find(
                (check) => check.sourceIndex === index + 1,
              );
              const deferred = sourceCheck?.code === "evidence_source_check_deferred";
              const missingUrl = sourceCheck?.code === "evidence_source_url_missing";
              return (
                <li
                  id={evidenceSourceId(evidence.id, index + 1)}
                  key={index}
                  className="scroll-mt-4 text-ui text-text-2"
                >
                  <span className="mr-2 text-text-3">[{index + 1}]</span>
                  {safeUrl(source.url) ? (
                    <a
                      href={safeUrl(source.url) || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                  {(source.coverage || source.checkedAt) && (
                    <p className="mt-1 text-caption text-text-3">
                      {source.coverage === "full-text"
                        ? "依据全文"
                        : source.coverage === "abstract"
                          ? "依据摘要"
                          : source.coverage === "excerpt"
                            ? "依据原文片段"
                            : ""}
                      {source.checkedAt &&
                        ` · 上次成功读取于 ${evidenceDay(source.checkedAt)}`}
                    </p>
                  )}
                  {source.publicationStatus && (
                    <div className="mt-2 space-y-1 text-caption text-warn">
                      <p>{publicationLabel(source.publicationStatus.kind)} · 待核查对结论的影响</p>
                      {source.publicationStatus.notices.map((notice,noticeIndex)=><p key={noticeIndex}>{notice}</p>)}
                    </div>
                  )}
                  {sourceCheck?.status === "retained" && (
                    <p className="mt-1 text-caption text-warn">
                      {deferred
                        ? "本轮尚未核查"
                        : missingUrl
                          ? "缺少原文链接"
                          : "本轮未能重新读取"}
                      ，沿用上次保留内容
                      {` · ${deferred || missingUrl ? "记录于" : "尝试于"} ${evidenceDay(sourceCheck.attemptedAt)}`}
                    </p>
                  )}
                  {source.excerpt && (
                    <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-caption text-text-3">
                      {source.excerpt}
                    </blockquote>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </article>
  );
}
