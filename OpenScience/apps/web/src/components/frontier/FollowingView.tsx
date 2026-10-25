import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BookmarkPlus, Plus, SearchX } from "lucide-react";
import { FRONTIER_SPECIALTY_LABELS_ZH } from "@evimed/domain";
import {
  addFrontierFollow,
  frontierErrorMessage,
  FRONTIER_FOLLOWS_CHANGED,
  FRONTIER_FOLLOWS_SEEN,
  listFrontierFollows,
  type FrontierFollow,
} from "@/lib/frontierClient";
import { fetchFrontierPrefs, type FrontierPrefs } from "@/lib/frontierPrefs";
import {
  listEvidenceZones,
  listFollowedEvidence,
  type EvidenceCard,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button, buttonClasses } from "@/components/ui/Button";
import { navItemClasses } from "@/components/ui/NavItem";
import { cn } from "@/lib/cn";
import type { FollowChoice } from "./FrontierControls";
import { FollowedEvidenceZones } from "./FollowedEvidenceZones";
import { FrontierOnboarding } from "./FrontierOnboarding";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { TypedFollowInput } from "./TypedFollowInput";

/** What the reader follows, read once for the whole 关注 view: the topics of the feed, the evidence zones, and whether they answered. */
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
  /**
   * Whether the reader finished or skipped the onboarding card; a server without the answer's route counts as answered (no card
   * is offered where its answer could not be kept).
   */
  answered: boolean;
  retry: () => void;
}

/**
 * The follows, the followed zones and the onboarding answer, asked together — the view needs all three to say what there is to
 * show — and asked again when a follow changes (the card menu, the 管理关注 drawer, 「筛选」's 关注). The recent cards are a courtesy:
 * where they cannot be read the zones still stand. While the view is away its last answer is kept, and shown while the new one is read.
 */
export function useFollowing(enabled: boolean): FollowingState {
  const [read, setRead] = useState<Pick<FollowingState, "topics" | "zones" | "cards" | "answered"> | null>(null);
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
        fetchFrontierPrefs().then((prefs) => Boolean(prefs.onboardedAt || prefs.skippedAt), () => true),
      ]).then(
        ([follows, zones, cards, answered]) => {
          if (!active) return;
          setRead({ topics: follows.filter((follow) => !follow.muted), zones: zones.items, cards, answered });
          setError(null);
        },
        (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
      );
    };
    load();
    // A follow made elsewhere (a card's menu, the drawer) changes what this view holds.
    window.addEventListener(FRONTIER_FOLLOWS_CHANGED, load);
    // A follow's feed was opened: the counts beside the follows are read again.
    window.addEventListener(FRONTIER_FOLLOWS_SEEN, load);
    return () => { active = false; window.removeEventListener(FRONTIER_FOLLOWS_CHANGED, load); window.removeEventListener(FRONTIER_FOLLOWS_SEEN, load); };
  }, [enabled, attempt]);
  const retry = useCallback(() => { setError(null); setAttempt((value) => value + 1); }, []);
  return {
    loading: read === null && error === null, error, topics: read?.topics ?? [], zones: read?.zones ?? [], cards: read?.cards ?? [],
    answered: read?.answered ?? true, retry,
  };
}

/** The entry an address names (`follow=`): 与我相关 when it names none — the first entry —, `all`, a follow's id, or `zone:<id>`. */
export function readFollowChoice(value: string | null): FollowChoice {
  const text = value?.trim() ?? "";
  if (!text || text === "foryou") return { kind: "foryou" };
  if (text === "all") return { kind: "all" };
  if (text.startsWith("zone:") && text.length > 5) return { kind: "zone", id: text.slice(5) };
  return { kind: "follow", id: text };
}

/** The address's word for an entry. */
export function followChoiceParam(choice: FollowChoice): string {
  if (choice.kind === "follow") return choice.id;
  if (choice.kind === "zone") return `zone:${choice.id}`;
  return choice.kind;
}

/** The kinds a follow can be, in the reader's words and in the order the list groups them. */
const KIND_GROUPS: ReadonlyArray<[FrontierFollow["kind"], string]> = [
  ["query", "关注词"], ["specialty", "专科"], ["tag", "标签"], ["drug", "药物"], ["topic", "主题"], ["source", "来源"], ["event", "事件"],
];

