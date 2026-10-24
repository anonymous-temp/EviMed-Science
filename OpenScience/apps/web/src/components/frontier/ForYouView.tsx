import type { ReactNode } from "react";
import { Newspaper } from "lucide-react";
import type { FrontierForYou, FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FrontierOnboarding } from "./FrontierOnboarding";
import { FrontierSkeleton } from "./FrontierSkeleton";

/** 与我相关, as read: still being read, unreadable, or read (`null` is a server without the route). */
export type ForYouState = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; forYou: FrontierForYou | null };

/** The reason's own topic; from a server that sends only the sentence, the sentence without 「因为你在做：」. */
export function forYouTopic(reason: { text: string; topic: string | null }): string {
  if (reason.topic) return reason.topic;
  const cut = reason.text.indexOf("：");
  return reason.text.startsWith("因为你") && cut > 0 ? reason.text.slice(cut + 1).trim() || reason.text : reason.text;
}

/**
 * The items under their topics, in the order the server served them: a heading wherever the topic changes. The server keeps each
 * topic's entries together, so an entry's index in its answer is the place it is shown at — what an impression and an open report
 * as its position (ct-track, 2026-10-24); merging a topic's runs here would move entries away from the positions they were served at.
 */
export function topicRuns(forYou: FrontierForYou): Array<{ topic: string; items: FrontierItem[] }> {
  const runs: Array<{ topic: string; items: FrontierItem[] }> = [];
  for (const { item, reason } of forYou.items) {
    const topic = forYouTopic(reason);
    const last = runs.at(-1);
    if (last && last.topic === topic) last.items.push(item);
    else runs.push({ topic, items: [item] });
  }
  return runs;
}

/** What the block says when it has nothing yet: what the reader can do, and what comes of it. */
export const FOR_YOU_EMPTY = "收藏或打开几条动态、或在对话里提几个问题后，这里会按你的兴趣推荐";
/** What it says to a reader who switched their memory off. */
export const FOR_YOU_PAUSED = "开启记忆后，这里会按你的兴趣推荐";
/** Where this deployment cannot recommend at all, nothing the reader does would change it: no promise. */
export const FOR_YOU_NONE = "暂无与你相关的动态";

/** The one line an empty block shows. */
export function forYouEmptyLine(forYou: FrontierForYou | null): string {
  if (forYou?.paused) return FOR_YOU_PAUSED;
  return forYou?.state === "available" ? FOR_YOU_EMPTY : FOR_YOU_NONE;
}

/**
 * 与我相关 (plan 2026-09-23 §6.2; 2026-09-24; ranked by the server since 2026-10-24): the items the server chose for the reader —
 * what they said they work on, follow, read, and what everyone should see — under the topic each was chosen for: the heading is
 * the topic's name, as Google News and Apple News let a section's name carry 「因为你关注」, and no card repeats 「因为你在做：…」.
 * Each item is the feed's own card. While the server says the reader has told it nothing yet, the onboarding card sits on top
 * (`FrontierOnboarding`, skippable, never a dialog). With nothing to show, one line says what the reader can do about it; how the
 * block is ranked is never shown. The list is a `[data-frontier-list="for-you"]` container: what is seen and opened in it is
 * reported with its list and position (`frontierTracking`).
 */
export function ForYouView({ state, renderItem, onRetry, onOnboarded }: {
  state: ForYouState;
  renderItem: (item: FrontierItem) => ReactNode;
  onRetry: () => void;
  /** The onboarding card was finished or skipped: read the block again. */
  onOnboarded?: () => void;
}) {
  if (state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "failed") return <LoadError message={state.message} onRetry={onRetry} />;
  const forYou = state.forYou;
  if (forYou?.state === "unavailable") return <LoadError message="暂时读不到与我相关的动态。" onRetry={onRetry} />;
  const onboarding = forYou?.state === "available" && forYou.onboarding === true
    ? <FrontierOnboarding onClose={() => onOnboarded?.()} /> : null;
  if (!forYou || forYou.state !== "available" || forYou.items.length === 0) {
    return (
      <div className="space-y-8">
        {onboarding}
        <EmptyState icon={Newspaper} title={forYouEmptyLine(forYou)} />
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {onboarding}
      <div data-frontier-list="for-you" data-frontier-list-id={forYou.listId ?? ""} className="space-y-8">
        {topicRuns(forYou).map((group, index) => (
          <section key={`${index}:${group.topic}`} aria-labelledby={`frontier-topic-${index}`}>
            <h2 id={`frontier-topic-${index}`} className="text-body font-semibold leading-6 text-text">{group.topic}</h2>
            <ul>{group.items.map(renderItem)}</ul>
          </section>
        ))}
      </div>
    </div>
  );
}
