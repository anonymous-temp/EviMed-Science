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
  /** The addressed reader already displays the headline and text. */
  reader?: boolean;
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

/** Feed cards open the addressed reader; original-source links live in that reader. */
export function FrontierCard({ reader = false, item, expanded = false, onExpand, grouped = true, markSelected = false, onStar, onHide, onSave, saving = false, onOpened, onTag }: FrontierCardProps) {
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
    ...(!reader ? [{ label: "详情", onSelect: openArticle }] : []),
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
      {!reader && <div className="mt-4 flex h-6 w-14 shrink-0 items-center justify-between pr-2">
        <time dateTime={item.timelineAt} className="text-caption tabular-nums text-text-3">{timeColumn(item, grouped)}</time>
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.selected ? "bg-accent" : "bg-border-control")} />
        {markSelected && item.selected && <span className="sr-only">精选</span>}
      </div>}
      <article aria-labelledby={reader ? undefined : titleId} className="min-w-0 flex-1 border-b border-border pb-5 pt-4">
        {!reader && <><div className="flex min-h-6 items-center gap-2 text-caption text-text-3">
          {item.safetyAlert && <Tag tone="safety">安全警示</Tag>}
          <span className="min-w-0 truncate">{item.source.name}</span>
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

        <h3 id={titleId} data-row-title className="mt-1.5 text-body font-semibold leading-6">
          <Link to={articlePath} state={articleState} onClick={() => { rememberFrontierPosition(); onOpened?.(item); }}
            className={cn("rounded outline-none hover:text-accent hover:underline", item.state.read ? "text-text-2" : "text-text")}>
            {item.title}
          </Link>
        </h3>
        {item.summary && <p ref={summary} className={cn("mt-1 max-w-measure whitespace-pre-line text-ui text-text-2", !expanded && "line-clamp-3")}>{item.summary}</p>}</>}

        <div className="-ml-1 mt-2 flex min-h-6 flex-wrap items-center gap-x-2 text-ui text-text-3">
          {item.summary && onExpand && (clamped || expanded) && <button type="button" aria-expanded={expanded} onClick={onExpand} className={cn(INLINE_ACTION, "px-1 hover:text-text")}><span className="text-caption">{expanded ? "收起摘要" : "展开摘要"}</span></button>}
          {!reader && <button type="button" onClick={openArticle} className={cn(INLINE_ACTION, "px-1 text-accent")}><span className="text-caption">详情</span></button>}
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
    </li>
  );
}
