import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierSkeleton } from "./FrontierSkeleton";
import {
  listEvidenceZones,
  listFollowedEvidence,
  type EvidenceCard,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";
import { evidenceReviewLabel } from "./EvidenceReading";

export function FollowedEvidenceZones() {
  const [cards, setCards] = useState<EvidenceCard[]>([]);
  const [zones, setZones] = useState<EvidenceZone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      listEvidenceZones("", null, "following"),
      listFollowedEvidence(),
    ])
      .then(([page, evidence]) => {
        if (active) {
          setZones(page.items.slice(0, 3));
          setCards(evidence.items.slice(0, 3));
        }
      })
      .catch((reason) => {
        if (active) setError(evidenceErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    // The first group of the 关注 feed, headed like the day groups below it —
    // not a bordered block of its own above the feed's filters (2026-10-07).
    <section aria-label="关注的证据专区">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-body font-semibold leading-6 text-text">证据专区</h2>
        <Link
          to="/app/frontier/zones?scope=following"
          className="text-caption text-accent"
        >
          查看全部关注专区
        </Link>
      </div>
      {error ? (
        <EmptyState
          title={error}
          action={
            <Button
              variant="secondary"
              onClick={() => setRefresh((value) => value + 1)}
            >
              重试
            </Button>
          }
        />
      ) : loading ? (
        <FrontierSkeleton />
      ) : !zones.length ? (
        <p className="mt-3 text-caption text-text-3">还没有关注证据专区</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {zones.map((zone) => (
            <li key={zone.id} className="py-3">
              <Link
                to={`/app/frontier/zones/${encodeURIComponent(zone.id)}`}
                className="text-ui text-text hover:text-accent"
              >
                {zone.title}
              </Link>
              {zone.evidenceCount !== null && (
                <span className="ml-3 text-caption text-text-3">
                  {zone.evidenceCount} 条证据
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {cards.length > 0 && (
        <div>
          <h3 className="mt-4 text-ui font-medium text-text">最近证据更新</h3>
          <ul className="mt-3 divide-y divide-border">
            {cards.map((card) => (
              <li key={card.id} className="py-3">
                <Link
                  to={`/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`}
                  className="text-ui text-text hover:text-accent"
                >
                  {card.content?.question || card.title}
                </Link>
                {(card.content?.answer || card.summary) && (
                  <p className="mt-1 line-clamp-2 max-w-measure text-caption text-text-2">
                    {card.content?.answer || card.summary}
                  </p>
                )}
                {evidenceReviewLabel(card) && (
                  <p className="mt-1 text-caption text-text-3">
                    {evidenceReviewLabel(card)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
