import type { ReactNode } from "react";
import { Newspaper } from "lucide-react";
import type { FrontierForYou, FrontierItem } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { FrontierSkeleton } from "./FrontierSkeleton";

/** 与我相关, as read: still being read, unreadable, or read (`null` is a server without the route). */
export type ForYouState = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; forYou: FrontierForYou | null };

/** The reason's own topic; from a server that sends only the sentence, the sentence without 「因为你在做：」. */
export function forYouTopic(reason: { text: string; topic: string | null }): string {
  if (reason.topic) return reason.topic;
  const cut = reason.text.indexOf("：");
  return reason.text.startsWith("因为你") && cut > 0 ? reason.text.slice(cut + 1).trim() || reason.text : reason.text;
}

/** The items by the reader's topics, each topic once, in the order the server ranked them. */
export function groupByTopic(forYou: FrontierForYou): Array<{ topic: string; items: FrontierItem[] }> {
  const groups: Array<{ topic: string; items: FrontierItem[] }> = [];
  for (const { item, reason } of forYou.items) {
    const topic = forYouTopic(reason);
    const group = groups.find((entry) => entry.topic === topic);
    if (group) group.items.push(item);
    else groups.push({ topic, items: [item] });
  }
  return groups;
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
 * 与我相关 (plan 2026-09-23 §6.2; 2026-09-24): the items the reader's interests
 * point at — what they starred, opened, asked and what their memory holds —
 * grouped under those interests: the heading is the interest's name, as
 * Google News and Apple News let a section's name carry 「因为你关注」, and no
 * card repeats 「因为你在做：…」. Each item is the feed's own card. With
 * nothing to show, one line says what the reader can do about it; how the
 * block is ranked is never shown.
 */
export function ForYouView({ state, renderItem, onRetry }: {
  state: ForYouState;
  renderItem: (item: FrontierItem) => ReactNode;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "failed") return <LoadError message={state.message} onRetry={onRetry} />;
  const forYou = state.forYou;
  if (forYou?.state === "unavailable") return <LoadError message="暂时读不到与我相关的动态。" onRetry={onRetry} />;
  if (!forYou || forYou.state !== "available" || forYou.items.length === 0) {
    return <EmptyState icon={Newspaper} title={forYouEmptyLine(forYou)} />;
  }
  return (
    <div className="space-y-8">
      {groupByTopic(forYou).map((group, index) => (
        <section key={group.topic} aria-labelledby={`frontier-topic-${index}`}>
          <h2 id={`frontier-topic-${index}`} className="text-body font-semibold leading-6 text-text">{group.topic}</h2>
          <ul>{group.items.map(renderItem)}</ul>
        </section>
      ))}
    </div>
  );
}
