import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import type { FrontierItem } from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { FrontierDetails } from "./FrontierDetails";
import {
  CARD_FLAG_KEYS,
  EXTERNAL,
  INLINE_ACTION,
  cardTags,
  evidenceTag,
  itemMarkdown,
  researchDraft,
  scoreBand,
  timeColumn,
  type CardTag,
} from "./frontierText";

const eventPath = (id: string) => `/app/frontier/events/${encodeURIComponent(id)}`;

/**
 * The editorial score's dot by band (plan §6.2): the accent at or above the
 * selection line, the secondary grey from 60 to it, the faint grey below 60.
 * The number itself stays grey, as every number on the card does.
 */
const BAND_DOT = { high: "bg-accent", medium: "bg-text-2", low: "bg-text-3" } as const;

export interface FrontierCardProps {
  item: FrontierItem;
  /** Inside a day group the time column is the clock; elsewhere it is the day. */
  grouped?: boolean;
  /** Where not every item is 精选 (全部, a search), say which are — the dot, and words for a screen reader. */
  markSelected?: boolean;
  onStar: (item: FrontierItem) => void;
  onHide: (item: FrontierItem) => void;
  /** 「存入知识库」; absent where this server cannot save yet. */
  onSave?: (item: FrontierItem) => void;
  saving?: boolean;
  /** The reader followed a link to the original, or to another report of it. */
  onOpened?: (item: FrontierItem) => void;
  /** A #tag was pressed: a specialty filters the feed, a disease searches for it. */
  onTag?: (tag: CardTag) => void;
}

/**
 * One item (plan 2026-09-23 §6.2, §6.3): a time column and a dot, who said it
 * and how hard the evidence is, the editorial score, the title, what it says
 * in at most three lines, and a footer — 「另有 N 家报道 ›」 and its #tags on
 * the left, the card's three actions on the right: the star, 「深入研究」 and
 * 「⋯」, always shown (owner, 2026-09-24: actions that appear only under the
 * pointer read as missing).
 *
 * The title is the way to the original, as a headline is in every reader
 * (owner, 2026-09-24: 「看原文，应该是点题目就能进去」); there is no second
 * 「原文」 control. 「深入研究」 opens a new conversation with a draft question
 * about the item in the composer, to send or rewrite — no menu of prepared
 * questions to choose from first.
 *
 * What the card no longer carries, and where it went: 「为什么值得看」 is the
 * summary's last sentence (the editor writes it so); 「为什么入选」 and
 * 「评估与核对」 are the back office's; the original title, the journal, the
 * authors and the impact factor are in 「⋯ › 详情」; the source type is in the
 * institution's own name; 「精选」 is the dot.
 *
 * A read card's title steps down to the secondary colour; a safety alert says
 * 「安全警示」 first and has no score — it is selected whatever it scored.
 */
