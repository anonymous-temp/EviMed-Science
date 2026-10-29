import { useId } from "react";
import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { TopicCard } from "@/lib/evidenceTopicClient";
import { Tag } from "@/components/ui/Tag";
import { EXTERNAL } from "../frontierText";

/** What a card that is not the current version says, in the reader's words; a current card says nothing. */
const STATUS: Readonly<Record<Exclude<TopicCard["status"], "current">, { text: string; tone: "warn" | "safety" }>> = {
  updating: { text: "有新进展", tone: "warn" },
  superseded: { text: "已有新版", tone: "warn" },
  withdrawn: { text: "已撤回", tone: "safety" },
};

/** Where a card opens: an address inside the app, or another site's page — and nothing for an address of any other kind. */
function cardTarget(card: TopicCard): { kind: "inline"; to: string } | { kind: "link"; url: string } | null {
  if (card.detail.kind === "inline") return /^\/app\/[^\s]*$/.test(card.detail.href) ? { kind: "inline", to: card.detail.href } : null;
  return /^https?:\/\/[^\s]+$/i.test(card.detail.url) ? { kind: "link", url: card.detail.url } : null;
}

/**
 * One evidence card of the team's interface, set apart from the zone's item rows (plan 4.3.2: "卡片和资讯一眼分得开"): a bordered block
 * of the conclusion layer — the question as its title, the one-line conclusion, then the certainty, how many studies stand behind it
 * and who produced it. The whole block is the way in, by the title's stretched link, as a list row is: an inline card opens its
 * reading page in the app, a card the interface only links to opens the other site in a new tab.
 */
export function ZoneCardBlock({ card, from }: { card: TopicCard; /** Where the reading page returns to. */ from?: { to: string; label: string } }) {
  const titleId = useId();
  const target = cardTarget(card);
  const status = card.status === "current" ? null : STATUS[card.status];
  const title = target?.kind === "inline" ? (
    <Link to={target.to} state={from ? { evidenceFrom: from } : undefined} className={LINK}>{card.title}</Link>
  ) : target ? (
    <a href={target.url} {...EXTERNAL} className={LINK}>{card.title}<ArrowUpRight size={16} aria-hidden="true" className="ml-0.5 inline align-text-bottom text-text-3" /></a>
  ) : card.title;
  return (
    <li data-zone-card={card.id} className={cn("relative rounded-card border border-border bg-surface p-4", target && "transition-colors duration-fast hover:bg-surface-2")}>
      <article aria-labelledby={titleId}>
        <h3 id={titleId} data-row-title className="text-body font-semibold leading-6 text-text">{title}</h3>
        {card.conclusion && <p data-prose="" className="mt-1.5 line-clamp-2 max-w-measure text-ui text-text-2">{card.conclusion}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-3">
          {card.certainty?.labelZh && <Tag tone="accent">{card.certainty.labelZh}</Tag>}
          {status && <Tag tone={status.tone}>{status.text}</Tag>}
          {card.sourceCount > 0 && <span className="tabular-nums">{card.sourceCount} 项研究</span>}
          {card.producer.name && <span>{card.producer.name}</span>}
        </div>
      </article>
    </li>
  );
}

/** The title's link covers the block, so one press anywhere on it opens the card (a list row's way). */
const LINK = "rounded outline-none after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-focus";
