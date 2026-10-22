import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { addFrontierFollow, frontierErrorMessage, type FrontierFollow, type FrontierItem } from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  CARD_FLAG_KEYS,
  INLINE_ACTION,
  PLATFORM_LABELS,
  cardTags,
  evidenceTag,
  isSocialItem,
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
 * What can be done with one item, as the card's ⋯ and the reader's ⋯ both list it: 深入研究 (the reader's only), 整理为证据卡片,
 * 存入知识库 where the deployment can save, 复制为 Markdown, 不感兴趣, then following or muting its source, its event, its drugs and
 * its specialties; and the other institutions' reports (「另有 N 家报道」) with the way to the whole event. One list, so the card and the
 * reader never offer an item two different sets of things.
 */
export function useItemActions(item: FrontierItem, { reader = false, onHide, onSave, saving = false, onOpened, onOpenArticle }: {
  reader?: boolean;
  onHide: (item: FrontierItem) => void;
  onSave?: (item: FrontierItem) => void;
  saving?: boolean;
  onOpened?: (item: FrontierItem) => void;
  /** The card's 「详情」: the addressed reader. */
  onOpenArticle?: () => void;
}): { more: MenuEntry[]; reports: MenuEntry[]; research: () => void } {
  const navigate = useNavigate();
  const origin = useFrontierOrigin();
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
  const research = () => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(researchDraft(item)) } });
  const openEvent = () => { rememberFrontierPosition(); navigate(eventPath(item.event!.id), { state: origin }); };
  const more: MenuEntry[] = [
    ...(reader ? [{ label: "深入研究", onSelect: research }] : []),
    ...(!reader && onOpenArticle ? [{ label: "详情", onSelect: onOpenArticle }] : []),
    { label: "整理为证据卡片", onSelect: () => { rememberFrontierPosition(); navigate(`/app/frontier/zones?fromItem=${encodeURIComponent(item.id)}`); } },
    ...(onSave ? [{ label: "存入知识库", disabled: saving, onSelect: () => onSave(item) }] : []),
    { label: "复制为 Markdown", onSelect: () => void copy() },
    { label: "不感兴趣", onSelect: () => onHide(item) },
    "separator",
    { label: `关注 ${item.source.name}`, onSelect: () => void follow("source", item.source.id, item.source.name) },
    { label: `屏蔽 ${item.source.name}`, onSelect: () => void follow("source", item.source.id, item.source.name, true) },
    ...(item.event ? [{ label: "同一事件的全部报道", onSelect: openEvent }, { label: "关注此事件", onSelect: () => void follow("event", item.event!.id, item.title.slice(0, 120)) }] : []),
    ...item.entities.drugs.slice(0, 3).map((drug) => ({ label: `关注药物：${drug}`, onSelect: () => void follow("drug", drug, drug) })),
    ...item.specialties.slice(0, 2).map((specialty) => ({ label: `关注专科：${specialty.label}`, onSelect: () => void follow("specialty", specialty.key, specialty.label) })),
  ];
  const reports: MenuEntry[] = [
    ...item.alsoReportedBy.map((mention) => ({
      label: mention.sourceName,
      onSelect: () => {
        window.open(mention.url, "_blank", "noopener,noreferrer");
        onOpened?.(item);
      },
    })),
    ...(item.event ? ["separator" as const, { label: "同一事件的全部报道", onSelect: openEvent }] : []),
  ];
  return { more, reports, research };
}

