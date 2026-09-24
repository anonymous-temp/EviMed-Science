import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { FRONTIER_ACCESS_LABELS_ZH } from "@evimed/domain";
import { fetchFrontierSources, frontierErrorMessage, FRONTIER_LANES, type FrontierSource, type FrontierSources } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { ago } from "./frontierText";
import { useOpenedOnce } from "./useOpenedOnce";

/** Lanes in the filter row's order; the sources the model sorts per item come last. */
const LANE_ORDER = [...FRONTIER_LANES.map((lane) => lane.key), "mixed"];

/**
 * 「我们在读哪些信源」 (plan §4.10): every source being read, by lane, with how
 * it is read, when it was last read and whether it is healthy. For an
 * evidence product the list itself is part of the credibility, so it is
 * public to every reader — folded at the foot of the page, and read only when
 * someone opens it (the list is several hundred rows).
 */
export function SourcesDisclosure() {
  const [ref, opened] = useOpenedOnce();
  return (
    <div ref={ref} className="border-t border-border pt-4">
      <Disclosure summary="我们在读哪些信源">
        {opened ? <SourcesTable /> : null}
      </Disclosure>
    </div>
  );
}

function SourcesTable() {
  const [data, setData] = useState<FrontierSources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    fetchFrontierSources().then(
      (sources) => { if (active) setData(sources); },
      (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
    );
    return () => { active = false; };
  }, [attempt]);

  // Read: not retired, not switched off on either side. Everything the plugin
  // has registered but does not read yet is 「在接入中」.
  const { groups, planned } = useMemo(() => {
    const sources = data?.sources ?? [];
    const reading = sources.filter((source) => !source.retired && source.enabled && source.health !== "disabled");
    const byLane = new Map<string, FrontierSource[]>();
    for (const source of reading) byLane.set(source.lane, [...(byLane.get(source.lane) ?? []), source]);
    const lanes = [...byLane.keys()].sort((a, b) => rank(a) - rank(b));
    const counted = data?.counts.planned;
    return {
      groups: lanes.map((lane) => ({
        lane,
        label: lane === "mixed" ? "综合" : byLane.get(lane)?.[0]?.laneLabel || "其他",
        sources: [...(byLane.get(lane) ?? [])].sort((a, b) => a.name.localeCompare(b.name, "zh")),
      })),
      planned: typeof counted === "number" && counted > 0 ? counted
        : sources.filter((source) => !source.retired && source.health === "disabled").length,
    };
  }, [data]);

  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-ui text-muted">
        <span>{error}</span>
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" />重试</Button>
      </div>
    );
  }
  if (!data) return <p role="status" className="flex items-center gap-1.5 text-ui text-muted"><Loader2 size={16} className="animate-spin" aria-hidden="true" />正在读取信源清单…</p>;
  return (
    <div className="space-y-4">
      {groups.length === 0 && <p className="text-ui text-muted">信源正在接入，还没有开始读取的。</p>}
      {groups.map((group) => (
        <section key={group.lane} aria-labelledby={`frontier-sources-${group.lane}`}>
          <h3 id={`frontier-sources-${group.lane}`} className="mb-1 text-ui font-semibold text-text">
            {group.label} <span className="text-caption font-normal text-muted">{group.sources.length} 个</span>
          </h3>
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full border-collapse text-left text-ui">
              <thead>
                <tr className="bg-surface-1 text-caption text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">信源</th>
                  <th scope="col" className="px-3 py-2 font-medium">读法</th>
                  <th scope="col" className="px-3 py-2 font-medium">最近读到</th>
                  <th scope="col" className="px-3 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {group.sources.map((source) => (
                  <tr key={source.id} className="border-t border-faint">
                    <td className="px-3 py-1.5 text-text">
                      {source.homepage
                        ? <a href={source.homepage} target="_blank" rel="noopener noreferrer" className="hover:underline">{source.name}</a>
                        : source.name}
                    </td>
                    {/* 「读法」 in the vocabulary's words; a method it has no word for reads 「其他」, not as its key. */}
                    <td className="px-3 py-1.5 text-muted">{FRONTIER_ACCESS_LABELS_ZH[source.access] ?? "其他"}</td>
                    <td className="px-3 py-1.5 text-muted">{ago(source.lastOkAt) || "还没读到"}</td>
                    <td className="px-3 py-1.5 text-muted">{source.healthLabel || "未登记的状态"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {planned > 0 && <p className="text-caption text-muted">另有 {planned} 个信源在接入中。</p>}
    </div>
  );
}

function rank(lane: string): number {
  const index = LANE_ORDER.indexOf(lane);
  return index === -1 ? LANE_ORDER.length : index;
}
