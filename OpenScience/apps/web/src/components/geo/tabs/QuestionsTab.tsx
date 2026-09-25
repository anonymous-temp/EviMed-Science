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
import { Tag } from "@/components/ui/Tag";
import { GEO_POOL_KINDS, GEO_POOL_NAMES, GEO_POOLS, monthDay } from "../geoText";
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

/** Real phrasings shown before 「还有 N 条」. */
const PHRASINGS_SHOWN = 6;

/**
 * 问题 (plan §3.3, mockup g05): the four-pool question map. Pools are filter
 * chips; within a pool, each semantic group opens to its typical question,
 * the questions being measured (each with 「移出测量问句」) and the real
 * phrasings collected from social platforms, with the platform named.
 * Control groups are marked. A locked set is versioned: an older version can
 * be looked at, and removing a question writes a new one.
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
  geoId,
  data,
  groups,
  onVersion,
  onChanged,
}: {
  geoId: string;
  data: GeoQuestions;
  groups: GeoQuestionGroup[];
  onVersion: (version: number | null) => void;
  onChanged: () => void;
}) {
  const [pool, setPool] = useState<PoolFilter>("all");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
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
  const toggle = (id: string) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div data-geo-tab="questions">
      <FilterRow summary={`${counts.groups} 个语义群 · ${counts.measured} 问 · ${counts.real.toLocaleString("zh-CN")} 条真实问法`}>
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
      </FilterRow>
      {(pool === "all" || !pools.includes(pool as GeoPool) ? pools : [pool as GeoPool]).map((key) => (
        <section key={key} aria-label={GEO_POOL_KINDS[key]} className="mt-8">
          <h2 className="flex items-baseline gap-2 text-ui font-medium text-text">
            {GEO_POOL_KINDS[key]}
            {!GEO_POOL_NAMES[key].startsWith(GEO_POOL_KINDS[key]) && (
              <span className="text-caption font-normal text-text-3">{GEO_POOL_NAMES[key]}</span>
            )}
          </h2>
          <ul className="mt-2 flex flex-col divide-y divide-faint">
            {groups.filter((group) => group.pool === key).map((group) => (
              <GroupRow
                key={group.id}
                geoId={geoId}
                group={group}
                expanded={open.has(group.id)}
                onToggle={() => toggle(group.id)}
                onChanged={onChanged}
                editable={current === latest}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function GroupRow({
  geoId,
  group,
  expanded,
  onToggle,
  onChanged,
  editable,
}: {
  geoId: string;
  group: GeoQuestionGroup;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  /** Only the newest version can lose a question. */
  editable: boolean;
}) {
  const questions = list(group.questions);
  const measured = questions.filter((question) => question.isMeasured);
  const phrasings = questions.filter((question) => !question.isMeasured && question.kind === "real");
  const meta = [
    group.journeyStage || null,
    `${measured.length} 问`,
    `${phrasings.length} 条原话`,
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
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left text-ui font-medium text-text hover:text-accent"
        >
          <ChevronRight size={16} aria-hidden="true" className={cn("shrink-0 text-text-3 transition-transform duration-fast", expanded && "rotate-90")} />
          <span className="min-w-0 truncate">{group.name}</span>
        </button>
        {group.isControl && <Tag>对照组</Tag>}
        <span className="shrink-0 text-caption tabular-nums text-text-3">{meta}</span>
      </div>
      {expanded && (
        <div id={panelId} className="mt-3 flex flex-col gap-3 pl-6">
          {/* A typical question that is itself measured is listed once, with its action. */}
          {group.typicalQuestion && !measured.some((question) => question.text.trim() === group.typicalQuestion.trim()) && (
            <p className="flex items-start gap-2 text-ui text-text">
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="max-w-measure">{group.typicalQuestion}</span>
            </p>
          )}
          {measured.length > 0 && (
            <ul aria-label="测量问句" className="flex flex-col">
              {measured.map((question) => (
                <MeasuredRow key={question.id} geoId={geoId} question={question} editable={editable} onChanged={onChanged} />
              ))}
            </ul>
          )}
          {phrasings.length > 0 && <Phrasings phrasings={phrasings} />}
        </div>
      )}
    </li>
  );
}

function MeasuredRow({ geoId, question, editable, onChanged }: { geoId: string; question: GeoQuestion; editable: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = () => {
    setBusy(true);
    void unmeasureGeoQuestion(geoId, question.id)
      .then(() => {
        toast.success("已移出，之后的测量不再问这一句。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "没有移出，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  return (
    <li data-geo-question={question.id} className="flex items-start gap-3 rounded px-2 py-2 hover:bg-surface-1">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="max-w-measure text-ui text-text">{question.text}</span>
        <span className="text-caption text-text-3">
          {[KIND_WORDS[question.kind] ?? null, question.platform || null].filter(Boolean).join(" · ")}
        </span>
      </div>
      {editable && (
        <Button variant="text" size="sm" loading={busy} onClick={remove}>移出测量问句</Button>
      )}
    </li>
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
          return (
            <li key={question.id} className="inline-flex max-w-full items-baseline gap-1 rounded bg-surface-1 px-2 py-1 text-ui text-text-2">
              <span className="min-w-0">{question.text}</span>
              {question.platform && (
                href
                  ? <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-caption text-text-3 underline decoration-border underline-offset-2 hover:text-text">{question.platform}</a>
                  : <span className="shrink-0 text-caption text-text-3">{question.platform}</span>
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
