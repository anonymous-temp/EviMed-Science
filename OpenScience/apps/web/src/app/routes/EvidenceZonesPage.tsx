import { useEffect, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { PageShell } from "@/components/layout/PageShell";
import { FrontierBack } from "@/components/frontier/FrontierBack";
import { ZoneDirectoryBody, readZoneScope, useZoneDirectory, zoneDirectoryControls } from "@/components/frontier/EvidenceZoneDirectory";
import { Menu } from "@/components/ui/Menu";

/**
 * `/app/frontier/zones`. The directory of evidence zones is a view of the feed page since 2026-10-22 (the owner: 证据专区 opens in
 * place, under the same band and tab row as the other views), so this address hands its scope and a requested topic over to
 * `/app/frontier?view=zones` — a notification, a bookmark or an older link lands on the same list.
 *
 * What stays here is the chooser of a zone for one frontier item (「⋯ › 整理为证据卡片」, `?fromItem=`): a task of its own, with its
 * own title and the reader's own zones only, which opens the chosen zone with the item in hand.
 */
export function EvidenceZonesPage() {
  const [params] = useSearchParams();
  const fromItem = params.get("fromItem");
  if (!fromItem) {
    const next = new URLSearchParams({ view: "zones" });
    const scope = readZoneScope(params.get("scope"));
    if (scope !== "public") next.set("scope", scope);
    const request = params.get("request");
    if (request !== null) next.set("request", request);
    return <Navigate replace to={`/app/frontier?${next.toString()}`} />;
  }
  return <ZoneChooser fromItem={fromItem} />;
}

function ZoneChooser({ fromItem }: { fromItem: string }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // The box commits to the query a moment after typing stops, never in the middle of an IME composition (pinyin is not a query);
  // Enter commits at once.
  const composing = useRef(false);
  const [composed, setComposed] = useState(0);
  useEffect(() => {
    const text = q.trim();
    if (composing.current || text === query) return;
    const timer = setTimeout(() => setQuery(text), 300);
    return () => clearTimeout(timer);
  }, [q, composed, query]);
  const directory = useZoneDirectory({ scope: "owned", query, fromItem });
  const controls = zoneDirectoryControls({ scope: "owned", onScope: () => undefined, query, directory, chooser: true });
  return (
    <PageShell
      title="选择证据专区"
      back={<FrontierBack />}
      actions={directory.canCreate ? <Menu label="更多操作" items={[{ label: "新建专区", onSelect: () => directory.setCreating(!directory.creating) }]} /> : undefined}
      toolbar={{
        label: "专区筛选",
        filters: controls.filters,
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
        summary: controls.summary,
      }}
    >
      <ZoneDirectoryBody directory={directory} scope="owned" query={query} fromItem={fromItem} onScope={() => undefined}
        onClearSearch={() => { setQ(""); setQuery(""); }} />
    </PageShell>
  );
}
