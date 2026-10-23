import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router";
import { EVIDENCE_PRODUCER_KIND_LABELS_ZH, EVIDENCE_PRODUCER_RELATION_LABELS_ZH, EVIDENCE_ZONE_KIND_LABELS_ZH } from "@evimed/domain";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierBack, evidenceFromState } from "@/components/frontier/FrontierBack";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { FactList, type Fact } from "@/components/ui/FactList";
import { List, ListRow } from "@/components/ui/ListRow";
import type { TabItem } from "@/components/ui/Tabs";
import { Note } from "@/components/ui/Note";
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
  // What the page knows of the author, as the one key / value list: the producer, the people their cards name, and the record in numbers.
  const facts: Fact[] = author
    ? [
        ...(author.producer ? [{
          label: "出品方",
          value: [
            `${EVIDENCE_PRODUCER_KIND_LABELS_ZH[author.producer.kind]} ${author.producer.name}`,
            (EVIDENCE_PRODUCER_RELATION_LABELS_ZH as Record<string, string>)[author.producer.relation],
            author.producer.products.length > 0 ? `（${author.producer.products.join("、")}）` : null,
          ].filter(Boolean).join(" · ").replace(" · （", "（"),
        }] : []),
        ...(author.people && author.people.length > 0 ? [{
          label: "署名",
          value: author.people.map((person) => [person.name, person.affiliation, person.title].filter(Boolean).join("，")).join("；"),
        }] : []),
        ...(stats.length > 0 ? [{ label: "概况", value: stats.join(" · ") }] : []),
      ]
    : [];
  const ready = !loading && !error && author;
  return (
    <PageShell
      title={author?.author.name ?? "作者"}
      className="frontier-theme"
      meta={author?.author.platform ? <Tag>平台出版方</Tag> : undefined}
      back={<FrontierBack to={from?.to} label={from?.label} />}
      // The author's three views and the card search are the page's one row of controls, over what they switch.
      toolbar={ready ? {
        label: "作者内容",
        views: { label: "作者的内容", panelId: "author-panel", items: tabs, value: view, onChange: (next) => setView(next as View) },
        search: view === "cards" && cards.length > FILTER_FROM
          ? { label: "搜索证据卡", value: filter, maxLength: 200, onChange: setFilter, onClear: () => setFilter("") }
          : undefined,
      } : undefined}
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
            {facts.length > 0 && <FactList rows={facts} />}
            {view === "cards" && (
              cards.length === 0 ? (
                <EmptyState title="暂无已发布的证据卡" />
              ) : shown.length === 0 ? (
                <EmptyState title="没有找到匹配的证据卡" action={<Button variant="secondary" onClick={() => setFilter("")}>显示全部证据卡</Button>} />
              ) : (
                <>
                  <List divided label="证据卡">
                    {shown.map((card) => (
                      <ListRow
                        key={card.id}
                        to={`/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`}
                        title={card.title}
                        meta={(
                          <>
                            {card.summary && <span className="line-clamp-2 max-w-measure text-ui leading-relaxed text-text-2">{card.summary}</span>}
                            <span className={card.summary ? "mt-1 block" : "block"}>{[card.claimCount > 0 ? `${card.claimCount} 条结论` : null, `更新于 ${evidenceDay(card.updatedAt)}`].filter(Boolean).join(" · ")}</span>
                          </>
                        )}
                      />
                    ))}
                  </List>
                  {author.totals.cards > cards.length && !filter.trim() && (
                    <Note result={[`共 `, { n: author.totals.cards }, ` 张，这里列出最近的 `, { n: cards.length }, ` 张。`]} className="pt-3" />
                  )}
                </>
              )
            )}
            {view === "zones" && (
              author.zones.length === 0 ? (
                <EmptyState title="暂无公开的专区" />
              ) : (
                <List divided label="专区">
                  {author.zones.map((zone) => (
                    <ListRow
                      key={zone.id}
                      to={`/app/frontier/zones/${encodeURIComponent(zone.id)}`}
                      title={zone.title}
                      meta={[EVIDENCE_ZONE_KIND_LABELS_ZH[zone.kind], zone.evidenceCount > 0 ? `${zone.evidenceCount} 条证据` : "暂无证据", zone.follows > 0 ? `${zone.follows} 人关注` : null].filter(Boolean).join(" · ")}
                    />
                  ))}
                </List>
              )
            )}
            {view === "changes" && (
              <List divided label="最近变更">
                {(author.changes ?? []).map((change, index) => (
                  <ListRow
                    key={change.id ?? index}
                    title={<span className="font-normal text-text-2">{change.summary ?? change.categoryLabel}</span>}
                    meta={change.occurredAt ? evidenceDay(change.occurredAt) : undefined}
                  />
                ))}
              </List>
            )}
          </div>
        )
      )}
    </PageShell>
  );
}
