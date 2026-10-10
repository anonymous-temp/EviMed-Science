import { ValueSection } from "./ValueSection";
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getGeoQuestions,
  unmeasureGeoQuestion,
  type GeoPool,
  type GeoProject,
  type GeoQuestion,
  type GeoQuestionGroup,
  type GeoQuestions,
} from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tag } from "@/components/ui/Tag";
import { GEO_POOL_KINDS, GEO_POOL_NAMES, GEO_POOLS, groupName, monthDay, platformName } from "../geoText";
import { answerPath } from "./geoTabText";
import { FilterRow, StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

type PoolFilter = "all" | GeoPool;

const KIND_WORDS: Readonly<Record<GeoQuestion["kind"], string>> = Object.freeze({
  typical: "典型问句",
  real: "真实问法",
  label_safety: "说明书安全题",
  client: "客户提供",
});

const SIGNAL_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_signal: "无信号",
  partial: "信号不全",
  client: "客户提供",
});

/** Real phrasings shown before “还有 N 条”. */
const PHRASINGS_SHOWN = 6;

/**
 * 问题 (plan §3.3, mockup g05): the four-pool question map. Pools are filter
 * chips; within a pool, each semantic group opens to its typical question,
 * the questions being measured (each with “移出测量问句”) and the real
 * phrasings collected from social platforms, with the platform named.
 * Control groups are marked. A locked set is versioned: an older version can
 * be looked at, and removing a question writes a new one.
 *
 * A search box finds a question by any word of it (88 questions in 25 groups are
 * too many to scan); the groups it matches open by themselves. A measured
 * question opens the answer it last got, so “他们到底怎么答的” is one click.
 */
export function QuestionsTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const [version, setVersion] = useState<number | null>(null);
  const { state, reload } = useGeoLoad(`questions:${geoId}:${version ?? "latest"}`, () => getGeoQuestions(geoId, version));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const groups = Array.isArray(data?.groups) ? data.groups.filter((group) => group && group.id) : [];
  if (groups.length === 0) return <StepPending geoId={geoId} project={project} step="questions" />;
  return (
    <QuestionMap
      project={project}
      geoId={geoId}
      data={data}
      groups={groups}
      onVersion={setVersion}
      onChanged={() => {
        // A removal writes a new set: show the newest one.
        setVersion(null);
        reload();
      }}
    />
  );
}

