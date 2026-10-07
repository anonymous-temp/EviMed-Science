import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { EVIDENCE_PRODUCER_KIND_LABELS_ZH, EVIDENCE_PRODUCER_RELATION_LABELS_ZH, EVIDENCE_ZONE_KIND_LABELS_ZH } from "@evimed/domain";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { evidenceDay } from "@/components/frontier/evidenceDate";
import { evidenceErrorMessage, fetchEvidenceAuthor, type EvidenceAuthorPage as Author } from "@/lib/evidenceZoneClient";
import { WebApiError } from "@/lib/apiClient";

type View = "cards" | "zones" | "changes";

const NO_CARDS: Author["cards"] = [];

/** A card list longer than this offers a title filter: shorter than that it is faster to read than to search. */
const FILTER_FROM = 8;

/**
 * One author's page (`/app/frontier/authors/:authorId`, the author's public handle): their published cards, their zones, and the changes
 * made lately — three views of one record, on tabs, with the cards first. Under the name, what the author has to show: cards, the accounts
 * that follow their zones, and how many times other accounts' research started from their cards — the only citation signal there is, and named
 * for what it is; a number that is zero is left out. No ranking, no comparison with anyone: the page is one author's own record. An author
 * with nothing published has no page. The way back names the page the reader came from when a link says so (`evidenceFrom`), a card's
 * author link says its card.
 */
export function EvidenceAuthorPage() {
  const { authorId = "" } = useParams();
  return <EvidenceAuthorContent key={authorId} authorId={authorId} />;
}

function EvidenceAuthorContent({ authorId }: { authorId: string }) {
  const from = evidenceFromState(useLocation().state);
  const [author, setAuthor] = useState<Author | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>("cards");
  const [filter, setFilter] = useState("");
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
  const cards = author?.cards ?? NO_CARDS;
  const shown = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return text ? cards.filter((card) => card.title.toLowerCase().includes(text)) : cards;
  }, [cards, filter]);
  const tabs: TabItem<View>[] = author
    ? [
        { value: "cards", label: "证据卡", count: author.cards.length || undefined },
        { value: "zones", label: "专区", count: author.zones.length || undefined },
        ...(author.changes && author.changes.length > 0 ? [{ value: "changes" as const, label: "最近变更" }] : []),
      ]
    : [];
  const stats = author
    ? [
        author.totals.cards > 0 ? `${author.totals.cards} 张证据卡` : null,
        author.totals.followers > 0 ? `${author.totals.followers} 人关注` : null,
        author.totals.runsFromCards > 0 ? `${author.totals.runsFromCards} 次研究从这里开始` : null,
      ].filter(Boolean)
    : [];
  return (
    <PageShell
      title={author?.author.name ?? "作者"}
      meta={author?.author.platform ? <Tag>平台出版方</Tag> : undefined}
      back={<FrontierBack to={from?.to} label={from?.label} />}
    >
      {loading ? (
        <FrontierSkeleton />
      ) : error ? (
        <EmptyState
          title={error.missing ? "这位作者还没有公开的内容" : error.message}
          action={error.missing ? undefined : <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>重试</Button>}
        />
      ) : (
        author && (
          <div className="space-y-6">
            <header className="space-y-2">
              {author.producer && (
                <p className="text-ui text-text-2">
                  出品方：{EVIDENCE_PRODUCER_KIND_LABELS_ZH[author.producer.kind]} {author.producer.name}
                  {(EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[author.producer.relation] && `。${(EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[author.producer.relation]}`}
                  {author.producer.products.length > 0 && `（${author.producer.products.join("、")}）`}
                </p>
              )}
              {author.people && author.people.length > 0 && (
                <p className="text-ui text-text-2">
                  卡片里署名的作者和审核人：{author.people.map((person) => [person.name, person.affiliation, person.title].filter(Boolean).join("，")).join("；")}
                </p>
              )}
              {stats.length > 0 && <p className="text-ui text-text-2">{stats.join(" · ")}</p>}
            </header>
            <div>
              <Tabs
                label="作者的内容"
                panelId="author-panel"
                items={tabs}
                value={view}
                onChange={setView}
                trailing={
                  view === "cards" && cards.length > FILTER_FROM ? (
                    <SearchInput
                      label="搜索证据卡"
                      size="sm"
                      value={filter}
                      maxLength={200}
                      onChange={(event) => setFilter(event.target.value)}
                      onClear={() => setFilter("")}
                    />
                  ) : undefined
                }
              />
              <div id="author-panel" role="tabpanel" className="mt-2">
                {view === "cards" && (
                  cards.length === 0 ? (
                    <p className="py-4 text-ui text-text-3">暂无已发布的证据卡。</p>
                  ) : shown.length === 0 ? (
                    <p className="py-4 text-ui text-text-3">没有找到匹配的证据卡。</p>
                  ) : (
                    <>
                      <ul className="divide-y divide-border">
                        {shown.map((card) => (
                          <li key={card.id} className="py-3">
                            <Link className="text-ui font-medium text-text hover:text-accent" to={`/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`}>{card.title}</Link>
                            {card.summary && <p className="mt-1 line-clamp-2 max-w-measure text-ui text-text-2">{card.summary}</p>}
                            <p className="mt-1 text-caption text-text-3">{[card.claimCount > 0 ? `${card.claimCount} 条结论` : null, `更新于 ${evidenceDay(card.updatedAt)}`].filter(Boolean).join(" · ")}</p>
                          </li>
                        ))}
                      </ul>
                      {author.totals.cards > cards.length && !filter.trim() && (
                        <p className="pt-3 text-caption text-text-3">共 {author.totals.cards} 张，这里列出最近的 {cards.length} 张。</p>
                      )}
                    </>
                  )
                )}
                {view === "zones" && (
                  author.zones.length === 0 ? (
                    <p className="py-4 text-ui text-text-3">暂无公开的专区。</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {author.zones.map((zone) => (
                        <li key={zone.id} className="py-3">
                          <Link className="text-ui font-medium text-text hover:text-accent" to={`/app/frontier/zones/${encodeURIComponent(zone.id)}`}>{zone.title}</Link>
                          <p className="mt-1 text-caption text-text-3">
                            {[EVIDENCE_ZONE_KIND_LABELS_ZH[zone.kind], zone.evidenceCount > 0 ? `${zone.evidenceCount} 条证据` : "暂无证据", zone.follows > 0 ? `${zone.follows} 人关注` : null].filter(Boolean).join(" · ")}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )
                )}
                {view === "changes" && (
                  <ul className="space-y-1 py-2">
                    {(author.changes ?? []).map((change, index) => (
                      <li key={change.id ?? index} className="text-ui text-text-2">
                        {change.occurredAt && <span className="text-text-3">{evidenceDay(change.occurredAt)} · </span>}
                        {change.summary ?? change.categoryLabel}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )
      )}
    </PageShell>
  );
}
