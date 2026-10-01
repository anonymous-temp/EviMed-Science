import { Button } from "@/components/ui/Button";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";

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
export function EvidenceReading({
  evidence,
  onDeleteComment,
}: {
  evidence: EvidenceCard;
  onDeleteComment?: (id: string) => void;
}) {
  return (
    <article className="space-y-6 max-w-measure-body">
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
          {evidence.title}
        </h2>
        <p className="text-caption text-text-3">
          {evidence.state === "draft" ? "草稿" : "已发布"}
          {evidence.createdAt && ` · ${evidenceDate(evidence.createdAt)}`}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-3">
          {evidence.creator && <span>创作者 {evidence.creator}</span>}
          {evidence.reviewer && <span>评议者 {evidence.reviewer}</span>}
          {evidence.reviewedAt && (
            <span>评议于 {evidenceDate(evidence.reviewedAt)}</span>
          )}
        </div>
      </header>
      {evidence.summary && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">摘要</h3>
          <p className="whitespace-pre-wrap text-ui leading-relaxed text-text-2">
            {evidence.summary}
          </p>
        </section>
      )}
      {evidence.body && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">证据正文</h3>
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
      {evidence.sources.length > 0 && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">来源与引用</h3>
          <ol className="space-y-3">
            {evidence.sources.map((source, index) => (
              <li key={index} className="text-ui text-text-2">
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
          <h3 className="mb-2 text-ui font-medium text-text">评议意见</h3>
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
