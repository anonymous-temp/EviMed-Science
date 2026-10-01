import { Button } from "@/components/ui/Button";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import {
  EvidenceContent,
  EvidenceReferences,
  evidenceSourceId,
} from "./EvidenceContent";

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

export const evidenceDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
/** Only omit an exact repeated answer; additional authored prose remains visible. */
const redundantBody = (evidence: EvidenceCard) =>
  !!evidence.content &&
  evidence.body.trim() === evidence.content.answer?.trim();
export const evidenceReviewLabel = (evidence: EvidenceCard) =>
  !evidence.editorial
    ? null
    : evidence.editorial.status === "ai-reviewed" &&
        evidence.editorial.reviewRevision === evidence.revision &&
        evidence.editorial.reviewer
      ? "AI 已评议"
      : "AI 待评议";
export function EvidenceReading({
  evidence,
  onDeleteComment,
}: {
  evidence: EvidenceCard;
  onDeleteComment?: (id: string) => void;
}) {
  return (
    <article className="min-w-0 max-w-measure-body space-y-6 break-words">
      <header className="space-y-2">
        {evidence.subtype && (
          <p className="text-caption text-text-3">
            {evidence.subtype === "academic"
              ? "学术证据"
              : evidence.subtype === "knowledge"
                ? "知识证据卡片"
                : evidence.subtype}
          </p>
        )}
        <h2 className="text-section font-semibold text-text">
          {evidence.content?.question || evidence.title}
        </h2>
        <p className="text-caption text-text-3">
          {evidence.state === "draft" ? "草稿" : "已发布"}
          {evidence.createdAt && ` · ${evidenceDate(evidence.createdAt)}`}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-3">
          {evidence.editorial?.author ? (
            <span>
              {evidence.editorial.author.kind === "ai" ? "AI 编写" : "编写"} ·{" "}
              {evidence.editorial.author.name}
            </span>
          ) : (
            evidence.creator && <span>创作者 {evidence.creator}</span>
          )}
          {evidence.reviewer && <span>评议者 {evidence.reviewer}</span>}
          {evidenceReviewLabel(evidence) && (
            <span>{evidenceReviewLabel(evidence)}</span>
          )}
          {evidence.reviewedAt && (
            <span>评议于 {evidenceDate(evidence.reviewedAt)}</span>
          )}
        </div>
        {evidence.editorial?.sourceCheckedAt && (
          <p className="text-caption text-text-3">
            来源核查于 {evidenceDate(evidence.editorial.sourceCheckedAt)}
          </p>
        )}
        {evidence.editorial?.sourceChangedAt && (
          <p
            className={
              evidence.editorial.status === "review-pending"
                ? "text-caption text-warn"
                : "text-caption text-text-3"
            }
          >
            依据来源更新于 {evidenceDate(evidence.editorial.sourceChangedAt)}
            {evidence.editorial.status === "review-pending" && " · 等待复核"}
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
      {evidence.claims.length > 0 && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">证据要点</h3>
          <ul className="space-y-3">
            {evidence.claims.map((claim, index) => (
              <li
                key={index}
                className="whitespace-pre-wrap text-ui leading-relaxed text-text-2"
              >
                {claim.text}
              </li>
            ))}
          </ul>
        </section>
      )}
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
            {evidence.sources.map((source, index) => (
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
                      ` · 查阅于 ${evidenceDate(source.checkedAt)}`}
                  </p>
                )}
                {source.excerpt && (
                  <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-caption text-text-3">
                    {source.excerpt}
                  </blockquote>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {evidence.editorial && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">AI 证据评议</h3>
          <p className="text-caption text-text-3">
            {evidence.editorial.reviewer?.name || "待评议"}
            {evidence.editorial.reviewedAt &&
              ` · ${evidenceDate(evidence.editorial.reviewedAt)}`}
          </p>
          <p className="mt-2 text-ui text-text-2">
            {evidence.editorial.status === "ai-reviewed" &&
            evidence.editorial.reviewRevision === evidence.revision
              ? "当前内容已完成 AI 评议"
              : "当前内容待重新评议"}
          </p>
          {(evidence.editorial.findings?.length || 0) > 0 && (
            <ul className="mt-3 space-y-2">
              {evidence.editorial.findings?.map((finding, index) => (
                <li key={index} className="text-ui text-text-2">
                  {finding.text}
                  <EvidenceReferences
                    evidence={evidence}
                    indexes={finding.sourceIndex ? [finding.sourceIndex] : []}
                  />
                </li>
              ))}
            </ul>
          )}
          {!evidence.reviews?.some((entry) => entry.current) && (
            <p className="mt-2 text-caption text-text-3">
              尚无当前内容的用户评议
            </p>
          )}
          {(evidence.editorial.author.model ||
            evidence.editorial.reviewer?.model) && (
            <details className="mt-2 text-caption text-text-3">
              <summary className="cursor-pointer">编写与评议信息</summary>
              <div className="mt-2 space-y-1">
                {evidence.editorial.author.model && (
                  <p>编写模型 · {evidence.editorial.author.model}</p>
                )}
                {evidence.editorial.reviewer?.model && (
                  <p>评议模型 · {evidence.editorial.reviewer.model}</p>
                )}
              </div>
            </details>
          )}
        </section>
      )}
      {evidence.review && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">学术评议</h3>
          <p className="text-ui text-text-2">
            {evidence.review.label}
            {evidence.review.score !== null && (
              <span className="ml-2 tabular-nums">{evidence.review.score}</span>
            )}
          </p>
        </section>
      )}
      {evidence.reviews?.length ? (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">用户评议意见</h3>
          <ul className="space-y-3">
            {evidence.reviews.map((entry, index) => (
              <li key={index} className="text-ui text-text-2">
                <p className="text-caption text-text-3">
                  {entry.author} · {entry.score} / 5
                  {!entry.current && " · 历史版本"}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{entry.text}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {(evidence.revisions?.length || 0) > 1 && (
        <details>
          <summary className="cursor-pointer text-ui font-medium text-text">
            更新记录
          </summary>
          <ol className="mt-3 space-y-3">
            {evidence.revisions?.map((entry, index, entries) => (
              <li key={entry.revision} className="text-caption text-text-2">
                <p className="text-text-3">
                  {evidenceDate(entry.recordedAt)}
                  {index === 0 && " · 当前内容"}
                </p>
                <p className="mt-1">{entry.title}</p>
                {entries[index + 1] &&
                  entry.sourceFingerprint !==
                    entries[index + 1].sourceFingerprint && (
                    <p className="mt-1 text-text-3">依据来源有更新</p>
                  )}
              </li>
            ))}
          </ol>
        </details>
      )}
      <section>
        <h3 className="mb-2 text-ui font-medium text-text">讨论</h3>
        {evidence.discussion.length ? (
          <ul className="divide-y divide-border">
            {evidence.discussion.map((entry, index) => (
              <li key={index} className="py-3">
                <p className="text-caption text-text-3">
                  {entry.author}
                  {entry.createdAt && (
                    <span className="ml-3">
                      {evidenceDate(entry.createdAt)}
                    </span>
                  )}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-ui text-text-2">
                  {entry.text}
                </p>
                {entry.canDelete && entry.id && onDeleteComment && (
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => onDeleteComment(entry.id!)}
                  >
                    删除我的讨论
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui text-text-3">暂无讨论</p>
        )}
      </section>
    </article>
  );
}
