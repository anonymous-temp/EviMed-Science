import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { EVIDENCE_ZONE_KIND_LABELS_ZH } from "@evimed/domain";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierNavigation } from "@/components/frontier/FrontierNavigation";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { evidenceDate } from "@/components/frontier/evidenceDate";
import { evidenceErrorMessage, fetchEvidenceAuthor, type EvidenceAuthorPage as Author } from "@/lib/evidenceZoneClient";
import { WebApiError } from "@/lib/apiClient";

/**
 * One author's page (`/app/frontier/authors/:authorId`, the author's public handle): their published zones and cards, the accounts that follow their zones,
 * and how many times other accounts' research started from their cards — the only citation signal there is, and named for
 * what it is. No ranking, no comparison with anyone: the page is one author's own record. An author with nothing published
 * has no page.
 */
export function EvidenceAuthorPage() {
  const { authorId = "" } = useParams();
  return <EvidenceAuthorContent key={authorId} authorId={authorId} />;
}

function EvidenceAuthorContent({ authorId }: { authorId: string }) {
  const [author, setAuthor] = useState<Author | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchEvidenceAuthor(authorId)
      .then((page) => { if (active) setAuthor(page); })
      .catch((reason) => { if (active) setError({ message: evidenceErrorMessage(reason), missing: reason instanceof WebApiError && reason.status === 404 && reason.code === "evidence_author_not_found" }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authorId, attempt]);
  return (
    <PageShell title="前沿动态">
      <FrontierNavigation active="zones" />
      {loading ? (
        <FrontierSkeleton />
      ) : error ? (
        <EmptyState
          title={error.missing ? "这位作者还没有公开的内容" : error.message}
          action={error.missing ? undefined : <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>重试</Button>}
        />
      ) : (
        author && (
          <div className="mt-4 space-y-6">
            <header className="space-y-2">
              <h2 className="text-section font-semibold text-text">
                {author.author.name}
                {author.author.platform && <Tag className="ml-2">平台出版方</Tag>}
              </h2>
              <p className="text-ui text-text-2">
                {author.totals.cards} 张已发布证据卡 · {author.totals.followers} 位关注者 · 别人的研究由这位作者的卡片发起了 {author.totals.runsFromCards} 次
              </p>
            </header>
            <section aria-label="专区">
              <h3 className="mb-2 text-ui font-medium text-text">专区</h3>
              <ul className="divide-y divide-border">
                {author.zones.map((zone) => (
                  <li key={zone.id} className="py-3">
                    <Link className="text-ui font-medium text-text hover:text-accent" to={`/app/frontier/zones/${encodeURIComponent(zone.id)}`}>{zone.title}</Link>
                    <p className="mt-1 text-caption text-text-3">
                      {EVIDENCE_ZONE_KIND_LABELS_ZH[zone.kind]} · {zone.evidenceCount} 条证据 · {zone.follows} 人关注
                    </p>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-label="证据卡">
              <h3 className="mb-2 text-ui font-medium text-text">证据卡</h3>
              {author.cards.length === 0 ? (
                <p className="text-ui text-text-3">暂无已发布的证据卡。</p>
              ) : (
                <ul className="divide-y divide-border">
                  {author.cards.map((card) => (
                    <li key={card.id} className="py-3">
                      <Link className="text-ui font-medium text-text hover:text-accent" to={`/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`}>{card.title}</Link>
                      {card.summary && <p className="mt-1 line-clamp-2 max-w-measure text-ui text-text-2">{card.summary}</p>}
                      <p className="mt-1 text-caption text-text-3">{card.claimCount} 条结论 · 更新于 {evidenceDate(card.updatedAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {author.changes && author.changes.length > 0 && (
              <section aria-label="最近的变更">
                <h3 className="mb-2 text-ui font-medium text-text">最近的变更</h3>
                <ul className="space-y-1">
                  {author.changes.map((change, index) => (
                    <li key={change.id ?? index} className="text-ui text-text-2">
                      {change.occurredAt && <span className="text-text-3">{evidenceDate(change.occurredAt)} · </span>}
                      {change.summary ?? change.categoryLabel}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )
      )}
    </PageShell>
  );
}
