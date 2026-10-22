import { useCallback, useEffect, useRef, useState } from "react";
import { EVIDENCE_ZONE_KINDS, EVIDENCE_ZONE_KIND_LABELS_ZH } from "@evimed/domain";
import { Layers } from "lucide-react";
import { useNavigate } from "react-router";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { ShowMore } from "@/components/ui/ShowMore";
import type { FilterOption } from "@/components/ui/FilterChips";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { evidenceErrorMessage, followEvidenceZone, listEvidenceZones, type EvidenceZone } from "@/lib/evidenceZoneClient";
import { ZoneEditor } from "./EvidenceEditors";
import type { EvidenceFrom } from "./FrontierBack";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { rememberFrontierPosition } from "./frontierReadingState";
import { TopicRequests } from "./TopicRequests";
import { useEvidenceFeatures } from "./useEvidenceFeatures";
import { useEvidenceScope } from "./useEvidenceScope";

/** Whose zones the directory lists: every published zone, the reader's own, or the ones the reader follows. */
export type ZoneScope = "public" | "owned" | "following";

export const ZONE_SCOPES: readonly FilterOption<ZoneScope>[] = [
  { value: "public", label: "全部专区" },
  { value: "owned", label: "我创建的" },
  { value: "following", label: "我关注的" },
];

/** The scope a link names (`?scope=`); every other value is 全部专区. */
export function readZoneScope(value: string | null): ZoneScope {
  return value === "owned" || value === "following" ? value : "public";
}

/** A zone with no evidence yet reads 「暂无证据」 — not a count of nothing — and stands after the zones that have some. */
const emptyLast = (zones: EvidenceZone[]) =>
  [...zones].sort((a, b) => Number(a.evidenceCount === 0) - Number(b.evidenceCount === 0));

export interface ZoneDirectory {
  items: EvidenceZone[];
  /** How many zones match, where the server counts them. */
  total: number | null;
  cursor: string | null;
  loading: boolean;
  error: string | null;
  /** Whether this reader may make a zone (the server says so with the list). */
  canCreate: boolean;
  /** 「申请选题」 is offered (the public evidence pages are on, and this is not the chooser of a zone for an item). */
  requestable: boolean;
  /** Pages read so far, so that coming back reads as many again. */
  pages: number;
  /** The id of the zone whose follow is being changed. */
  busy: string | null;
  creating: boolean;
  setCreating: (creating: boolean) => void;
  /** The topic typed in 「申请选题」, or null while its drawer is closed. */
  asking: string | null;
  setAsking: (topic: string | null) => void;
  more: () => Promise<void>;
  follow: (zone: EvidenceZone) => Promise<void>;
  retry: () => void;
}

/**
 * The evidence-zone directory's data: one page of zones for a scope and a search, the next pages on request, and following a zone in
 * place. Read only while `enabled`, so the feed page can hold it beside its other views and ask nothing until 证据专区 is open;
 * `restorePages` reads that many pages at once, for a reader coming back to where they were.
 */
