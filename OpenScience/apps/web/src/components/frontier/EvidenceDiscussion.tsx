import { Button } from "@/components/ui/Button";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { EvidenceReferences } from "./EvidenceContent";
import { evidenceDay } from "./evidenceDate";

/**
 * What a card's readers and reviewers have said about it — the AI's review of it, the scholarly score, the written opinions of
 * accounts, and the discussion — kept out of the article: the reading page folds it under 「评议与讨论（N）」, and the forms to
 * add to it sit in the same fold. The reading is the card; this is what people made of it.
 */

/** How many things the fold holds, for its name: the written reviews and the comments. */
export const evidenceDiscussionCount = (evidence: Pick<EvidenceCard, "reviews" | "discussion">) =>
  (evidence.reviews?.length ?? 0) + evidence.discussion.length;

/**
 * The AI's findings about the card are content, and stay under their heading. Who the AI reviewer was, when it read the card and whether
 * its review is current are the pipeline's bookkeeping, and are not said (owner ruling 2026-10-10). The line that no reader has reviewed
 * the current content is about the readers, and stays.
 */
export function EvidenceReviews({ evidence }: { evidence: EvidenceCard }) {
  const editorial = evidence.editorial;
  const findings = editorial?.findings ?? [];
  return (
    <>
      {findings.length > 0 && (
        <section>
          <h3 className="mb-2 text-ui font-medium text-text">AI 证据评议</h3>
          <ul className="space-y-2">
            {findings.map((finding, index) => (
              <li key={index} className="text-ui text-text-2">
                {finding.text}
                <EvidenceReferences
                  evidence={evidence}
                  indexes={finding.sourceIndex ? [finding.sourceIndex] : []}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {editorial && !evidence.reviews?.some((entry) => entry.current) && (
        <p className="text-caption text-text-3">尚无当前内容的用户评议</p>
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
    </>
  );
}

export function EvidenceDiscussionList({
  evidence,
  onDeleteComment,
}: {
  evidence: EvidenceCard;
  onDeleteComment?: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-ui font-medium text-text">讨论</h3>
      {evidence.discussion.length ? (
        <ul className="divide-y divide-border">
          {evidence.discussion.map((entry, index) => (
            <li key={index} className="py-3">
              <p className="text-caption text-text-3">
                {entry.author}
                {entry.createdAt && (
                  <span className="ml-3">{evidenceDay(entry.createdAt)}</span>
                )}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-ui text-text-2">{entry.text}</p>
              {entry.canDelete && entry.id && onDeleteComment && (
                <Button variant="text" size="sm" onClick={() => onDeleteComment(entry.id!)}>
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
  );
}

/** The card's own revisions, newest first; nothing to say while there is only the one. */
export function EvidenceRevisions({ evidence }: { evidence: EvidenceCard }) {
  const revisions = evidence.revisions ?? [];
  if (revisions.length < 2) return null;
  return (
    <ol className="space-y-3">
      {revisions.map((entry, index, entries) => (
        <li key={entry.revision} className="text-caption text-text-2">
          <p className="text-text-3">
            {evidenceDay(entry.recordedAt)}
            {index === 0 && " · 当前内容"}
          </p>
          <p className="mt-1">{entry.title}</p>
          {entries[index + 1] &&
            entry.sourceFingerprint !== entries[index + 1].sourceFingerprint && (
              <p className="mt-1 text-text-3">依据来源有更新</p>
            )}
        </li>
      ))}
    </ol>
  );
}
