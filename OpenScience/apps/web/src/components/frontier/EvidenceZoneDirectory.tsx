import { useCallback, useEffect, useState } from "react";
import { Layers, Star } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import type { FilterOption } from "@/components/ui/FilterChips";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { BlockHeading, Section } from "@/components/ui/Section";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { cn } from "@/lib/cn";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";
import {
  fetchZoneDirectory,
  followZoneSummary,
  type ZoneDirectory,
  type ZoneDirectoryView,
  type ZoneSummary,
} from "@/lib/evidenceTopicClient";
import { FRONTIER_SPECIALTIES } from "@/lib/frontierClient";
import { formatDay } from "@/lib/format";
import type { EvidenceFrom } from "./FrontierBack";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { rememberFrontierPosition } from "./frontierReadingState";
import { useEvidenceScope } from "./useEvidenceScope";
import { zonePath } from "./zoneLinks";

/**
 * The topic directory of 「证据专区」 (owner 2026-10-29; plan `2026-10-29-evidence-zone-topics.md` §4.4): a zone is one topic of two or
 * three keywords, and the directory lists them three ways — 推荐 (the platform's zones: specialty → group → zone), 我的 (the reader's
 * own, then the ones they follow) and 大家建的 (other readers' published zones).
 *
 * Hidden knowledge:
 *
 *  - The view lives in the address as `scope=` (`mine`, `community`; none is 推荐), the specialty as `zoneSpecialty=`: `specialty` is the
 *    feed's own 「筛选」 and is kept across views. An older link's `scope=owned|following` reads as 我的.
 *  - A directory row carries no revision unless the server sends one, so following reads the zone first (`followZoneSummary`).
 *  - 我的 lists the reader's own zones first; which rows those are is `owned` where the server says it, else the first
 *    `userZones.count` rows of an unfiltered list (the server's order). An own zone has no star: it is always followed.
 *  - Nothing here is paged: the server answers the whole directory.
 */

export const ZONE_VIEWS: readonly FilterOption<ZoneDirectoryView>[] = [
  { value: "recommended", label: "推荐" },
  { value: "mine", label: "我的" },
  { value: "community", label: "大家建的" },
];

/** The view a link names (`?scope=`); an older link's `owned` and `following` are 我的, every other value is 推荐. */
export function readZoneView(value: string | null): ZoneDirectoryView {
  if (value === "community") return "community";
  return value === "mine" || value === "owned" || value === "following" ? "mine" : "recommended";
}

/** The zones of a directory, wherever it lists them (groups of the recommended view, the flat list of the others). */
export function directoryZones(directory: ZoneDirectory): ZoneSummary[] {
  return directory.view === "recommended" ? directory.groups.flatMap((group) => group.sections.flatMap((section) => section.zones)) : directory.zones;
}

function mapZones(directory: ZoneDirectory, change: (zone: ZoneSummary) => ZoneSummary): ZoneDirectory {
  return {
    ...directory,
    groups: directory.groups.map((group) => ({ ...group, sections: group.sections.map((section) => ({ ...section, zones: section.zones.map(change) })) })),
    zones: directory.zones.map(change),
  };
}

export interface ZoneDirectoryState {
  view: ZoneDirectoryView;
  directory: ZoneDirectory | null;
  loading: boolean;
  error: string | null;
  /** Whether this reader may make a zone (the server says so with the list). */
  canCreate: boolean;
  /** The id of the zone whose follow is being changed. */
  busy: string | null;
  /** Whether a search or a specialty narrows the list. */
  filtered: boolean;
  follow: (zone: ZoneSummary) => Promise<void>;
  retry: () => void;
}

/**
 * The directory's data: one view for a specialty and a search, and following a zone in place. Read only while `enabled`, so the feed
 * page can hold it beside its other views and ask nothing until 证据专区 is open.
 */
