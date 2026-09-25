import { useState } from "react";
import { Link } from "react-router";
import {
  getGeoDiagnosis,
  readGeoCell,
  type GeoCell,
  type GeoDiagnosis,
  type GeoErrorRow,
  type GeoProject,
} from "@/lib/geoClient";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import { AskAi } from "../AskAi";
import { geoCellPhrase } from "../GeoCellText";
import {
  engineName,
  GEO_ERROR_ACTION_WORDS,
  GEO_ERROR_STATUS_WORDS,
  GEO_ERROR_TYPE_WORDS,
  GEO_POOL_KINDS,
  GEO_STABILITY_WORDS,
  monthDay,
} from "../geoText";
import {
  answerPath,
  CITED_ATTRIBUTE_WORDS,
  errorLine,
  MENTION_ONLY_WORD,
  mentionOnly,
  metricUnit,
  roundLabel,
  rowDraft,
  severityWord,
  surfaceText,
} from "./geoTabText";
import { CellLink, FilterRow, StepPending, TabError, TabSection, TabSkeleton, TD, TH, useGeoLoad } from "./geoTabKit";

/**
 * 诊断 (plan §3.4, mockup g06): one measurement round read four ways — the
 * four failure modes, each engine, each pool, and the wrong sentences about
 * us. Every number opens the answers behind it; 「问 AI」 beside a row takes
 * its numbers into the project's conversation.
 *
 * 百度 is measured through the inclusion channel, which sees only whether we
 * are mentioned: its accuracy, citation and retrieval read 「只测提及」.
 */
export function DiagnosisTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const [round, setRound] = useState<string | null>(null);
  const { state, reload } = useGeoLoad(`diagnosis:${geoId}:${round ?? "latest"}`, () => getGeoDiagnosis(geoId, round));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const diagnosis = state.data;
  if (!diagnosis?.round) return <StepPending geoId={geoId} project={project} step="diagnosis" />;
  return <Diagnosis geoId={geoId} project={project} diagnosis={diagnosis} onRound={setRound} />;
}

function Diagnosis({
  geoId,
  project,
  diagnosis,
  onRound,
}: {
  geoId: string;
  project: GeoProject;
  diagnosis: GeoDiagnosis;
  onRound: (round: string | null) => void;
}) {
  const round = diagnosis.round!;
  const rounds = Array.isArray(diagnosis.rounds) && diagnosis.rounds.length ? diagnosis.rounds : [round];
  const options: FilterOption<string>[] = rounds.map((item) => ({ value: item.id, label: roundLabel(item) }));
  const date = monthDay(round.sampleDate);
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const target = { projectId: project.projectId, sessionId: project.sessionId };
  const errors = (Array.isArray(diagnosis.errors) ? diagnosis.errors : []).filter((error) => error && error.id);
  const engines = Array.isArray(round.engines) ? round.engines : [];
  const summary = [
    engines.length ? `${engines.length} 个引擎` : null,
    typeof round.done === "number" ? `${round.done.toLocaleString("zh-CN")} 次回答` : null,
    surfaceText(round.surface),
    date,
  ].filter(Boolean).join(" · ");

  return (
    <div data-geo-tab="diagnosis">
      <FilterRow summary={summary || undefined}>
        <FilterChips label="测量轮次" options={options} value={round.id} onChange={(value) => onRound(value)} />
      </FilterRow>
      <FailureModes geoId={geoId} diagnosis={diagnosis} errors={errors} />
      <ByEngine geoId={geoId} diagnosis={diagnosis} errors={errors} product={product} date={date} target={target} />
      <ByPool geoId={geoId} diagnosis={diagnosis} product={product} date={date} target={target} />
      {errors.length > 0 && <Errors geoId={geoId} errors={errors} product={product} date={date} target={target} />}
      <More geoId={geoId} diagnosis={diagnosis} product={product} date={date} target={target} />
    </div>
  );
}

type Target = { projectId: string; sessionId: string | null };

const MODES: Array<{ key: keyof GeoDiagnosis["failureModes"]; label: string }> = [
  { key: "omitted", label: "漏提我方" },
  { key: "correct", label: "讲对我方" },
  { key: "wrongOurs", label: "讲错我方" },
  { key: "wrongCompetitor", label: "讲错竞品" },
];

/**
 * The four failure modes as counts over the round's answers. A count is the
 * cell's numerator; the denominator — how many answers it is out of — is
 * stated once for the block.
 */
