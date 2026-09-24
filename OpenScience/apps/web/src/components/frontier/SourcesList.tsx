import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { fetchFrontierSources, frontierErrorMessage, type FrontierSource, type FrontierSources } from "@/lib/frontierClient";
import { LoadError } from "@/components/cards/LoadError";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChips } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { INLINE_ACTION } from "./frontierText";

/** One institution the feed reads, however many feeds it is read through. */
export interface ReadInstitution {
  name: string;
  homepage: string | null;
  /** Its items selected in the last 30 days, all its feeds together. */
  selected30d: number;
}

/**
 * The sources being read, as a reader knows them: by institution (FDA, not
 * 「openFDA 药品召回（enforcement）API」 and its four siblings), with the
 * selected items of each summed. Retired sources, sources switched off on
 * either side and sources not read yet are not listed.
 */
export function readInstitutions(sources: readonly FrontierSource[]): ReadInstitution[] {
  const byName = new Map<string, ReadInstitution>();
  for (const source of sources) {
    if (source.retired || !source.enabled || source.health === "disabled") continue;
    const name = source.displayName || source.name;
    const known = byName.get(name);
    if (known) {
      known.selected30d += source.selected30d;
      known.homepage ??= source.homepage;
    } else {
      byName.set(name, { name, homepage: source.homepage, selected30d: source.selected30d });
    }
  }
  return [...byName.values()];
}

type Order = "selected" | "name";
const ORDERS = [{ value: "selected" as const, label: "按近 30 天精选" }, { value: "name" as const, label: "按名称" }];

/**
 * 「我们在读的信源（N）」, at the foot of 全部 (plan 2026-09-23 §6.2 来源榜，
 * 低调): a quiet link that opens a plain list of the institutions, each with
 * how many of its items were selected in the last 30 days, and sortable by
 * that. Not a ranking on the front page — publishing more is not being better
 * — and nothing of how a source is read or how healthy it is: that is the
 * operators'. The list is read when it is opened, not before.
 */
export function SourcesLink({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn(INLINE_ACTION, "-ml-1.5 px-1.5 text-text-3 hover:text-text")}>
        <span className="text-caption">我们在读的信源{count > 0 ? `（${count}）` : ""}</span>
      </button>
      {open && <SourcesDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

function SourcesDrawer({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<FrontierSources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [order, setOrder] = useState<Order>("selected");
  useEffect(() => {
    let active = true;
    setError(null);
    fetchFrontierSources().then(
      (sources) => { if (active) setData(sources); },
      (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
    );
    return () => { active = false; };
  }, [attempt]);

  const institutions = useMemo(() => readInstitutions(data?.sources ?? []), [data]);
  // A server that has not counted selections yet sends none: then there is
  // nothing to show or sort by, rather than a column of zeros.
  const counted = institutions.some((institution) => institution.selected30d > 0);
  const rows = useMemo(() => [...institutions].sort((a, b) => ((counted && order === "selected") ? b.selected30d - a.selected30d : 0)
    || a.name.localeCompare(b.name, "zh")), [institutions, order, counted]);

  return (
    <Drawer title="我们在读的信源" onClose={onClose}>
      {error ? <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} /> : !data ? (
        <div className="animate-pulse space-y-3" aria-hidden="true">
          {["w-2/3", "w-1/2", "w-3/5", "w-1/3"].map((width) => <div key={width} className={cn("h-3.5 rounded bg-surface-2", width)} />)}
        </div>
      ) : (
        <div className="space-y-3">
          {counted && <FilterChips label="排序" options={ORDERS} value={order} onChange={setOrder} />}
          <List label="信源" divided>
            {rows.map((institution) => (
              <ListRow
                key={institution.name}
                title={institution.name}
                href={institution.homepage ?? undefined}
                trailing={counted ? <span className="tabular-nums">近 30 天精选 {institution.selected30d} 条</span> : undefined}
              />
            ))}
          </List>
        </div>
      )}
    </Drawer>
  );
}