export function useZoneDirectory({ scope, query, enabled = true, fromItem = null, restorePages = 1 }: {
  scope: ZoneScope;
  query: string;
  enabled?: boolean;
  /** The chooser of a zone for one frontier item: the reader's own zones, and no 申请选题. */
  fromItem?: string | null;
  restorePages?: number;
}): ZoneDirectory {
  const [items, setItems] = useState<EvidenceZone[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const features = useEvidenceFeatures();
  const capture = useEvidenceScope(`${query}:${scope}:${refresh}`);
  const wanted = useRef(Math.max(1, Math.min(20, Math.floor(restorePages))));
  const listScope = scope === "public" ? undefined : scope;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setBusy(null);
    setError(null);
    setItems([]);
    setCursor(null);
    const read = async () => {
      let page = await listEvidenceZones(query, null, listScope);
      if (!active) return;
      const zones = [...page.items];
      let pagesRead = 1;
      // A reader coming back finds as many pages as they had read; once, then a change of scope or search starts at one.
      while (pagesRead < wanted.current && page.nextCursor) {
        page = await listEvidenceZones(query, page.nextCursor, listScope);
        if (!active) return;
        zones.push(...page.items.filter((zone) => !zones.some((known) => known.id === zone.id)));
        pagesRead += 1;
      }
      wanted.current = 1;
      setCanCreate(page.canCreate === true);
      setTotal(page.total);
      setItems(zones);
      setCursor(page.nextCursor);
      setPages(pagesRead);
    };
    read()
      .catch((reason) => { if (active) setError(evidenceErrorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, query, listScope, refresh]);

  const more = useCallback(async () => {
    if (!cursor) return;
    const current = capture();
    setLoading(true);
    setError(null);
    try {
      const page = await listEvidenceZones(query, cursor, listScope);
      if (current()) {
        setItems((previous) => [...previous, ...page.items]);
        setCursor(page.nextCursor);
        setPages((value) => value + 1);
      }
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setLoading(false);
    }
  }, [capture, cursor, listScope, query]);

  const follow = useCallback(async (zone: EvidenceZone) => {
    const current = capture();
    setBusy(zone.id);
    setError(null);
    try {
      const updated = await followEvidenceZone(zone);
      if (current()) setItems((previous) => previous.map((item) => (item.id === zone.id ? updated : item)));
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setBusy(null);
    }
  }, [capture]);

  return {
    items, total, cursor, loading, error, canCreate, pages, busy, creating, setCreating, asking, setAsking,
    requestable: features.publicPages && !fromItem,
    more, follow,
    retry: () => setRefresh((value) => value + 1),
  };
}

/**
 * The directory's controls for a toolbar: the scope as a row of chips, and the count of a search's matches. The chooser offers the
 * reader's own zones only, so it has no scope to choose.
 */
export function zoneDirectoryControls({ scope, onScope, query, directory, chooser = false }: {
  scope: ZoneScope;
  onScope: (scope: ZoneScope) => void;
  query: string;
  directory: ZoneDirectory;
  chooser?: boolean;
}): { filters: ToolbarFilter[]; summary: string | undefined } {
  return {
    filters: chooser ? [] : [{ kind: "chips", label: "专区范围", options: ZONE_SCOPES, value: scope, onChange: (next) => onScope(readZoneScope(next)) }],
    summary: query && directory.total !== null ? `${directory.total} 个匹配专区` : undefined,
  };
}

/**
 * The evidence zones, grouped by kind — 官方, 产品, 用户 — and each group's zones in a list; a zone opens on its own addressed page.
 * What it has to say with no zones is a way on: to every zone, to making one, to asking for a topic nobody has written, or out of a
 * search. It is the body of the feed page's 证据专区 view and of the chooser of a zone for a frontier item, which share every row.
 *
 * `from` is where a zone's page goes back to (`FrontierBack`): the view with its scope, so 返回 lands where the reader was, at the
 * same scroll (the feed page remembers it as the reader leaves).
 */
export function ZoneDirectoryBody({ directory, scope, query, fromItem = null, from, onScope, onClearSearch }: {
  directory: ZoneDirectory;
  scope: ZoneScope;
  query: string;
  fromItem?: string | null;
  from?: EvidenceFrom;
  onScope: (scope: ZoneScope) => void;
  onClearSearch: () => void;
}) {
  const navigate = useNavigate();
  const { items, total, cursor, loading, error, canCreate, requestable, busy, creating, setCreating, asking, setAsking } = directory;
  const zonePath = (zone: EvidenceZone) =>
    `/app/frontier/zones/${encodeURIComponent(zone.id)}${fromItem ? `?fromItem=${encodeURIComponent(fromItem)}` : ""}`;
  // Zones are grouped by kind; the group's name is told only where there is more than one group to tell apart.
  const kinds = EVIDENCE_ZONE_KINDS.filter((kind) => items.some((zone) => (zone.kind ?? "user") === kind));
  // An empty list says where to go from it: to every zone, to the one the reader may make, to a topic nobody has written, or out of a search.
  const emptyAction = scope === "following"
    ? <Button variant="secondary" onClick={() => onScope("public")}>看全部专区</Button>
    : canCreate && scope === "owned" && !query
      ? <Button variant="secondary" onClick={() => setCreating(true)}>新建专区</Button>
      : requestable
        ? <Button variant="secondary" onClick={() => setAsking("")}>申请选题</Button>
        : query
          ? <Button variant="secondary" onClick={onClearSearch}>清除搜索</Button>
          : null;
  const list = (zones: EvidenceZone[]) => (
    <List divided label="证据专区">
      {zones.map((zone) => {
        const counts = [
          zone.state === "draft" ? "草稿" : null,
          zone.evidenceCount === null ? null : zone.evidenceCount === 0 ? "暂无证据" : `${zone.evidenceCount} 条证据`,
        ].filter(Boolean).join(" · ");
        return (
          <ListRow
            key={zone.id}
            to={zonePath(zone)}
            state={from ? { evidenceFrom: from } : undefined}
            onOpen={rememberFrontierPosition}
            title={zone.title}
            meta={(zone.description || counts) ? (
              <>
                {zone.description && <span className="line-clamp-2 max-w-measure text-text-2">{zone.description}</span>}
                {counts && <span className={zone.description ? "mt-1 block" : "block"}>{counts}</span>}
              </>
            ) : undefined}
            actions={zone.canFollow ? (
              <Button variant="secondary" size="sm" loading={busy === zone.id} onClick={() => void directory.follow(zone)}>
                {zone.following ? "取消关注" : "关注"}
              </Button>
            ) : undefined}
          />
        );
      })}
    </List>
  );
  return (
    <>
      {creating && (
        <div className="mb-4">
          <ZoneEditor
            onCancel={() => setCreating(false)}
            onSaved={(zone) => { rememberFrontierPosition(); navigate(zonePath(zone), from ? { state: { evidenceFrom: from } } : undefined); }}
          />
        </div>
      )}
      {error && <EmptyState title={error} action={<Button variant="secondary" onClick={directory.retry}>重试</Button>} />}
      {loading && items.length === 0 ? (
        <FrontierSkeleton />
      ) : !error && items.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={query ? "没有找到匹配的专区" : "暂无证据专区"}
          {...(emptyAction ? { action: emptyAction } : { reason: "专区由平台和研究者发布，发布后会列在这里。" })}
        />
      ) : (
        <div className="space-y-6">
          {kinds.map((kind) => {
            const zones = emptyLast(items.filter((zone) => (zone.kind ?? "user") === kind));
            const label = (EVIDENCE_ZONE_KIND_LABELS_ZH as Record<string, string>)[kind];
            // A group is told by name only where there is more than one to tell apart.
            return kinds.length > 1
              ? <Section key={kind} title={label}>{list(zones)}</Section>
              : <section key={kind} aria-label={label}>{list(zones)}</section>;
          })}
        </div>
      )}
      {cursor && <ShowMore remaining={typeof total === "number" ? Math.max(1, total - items.length) : null} unit="个" loading={loading} onMore={() => void directory.more()} />}
      {/* The way to a topic nobody has written yet: the end of the list, where a reader who did not find theirs has arrived. */}
      {requestable && items.length > 0 && !cursor && (
        <div className="mt-6">
          <Note action={<Button variant="secondary" size="sm" onClick={() => setAsking("")}>申请选题</Button>}>没有找到想看的主题？</Note>
        </div>
      )}
      {asking !== null && requestable && (
        <Drawer title="申请选题" onClose={() => setAsking(null)}>
          <TopicRequests
            initialTitle={asking}
            zones={items
              .filter((zone) => zone.kind === "official" && zone.state === "published")
              .map((zone) => ({ id: zone.id, title: zone.title }))}
          />
        </Drawer>
      )}
    </>
  );
}