function FailureModes({ geoId, diagnosis, errors }: { geoId: string; diagnosis: GeoDiagnosis; errors: GeoErrorRow[] }) {
  const modes = MODES.map((mode) => ({ ...mode, cell: readGeoCell(diagnosis.failureModes?.[mode.key]) }));
  const total = modes.map((mode) => mode.cell.denominator).find((value): value is number => typeof value === "number" && value > 0) ?? null;
  const firstError = errors.find((error) => error.snapshotId)?.snapshotId ?? null;
  return (
    <div data-geo-failure-modes="" className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-4 rounded-card bg-surface-1 px-5 py-4">
      {modes.map((mode) => {
        const count = mode.cell.status === "absent" || mode.cell.status === "not_measurable" ? null : mode.cell.numerator;
        const snapshot = mode.cell.snapshotIds?.[0] ?? (mode.key === "wrongOurs" ? firstError : null);
        const wrong = mode.key === "wrongOurs" && typeof count === "number" && count > 0;
        const text = (
          <span className={wrong ? "text-title font-semibold tabular-nums text-danger" : "text-title font-semibold tabular-nums text-text"}>
            {count === null ? "—" : count.toLocaleString("zh-CN")}
          </span>
        );
        return (
          <div key={mode.key} data-geo-mode={mode.key} className="flex flex-col gap-1">
            <span className="text-caption text-text-3">{mode.label}</span>
            {snapshot && count !== null ? (
              <Link to={answerPath(geoId, snapshot)} className="rounded hover:underline hover:underline-offset-4">
                {text}
                <span className="sr-only">{`${mode.label}，看回答`}</span>
              </Link>
            ) : text}
          </div>
        );
      })}
      {total !== null && <span className="ml-auto text-caption tabular-nums text-text-3">{`共 ${total.toLocaleString("zh-CN")} 次回答`}</span>}
    </div>
  );
}

const ENGINE_COLUMNS: Array<{ key: "mention" | "accuracy" | "citation" | "retrieval"; label: string; mentionOnly: boolean }> = [
  { key: "mention", label: "品牌提及率", mentionOnly: false },
  { key: "accuracy", label: "事实准确率", mentionOnly: true },
  { key: "citation", label: "引用命中率", mentionOnly: true },
  { key: "retrieval", label: "检索触发率", mentionOnly: true },
];

