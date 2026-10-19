import { Link } from "react-router";
import { List, ListRow } from "@/components/ui/ListRow";
import type { EvidenceCard, EvidenceZone } from "@/lib/evidenceZoneClient";

/**
 * The first group of the 关注 feed, headed like the day groups below it (not a bordered block of its
 * own above the feed's filters, 2026-10-07): up to three followed zones and the three latest cards of
 * them. The view hands them over and draws this only when the reader follows a zone, so there is no
 * 「还没有关注」 line here — nothing followed is the view's one empty state.
 */
export function FollowedEvidenceZones({ zones, cards }: { zones: readonly EvidenceZone[]; cards: readonly EvidenceCard[] }) {
  const shownZones = zones.slice(0, 3);
  const shownCards = cards.slice(0, 3);
  return (
    <section aria-label="关注的证据专区">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-body font-semibold leading-6 text-text">证据专区</h2>
        <Link to="/app/frontier/zones?scope=following" className="rounded text-ui text-accent hover:underline hover:underline-offset-4">
          查看全部关注专区
        </Link>
      </div>
      <List divided label="关注的专区" className="mt-3">
        {shownZones.map((zone) => (
          <ListRow
            key={zone.id}
            to={`/app/frontier/zones/${encodeURIComponent(zone.id)}`}
            title={zone.title}
            trailing={zone.evidenceCount !== null ? <span className="tabular-nums">{zone.evidenceCount} 条证据</span> : undefined}
          />
        ))}
      </List>
      {shownCards.length > 0 && (
        <div>
          <h3 className="mt-4 text-body font-semibold text-text">最近证据更新</h3>
          <List divided label="最近证据更新" className="mt-3">
            {shownCards.map((card) => (
              <ListRow
                key={card.id}
                to={`/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`}
                title={card.content?.question || card.title}
                // The card's own list line — never the neutral answer every card without a headline shares.
                meta={(card.summary || card.content?.answer) ? <span className="line-clamp-2 block max-w-measure text-text-2">{card.summary || card.content?.answer}</span> : undefined}
              />
            ))}
          </List>
        </div>
      )}
    </section>
  );
}
