import { Circle, CircleCheck, CircleDot, Clock, CircleSlash, BadgeCheck } from "lucide-react";
import type { GeoAction, GeoActionStatus } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import {
  articleLine,
  conditionsWord,
  expectedText,
  leadSource,
  routeWord,
  sourceName,
  statusShape,
  statusWord,
  whatLines,
  type StatusShape,
} from "./actionModel";
import { clusterContext, clusterName } from "./clusterModel";
import { ClusterLink } from "./ClusterLink";

/**
 * One action of 行动: two lines, every part of it a count or a word, nothing hidden behind a hover (owner, 2026-09-24).
 *
 *   ◐ 在写   品牌身份、规格与厂家  存量 · 认知与选药   纠正讲错 · 把信尔美说成需要每天注射一次     [打开稿件] [换信源 ▾] [⋯]
 *            稿件 科普稿件 · 针对 千问、元宝   信源 丁香园 ✓ +3 · 等媒介集市接通   预期 品牌提及率 3/12（样本不足）· 池目标 58%
 *
 * The group's name is the way to its drawer, the row (its title) is the way to the action's, and the three buttons are the three
 * things a person may want to do without opening anything: look at the article, send the action to another source, set it aside.
 * A skipped row stays on the page, quiet, with the way back (「恢复」).
 */

const SHAPE_ICON: Record<StatusShape, { icon: typeof Circle; tone: string }> = {
  hollow: { icon: Circle, tone: "text-text-3" },
  half: { icon: CircleDot, tone: "text-accent" },
  filled: { icon: CircleCheck, tone: "text-accent" },
  cited: { icon: BadgeCheck, tone: "text-accent-strong" },
  stale: { icon: Clock, tone: "text-warn-strong" },
  skipped: { icon: CircleSlash, tone: "text-text-3" },
};

/** The status as a shape and a word: a hollow ring (nothing yet) … a badge (an engine cited it); amber is for 「陈旧」. */
export function StatusMark({ status, className }: { status: GeoActionStatus; className?: string }) {
  const shape = SHAPE_ICON[statusShape(status)];
  const Icon = shape.icon;
  return (
    <span data-status-mark={status} className={cn("inline-flex items-center gap-1.5 text-caption text-text-2", className)}>
      <Icon size={16} aria-hidden="true" className={cn("shrink-0", shape.tone)} />
      {statusWord(status)}
    </span>
  );
}

export interface ActionRowProps {
  action: GeoAction;
  /** Draws the group's name on the row; a block that already has its group's heading leaves it out. */
  showCluster: boolean;
  /** The article the 「打开稿件」 button opens, when there is one. */
  article: { label: string } | null;
  busy?: boolean;
  canRun: boolean;
  canEdit: boolean;
  onOpen: () => void;
  onOpenArticle: () => void;
  onSkip: (skipped: boolean) => void;
  onSwap: (domain: string | null) => void;
  onAsk: () => void;
}

