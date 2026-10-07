import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { WebApiError } from "@/lib/apiClient";
import { fetchEvidenceCommunity, type EvidenceCommunityCard } from "@/lib/evidenceCommunityClient";

const cardPath = (card: Pick<EvidenceCommunityCard, "zoneId" | "id">) => `/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`;

/** What the readers' marks say about a card, in the words the rest of the evidence pages use. */
function standing(card: EvidenceCommunityCard): string {
  const parts: string[] = [];
  if (card.claims.total > 0) parts.push(`${card.claims.verified}/${card.claims.total} 条结论已在来源里核对到原文`);
  if (card.reviewScore !== null) parts.push(`读者评分 ${card.reviewScore}（${card.reviews} 人）`);
  return parts.join(" · ");
}

/**
 * 社区卡片 — other users' public cards on the same subjects as an official zone, signed with their author and read-only: the platform does not
 * edit them, rank them by anything but how many of their claims were found in their sources and how readers scored them, or vouch for them.
 * Only authors with three published cards that each carry a ✓ appear (the server's rule). Quiet where there is nothing to show: a deployment that has
 * not switched the column on, a zone with no such cards, and a read that fails (said once, with a retry) never replace the zone.
 */
export function EvidenceCommunityCards({ zoneId }: { zoneId: string }) {
  const [items, setItems] = useState<EvidenceCommunityCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    fetchEvidenceCommunity(zoneId)
      .then((column) => { if (active) setItems(column.items); })
      .catch((reason: unknown) => {
        if (!active) return;
        // The column is optional: a deployment without it, or a zone it does not apply to, shows nothing.
        const absent = reason instanceof WebApiError && (reason.code === "evidence_community_not_enabled" || reason.code === "evidence_community_not_found");
        if (absent) setItems([]);
        else setFailed(true);
      });
    return () => { active = false; };
  }, [zoneId, attempt]);
  if (failed) {
    return (
      <p role="status" className="text-caption text-text-3">
        社区卡片暂时读不出来。
        <Button variant="text" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      </p>
    );
  }
  if (!items?.length) return null;
  return (
    <section aria-label="社区卡片" className="space-y-3">
      <div>
        <h3 className="text-ui font-medium text-text">社区卡片</h3>
        <p className="mt-1 text-caption text-text-3">其他用户公开发布的相关卡片，署名、只读，平台没有改动，也不为它们背书；点开卡片可以看到来源和核对结果。</p>
      </div>
      <ul className="divide-y divide-border">
        {items.map((card) => (
          <li key={card.id} className="py-3">
            <Link className="text-ui text-accent hover:underline" to={cardPath(card)}>{card.title}</Link>
            <p className="mt-1 text-caption text-text-3">
              <Link className="hover:underline" to={`/app/frontier/authors/${encodeURIComponent(card.author.id)}`}>{card.author.name}</Link>
              {` · ${card.zoneTitle}`}
              {standing(card) && ` · ${standing(card)}`}
            </p>
            {card.summary && <p className="mt-1 line-clamp-2 text-ui text-text-2">{card.summary}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
