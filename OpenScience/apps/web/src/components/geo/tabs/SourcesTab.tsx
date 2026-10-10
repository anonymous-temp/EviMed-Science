import { ValueSection } from "./ValueSection";
import { useMemo, useState } from "react";
import { getGeoSources, type GeoProject, type GeoSourceRow } from "@/lib/geoClient";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListHeader, ListRow, type ListColumn } from "@/components/ui/ListRow";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tag } from "@/components/ui/Tag";
import { engineName, GEO_SOURCE_LAYER_WORDS, zh } from "../geoText";
import { sourceKindWord } from "./geoTabText";
import { FilterRow, StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";
import { GeoSourceDrawer } from "./GeoSourceDrawer";
import { ShowMore, useShowMore } from "./showMore";

/** Sources listed before 「显示更多」, and how many each press adds. */
const SOURCES_SHOWN = 30;

type Only = "wrong" | "mentions" | "own";

const ONLY_OPTIONS: ReadonlyArray<FilterOption<Only>> = [
  { value: "wrong", label: "讲错过我方" },
  { value: "mentions", label: "提到过我方" },
  { value: "own", label: "自有渠道" },
];

type SortKey = "cited" | "wrong" | "mentions";

/** The three numbers of a row, named as the header names them. */
const COLUMNS: ReadonlyArray<ListColumn & { key: SortKey }> = [
  { key: "cited", label: "被引用", sortable: true },
  { key: "wrong", label: "讲错的回答", sortable: true },
  { key: "mentions", label: "提到你", sortable: true },
];

/**
 * 信源 (plan §3.5, mockup g08; R13 E-15): who the engines cite, as one list. A row is the site — its name, its kind, its domain — and
 * three numbers that are all counts of the latest round's answers: how many cited the site, how many of those misstated us, how many
 * of those named us. The headers sort by them; the red one is a button that opens what it counts. A row opens the site's drawer: the
 * answers behind the three numbers, each the way into its answer page, and last the three conditions (ICP owner matches, news-grade
 * indexed, medical) and what a placement there costs. The strategy that used to sit under the list — per-engine expectations, the
 * main battlefield, the target tiers — is a plan, and lives on 方案.
 */
export function SourcesTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`sources:${geoId}`, () => getGeoSources(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const sources = (Array.isArray(data?.sources) ? data.sources : []).filter((source) => source && source.domain);
  if (sources.length === 0) return <StepPending geoId={geoId} project={project} step="sources" />;
  const linkless = (Array.isArray(data?.linklessEngines) ? data.linklessEngines : []).filter(Boolean);
  return (
    <div data-geo-tab="sources">
      <ValueSection geoId={geoId} project={project} mode="sources" />
      <SourceList geoId={geoId} project={project} sources={sources} engines={project.engines} />
      {/* An engine whose citations had no link is not missing from the list
          by accident: it is said, not dropped (G8). */}
      {linkless.length > 0 && (
        <p data-geo-linkless="" className="mt-3 text-caption text-text-3">
          {zh`${linkless.map(engineName).join("、")}的引用只有标题、没有链接，引用了哪些信源测不出`}
        </p>
      )}
    </div>
  );
}

/** The row's three numbers for the engine the page is narrowed to (`all`: the whole round). */
export interface SourceCounts {
  cited: number;
  wrong: number;
  mentions: number;
}

export function sourceCounts(source: GeoSourceRow, engine: string): SourceCounts {
  const cited = source.cited && typeof source.cited === "object" ? source.cited : {};
  if (engine === "all") {
    return {
      cited: Object.values(cited).reduce((sum, count) => sum + (typeof count === "number" ? count : 0), 0),
      wrong: source.wrongOurs,
      mentions: source.mentionsOurs,
    };
  }
  return {
    cited: typeof cited[engine] === "number" ? cited[engine] : 0,
    wrong: source.wrongOursByEngine ? source.wrongOursByEngine[engine] ?? 0 : source.wrongOurs,
    mentions: source.mentionsOursByEngine ? source.mentionsOursByEngine[engine] ?? 0 : source.mentionsOurs,
  };
}

function matchesOnly(source: GeoSourceRow, counts: SourceCounts, only: Only | null): boolean {
  if (only === "wrong") return counts.wrong > 0;
  if (only === "mentions") return counts.mentions > 0;
  if (only === "own") return source.layer === "owned";
  return true;
}

interface Opened {
  key: string;
  /** The engine filter when it was opened: the drawer lists the answers the row counted. */
  engine: string;
  focus: "wrong" | null;
}

function SourceList({ geoId, project, sources, engines }: { geoId: string; project: GeoProject; sources: GeoSourceRow[]; engines: string[] }) {
  const [engine, setEngine] = useState("all");
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<Only | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "cited", descending: true });
  const [opened, setOpened] = useState<Opened | null>(null);
  const cited = useMemo(() => new Set(sources.flatMap((source) => Object.keys(source.cited ?? {}))), [sources]);
  const listed = [...engines.filter((key) => cited.has(key)), ...[...cited].filter((key) => !engines.includes(key))];
  const options: FilterOption<string>[] = [
    { value: "all", label: "全部引擎" },
    ...listed.map((key) => ({ value: key, label: engineName(key) })),
  ];
  const current = options.some((option) => option.value === engine) ? engine : "all";
  const impostors = sources.filter((source) => source.impostor);
  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => sources
    .filter((source) => !source.impostor)
    .map((source) => ({ source, counts: sourceCounts(source, current) }))
    .filter(({ source, counts }) => (current === "all" || counts.cited > 0) && matchesOnly(source, counts, only))
    .filter(({ source }) => !needle || `${source.name ?? ""} ${source.domain}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort.descending ? b.counts[sort.key] - a.counts[sort.key] : a.counts[sort.key] - b.counts[sort.key]) || b.counts.cited - a.counts.cited),
  [sources, current, only, needle, sort]);
  const { visible, remaining, more } = useShowMore(rows, { first: SOURCES_SHOWN, step: SOURCES_SHOWN, resetKey: `${current}|${only}|${needle}|${sort.key}|${sort.descending}` });
  const summary = `${needle ? "匹配 " : ""}${rows.length.toLocaleString("zh-CN")} 个信源`;
  const drawerRow = opened ? sources.find((source) => (source.id || source.domain) === opened.key) ?? null : null;
  // Pressing the sorted column again turns it over; another column starts from the most.
  const sortBy = (key: string) => setSort((now) => (now.key === key ? { key: now.key, descending: !now.descending } : { key: key as SortKey, descending: true }));

  return (
    <section aria-label="信源">
      <FilterRow summary={summary}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 max-sm:w-full">
          <FilterChips label="引擎" options={options} value={current} onChange={setEngine} />
          <div className="flex min-w-0 items-center gap-2 max-sm:w-full">
            <SearchInput label="搜索信源" size="sm" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} className="w-52 max-sm:flex-1" />
            <FilterSelect<Only> label="只看" options={ONLY_OPTIONS} value={only} onChange={setOnly} allLabel="全部信源" />
          </div>
        </div>
      </FilterRow>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-ui text-text-3">
          {needle ? `没有包含“${query.trim()}”的信源。` : "没有符合的信源。"}
        </p>
      ) : (
        <>
          <ListHeader label="按数字排序" columns={COLUMNS} sort={sort} onSort={sortBy} className="mt-3" />
          <List divided label="信源">
            {visible.map(({ source, counts }) => {
              const key = source.id || source.domain;
              return (
                <ListRow
                  key={key}
                  title={<SourceTitle source={source} />}
                  titleProps={{ "data-geo-source": source.domain }}
                  onOpen={() => setOpened({ key, engine: current, focus: null })}
                  columns={[
                    { key: "cited", label: "被引用", value: counts.cited.toLocaleString("zh-CN") },
                    {
                      key: "wrong",
                      label: "讲错的回答",
                      value: counts.wrong.toLocaleString("zh-CN"),
                      // The one red thing on a row, and the way to the answers it counts.
                      ...(counts.wrong > 0 ? { tone: "danger" as const, onOpen: () => setOpened({ key, engine: current, focus: "wrong" }) } : {}),
                    },
                    { key: "mentions", label: "提到你", value: counts.mentions.toLocaleString("zh-CN") },
                  ]}
                />
              );
            })}
          </List>
          <ShowMore remaining={remaining} unit="个" onMore={more} />
        </>
      )}
      {impostors.length > 0 && (
        <Disclosure summary="冒名站" className="mt-4">
          <ul className="flex flex-col gap-1">
            {impostors.map((source) => (
              <li key={source.id || source.domain} className="text-ui text-text-2">
                {source.name ? `${source.name} · ${source.domain}` : source.domain}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {opened && drawerRow && (
        <GeoSourceDrawer geoId={geoId} project={project} source={drawerRow} engine={opened.engine} focus={opened.focus} onClose={() => setOpened(null)} />
      )}
    </section>
  );
}

/**
 * The site on one line: its name, its kind, the 「自有」 tag when it is ours, and the domain in grey. The other layer words
 * (覆盖, 锚点) are about where we would place content there, which is the drawer's to say.
 */
function SourceTitle({ source }: { source: GeoSourceRow }) {
  const kind = sourceKindWord(source.kind);
  const own = source.layer === "owned" ? GEO_SOURCE_LAYER_WORDS.owned : null;
  return (
    // One line from `sm` up, the name and the domain shortened to fit; on a phone the tags and the domain wrap under the name.
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 sm:flex-nowrap">
      <span className="max-w-full min-w-0 truncate">{source.name || source.domain}</span>
      {kind && <Tag>{kind}</Tag>}
      {own && <Tag tone="accent">{own}</Tag>}
      {source.name && <span className="min-w-0 max-w-full truncate text-caption text-text-3">{source.domain}</span>}
    </span>
  );
}