function QuestionMap({
  project,
  geoId,
  data,
  groups,
  onVersion,
  onChanged,
}: {
  geoId: string;
  project: GeoProject;
  data: GeoQuestions;
  groups: GeoQuestionGroup[];
  onVersion: (version: number | null) => void;
  onChanged: () => void;
}) {
  const [pool, setPool] = useState<PoolFilter>("all");
  const [query, setQuery] = useState("");
  /** What the reader opened or closed by hand during this search; a new search starts from what it matched. */
  const [chosen, setChosen] = useState<Map<string, boolean>>(() => new Map());
  const needle = query.trim().toLowerCase();
  const counts = useMemo(() => {
    const questions = groups.flatMap((group) => list(group.questions));
    return {
      groups: groups.length,
      measured: questions.filter((question) => question.isMeasured).length,
      real: questions.filter((question) => question.kind === "real").length,
    };
  }, [groups]);
  const pools = GEO_POOLS.filter((key) => groups.some((group) => group.pool === key));
  const options: FilterOption<PoolFilter>[] = [
    { value: "all", label: "全部" },
    ...pools.map((key) => ({ value: key, label: GEO_POOL_KINDS[key] })),
  ];
  const sets = Array.isArray(data.sets) ? data.sets.filter((set) => set && typeof set.version === "number") : [];
  const latest = sets.reduce<number | null>((top, set) => (top === null || set.version > top ? set.version : top), null);
  const current = data.version ?? latest;
  const shownPools = pool === "all" || !pools.includes(pool as GeoPool) ? pools : [pool as GeoPool];
  const matches = useMemo(() => new Map(groups.map((group) => [group.id, matchGroup(group, needle)])), [groups, needle]);
  const found = shownPools.flatMap((key) => groups.filter((group) => group.pool === key && matches.get(group.id)));
  const matchedQuestions = found.reduce((sum, group) => sum + (matches.get(group.id)?.count ?? 0), 0);
  const isOpen = (id: string) => chosen.get(id) ?? needle !== "";
  const toggle = (id: string) => setChosen((previous) => new Map(previous).set(id, !(previous.get(id) ?? needle !== "")));
  const search = (value: string) => {
    setQuery(value);
    setChosen(new Map());
  };

  return (
    <div data-geo-tab="questions">
      <ValueSection geoId={geoId} project={project} mode="decisions" />
      <FilterRow summary={needle ? `匹配 ${matchedQuestions} 个问题` : `${counts.groups} 个语义群 · ${counts.measured} 问 · ${counts.real.toLocaleString("zh-CN")} 条真实问法`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 max-sm:w-full">
          <FilterChips
            label="问句池"
            options={options}
            value={pools.includes(pool as GeoPool) ? pool : "all"}
            onChange={setPool}
            trailing={sets.length > 1 ? (
              <FilterSelect<string>
                label="问句版本"
                options={[...sets].sort((a, b) => b.version - a.version).map((set) => ({
                  value: String(set.version),
                  label: [`第 ${set.version} 版`, set.lockedAt ? `${monthDay(set.lockedAt)}锁定` : null].filter(Boolean).join(" · "),
                }))}
                value={current === null ? null : String(current)}
                onChange={(value) => onVersion(value === null || Number(value) === latest ? null : Number(value))}
              />
            ) : undefined}
          />
          <SearchInput label="搜索问题" size="sm" value={query} maxLength={80} onChange={(event) => search(event.target.value)} onClear={() => search("")} className="w-52 max-sm:w-full" />
        </div>
      </FilterRow>
      {needle && found.length === 0 && (
        <p className="py-10 text-center text-ui text-text-3">{`没有包含“${query.trim()}”的问题。`}</p>
      )}
      {shownPools.map((key) => {
        const inPool = groups.filter((group) => group.pool === key && matches.get(group.id));
        if (inPool.length === 0) return null;
        return (
          <section key={key} aria-label={GEO_POOL_KINDS[key]} className="mt-8">
            {/* A pool is a group heading over its rows, in the list's meta
                level: the groups under it are what a reader opens. */}
            <h2 className="flex items-baseline gap-2 text-caption text-text-3">
              <span className="text-text-2">{GEO_POOL_KINDS[key]}</span>
              {!GEO_POOL_NAMES[key].startsWith(GEO_POOL_KINDS[key]) && <span>{GEO_POOL_NAMES[key]}</span>}
            </h2>
            <ul className="mt-2 flex flex-col divide-y divide-faint">
              {inPool.map((group) => (
                <GroupRow
                  key={group.id}
                  geoId={geoId}
                  group={group}
                  match={matches.get(group.id)!}
                  expanded={isOpen(group.id)}
                  onToggle={() => toggle(group.id)}
                  onChanged={onChanged}
                  editable={current === latest}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** What of a group a search leaves: nothing (no match), or the parts to show. Without a search, all of it. */
interface GroupMatch {
  typical: boolean;
  measured: GeoQuestion[];
  phrasings: GeoQuestion[];
  /** The questions this group puts in front of the reader: the typical one when it stands alone, the measured ones, the phrasings. */
  count: number;
}

function matchGroup(group: GeoQuestionGroup, needle: string): GroupMatch | null {
  const questions = list(group.questions);
  const hit = (text: string | null | undefined) => !needle || (text ?? "").toLowerCase().includes(needle);
  // A group named for what the reader typed keeps every question: they asked for the topic.
  const topic = !needle || groupName(group.name).toLowerCase().includes(needle) || (group.name ?? "").toLowerCase().includes(needle);
  const take = (question: GeoQuestion) => topic || hit(question.text);
  const measured = questions.filter((question) => question.isMeasured && take(question));
  const phrasings = questions.filter((question) => !question.isMeasured && question.kind === "real" && take(question));
  const typicalText = (group.typicalQuestion ?? "").trim();
  const typical = Boolean(typicalText)
    && !questions.some((question) => question.isMeasured && question.text.trim() === typicalText)
    && (topic || hit(typicalText));
  const count = (typical ? 1 : 0) + measured.length + phrasings.length;
  if (needle && !topic && count === 0) return null;
  return { typical, measured, phrasings, count };
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function GroupRow({
  geoId,
  group,
  match,
  expanded,
  onToggle,
  onChanged,
  editable,
}: {
  geoId: string;
  group: GeoQuestionGroup;
  /** The parts of the group a search leaves; all of it without one. */
  match: GroupMatch;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  /** Only the newest version can lose a question. */
  editable: boolean;
}) {
  const questions = list(group.questions);
  const { measured, phrasings } = match;
  // The header counts the whole group, whatever a search shows of it. Every real phrasing counts, measured ones too (G18).
  const real = questions.filter((question) => question.kind === "real").length;
  const meta = [
    group.journeyStage || null,
    `${questions.filter((question) => question.isMeasured).length} 问`,
    `${real} 条原话`,
    group.signal ? SIGNAL_WORDS[group.signal] ?? null : null,
  ].filter(Boolean).join(" · ");
  const panelId = `geo-group-${group.id}`;

  return (
    <li data-geo-group={group.id} className="py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          className="flex h-sm min-w-0 flex-1 items-center gap-2 rounded text-left text-ui text-text hover:text-accent"
        >
          <ChevronRight size={16} aria-hidden="true" className={cn("shrink-0 text-text-3 transition-transform duration-fast", expanded && "rotate-90")} />
          <span className="min-w-0 truncate">{groupName(group.name)}</span>
        </button>
        {group.isControl && <Tag>对照组</Tag>}
        <span className="shrink-0 text-caption tabular-nums text-text-3">{meta}</span>
      </div>
      {expanded && (
        <div id={panelId} className="mt-3 flex flex-col gap-3 pl-6">
          {/* A typical question that is itself measured is listed once, with its action. */}
          {match.typical && (
            <p className="flex items-start gap-2 text-ui text-text">
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="max-w-measure">{group.typicalQuestion}</span>
            </p>
          )}
          {measured.length > 0 && (
            <List label="测量问句">
              {measured.map((question) => (
                <MeasuredRow key={question.id} geoId={geoId} question={question} editable={editable} onChanged={onChanged} />
              ))}
            </List>
          )}
          {phrasings.length > 0 && <Phrasings phrasings={phrasings} />}
        </div>
      )}
    </li>
  );
}

/**
 * One measured question. Its row is the way to the answer it last got — the whole row, not a word at its end: the title is the
 * link and the row says so with its mark and its 「看回答」. A question nothing has answered yet has nothing to open, so its row is
 * not drawn as something that opens (no hover, no link). 「移出测量问句」 stays a control of its own.
 */
function MeasuredRow({ geoId, question, editable, onChanged }: { geoId: string; question: GeoQuestion; editable: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = () => {
    setBusy(true);
    void unmeasureGeoQuestion(geoId, question.id)
      .then(() => {
        toast.success("已移出，之后的测量不再问这一句。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一句无法移出，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  // The answer it last got: the first engine of the project's order; the answer page lists the other engines' answers beside it.
  const answered = Array.isArray(question.answers) ? question.answers.find((answer) => answer?.snapshotId) : null;
  return (
    <ListRow
      title={<span className="max-w-measure">{question.text}{answered && <span className="sr-only">，看回答</span>}</span>}
      titleProps={{ "data-geo-question": question.id }}
      to={answered ? answerPath(geoId, answered.snapshotId) : undefined}
      meta={[KIND_WORDS[question.kind] ?? null, platformName(question.platform)].filter(Boolean).join(" · ")}
      trailing={answered ? <span aria-hidden="true" className="max-sm:hidden">看回答</span> : undefined}
      // The row's own control, always shown: one 「⋯」, which on a phone leaves the question its width (a text button took half of it).
      menu={editable ? <Menu label={`“${question.text}”的操作`} items={[{ label: "移出测量问句", disabled: busy, onSelect: remove }]} /> : undefined}
    />
  );
}

/** The real phrasings: the words people used, and where they said them. */
function Phrasings({ phrasings }: { phrasings: GeoQuestion[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? phrasings : phrasings.slice(0, PHRASINGS_SHOWN);
  return (
    <div>
      <ul aria-label="真实问法" className="flex flex-wrap gap-2">
        {shown.map((question) => {
          const href = safeWebHref(question.sourceUrl);
          const platform = platformName(question.platform);
          return (
            <li key={question.id} className="inline-flex max-w-full items-baseline gap-1 rounded bg-surface-1 px-2 py-1 text-ui text-text-2">
              <span className="min-w-0">{question.text}</span>
              {platform && (
                href
                  ? <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-caption text-text-3 underline decoration-border underline-offset-2 hover:text-text">{platform}</a>
                  : <span className="shrink-0 text-caption text-text-3">{platform}</span>
              )}
            </li>
          );
        })}
      </ul>
      {phrasings.length > PHRASINGS_SHOWN && (
        <Button variant="text" size="sm" className="mt-2" onClick={() => setAll((value) => !value)}>
          {all ? "收起" : `还有 ${phrasings.length - PHRASINGS_SHOWN} 条`}
        </Button>
      )}
    </div>
  );
}