export function FrontierCard({ item, grouped = true, markSelected = false, onStar, onHide, onSave, saving = false, onOpened, onTag }: FrontierCardProps) {
  const titleId = useId();
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const evidence = evidenceTag(item);
  const flags = item.flags.filter((flag) => CARD_FLAG_KEYS.has(flag.key));
  const band = scoreBand(item);
  const tags = cardTags(item);
  const starred = item.state.starred;
  const also = item.alsoReportedCount;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(itemMarkdown(item));
      toast.success("已复制");
    } catch {
      toast.error("没有复制成功");
    }
  };
  const more: MenuEntry[] = [
    { label: "详情", onSelect: () => setDetails(true) },
    ...(onSave ? [{ label: "存入知识库", disabled: saving, onSelect: () => onSave(item) }] : []),
    { label: "复制为 Markdown", onSelect: () => void copy() },
    { label: "不感兴趣", onSelect: () => onHide(item) },
  ];
  const research = () => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(researchDraft(item)) } });
  const reports: MenuEntry[] = [
    ...item.alsoReportedBy.map((mention) => ({
      label: mention.sourceName,
      onSelect: () => {
        window.open(mention.url, "_blank", "noopener,noreferrer");
        onOpened?.(item);
      },
    })),
    ...(item.event ? ["separator" as const, { label: "同一事件的全部报道", onSelect: () => navigate(eventPath(item.event!.id)) }] : []),
  ];

  return (
    <li data-frontier-item={item.id} className="flex">
      <div className="mt-4 flex h-6 w-14 shrink-0 items-center justify-between pr-2">
        <time dateTime={item.timelineAt} className="text-caption tabular-nums text-text-3">{timeColumn(item, grouped)}</time>
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.selected ? "bg-accent" : "bg-border-control")} />
        {markSelected && item.selected && <span className="sr-only">精选</span>}
      </div>
      <article aria-labelledby={titleId} className="min-w-0 flex-1 border-b border-border pb-5 pt-4">
        <div className="flex min-h-6 items-center gap-2 text-caption text-text-3">
          {item.safetyAlert && <Tag tone="safety">安全警示</Tag>}
          <span className="min-w-0 truncate">{item.source.name}</span>
          {evidence && <Tag>{evidence}</Tag>}
          {flags.map((flag) => (flag.key === "retracted"
            ? <Tag key={flag.key} tone="safety">{flag.label}</Tag>
            : <span key={flag.key} className="shrink-0">· {flag.label}</span>))}
          {band && (
            <span title="编辑评分 · 满分 100" className="ml-auto inline-flex shrink-0 items-center gap-1 text-caption font-semibold tabular-nums text-text-3">
              <span aria-hidden="true" data-band={band} className={cn("h-1.5 w-1.5 rounded-full", BAND_DOT[band])} />
              <span className="sr-only">编辑评分</span>
              {item.score}
            </span>
          )}
        </div>

        <h3 id={titleId} data-row-title className="mt-1.5 text-body font-semibold leading-6">
          <a href={item.url} {...EXTERNAL} onClick={() => onOpened?.(item)}
            className={cn("rounded outline-none hover:text-accent hover:underline", item.state.read ? "text-text-2" : "text-text")}>
            {item.title}
          </a>
        </h3>
        {item.summary && <p className="mt-1 line-clamp-3 max-w-measure text-ui text-text-2">{item.summary}</p>}

        <div className="-ml-1 mt-2 flex min-h-6 flex-wrap items-center gap-x-2 text-ui text-text-3">
          {also > 0 && (
            <Menu label={`另有 ${also} 家报道`} align="start" items={reports}>
              <button type="button" className={cn(INLINE_ACTION, "px-1 hover:text-text")}>
                <span className="text-caption">另有 {also} 家报道 ›</span>
              </button>
            </Menu>
          )}
          {tags.map((tag) => (onTag ? (
            <button key={`${tag.kind}-${tag.key}`} type="button" title={tag.kind === "specialty" ? `只看${tag.label}` : `搜索「${tag.label}」`}
              onClick={() => onTag(tag)} className={cn(INLINE_ACTION, "px-1 hover:text-text")}>
              <span className="text-caption">#{tag.label}</span>
            </button>
          ) : <span key={`${tag.kind}-${tag.key}`} className="px-1 text-caption">#{tag.label}</span>))}
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              icon={Star}
              size="sm"
              label="收藏"
              aria-pressed={starred}
              className={starred ? "text-accent [&_svg]:fill-current" : undefined}
              onClick={() => onStar(item)}
            />
            <button type="button" onClick={research} className={cn(INLINE_ACTION, "px-1.5 text-text-2 hover:text-text")}>
              <span className="text-caption">深入研究</span>
            </button>
            <Menu label="更多操作" items={more} />
          </div>
        </div>
      </article>
      {details && <FrontierDetails item={item} onClose={() => setDetails(false)} onOpened={onOpened} />}
    </li>
  );
}
