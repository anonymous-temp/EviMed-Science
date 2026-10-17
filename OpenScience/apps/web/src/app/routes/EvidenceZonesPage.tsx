import { useEffect, useRef, useState } from "react";
import { EVIDENCE_ZONE_KINDS, EVIDENCE_ZONE_KIND_LABELS_ZH } from "@evimed/domain";
import { Layers } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { useEvidenceScope } from "@/components/frontier/useEvidenceScope";
import { ZoneEditor } from "@/components/frontier/EvidenceEditors";
import { TopicRequests } from "@/components/frontier/TopicRequests";
import { useEvidenceFeatures } from "@/components/frontier/useEvidenceFeatures";
import type { TabItem } from "@/components/ui/Tabs";
import { PageShell } from "@/components/layout/PageShell";
import { FrontierBack } from "@/components/frontier/FrontierBack";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { ShowMore } from "@/components/ui/ShowMore";
import {
  listEvidenceZones,
  followEvidenceZone,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";

type Scope = "public" | "owned" | "following";
const SCOPES: readonly TabItem<Scope>[] = [
  { value: "public", label: "全部专区" },
  { value: "owned", label: "我创建的" },
  { value: "following", label: "我关注的" },
];

/** A zone with no evidence yet reads 「暂无证据」 — not a count of nothing — and stands after the zones that have some. */
const emptyLast = (zones: EvidenceZone[]) =>
  [...zones].sort((a, b) => Number(a.evidenceCount === 0) - Number(b.evidenceCount === 0));

export function EvidenceZonesPage() {
  const [params, setParams] = useSearchParams();
  const fromItem = params.get("fromItem");
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const scope: Scope = fromItem
    ? "owned"
    : params.get("scope") === "following"
      ? "following"
      : params.get("scope") === "owned"
        ? "owned"
        : "public";
  const setScope = (next: Scope) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === "public") updated.delete("scope");
      else updated.set("scope", next);
      return updated;
    });
  };
  const [canCreate, setCanCreate] = useState(false);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // The box commits to the query a moment after typing stops, never in the middle of an IME
  // composition (pinyin is not a query); Enter commits at once.
  const composing = useRef(false);
  const [composed, setComposed] = useState(0);
  useEffect(() => {
    const text = q.trim();
    if (composing.current || text === query) return;
    const timer = setTimeout(() => setQuery(text), 300);
    return () => clearTimeout(timer);
  }, [q, composed, query]);
  const [items, setItems] = useState<EvidenceZone[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const capture = useEvidenceScope(`${query}:${scope}:${refresh}`);
  const [busy, setBusy] = useState<string | null>(null);
  const features = useEvidenceFeatures();
  // 「申请选题」 opens in a drawer from the header; `asking` is the topic already typed in it (an empty zone's link brings its own).
  const requestable = features.publicPages && !fromItem;
  const requestParam = params.get("request");
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (requestParam === null || !requestable) return;
    setAsking(requestParam);
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.delete("request");
      return updated;
    }, { replace: true });
  }, [requestParam, requestable, setParams]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setBusy(null);
    setError(null);
    setItems([]);
    setCursor(null);
    listEvidenceZones(query, null, scope === "public" ? undefined : scope)
      .then((page) => {
        if (active) {
          setCanCreate(page.canCreate === true);
          setTotal(page.total);
          setItems(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((reason) => {
        if (active) setError(evidenceErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [query, refresh, scope]);
  const more = async () => {
    if (!cursor) return;
    const current = capture();
    setLoading(true);
    setError(null);
    try {
      const page = await listEvidenceZones(
        query,
        cursor,
        scope === "public" ? undefined : scope,
      );
      if (current()) {
        setItems((previous) => [...previous, ...page.items]);
        setCursor(page.nextCursor);
      }
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setLoading(false);
    }
  };
  const follow = async (zone: EvidenceZone) => {
    const current = capture();
    setBusy(zone.id);
    setError(null);
    try {
      const updated = await followEvidenceZone(zone);
      if (current())
        setItems((previous) =>
          previous.map((item) => (item.id === zone.id ? updated : item)),
        );
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setBusy(null);
    }
  };
  // Zones are grouped by kind; the group's name is told only where there is more than one group to tell apart.
  const kinds = EVIDENCE_ZONE_KINDS.filter((kind) => items.some((zone) => (zone.kind ?? "user") === kind));
  const zonePath = (zone: EvidenceZone) =>
    `/app/frontier/zones/${encodeURIComponent(zone.id)}${fromItem ? `?fromItem=${encodeURIComponent(fromItem)}` : ""}`;
  // An empty list says where to go from it: to every zone, to the one the reader may make, to a topic nobody has written, or out of a search.
  const emptyAction = scope === "following"
    ? <Button variant="secondary" onClick={() => setScope("public")}>看全部专区</Button>
    : canCreate && scope === "owned" && !query
      ? <Button variant="secondary" onClick={() => setCreating(true)}>新建专区</Button>
      : requestable
        ? <Button variant="secondary" onClick={() => setAsking("")}>申请选题</Button>
        : query
          ? <Button variant="secondary" onClick={() => { setQ(""); setQuery(""); }}>清除搜索</Button>
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
            title={zone.title}
            meta={(zone.description || counts) ? (
              <>
                {zone.description && <span className="line-clamp-2 max-w-measure text-text-2">{zone.description}</span>}
                {counts && <span className={zone.description ? "mt-1 block" : "block"}>{counts}</span>}
              </>
            ) : undefined}
            actions={zone.canFollow ? (
              <Button variant="secondary" size="sm" loading={busy === zone.id} onClick={() => void follow(zone)}>
                {zone.following ? "取消关注" : "关注"}
              </Button>
            ) : undefined}
          />
        );
      })}
    </List>
  );
  return (
    <PageShell
      title={fromItem ? "选择证据专区" : "证据专区"}
      back={<FrontierBack />}
      actions={canCreate ? <Menu label="更多操作" items={[{ label: "新建专区", onSelect: () => setCreating((value) => !value) }]} /> : undefined}
      toolbar={{
        label: "专区筛选",
        // Choosing a zone for an item offers the reader's own zones only.
        views: { label: "专区范围", items: fromItem ? SCOPES.filter((item) => item.value === "owned") : SCOPES, value: scope, onChange: setScope },
        search: {
          label: "搜索",
          value: q,
          maxLength: 200,
          onChange: setQ,
          onClear: () => { setQ(""); setQuery(""); },
          inputProps: {
            onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); setQuery(q.trim()); } },
            onCompositionStart: () => { composing.current = true; },
            onCompositionEnd: (event) => { composing.current = false; setQ(event.currentTarget.value); setComposed((value) => value + 1); },
          },
        },
        summary: query && total !== null ? `${total} 个匹配专区` : undefined,
      }}
    >
      {creating && (
        <div className="mb-4">
          <ZoneEditor
            onCancel={() => setCreating(false)}
            onSaved={(zone) =>
              navigate(
                `/app/frontier/zones/${encodeURIComponent(zone.id)}${fromItem ? `?fromItem=${encodeURIComponent(fromItem)}` : ""}`,
              )
            }
          />
        </div>
      )}
      {error && (
        <EmptyState
          title={error}
          action={
            <Button
              variant="secondary"
              onClick={() => setRefresh((value) => value + 1)}
            >
              重试
            </Button>
          }
        />
      )}
      {loading && items.length === 0 ? (
        <FrontierSkeleton />
      ) : !error && items.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={query ? "没有找到匹配的专区" : "暂无证据专区"}
          {...(emptyAction
            ? { action: emptyAction }
            : { reason: "专区由平台和研究者发布，发布后会列在这里。" })}
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
      {cursor && <ShowMore remaining={typeof total === "number" ? Math.max(1, total - items.length) : null} unit="个" loading={loading} onMore={() => void more()} />}
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
    </PageShell>
  );
}
