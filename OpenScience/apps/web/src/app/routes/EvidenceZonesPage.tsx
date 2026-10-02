import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useEvidenceScope } from "@/components/frontier/useEvidenceScope";
import { ZoneEditor } from "@/components/frontier/EvidenceEditors";
import { FilterChips } from "@/components/ui/FilterChips";
import { PageShell } from "@/components/layout/PageShell";
import { FrontierNavigation } from "@/components/frontier/FrontierNavigation";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EmptyState } from "@/components/cards/EmptyState";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import {
  listEvidenceZones,
  followEvidenceZone,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";

export function EvidenceZonesPage() {
  const [params, setParams] = useSearchParams();
  const fromItem = params.get("fromItem");
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const scope: "public" | "owned" | "following" = fromItem
    ? "owned"
    : params.get("scope") === "following"
      ? "following"
      : params.get("scope") === "owned"
        ? "owned"
        : "public";
  const setScope = (next: "public" | "owned" | "following") => {
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
  const [items, setItems] = useState<EvidenceZone[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const capture = useEvidenceScope(`${query}:${scope}:${refresh}`);
  const [busy, setBusy] = useState<string | null>(null);
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
  return (
    <PageShell
      title="前沿动态"
      actions={
        canCreate && (
          <Button
            variant="secondary"
            onClick={() => setCreating((value) => !value)}
          >
            新建专区
          </Button>
        )
      }
    >
      <FrontierNavigation active="zones" />
      {fromItem && (
        <p className="mt-4 text-ui font-medium text-text">选择证据专区</p>
      )}
      <div className="mt-4">
        <FilterChips
          label="专区范围"
          options={
            fromItem
              ? [{ value: "owned", label: "我创建的" }]
              : [
                  { value: "public", label: "全部专区" },
                  { value: "owned", label: "我创建的" },
                  { value: "following", label: "我关注的" },
                ]
          }
          value={scope}
          onChange={setScope}
        />
      </div>
      {creating && (
        <div className="mt-4">
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
      <form
        className="mt-6 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(q.trim());
        }}
      >
        <Input
          aria-label="搜索证据专区"
          placeholder="搜索证据专区"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <Button type="submit" variant="secondary">
          搜索
        </Button>
      </form>
      {total !== null && (
        <p className="mt-3 text-caption text-text-3">{total} 个匹配专区</p>
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
        <EmptyState title={query ? "没有找到匹配的专区" : "暂无证据专区"} />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {items.map((zone) => (
            <li
              key={zone.id}
              className="flex items-start justify-between gap-4 py-4"
            >
              <div className="min-w-0">
                <Link
                  to={`/app/frontier/zones/${encodeURIComponent(zone.id)}${fromItem ? `?fromItem=${encodeURIComponent(fromItem)}` : ""}`}
                  className="text-ui font-medium text-text hover:text-accent"
                >
                  {zone.title}
                </Link>
                {zone.description && (
                  <p className="mt-1 max-w-measure text-caption text-text-2 line-clamp-2">
                    {zone.description}
                  </p>
                )}
                {zone.state === "draft" && (
                  <p className="mt-2 text-caption text-text-3">草稿</p>
                )}
                {zone.evidenceCount !== null && (
                  <p className="mt-2 text-caption text-text-3">
                    {zone.evidenceCount} 条证据
                  </p>
                )}
              </div>
              {zone.canFollow && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === zone.id}
                  onClick={() => void follow(zone)}
                >
                  {zone.following ? "取消关注" : "关注"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="mt-4">
          <Button
            variant="secondary"
            loading={loading}
            onClick={() => void more()}
          >
            加载更多
          </Button>
        </div>
      )}
    </PageShell>
  );
}