/** The server stops counting here (`FRONTIER_FOLLOW_COUNT_CAP`): a number this high reads 「99+」. */
const NEW_COUNT_CAP = 99;

/** A follow as the list and its token say it: a tag with its 「#」. */
export function followLabel(follow: FrontierFollow): string {
  return follow.kind === "tag" ? `#${follow.label}` : follow.label;
}

/** What the entry an address names is called (for its token): a follow's or a zone's name, or nothing for the two lists. */
export function followChoiceLabel(choice: FollowChoice, state: FollowingState): string | null {
  if (choice.kind === "follow") {
    const follow = state.topics.find((entry) => entry.id === choice.id);
    return follow ? followLabel(follow) : null;
  }
  if (choice.kind === "zone") return state.zones.find((zone) => zone.id === choice.id)?.title ?? null;
  return null;
}

/**
 * The onboarding answer as the reader's first follows (owner, 2026-10-25): each chosen specialty and each chosen tag, where it is not
 * followed already. A follow that could not be made is said once; the others stand.
 */
export async function followAnswers(answer: FrontierPrefs | undefined, held: readonly FrontierFollow[]): Promise<void> {
  if (!answer) return;
  const has = (kind: FrontierFollow["kind"], key: string) => held.some((follow) => follow.kind === kind && follow.key.toLowerCase() === key.toLowerCase() && !follow.muted);
  const wanted = [
    ...answer.specialties.filter((key) => !has("specialty", key)).map((key) => ({ kind: "specialty" as const, key, label: FRONTIER_SPECIALTY_LABELS_ZH[key] ?? key })),
    ...answer.interestTags.filter((tag) => !has("tag", tag.slug)).map((tag) => ({ kind: "tag" as const, key: tag.slug, label: tag.name })),
  ];
  if (wanted.length === 0) return;
  const settled = await Promise.allSettled(wanted.map((follow) => addFrontierFollow(follow)));
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) toast.error(frontierErrorMessage(failed.reason));
}

/**
 * 关注's list (owner, 2026-10-25): 与我相关 (ranked), 全部关注 (newest first), then each followed thing under its kind — and the followed
 * evidence zones — with the number of new items where the server counts them, and at its foot 「添加关注 · 管理」, the 管理关注 drawer.
 * Every entry is an address (`follow=`), so Back and a shared link land on it; `onPick` hears the choice (on a phone it closes the
 * 「筛选」 sheet the list is the first section of). A column beside the entry on a wide screen.
 */
export function FollowList({ state, choice, hrefFor, onManage, onPick, onAdded, titled = false }: {
  state: FollowingState;
  choice: FollowChoice;
  hrefFor: (choice: FollowChoice) => string;
  onManage: () => void;
  onPick?: () => void;
  /** With it the list ends in 「关注一个药物、试验或问题」, and a follow made there opens (c3-watch, 2026-10-25). */
  onAdded?: (follow: FrontierFollow) => void;
  /** Named on the page (a section of the 「筛选」 sheet among the filters' groups). */
  titled?: boolean;
}) {
  const current = (entry: FollowChoice) => followChoiceParam(entry) === followChoiceParam(choice);
  const item = (entry: FollowChoice, label: string, count?: number) => (
    <li key={followChoiceParam(entry)}>
      <Link to={hrefFor(entry)} aria-current={current(entry) ? "page" : undefined} className={navItemClasses({ current: current(entry) })} onClick={onPick}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && <span className="shrink-0 text-caption tabular-nums text-text-3" aria-label={`${count >= NEW_COUNT_CAP ? `至少 ${NEW_COUNT_CAP}` : count} 条新动态`}>{count >= NEW_COUNT_CAP ? `${NEW_COUNT_CAP}+` : count}</span>}
      </Link>
    </li>
  );
  return (
    <nav aria-label="我的关注" data-frontier-follows="" className="space-y-4">
      {titled && <p aria-hidden="true" className="text-caption text-text-3">我的关注</p>}
      <ul className="space-y-0.5">
        {item({ kind: "foryou" }, "与我相关")}
        {item({ kind: "all" }, "全部关注")}
      </ul>
      {/* What the reader wants to hear about, in their own words, stays at the top: the list under it grows with every follow. */}
      {onAdded && <TypedFollowInput held={state.topics} compact onAdded={onAdded} />}
      {KIND_GROUPS.map(([kind, word]) => {
        const follows = state.topics.filter((follow) => follow.kind === kind);
        if (follows.length === 0) return null;
        return (
          <div key={kind} role="group" aria-label={word}>
            <p aria-hidden="true" className="px-2 pb-1 text-caption text-text-3">{word}</p>
            <ul className="space-y-0.5">{follows.map((follow) => item({ kind: "follow", id: follow.id }, followLabel(follow), follow.newItems))}</ul>
          </div>
        );
      })}
      {state.zones.length > 0 && (
        <div role="group" aria-label="证据专区">
          <p aria-hidden="true" className="px-2 pb-1 text-caption text-text-3">证据专区</p>
          <ul className="space-y-0.5">{state.zones.map((zone) => item({ kind: "zone", id: zone.id }, zone.title))}</ul>
        </div>
      )}
      <Button variant="text" size="sm" className="px-2" onClick={onManage}>
        <Plus size={16} aria-hidden="true" />添加关注 · 管理
      </Button>
    </nav>
  );
}

