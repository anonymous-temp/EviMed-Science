import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BookmarkPlus } from "lucide-react";
import {
  frontierErrorMessage,
  FRONTIER_FOLLOWS_CHANGED,
  listFrontierFollows,
  type FrontierFollow,
} from "@/lib/frontierClient";
import {
  listEvidenceZones,
  listFollowedEvidence,
  type EvidenceCard,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FollowedEvidenceZones } from "./FollowedEvidenceZones";
import { FrontierSkeleton } from "./FrontierSkeleton";

/** What the reader follows, read once for the whole 关注 view: the topics of the feed and the evidence zones. */
export interface FollowingState {
  /** Nothing read yet. */
  loading: boolean;
  /** Why the follows could not be read; never shown as "you follow nothing". */
  error: string | null;
  /** The follows that bring items into the feed (not muted), of every kind. */
  topics: FrontierFollow[];
  /** The followed evidence zones. */
  zones: EvidenceZone[];
  /** The latest cards of those zones. */
  cards: EvidenceCard[];
  retry: () => void;
}

/**
 * The follows and the followed zones, asked together — the view needs both to say whether there is
 * anything to show — and asked again when a follow changes (the card menu, the 管理关注 drawer).
 * The recent cards are a courtesy: where they cannot be read the zones still stand. While the view
 * is away its last answer is kept, and shown while the new one is read.
 */
export function useFollowing(enabled: boolean): FollowingState {
  const [read, setRead] = useState<Pick<FollowingState, "topics" | "zones" | "cards"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () => {
      Promise.all([
        listFrontierFollows(),
        listEvidenceZones("", null, "following"),
        listFollowedEvidence().then((page) => page.items, () => [] as EvidenceCard[]),
      ]).then(
        ([follows, zones, cards]) => {
          if (!active) return;
          setRead({ topics: follows.filter((follow) => !follow.muted), zones: zones.items, cards });
          setError(null);
        },
        (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
      );
    };
    load();
    // A follow made elsewhere (a card's menu, the drawer) changes what this view holds.
    window.addEventListener(FRONTIER_FOLLOWS_CHANGED, load);
    return () => { active = false; window.removeEventListener(FRONTIER_FOLLOWS_CHANGED, load); };
  }, [enabled, attempt]);
  const retry = useCallback(() => { setError(null); setAttempt((value) => value + 1); }, []);
  return { loading: read === null && error === null, error, topics: read?.topics ?? [], zones: read?.zones ?? [], cards: read?.cards ?? [], retry };
}

/** Which of the page's right-hand controls the 关注 view has something to offer. */
export type FollowControls = "none" | "manage" | "full";

/**
 * Filters belong to a feed, so they come with a topic follow; 「管理关注」 is the way to the first
 * one, so a reader with only zones keeps it; with nothing followed, or nothing read yet, the row
 * shows nothing and the empty state is the one place that offers the start.
 */
export function followControls(state: FollowingState): FollowControls {
  if (state.error) return "none";
  if (state.topics.length > 0) return "full";
  return state.zones.length > 0 ? "manage" : "none";
}

/**
 * 关注: one answer to "what do I follow", then the groups it has. Nothing followed is one sentence
 * and the way to start (the page used to say 「还没有关注证据专区」 and 「没有结果」 together, under
 * a row of filters with nothing to filter). Zones alone show only the zones; topics add the feed,
 * whose own empty words mean "nothing new", not "your filters excluded everything".
 */
export function FollowingView({ state, feed, onAdd }: {
  state: FollowingState;
  /** The feed of the followed topics, drawn only once there is a topic follow. */
  feed: ReactNode;
  /** Opens 管理关注, where a follow is added. */
  onAdd: () => void;
}) {
  if (state.error) return <LoadError message={state.error} onRetry={state.retry} />;
  if (state.loading) return <FrontierSkeleton />;
  if (state.topics.length === 0 && state.zones.length === 0) {
    return (
      <EmptyState
        icon={BookmarkPlus}
        title="关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。"
        action={(
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button onClick={onAdd}>添加关注</Button>
            <Link to="/app/frontier/zones" className={buttonClasses({ variant: "text" })}>浏览证据专区</Link>
          </div>
        )}
      />
    );
  }
  return (
    <div className="space-y-8">
      {state.zones.length > 0 && <FollowedEvidenceZones zones={state.zones} cards={state.cards} />}
      {state.topics.length > 0 && feed}
    </div>
  );
}
