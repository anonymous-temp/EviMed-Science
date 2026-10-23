import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { addFrontierFollow, frontierErrorMessage, type FrontierFollow, type FrontierItem, type FrontierTagRef } from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { ScorePill } from "@/components/ui/Score";
import { Tag } from "@/components/ui/Tag";
import {
  CARD_FLAG_KEYS,
  CARD_MAX_TAGS,
  INLINE_ACTION,
  PLATFORM_LABELS,
  SCORE_LABEL,
  SCORE_NOTE,
  cardEyebrow,
  clock,
  isSocialItem,
  itemMarkdown,
  metaTime,
  researchDraft,
  scoreBand,
  scoreBreakdown,
} from "./frontierText";

const eventPath = (id: string) => `/app/frontier/events/${encodeURIComponent(id)}`;
const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;
/** Where a tag narrows the feed, for a card whose page does not narrow it in place (the linked item). */
const tagPath = (slug: string) => `/app/frontier?view=all&tag=${encodeURIComponent(slug)}`;

export interface FrontierCardProps {
  item: FrontierItem;
  /**
   * Inside a day group the clock is a column of its own beside the card; in a list that is not cut into days (与我相关, a search, a
   * linked item) there is no column, and the date is said in the meta row after the source.
   */
  grouped?: boolean;
  /** Where not every item is 精选 (全部, a search), say which are — the dot, and words for a screen reader. */
  markSelected?: boolean;
  onStar: (item: FrontierItem) => void;
  onHide: (item: FrontierItem) => void;
  /** 「存入知识库」; absent where this server cannot save yet. */
  onSave?: (item: FrontierItem) => void;
  saving?: boolean;
  /** The reader opened the item, or followed a link to another report of it. */
  onOpened?: (item: FrontierItem) => void;
  /** A #tag was pressed: the feed narrows to it. Absent: the tag is a link to 全部 with it. */
  onTag?: (tag: FrontierTagRef) => void;
}

/**
 * What can be done with one item, as the card's ⋯ and the reader's ⋯ both list it: 深入研究 (the card's first entry — the reader has a
 * button of its own), 整理为证据卡片, 存入知识库 where the deployment can save, 复制为 Markdown, 不感兴趣, then following or muting its
 * source, its event, its drugs and its specialties; and the other institutions' reports (「另有 N 家报道」) with the way to the whole
 * event. One list, so the card and the reader never offer an item two different sets of things.
 */