/**
 * 关注 (owner, 2026-10-25: 「那就是订阅关注吧」): the reader's own place — the list of what they follow (`list`, a column on a wide screen;
 * on a phone it is in the 「筛选」 sheet and the page passes none) and the entry it has open:
 *
 *  - 与我相关: the ranked list the server chose for the reader (`forYou`);
 *  - 全部关注: the followed zones' latest cards, then the feed of every follow (`feed`); with nothing followed, the onboarding card —
 *    角色, 专科, 标签, 跳过 — whose answers become the first follows, or, once it was answered, one sentence and the way to start;
 *  - one follow: the feed narrowed to it, 「筛选」 still applying (`feed`);
 *  - one followed zone: its latest cards.
 */
export function FollowingView({ state, choice, list, forYou, feed, onAdd, onAnswered }: {
  state: FollowingState;
  choice: FollowChoice;
  /** The list of follows, drawn as a column beside the entry; none on a phone. */
  list: ReactNode;
  /** 与我相关, as the page reads it. */
  forYou: ReactNode;
  /** The feed of the follows (all, or the one narrowed to). */
  feed: ReactNode;
  /** Opens 管理关注, where a follow is added. */
  onAdd: () => void;
  /** The onboarding card was finished or skipped, with its answer: the page makes the first follows and reads again. */
  onAnswered: (answer: FrontierPrefs | undefined) => void;
}) {
  if (state.error) return <LoadError message={state.error} onRetry={state.retry} />;
  if (state.loading) return <FrontierSkeleton />;
  const nothing = state.topics.length === 0 && state.zones.length === 0;
  const entry = (() => {
    switch (choice.kind) {
      case "foryou":
        return forYou;
      case "zone": {
        const zone = state.zones.find((candidate) => candidate.id === choice.id);
        if (!zone) return <EmptyState icon={SearchX} title="这个专区已不在关注里" action={<Link to="/app/frontier?view=zones&scope=following" className={buttonClasses({ variant: "secondary" })}>看关注的专区</Link>} />;
        return <FollowedEvidenceZones zones={[zone]} cards={state.cards.filter((card) => card.zoneId === zone.id)} />;
      }
      case "follow":
        return feed;
      default:
        if (nothing && !state.answered) {
          return <FrontierOnboarding onClose={(saved, answer) => onAnswered(saved ? answer : undefined)} />;
        }
        if (nothing) {
          return (
            <EmptyState
              icon={BookmarkPlus}
              title="关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。"
              action={(
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button onClick={onAdd}>添加关注</Button>
                  <Link to="/app/frontier?view=zones" className={buttonClasses({ variant: "text" })}>浏览证据专区</Link>
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
  })();
  if (!list) return entry;
  return (
    <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-8">
      {/* The list stays in sight under the band while the entry scrolls; a long one scrolls on its own. */}
      <div className={cn("sticky top-[calc(var(--page-chrome-h,0px)+1rem)] self-start overflow-y-auto", "max-h-[calc(100vh-var(--page-chrome-h,0px)-2rem)]")}>
        {list}
      </div>
      <div className="min-w-0">{entry}</div>
    </div>
  );
}