export function ActionRow({ action, showCluster, article, busy = false, canRun, canEdit, onOpen, onOpenArticle, onSkip, onSwap, onAsk }: ActionRowProps) {
  const skipped = action.status === "skipped";
  const what = whatLines(action);
  const written = articleLine(action);
  const lead = leadSource(action);
  const expected = expectedText(action);
  const conditions = lead ? conditionsWord(lead.conditions) : null;
  const route = lead ? routeWord(lead.route) : null;
  const others = Math.max(0, action.sources.length - 1);
  const group = action.group;
  // A source can be sent to another only where there is another website to send it to; the one an order already holds stays.
  const swappable = action.sources.filter((source) => source.domain && source.chosen !== "placed");
  const placed = action.sources.some((source) => source.chosen === "placed");
  const swapped = action.sources.find((source) => source.chosen === "swapped") ?? null;

  const swapItems: MenuEntry[] = [
    ...swappable.map((source) => ({
      label: `${sourceName(source)}${source.chosen === "swapped" ? "（当前）" : ""}`,
      checked: source.chosen === "swapped" || (!swapped && source === swappable[0]),
      onSelect: () => onSwap(source.chosen === "swapped" ? swapped?.domain ?? null : source.domain),
    })),
    ...(swapped ? ["separator" as const, { label: "恢复推荐", onSelect: () => onSwap(null) }] : []),
  ];
  const moreItems: MenuEntry[] = [
    ...(canEdit ? [{ label: skipped ? "恢复这条行动" : "跳过这条行动", onSelect: () => onSkip(!skipped) }] : []),
    ...(canRun ? [{ label: "让 AI 重写", onSelect: onAsk }] : []),
  ];

  return (
    <li
      data-geo-action={action.key}
      data-geo-action-kind={action.kind}
      data-geo-action-status={action.status}
      className={cn(
        "relative flex flex-wrap items-start gap-x-3 gap-y-2 rounded px-2 py-3 hover:bg-surface-2",
        busy && "animate-pulse",
      )}
    >
      <StatusMark status={action.status} className="w-20 shrink-0 pt-0.5" />
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-x-2">
          {showCluster && (
            <span className="relative z-sticky flex min-w-0 max-w-[45%] shrink-0 items-baseline gap-x-2">
              <ClusterLink groupId={group?.id} className="min-w-0 truncate text-ui text-link">{group ? clusterName(group) : "全项目"}</ClusterLink>
              {group && <span className="hidden shrink-0 text-caption text-text-3 xl:inline">{clusterContext(group)}</span>}
            </span>
          )}
          <button
            type="button"
            onClick={onOpen}
            data-geo-action-open=""
            title={what.detail ?? undefined}
            className={cn(
              "min-w-0 flex-1 truncate text-left text-ui after:absolute after:inset-0 after:content-['']",
              skipped ? "text-text-3" : "text-text",
            )}
          >
            {what.title}
            {what.detail && <span className="text-text-2">{` · ${what.detail}`}</span>}
          </button>
        </div>
        <div className="grid min-w-0 gap-x-6 gap-y-0.5 text-compact text-text-2 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.2fr)]">
          <p data-geo-action-article="" className="min-w-0 truncate">
            <span className="mr-1.5 text-caption text-text-3">稿件</span>
            {[written.kind, written.engines].filter(Boolean).join(" · ") || "还没有稿件"}
          </p>
          <p data-geo-action-sources="" className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-caption text-text-3">信源</span>
            {lead ? (
              <>
                <span className="min-w-0 truncate">{sourceName(lead)}</span>
                {conditions && <span className={cn("shrink-0 text-caption", conditions.met ? "text-accent-strong" : "text-warn-strong")}>{conditions.met ? "✓" : "✗"}<span className="sr-only">{conditions.text}</span></span>}
                {route && lead.route !== "market" && <Tag>{route === "自有渠道，发布后贴链接" ? "自有渠道" : route}</Tag>}
                {others > 0 && <span className="shrink-0 text-caption tabular-nums text-text-3">{`+${others}`}</span>}
              </>
            ) : <span className="text-text-3">没有推荐</span>}
          </p>
          <p data-geo-action-expected="" className="min-w-0 truncate">
            <span className="mr-1.5 text-caption text-text-3">预期</span>
            <span className="tabular-nums">{expected.now}</span>
            {expected.sample && <span className="text-text-3">{`（${expected.sample}）`}</span>}
            {expected.goal && <span className="text-text-3">{` · ${expected.goal}`}</span>}
          </p>
        </div>
      </div>
      <div className="pointer-events-auto relative z-sticky flex shrink-0 items-center gap-1 self-start">
        {article && <Button variant="text" size="sm" onClick={onOpenArticle}>{article.label}</Button>}
        {swapItems.length > 0 && canEdit && !placed && swappable.length > 0 && (swappable.length > 1 || swapped) && (
          <Menu label="换信源" items={swapItems}>
            <Button variant="text" size="sm">换信源</Button>
          </Menu>
        )}
        {moreItems.length > 0 && <Menu label={`“${group ? clusterName(group) : "全项目"}”这条行动的更多操作`} items={moreItems} />}
      </div>
    </li>
  );
}