/** Feed cards open the addressed reader; original-source links live in that reader. */
export function FrontierCard({ item, expanded = false, onExpand, grouped = true, markSelected = false, onStar, onHide, onSave, saving = false, onOpened, onTag }: FrontierCardProps) {
  const titleId = useId();
  const navigate = useNavigate();
  const origin = useFrontierOrigin();
  const location = useLocation();
  const articlePath = `/app/frontier/items/${encodeURIComponent(item.id)}`;
  const articleState = { ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: location.pathname.includes("/events/") ? "事件报道" : "前沿动态" } };
  const openArticle = () => { rememberFrontierPosition(); onOpened?.(item); navigate(articlePath, { state: articleState }); };
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
  const actionTextClass = "text-caption";
  const also = item.alsoReportedCount;
  const { more, reports, research } = useItemActions(item, { onHide, onSave, saving, onOpened, onOpenArticle: openArticle });
  // A post is said by its account (「Arena.ai @arena · X」); anything else by its institution.
  const platform = item.platform ? PLATFORM_LABELS[item.platform] : null;
  const who = isSocialItem(item) && item.author
    ? [[item.author.name, item.author.handle ? `@${item.author.handle}` : null].filter(Boolean).join(" "), platform].filter(Boolean).join(" · ")
    : item.source.name;
  const [thumbFailed, setThumbFailed] = useState(false);

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
          <span className="min-w-0 truncate">{who}</span>
          {item.source.platformProduced && <Tag>EviMed 出品</Tag>}
          {evidence && <Tag>{evidence}</Tag>}
          {flags.map((flag) => (flag.key === "retracted"
            ? <Tag key={flag.key} tone="safety">{flag.label}</Tag>
            : <span key={flag.key} className="shrink-0">· {flag.label}</span>))}
          {/* The dot and the number are one picture with a name of its own (review L-9); the number stays a bare grey number. */}
          {band && (
            <Tooltip content="编辑评分 · 满分 100">
              <span role="img" aria-label={`编辑评分 ${item.score}`} className="ml-auto inline-flex shrink-0 items-center gap-1 text-caption tabular-nums text-text-3">
                <span aria-hidden="true" data-band={band} className={cn("h-1.5 w-1.5 rounded-full", BAND_DOT[band])} />
                {item.score}
              </span>
            </Tooltip>
          )}
        </div>

        <div className="flex gap-4">
          <div className="min-w-0 flex-1">
            <h3 id={titleId} data-row-title className="mt-1.5 text-body font-semibold leading-6">
              <Link to={articlePath} state={articleState} onClick={() => { rememberFrontierPosition(); onOpened?.(item); }}
                className={cn("rounded outline-none hover:text-accent hover:underline", item.state.read ? "text-text-2" : "text-text")}>
                {item.title}
              </Link>
            </h3>
            {item.summary && <p ref={summary} className={cn("mt-1 max-w-measure whitespace-pre-line text-ui text-text-2", !expanded && "line-clamp-3")}>{item.summary}</p>}
          </div>
          {/* The item's first picture, the title's link again for the pointer (the title is the one a keyboard reaches); a picture
            * this deployment can no longer serve leaves no empty box. */}
          {item.thumb && !thumbFailed && (
            <Link to={articlePath} state={articleState} tabIndex={-1} aria-hidden="true" onClick={() => { rememberFrontierPosition(); onOpened?.(item); }}
              className="mt-2 shrink-0 overflow-hidden rounded-card bg-surface-2">
              <img src={item.thumb.url} alt="" loading="lazy" decoding="async" onError={() => setThumbFailed(true)}
                className="block h-16 w-24 object-cover sm:h-20 sm:w-32" />
            </Link>
          )}
        </div>

        <div className="-ml-1 mt-2 flex min-h-6 flex-wrap items-center gap-x-2 text-ui text-text-3">
          {item.summary && onExpand && (clamped || expanded) && <button type="button" aria-expanded={expanded} onClick={onExpand} className={cn(INLINE_ACTION, "px-1 hover:text-text")}><span className={actionTextClass}>{expanded ? "收起摘要" : "展开摘要"}</span></button>}
          <button type="button" onClick={openArticle} className={cn(INLINE_ACTION, "px-1 text-accent")}><span className={actionTextClass}>详情</span></button>
          {also > 0 && (
            <Menu label={`另有 ${also} 家报道`} align="start" items={reports}>
              <button type="button" className={cn(INLINE_ACTION, "px-1 hover:text-text")}>
                <span className={actionTextClass}>另有 {also} 家报道 ›</span>
              </button>
            </Menu>
          )}
          {tags.map((tag) => (onTag ? (
            <Tooltip key={`${tag.kind}-${tag.key}`} content={tag.kind === "specialty" ? `只看${tag.label}` : `搜索“${tag.label}”`}>
              <button type="button" onClick={() => onTag(tag)} className={cn(INLINE_ACTION, "px-1 hover:text-text")}>
                <span className={actionTextClass}>#{tag.label}</span>
              </button>
            </Tooltip>
          ) : <span key={`${tag.kind}-${tag.key}`} className={cn("px-1", actionTextClass)}>#{tag.label}</span>))}
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
              <span className={actionTextClass}>深入研究</span>
            </button>
            <Menu label="更多操作" items={more} />
          </div>
        </div>
      </article>
    </li>
  );
}