export function useZoneDirectory({ view, specialty, query, enabled = true }: {
  view: ZoneDirectoryView;
  specialty: string;
  query: string;
  enabled?: boolean;
}): ZoneDirectoryState {
  const [directory, setDirectory] = useState<ZoneDirectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const capture = useEvidenceScope(`${view}:${specialty}:${query}:${refresh}`);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setBusy(null);
    setError(null);
    setDirectory(null);
    fetchZoneDirectory(view, { specialty: specialty || null, q: query })
      .then((answer) => { if (active) setDirectory(answer); })
      .catch((reason) => { if (active) setError(evidenceErrorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, view, specialty, query, refresh]);

  const follow = useCallback(async (zone: ZoneSummary) => {
    const current = capture();
    setBusy(zone.id);
    setError(null);
    try {
      const updated = await followZoneSummary(zone, !zone.following);
      if (current()) {
        setDirectory((previous) => previous && mapZones(previous, (entry) => (entry.id === zone.id ? { ...entry, following: updated.following, revision: updated.revision } : entry)));
      }
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setBusy(null);
    }
  }, [capture]);

  return {
    view, directory, loading, error, busy, follow, canCreate: directory?.canCreate === true,
    filtered: Boolean(specialty || query),
    retry: () => setRefresh((value) => value + 1),
  };
}

/**
 * The directory's controls for a toolbar: the view as the first control (a row of chips that stays in sight on a phone), the
 * specialty as a menu, and the count of the zones listed. 「新建专区」 is the page's action in its header (`frontierHeaderActions`).
 */
export function zoneDirectoryControls({ view, onView, specialty, onSpecialty, directory }: {
  view: ZoneDirectoryView;
  onView: (view: ZoneDirectoryView) => void;
  specialty: string;
  onSpecialty: (specialty: string) => void;
  directory: ZoneDirectoryState;
}): { filters: ToolbarFilter[]; summary: string | undefined } {
  const total = directory.directory?.total;
  return {
    filters: [
      { kind: "chips", label: "专区视图", pinned: true, options: ZONE_VIEWS, value: view, onChange: (next) => onView(readZoneView(next)) },
      {
        kind: "select", label: "专科", emptyText: "全部专科", allLabel: "全部专科",
        options: FRONTIER_SPECIALTIES.map((entry) => ({ value: entry.key, label: entry.label })),
        value: specialty || null, onChange: (next) => onSpecialty(next ?? ""),
      },
    ],
    summary: typeof total === "number" ? `${total} 个专区` : undefined,
  };
}

/** 「近 7 天 37 条 · 卡片 2」; a quiet zone says when it was last updated instead of a week's count. */
function zoneMeta(zone: ZoneSummary, view: ZoneDirectoryView, own: boolean): string {
  const parts: string[] = [];
  if (own) parts.push(zone.published ? "已公开" : "仅自己可见");
  if (zone.lifecycle === "quiet") {
    const day = formatDay(zone.latest?.at ?? zone.updatedAt);
    parts.push(day ? `最近更新于 ${day}` : "近期没有更新");
  } else parts.push(`近 7 天 ${zone.counts.week} 条`);
  if (zone.cards > 0) parts.push(`卡片 ${zone.cards}`);
  if (view === "community") {
    if (zone.creator) parts.push(`${zone.creator} 创建`);
    if (zone.followers) parts.push(`${zone.followers} 人关注`);
  }
  return parts.join(" · ");
}

function ZoneRow({ zone, view, own, busy, from, onFollow }: {
  zone: ZoneSummary;
  view: ZoneDirectoryView;
  own: boolean;
  busy: boolean;
  from?: EvidenceFrom;
  onFollow: (zone: ZoneSummary) => void;
}) {
  return (
    <ListRow
      to={zonePath(zone)}
      state={from ? { evidenceFrom: from } : undefined}
      onOpen={rememberFrontierPosition}
      title={zone.title}
      meta={(
        <>
          <span className="block tabular-nums">{zoneMeta(zone, view, own)}</span>
          {zone.latest && <span className="mt-0.5 block truncate">最新：{zone.latest.title}</span>}
        </>
      )}
      actions={own ? undefined : (
        <IconButton
          icon={Star}
          size="sm"
          label={zone.following ? `取消关注“${zone.title}”` : `关注“${zone.title}”`}
          aria-pressed={zone.following}
          disabled={busy}
          className={cn(zone.following && "text-accent [&_svg]:fill-current")}
          onClick={() => onFollow(zone)}
        />
      )}
    />
  );
}

/**
 * The directory under the page's band: 推荐 as specialty → group → zones, 我的 and 大家建的 as one list each. What it says with no
 * zones is a way on — to making one, or out of a search — and a search for a group's name ends in a row that makes a zone from it
 * (「新建专区：乳腺癌 + …」), the way to a topic nobody has written yet.
 *
 * `from` is where a zone's page goes back to (`FrontierBack`): the view with its address, so 返回 lands where the reader was.
 */
export function ZoneDirectoryBody({ state, query, from, onCreate, onClearFilters }: {
  state: ZoneDirectoryState;
  query: string;
  from?: EvidenceFrom;
  /**
   * Opens the editor: with words to start from where the reader searched; `generate` drafts them at once (a search that found no zone), where
   * the name of a group is only filled in, for the reader to add the qualifier to (「乳腺癌 + …」).
   */
  onCreate: (text?: string, generate?: boolean) => void;
  onClearFilters: () => void;
}) {
  const { view, directory, loading, error, busy, canCreate, filtered } = state;
  if (error) return <EmptyState title={error} action={<Button variant="secondary" onClick={state.retry}>重试</Button>} />;
  if (loading || !directory) return <FrontierSkeleton />;
  const zones = directoryZones(directory);
  // 我的 lists the reader's own zones first: by the server's word, else by the order it keeps while nothing narrows the list.
  const ownCount = filtered ? 0 : directory.userZones.count;
  const isOwn = (zone: ZoneSummary, index: number) => zone.owned ?? (view === "mine" && zone.kind === "user" && index < ownCount);
  const row = (zone: ZoneSummary, index: number) => (
    <ZoneRow key={zone.id} zone={zone} view={view} own={isOwn(zone, index)} busy={busy === zone.id} from={from} onFollow={(target) => void state.follow(target)} />
  );
  // A search for a broad word that names a group lists the group's zones and ends in a way to make one from it.
  const groupSearch = view === "recommended" && query.length >= 2 && directory.groups.some((group) => group.sections.some((section) => section.label === query || section.label.includes(query)));
  const createFromSearch = canCreate && groupSearch ? (
    <div className="mt-6">
      <Button variant="secondary" onClick={() => onCreate(query)}>新建专区：{query} + …</Button>
    </div>
  ) : null;

  if (zones.length === 0) {
    const action = filtered
      ? <Button variant="secondary" onClick={onClearFilters}>清除搜索</Button>
      : canCreate ? <Button variant="secondary" onClick={() => onCreate()}>新建专区</Button> : null;
    const title = filtered ? "没有找到匹配的专区"
      : view === "mine" ? "还没有自己的专区。用一句话说出想持续看什么，就能建一个。"
        : view === "community" ? "还没有人公开自己建的专区" : "暂无证据专区";
    return (
      <>
        <EmptyState icon={Layers} title={title} {...(action ? { action } : {})} />
        {filtered && canCreate && query.length >= 2 && (
          <div className="mt-4 flex justify-center"><Button variant="text" onClick={() => onCreate(query, true)}>以此新建专区</Button></div>
        )}
      </>
    );
  }

  if (view !== "recommended") {
    return (
      <>
        <List divided label={view === "mine" ? "我的专区" : "大家建的专区"}>{zones.map(row)}</List>
        {view === "mine" && directory.userZones.max > 0 && (
          <p className="mt-4 text-caption tabular-nums text-text-3">已建 {directory.userZones.count} / {directory.userZones.max} 个</p>
        )}
      </>
    );
  }
  // A running index over the groups: the same zone is never listed twice, so a row's place is its place in the whole list.
  let index = 0;
  return (
    <>
      {directory.groups.map((group) => (
        <Section key={group.specialty.key} title={group.specialty.label} count={group.sections.reduce((sum, section) => sum + section.zones.length, 0)}>
          {group.sections.map((section) => (
            section.label && group.sections.length > 0 ? (
              // A group inside a specialty is a label over its zones, in the caption's rung: the page already holds the title, the
              // specialty's heading, the rows and the meta, and a fifth size × weight pair for a name in between is one too many.
              <div key={section.label} className="mt-6 first:mt-0">
                <BlockHeading className="mb-1 text-caption text-text-3">{section.label}</BlockHeading>
                <List divided label={`${section.label}专区`}>{section.zones.map((zone) => row(zone, index++))}</List>
              </div>
            ) : (
              <List key="ungrouped" divided label={`${group.specialty.label}专区`}>{section.zones.map((zone) => row(zone, index++))}</List>
            )
          ))}
        </Section>
      ))}
      {createFromSearch}
    </>
  );
}