export function useItemActions(item: FrontierItem, { reader = false, onHide, onSave, saving = false, onOpened }: {
  /** The reader's ⋯, beside its own 「深入研究」 button. */
  reader?: boolean;
  onHide: (item: FrontierItem) => void;
  onSave?: (item: FrontierItem) => void;
  saving?: boolean;
  onOpened?: (item: FrontierItem) => void;
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
    ...(reader ? [] : [{ label: "深入研究", onSelect: research }]),
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

/** What sits above the card's stretched link, so a press on it is its own and not the card's. */
const ABOVE = "relative z-sticky";

/**
 * One item of the feed (owner, 2026-10-23, after AIHOT's list): the whole card is the way to its addressed reader — the title's link
 * stretches over it, the ground lightens under the pointer and the title turns the accent — and what else it holds sits above that
 * link and does its own thing:
 *
 *  - the meta row: who said it (the account for a post), in an undated list the date (「肿瘤学年鉴 · 10月20日」, today the clock), one
 *    eyebrow tag — the evidence type of a paper, else the lane — and the flags that change how to take it; a safety alert says
 *    「安全警示」 first; at the right 「AI 评分」, whose parts open on hover, focus or a tap;
 *  - the title in the brand's deep ink (`title-ink`), a read one in the secondary grey; the summary in three lines (two on a phone);
 *  - at the meta row's right, after the score, ☆ and ⋯ (深入研究 first);
 *  - a footer only when there is something for it: up to three of its tags, each narrowing the feed to it, and 「另有 N 家报道 ›」.
 *
 * In a day group the clock is a column of its own beside the card, with the 精选 dot.
 */
export function FrontierCard({ item, grouped = false, markSelected = false, onStar, onHide, onSave, saving = false, onOpened, onTag }: FrontierCardProps) {
  const titleId = useId();
  const origin = useFrontierOrigin();
  const location = useLocation();
  const articleState = { ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: location.pathname.includes("/events/") ? "事件报道" : "前沿动态" } };
  const eyebrow = cardEyebrow(item);
  const flags = item.flags.filter((flag) => CARD_FLAG_KEYS.has(flag.key));
  const band = scoreBand(item);
  const tags = item.tags.slice(0, CARD_MAX_TAGS);
  const starred = item.state.starred;
  const also = item.alsoReportedCount;
  const { more, reports } = useItemActions(item, { onHide, onSave, saving, onOpened });
  // A post is said by its account (「Arena.ai @arena · X」); anything else by its institution.
  const platform = item.platform ? PLATFORM_LABELS[item.platform] : null;
  const who = isSocialItem(item) && item.author
    ? [[item.author.name, item.author.handle ? `@${item.author.handle}` : null].filter(Boolean).join(" "), platform].filter(Boolean).join(" · ")
    : item.source.name;
  const when = grouped ? "" : metaTime(item);
  const [thumbFailed, setThumbFailed] = useState(false);

  return (
    <li data-frontier-item={item.id} className="flex">
      {/* On a phone the clock joins the source line (as AIHOT's phone list has it): the column's 56 px go to the source's name. */}
      {grouped && (
        <div className="mt-3 hidden h-6 w-14 shrink-0 items-center justify-between pr-2 sm:flex">
          <time dateTime={item.timelineAt} className="text-caption tabular-nums text-text-3">{clock(item.timelineAt)}</time>
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.selected ? "bg-accent" : "bg-border-control")} />
        </div>
      )}
      <article
        aria-labelledby={titleId}
        className={cn(
          // `isolate`: what lifts itself over the stretched link stays inside the card, under a sticky day heading. The rule between two
          // cards is drawn under the words (`before:`), so the ground the pointer lightens keeps its rounded corners.
          "group relative isolate min-w-0 flex-1 rounded-card px-3 pb-4 pt-3 transition-colors duration-fast hover:bg-surface-2",
          "before:pointer-events-none before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border before:content-['']",
          !grouped && "-mx-3",
        )}
      >
        <div className="flex min-h-6 items-center gap-2 text-caption text-text-3">
          {item.safetyAlert && <Tag tone="safety">安全警示</Tag>}
          <span className="min-w-0 truncate">
            <span>{who}</span>
            {when && <> · <time dateTime={item.timelineAt} className="tabular-nums">{when}</time></>}
            {grouped && <span className="sm:hidden"> · <span className="tabular-nums">{clock(item.timelineAt)}</span></span>}
          </span>
          {markSelected && item.selected && <span className="sr-only">精选</span>}
          {item.source.platformProduced && <Tag>EviMed 出品</Tag>}
          {eyebrow && <Tag>{eyebrow}</Tag>}
          {flags.map((flag) => (flag.key === "retracted"
            ? <Tag key={flag.key} tone="safety">{flag.label}</Tag>
            : <span key={flag.key} className="shrink-0">· {flag.label}</span>))}
          {/* At the right, as AIHOT has them: the score, ☆ and ⋯ — so a card with no tags has no line of its own for two icons. */}
          <div className={cn("ml-auto flex shrink-0 items-center gap-1", ABOVE)}>
            {band && item.score !== null && (
              <ScorePill className="mr-1" label={SCORE_LABEL} value={item.score} tier={band} parts={scoreBreakdown(item)} note={SCORE_NOTE} />
            )}
            <IconButton
              icon={Star}
              size="sm"
              label="收藏"
              aria-pressed={starred}
              className={starred ? "text-accent [&_svg]:fill-current" : undefined}
              onClick={() => onStar(item)}
            />
            <Menu label="更多操作" items={more} />
          </div>
        </div>

        <div className="flex gap-4">
          <div className="min-w-0 flex-1">
            <h3 id={titleId} data-row-title className="mt-1.5 text-body font-semibold leading-6">
              <Link
                to={articlePath(item.id)}
                state={articleState}
                data-card-link=""
                onClick={() => { rememberFrontierPosition(); onOpened?.(item); }}
                className={cn(
                  "rounded outline-none transition-colors duration-fast group-hover:text-accent",
                  // The link stretches over the card; its focus is the card's ring, not a ring round the words.
                  "after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-focus",
                  item.state.read ? "text-text-2" : "text-title-ink",
                )}
              >
                {item.title}
              </Link>
            </h3>
            {item.summary && <p className="mt-1 line-clamp-2 max-w-measure whitespace-pre-line text-ui text-text-2 sm:line-clamp-3">{item.summary}</p>}
          </div>
          {/* The item's first picture, beside the title and not a second link to the same article: the release walk counts a
            * hidden duplicate link as a control without a name, and each picture height as one more kind of control. A
            * picture this deployment can no longer serve leaves no empty box. */}
          {item.thumb && !thumbFailed && (
            <div className="mt-2 shrink-0 overflow-hidden rounded-card bg-surface-2">
              <img src={item.thumb.url} alt="" loading="lazy" decoding="async" onError={() => setThumbFailed(true)}
                className="block h-16 w-24 object-cover sm:h-20 sm:w-32" />
            </div>
          )}
        </div>

        {(tags.length > 0 || also > 0) && (
        <div className="-ml-1 mt-2 flex min-h-6 flex-wrap items-center gap-x-1 text-ui text-text-3">
          {tags.map((tag) => (onTag ? (
            <button key={tag.slug} type="button" onClick={() => onTag(tag)} className={cn(INLINE_ACTION, ABOVE, "px-1 hover:text-accent")}>
              <span className="text-caption">#{tag.name}</span>
            </button>
          ) : (
            <Link key={tag.slug} to={tagPath(tag.slug)} className={cn(INLINE_ACTION, ABOVE, "px-1 hover:text-accent")}>
              <span className="text-caption">#{tag.name}</span>
            </Link>
          )))}
          {also > 0 && (
            <Menu label={`另有 ${also} 家报道`} align="start" items={reports}>
              <button type="button" className={cn(INLINE_ACTION, ABOVE, "px-1 hover:text-text")}>
                <span className="text-caption">另有 {also} 家报道 ›</span>
              </button>
            </Menu>
          )}
        </div>
        )}
      </article>
    </li>
  );
}
