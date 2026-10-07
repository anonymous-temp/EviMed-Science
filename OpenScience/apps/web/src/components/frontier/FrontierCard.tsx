import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { addFrontierFollow, frontierErrorMessage, type FrontierFollow, type FrontierItem } from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { FrontierDetails, frontierDetailsOffered } from "./FrontierDetails";
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
  expanded?: boolean;
  onExpand?: () => void;
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
 * The footer says only what it can do: 「展开摘要」 where the summary is cut at three lines, 「详情」
 * where the drawer holds something the card does not (an abstract, the facts, the original title, a
 * free full text), and the star, 「深入研究」 and 「⋯」; the details stay in 「⋯ › 详情」 either way.
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
export function FrontierCard({ item, expanded = false, onExpand, grouped = true, markSelected = false, onStar, onHide, onSave, saving = false, onOpened, onTag }: FrontierCardProps) {
  const titleId = useId();
  const navigate = useNavigate();
  const origin = useFrontierOrigin();
  const [details, setDetails] = useState(false);
  // A summary that fits in its three lines has nothing to expand: measure the clamp, not the text.
  const summary = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const element = summary.current;
    if (!element || expanded) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, item.summary]);
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
  const follow = async (kind: FrontierFollow["kind"], key: string, label: string, muted = false) => {
    try { await addFrontierFollow({ kind, key, label, muted }); toast.success(muted ? "已屏蔽" : "已关注"); }
    catch (error) { toast.error(frontierErrorMessage(error)); }
  };
  const more: MenuEntry[] = [
    { label: "详情", onSelect: () => setDetails(true) },
    { label: "整理为证据卡片", onSelect: () => { rememberFrontierPosition(); navigate(`/app/frontier/zones?fromItem=${encodeURIComponent(item.id)}`); } },
    ...(onSave ? [{ label: "存入知识库", disabled: saving, onSelect: () => onSave(item) }] : []),
    { label: "复制为 Markdown", onSelect: () => void copy() },
    { label: "不感兴趣", onSelect: () => onHide(item) },
    "separator",
    { label: `关注 ${item.source.name}`, onSelect: () => void follow("source", item.source.id, item.source.name) },
    { label: `屏蔽 ${item.source.name}`, onSelect: () => void follow("source", item.source.id, item.source.name, true) },
    ...(item.event ? [{ label: "同一事件的全部报道", onSelect: () => { rememberFrontierPosition(); navigate(eventPath(item.event!.id), { state: origin }); } }, { label: "关注此事件", onSelect: () => void follow("event", item.event!.id, item.title.slice(0, 120)) }] : []),
    ...item.entities.drugs.slice(0, 3).map((drug) => ({ label: `关注药物：${drug}`, onSelect: () => void follow("drug", drug, drug) })),
    ...item.specialties.slice(0, 2).map((specialty) => ({ label: `关注专科：${specialty.label}`, onSelect: () => void follow("specialty", specialty.key, specialty.label) })),
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
    ...(item.event ? ["separator" as const, { label: "同一事件的全部报道", onSelect: () => { rememberFrontierPosition(); navigate(eventPath(item.event!.id), { state: origin }); } }] : []),
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
          {item.source.platformProduced && <Tag>EviMed 出品</Tag>}
          {evidence && <Tag>{evidence}</Tag>}
          {flags.map((flag) => (flag.key === "retracted"
            ? <Tag key={flag.key} tone="safety">{flag.label}</Tag>
            : <span key={flag.key} className="shrink-0">· {flag.label}</span>))}
          {band && (
            <Tooltip content="编辑评分 · 满分 100">
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-caption font-semibold tabular-nums text-text-3">
                <span aria-hidden="true" data-band={band} className={cn("h-1.5 w-1.5 rounded-full", BAND_DOT[band])} />
                <span className="sr-only">编辑评分</span>
                {item.score}
              </span>
            </Tooltip>
          )}
        </div>

        <h3 id={titleId} data-row-title className="mt-1.5 text-body font-semibold leading-6">
          <a href={item.url} {...EXTERNAL} onClick={() => onOpened?.(item)}
            className={cn("rounded outline-none hover:text-accent hover:underline", item.state.read ? "text-text-2" : "text-text")}>
            {item.title}
          </a>
        </h3>
        {item.summary && <p ref={summary} className={cn("mt-1 max-w-measure whitespace-pre-line text-ui text-text-2", !expanded && "line-clamp-3")}>{item.summary}</p>}

        <div className="-ml-1 mt-2 flex min-h-6 flex-wrap items-center gap-x-2 text-ui text-text-3">
          {item.summary && onExpand && (clamped || expanded) && <button type="button" aria-expanded={expanded} onClick={onExpand} className={cn(INLINE_ACTION, "px-1 hover:text-text")}><span className="text-caption">{expanded ? "收起摘要" : "展开摘要"}</span></button>}
          {frontierDetailsOffered(item) && <button type="button" onClick={() => setDetails(true)} className={cn(INLINE_ACTION, "px-1 text-accent")}><span className="text-caption">详情</span></button>}
          {also > 0 && (
            <Menu label={`另有 ${also} 家报道`} align="start" items={reports}>
              <button type="button" className={cn(INLINE_ACTION, "px-1 hover:text-text")}>
                <span className="text-caption">另有 {also} 家报道 ›</span>
              </button>
            </Menu>
          )}
          {tags.map((tag) => (onTag ? (
            <Tooltip key={`${tag.kind}-${tag.key}`} content={tag.kind === "specialty" ? `只看${tag.label}` : `搜索“${tag.label}”`}>
              <button type="button" onClick={() => onTag(tag)} className={cn(INLINE_ACTION, "px-1 hover:text-text")}>
                <span className="text-caption">#{tag.label}</span>
              </button>
            </Tooltip>
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
