import { Link } from "react-router";
import type { EvidenceCard, EvidenceZone } from "@/lib/evidenceZoneClient";
import { evidenceReviewLabel } from "./EvidenceReading";

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
        <Link to="/app/frontier/zones?scope=following" className="text-caption text-accent">
          查看全部关注专区
        </Link>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {shownZones.map((zone) => (
          <li key={zone.id} className="py-3">
            <Link to={`/app/frontier/zones/${encodeURIComponent(zone.id)}`} className="text-ui text-text hover:text-accent">
              {zone.title}
            </Link>
            {zone.evidenceCount !== null && <span className="ml-3 text-caption text-text-3">{zone.evidenceCount} 条证据</span>}
          </li>
        ))}
      </ul>
      {shownCards.length > 0 && (
        <div>
          <h3 className="mt-4 text-ui font-medium text-text">最近证据更新</h3>
          <ul className="mt-3 divide-y divide-border">
            {shownCards.map((card) => (
              <li key={card.id} className="py-3">
                <Link
                  to={`/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`}
                  className="text-ui text-text hover:text-accent"
                >
                  {card.content?.question || card.title}
                </Link>
                {(card.content?.answer || card.summary) && (
                  <p className="mt-1 line-clamp-2 max-w-measure text-caption text-text-2">{card.content?.answer || card.summary}</p>
                )}
                {evidenceReviewLabel(card) && <p className="mt-1 text-caption text-text-3">{evidenceReviewLabel(card)}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
