import { Link } from "react-router";
import { List, ListRow } from "@/components/ui/ListRow";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import type { ZoneSummary } from "@/lib/evidenceTopicClient";
import { zonePath } from "./zoneLinks";

/** How many zones the 关注 view's first group shows before 「查看全部」. */
const SHOWN = 5;

/**
 * The first group of the 关注 feed, headed like the day groups below it (not a bordered block of its own above the feed's filters,
 * 2026-10-07): 「我的专区与关注的专区」 (2026-10-29, when a reader's typed follows became zones of their own), up to five of them
 * with the week's count of each, and the three latest cards of them. The view hands them over and draws this only when the reader
 * has a zone or follows one, so there is no 「还没有关注」 line here — nothing followed is the view's one empty state.
 */
export function FollowedEvidenceZones({ zones, cards }: { zones: readonly ZoneSummary[]; cards: readonly EvidenceCard[] }) {
  const shownZones = zones.slice(0, SHOWN);
  const shownCards = cards.slice(0, 3);
  return (
    <section aria-label="我的专区与关注的专区">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-body font-semibold leading-6 text-text">我的专区与关注的专区</h2>
        <Link to="/app/frontier?view=zones&scope=mine" className="rounded text-ui text-accent hover:underline hover:underline-offset-4">
          查看全部专区
        </Link>
      </div>
      <List divided label="我的专区与关注的专区" className="mt-3">
        {shownZones.map((zone) => (
          <ListRow
            key={zone.id}
            to={zonePath(zone)}
            title={zone.title}
            trailing={<span className="tabular-nums">{zone.lifecycle === "quiet" ? "近期没有更新" : `近 7 天 ${zone.counts.week} 条`}</span>}
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
