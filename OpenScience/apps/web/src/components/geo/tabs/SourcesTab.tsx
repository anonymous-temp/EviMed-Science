import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { getGeoSources, type GeoProject, type GeoSourceRow } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tag } from "@/components/ui/Tag";
import { engineName, GEO_SOURCE_LAYER_WORDS, zh } from "../geoText";
import { sourceKindWord, yuan } from "./geoTabText";
import { FilterRow, StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";

/** Sources listed before 「显示更多」, and how many each press adds. */
const SOURCES_SHOWN = 30;

type Only = "wrong" | "mentions" | "own";

const ONLY_OPTIONS: ReadonlyArray<FilterOption<Only>> = [
  { value: "wrong", label: "讲错过我方" },
  { value: "mentions", label: "提到过我方" },
  { value: "own", label: "自有渠道" },
];

/**
 * 信源 (plan §3.5, mockup g08): who the engines cite, as one list. A row says what a reader decides on without opening it — how
 * often the site was cited, how many of those times it got us wrong, how often it named us — and opens in place to the three
 * conditions (ICP owner matches, news-grade indexed, medical) and what a placement there costs. The strategy that used to sit
 * under the list — per-engine expectations, the main battlefield, the target tiers — is a plan, and lives on 方案.
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
      <SourceList sources={sources} engines={project.engines} />
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

function citedCount(source: GeoSourceRow, engine: string): number {
  const cited = source.cited && typeof source.cited === "object" ? source.cited : {};
  if (engine !== "all") return typeof cited[engine] === "number" ? cited[engine] : 0;
  return Object.values(cited).reduce((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
}

const CONDITION_WORDS: Array<{ key: keyof GeoSourceRow["conditions"]; label: string }> = [
  { key: "icp", label: "备案" },
  { key: "newsIndexed", label: "新闻源" },
  { key: "medical", label: "医疗" },
];

function matchesOnly(source: GeoSourceRow, only: Only | null): boolean {
  if (only === "wrong") return source.wrongOurs > 0;
  if (only === "mentions") return source.mentionsOurs > 0;
  if (only === "own") return source.layer === "owned";
  return true;
}

function SourceList({ sources, engines }: { sources: GeoSourceRow[]; engines: string[] }) {
  const [engine, setEngine] = useState("all");
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<Only | null>(null);
  const [open, setOpen] = useState<string | null>(null);
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
    .filter((source) => !source.impostor && (current === "all" || citedCount(source, current) > 0) && matchesOnly(source, only))
    .filter((source) => !needle || `${source.name ?? ""} ${source.domain}`.toLowerCase().includes(needle))
    .sort((a, b) => citedCount(b, current) - citedCount(a, current)), [sources, current, only, needle]);
  const { visible, remaining, more } = useShowMore(rows, { first: SOURCES_SHOWN, step: SOURCES_SHOWN, resetKey: `${current}|${only}|${needle}` });
  const summary = [
    `${needle ? "匹配 " : ""}${rows.length.toLocaleString("zh-CN")} 个信源`,
    impostors.length > 0 ? `已排除 ${impostors.length} 个冒名站` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section aria-label="信源">
      <FilterRow summary={summary}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 max-sm:w-full">
          <FilterChips label="引擎" options={options} value={current} onChange={setEngine} />
          <div className="flex min-w-0 items-center gap-2 max-sm:w-full">
            <SearchInput label="搜索信源" size="sm" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} className="w-52 max-sm:flex-1" />
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
          <List divided label="信源" className="mt-3">
            {visible.map((source) => {
              const key = source.id || source.domain;
              const expanded = open === key;
              return (
                <ListRow
                  key={key}
                  title={<SourceTitle source={source} />}
                  titleProps={{ "data-geo-source": source.domain }}
                  onOpen={() => setOpen(expanded ? null : key)}
                  expanded={expanded}
                  meta={(
                    <>
                      <Citations source={source} count={citedCount(source, current)} />
                      {expanded && <SourceDetail source={source} />}
                    </>
                  )}
                  trailing={<SourceTrailing source={source} />}
                />
              );
            })}
          </List>
          <ShowMore remaining={remaining} unit="个" onMore={more} />
          {rows.some((source) => unverified(source.conditions).length > 0) && (
            <p className="mt-3 text-caption text-text-3">“未核实”是平台还没核对这一项，不等于不满足。</p>
          )}
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
    </section>
  );
}

/** The reader's name for the site and, when it is known, its kind; the domain is under it. */
function SourceTitle({ source }: { source: GeoSourceRow }) {
  const kind = sourceKindWord(source.kind);
  return (
    <>
      <span className="inline-flex max-w-full items-center gap-2">
        <span className="min-w-0 truncate">{source.name || source.domain}</span>
        {kind && <Tag>{kind}</Tag>}
      </span>
      {source.name && <span className="block truncate text-caption text-text-3">{source.domain}</span>}
    </>
  );
}

/** “被引用 69 次 · 有 14 处讲错 · 提到你 35 次” — the wrong part is the one thing on the row in red. */
function Citations({ source, count }: { source: GeoSourceRow; count: number }) {
  const parts: Array<{ text: string; wrong?: boolean }> = [
    ...(count > 0 ? [{ text: `被引用 ${count.toLocaleString("zh-CN")} 次` }] : []),
    ...(source.wrongOurs > 0 ? [{ text: `有 ${source.wrongOurs} 处讲错`, wrong: true }] : []),
    ...(source.mentionsOurs > 0 ? [{ text: `提到你 ${source.mentionsOurs} 次` }] : []),
  ];
  if (parts.length === 0) return null;
  return (
    <span data-geo-source-line="">
      {parts.map((part, index) => (
        <span key={part.text}>
          {index > 0 && " · "}
          <span className={cn(part.wrong && "text-danger")}>{part.text}</span>
        </span>
      ))}
    </span>
  );
}

/** Where we would place there (自有 / 覆盖 / 锚点) and what one article costs, when the site has a price. */
function SourceTrailing({ source }: { source: GeoSourceRow }) {
  const layer = source.layer ? GEO_SOURCE_LAYER_WORDS[source.layer] ?? null : null;
  const price = source.market && typeof source.market.price === "number" ? `${yuan(source.market.price)}/篇` : null;
  return (
    <>
      {layer && <span>{layer}</span>}
      {price && <span className="tabular-nums">{price}</span>}
    </>
  );
}

function unverified(conditions: GeoSourceRow["conditions"] | null | undefined): string[] {
  return CONDITION_WORDS.filter(({ key }) => conditions?.[key] == null).map(({ label }) => label);
}

/** What the row opens to: the three conditions, said as words, and the price of one article. */
function SourceDetail({ source }: { source: GeoSourceRow }) {
  const missing = unverified(source.conditions);
  const known = CONDITION_WORDS.filter(({ key }) => source.conditions?.[key] != null);
  const price = source.market && typeof source.market.price === "number" ? yuan(source.market.price) : null;
  return (
    <span data-geo-source-detail="" className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui text-text-2">
      {known.map(({ key, label }) => {
        const yes = source.conditions[key] === true;
        const Icon = yes ? Check : X;
        return (
          <span key={key} data-geo-condition={`${key}:${yes ? "yes" : "no"}`} className="inline-flex items-center gap-1">
            {label}
            <Icon size={16} aria-hidden="true" className={yes ? "text-accent" : "text-text-3"} />
            <span className="sr-only">{yes ? "满足" : "不满足"}</span>
          </span>
        );
      })}
      {missing.length > 0 && (
        <span data-geo-condition-unverified={missing.length === CONDITION_WORDS.length ? "all" : "some"}>
          {missing.length === CONDITION_WORDS.length ? "三项都未核实" : `${missing.join("、")}未核实`}
        </span>
      )}
      {price && <span>{`单篇价格 ${price}`}</span>}
    </span>
  );
}