function ByEngine({
  geoId,
  diagnosis,
  errors,
  product,
  date,
  target,
}: {
  geoId: string;
  diagnosis: GeoDiagnosis;
  errors: GeoErrorRow[];
  product: string;
  date: string | null;
  target: Target;
}) {
  const rows = (Array.isArray(diagnosis.byEngine) ? diagnosis.byEngine : []).filter((row) => row && row.engine);
  if (rows.length === 0) return null;
  return (
    <TabSection title="按引擎" className="mt-8">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 bg-bg`}>AI 引擎</th>
              {ENGINE_COLUMNS.map((column) => <th key={column.key} scope="col" className={`${TH} text-right`}>{column.label}</th>)}
              <th scope="col" className={TH}><span className="sr-only">问 AI</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const only = mentionOnly(row.engine);
              const cells = ENGINE_COLUMNS.map((column) => ({ ...column, cell: readGeoCell(row[column.key]) }));
              const errorSnapshot = errors.find((error) => error.engine === row.engine && error.snapshotId)?.snapshotId ?? null;
              return (
                <tr key={row.engine} data-geo-engine={row.engine} className="border-b border-faint">
                  <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>{engineName(row.engine)}</th>
                  {cells.map((column) => (
                    <td key={column.key} className={`${TD} text-right`}>
                      {only && column.mentionOnly
                        ? <span className="text-ui text-text-3">{MENTION_ONLY_WORD}</span>
                        : (
                          <CellLink
                            geoId={geoId}
                            cell={column.cell}
                            className="inline-flex justify-end text-right"
                            fallbackSnapshotId={column.key === "accuracy" ? errorSnapshot : null}
                            label={`${engineName(row.engine)}的${column.label}`}
                          />
                        )}
                    </td>
                  ))}
                  <td className={`${TD} w-16 text-right`}>
                    {/* An engine with no measured number has nothing to ask about. */}
                    {cells.some((column) => column.cell?.value != null) && (
                      <AskAi
                        project={target}
                        draft={rowDraft({
                          product,
                          scope: engineName(row.engine),
                          cells: cells.map((column) => ({ name: column.label, cell: column.cell, word: only && column.mentionOnly ? MENTION_ONLY_WORD : undefined })),
                          date,
                        })}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TabSection>
  );
}

function ByPool({ geoId, diagnosis, product, date, target }: { geoId: string; diagnosis: GeoDiagnosis; product: string; date: string | null; target: Target }) {
  const rows = (Array.isArray(diagnosis.byPool) ? diagnosis.byPool : []).filter((row) => row && row.pool);
  if (rows.length === 0) return null;
  return (
    <TabSection title="按问句池">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={`${TH} sticky left-0 bg-bg`}>问句池</th>
              <th scope="col" className={`${TH} text-right`}>品牌提及率</th>
              <th scope="col" className={TH}>头部竞品</th>
              <th scope="col" className={TH}>主要问题</th>
              <th scope="col" className={TH}><span className="sr-only">问 AI</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cell = readGeoCell(row.mention);
              const pool = GEO_POOL_KINDS[row.pool] ?? "—";
              return (
                <tr key={row.pool} data-geo-pool={row.pool} className="border-b border-faint">
                  <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>{pool}</th>
                  <td className={`${TD} text-right`}>
                    <CellLink geoId={geoId} cell={cell} className="inline-flex justify-end" label={`${pool}的品牌提及率`} />
                  </td>
                  <td className={TD}>{row.topCompetitor || "—"}</td>
                  <td className={`${TD} max-w-measure`}>{row.mainIssue || "—"}</td>
                  <td className={`${TD} w-16 text-right`}>
                    <AskAi
                      project={target}
                      draft={`${product} · ${pool}：品牌提及率 ${geoCellPhrase(cell)}${row.topCompetitor ? `，头部竞品${row.topCompetitor}` : ""}${row.mainIssue ? `，主要问题：${row.mainIssue}` : ""}${date ? `（${date}测量）` : ""}。这说明了什么，接下来该做什么？`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TabSection>
  );
}

/**
 * The wrong sentences about us — the one red on the page. Each opens the
 * answer it was said in, and says what it gets wrong, how bad it would be,
 * where the engine took it from and what has been done about it.
 */
function Errors({ geoId, errors, product, date, target }: { geoId: string; errors: GeoErrorRow[]; product: string; date: string | null; target: Target }) {
  const open = errors.filter((error) => error.status !== "closed");
  return (
    <TabSection title="需要纠正" meta={open.length < errors.length ? `${open.length} 条待处理 · ${errors.length - open.length} 条已消失` : undefined}>
      <List divided>
        {errors.map((error) => {
          const closed = error.status === "closed";
          const cited = error.citedSource;
          const source = cited?.domain
            ? `出处 ${cited.domain}${cited.attribute && CITED_ATTRIBUTE_WORDS[cited.attribute] ? `（${CITED_ATTRIBUTE_WORDS[cited.attribute]}）` : ""}`
            : cited?.attribute === "none" ? CITED_ATTRIBUTE_WORDS.none : null;
          const meta = [
            GEO_ERROR_TYPE_WORDS[error.errorType] ?? null,
            severityWord(error.severity),
            error.stability ? GEO_STABILITY_WORDS[error.stability] ?? null : null,
            source,
            error.action ? GEO_ERROR_ACTION_WORDS[error.action] ?? null : null,
            closed ? null : GEO_ERROR_STATUS_WORDS[error.status] ?? null,
          ].filter(Boolean).join(" · ");
          return (
            <ListRow
              key={error.id}
              leading={<span className="w-16"><Tag tone={closed ? "neutral" : "safety"}>{closed ? "已消失" : "讲错我方"}</Tag></span>}
              title={errorLine(error)}
              to={error.snapshotId ? answerPath(geoId, error.snapshotId) : undefined}
              muted={closed}
              meta={meta}
              actions={(
                <AskAi
                  project={target}
                  draft={`${engineName(error.engine)}在回答里说「${error.statement}」${date ? `（${date}测量）` : ""}，这和${product}的说明书不一致。它从哪来，该怎么纠正？`}
                />
              )}
            />
          );
        })}
      </List>
    </TabSection>
  );
}

/** Everything else the round measured, folded: the index's other dimensions, rates and counts. */
function More({ geoId, diagnosis, product, date, target }: { geoId: string; diagnosis: GeoDiagnosis; product: string; date: string | null; target: Target }) {
  const rows = (Array.isArray(diagnosis.more) ? diagnosis.more : []).filter((row) => row && row.name);
  const noise = diagnosis.noise && typeof diagnosis.noise.band === "number" ? diagnosis.noise : null;
  if (rows.length === 0 && !noise) return null;
  return (
    <section className="mt-10">
      <Disclosure summary="更多指标">
        <ul className="flex flex-col divide-y divide-faint">
          {rows.map((row) => {
            const cell: GeoCell = readGeoCell(row.cell);
            const unit = metricUnit(row.metricId);
            return (
              <li key={row.metricId || row.name} data-geo-metric={row.metricId} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 text-ui text-text">{row.name}</span>
                <CellLink geoId={geoId} cell={cell} unit={unit} layout="inline" label={row.name} />
                <AskAi project={target} product={product} name={row.name} cell={cell} unit={unit} date={date} />
              </li>
            );
          })}
          {noise && (
            <li className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-ui text-text">波动范围</span>
              <span className="text-ui tabular-nums text-text">{`±${Math.round(noise.band * 10) / 10}`}</span>
              {noise.measuredAt && <span className="text-caption text-text-3">{`${monthDay(noise.measuredAt)}测`}</span>}
            </li>
          )}
        </ul>
      </Disclosure>
    </section>
  );
}
