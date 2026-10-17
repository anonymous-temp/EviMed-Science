import { useState, type ReactNode } from "react";
import { ChevronLeft, CircleCheck, Info } from "lucide-react";
import { VCR_COMPARATOR_ROUTE_LABELS_ZH } from "@evimed/domain";
import { getVcrComparator, type VcrComparatorTab as ComparatorData, type VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid, type ChartGridCell } from "@/components/ui/ChartGrid";
import { Disclosure } from "@/components/ui/Disclosure";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Headline } from "@/components/ui/Headline";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail } from "@/components/ui/MasterDetail";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { VcrSeriesLegend, VcrSurvivalChart } from "../VcrCharts";
import { ConclusionChip, SourceTag } from "../VcrMarks";
import { VcrNumber } from "../VcrNumber";
import { NotEstimableCard, PartialResultNote, Stale, VcrStepFailed, VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { BalancePlot } from "../comparator/BalancePlot";
import { DimensionBand } from "../comparator/DimensionBand";
import { useStudyFrame } from "../studyFrameContext";
import { pairRows, useVcrLoad, VcrTabError } from "../vcrTabKit";
import { conclusionLabel, intervalText } from "../vcrText";

const ROUTE_LABELS = VCR_COMPARATOR_ROUTE_LABELS_ZH as Record<string, string>;

/** What a route's state is called when it is not one of the three conclusions. */
const ROUTE_STATE_WORDS: Record<string, string> = {
  not_applicable: "不适用",
  scenario: "情景",
  design_only: "设计期可用",
};

/** The routes whose state is a conclusion (a chip of its own); the rest are a word. */
const CONCLUSIONS = new Set(["estimable", "limited", "not_estimable"]);

/** What 「评估可比性」 puts in the conversation's composer — never sent. */
export const VCR_ASSESS_COMPARABILITY_DRAFT = "请评估这项对照在十个可比性维度上能模拟到什么程度：";

/**
 * 对照: who this study should be compared with, and how much that comparison can carry.
 *
 * The routes are a list beside the record of the one in view (R19, plan §5.3; audit B §4.4): each says what it is at this study's
 * data tier, and the ones that cannot apply say what they would need and where it is brought in. The route the study uses is the
 * one with its results: the curves, the balance, the weights, the ten dimensions. 「不可估计」 is a finished result with a gap list
 * and what each gap would answer — the card, not a blank.
 *
 * Hidden knowledge:
 *  - **The conclusion is in the sentence.** What the page used to say last (「本页结论」) is the chip beside the headline.
 *  - **A reconstructed curve is dashed, always**, and the legend says what the dash is. A Kaplan-Meier reconstructed out of a
 *    published figure is not a curve anybody measured, even when it passed the quality check beside it.
 *  - **Comparability is said twice, and the two are different claims**: the ten dimensions say how far the comparison can be
 *    simulated at all; the balance plot and the weight numbers say how well the weighting did on the covariates it could see.
 *  - **The balance is a plot, not a table.** Where the weighting moved a covariate is the distance between two dots on one axis;
 *    the numbers stand beside it.
 *  - **Looking at a route is not choosing it.** The route the study uses is the server's; a press on another row reads about that
 *    route (what it is, what it would need) and changes nothing the study computes.
 */
export function ComparatorTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { state, reload } = useVcrLoad(`${studyId}:comparator`, () => getVcrComparator(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  return <ComparatorView studyId={studyId} study={study} data={state.data} />;
}

function ComparatorView({ studyId, study, data }: { studyId: string; study: VcrStudy; data: ComparatorData }) {
  const failed = study.steps.comparator?.status === "failed";
  // The routes and the ten dimensions are what every study has before anything ran — they say what each route could be at this tier —
  // so they do not count as a result.
  const prior = data.prior ?? [];
  const nothing = data.curves.length === 0 && !data.rmst && !data.median && !data.gaps && !data.estimand
    && data.comparability.length === 0 && data.diagnostics.length === 0 && prior.length === 0 && data.qc.length === 0 && !data.verdict;
  // The route in view: the one the study uses until the reader presses another. On a narrow page the record replaces the list.
  const used = data.routes.find((route) => route.selected)?.route ?? data.routes[0]?.route ?? null;
  const [looking, setLooking] = useState<string | null>(null);
  const [listed, setListed] = useState(false);
  if (nothing) {
    return failed
      ? <VcrStepFailed studyId={studyId} study={study} step="comparator" partial={data.partial} />
      : <VcrStepPending studyId={studyId} study={study} step="comparator" />;
  }
  const viewed = data.routes.find((route) => route.route === (looking ?? used)) ?? null;

  const choose = (route: string) => { setLooking(route); setListed(false); };
  const list = (
    <div className="pr-4 max-lg:pr-0">
      <List label="对照路线">
        {data.routes.map((route) => (
          <ListRow
            key={route.route}
            title={ROUTE_LABELS[route.route] ?? route.route}
            onOpen={() => choose(route.route)}
            selected={viewed?.route === route.route}
            titleProps={{ "data-vcr-route": route.route, "data-vcr-route-state": route.state }}
            meta={(
              <span className="flex flex-wrap items-center gap-1.5">
                {CONCLUSIONS.has(route.state) ? <ConclusionChip state={route.state as "estimable" | "limited" | "not_estimable"} /> : <Tag>{ROUTE_STATE_WORDS[route.state] ?? route.state}</Tag>}
                {route.selected && <Tag tone="accent">采用</Tag>}
                {(route.reason || route.note) && <span className="min-w-0 truncate text-caption text-text-3">{route.reason ?? route.note}</span>}
              </span>
            )}
          />
        ))}
      </List>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {failed
        ? <VcrStepFailed studyId={studyId} study={study} step="comparator" partial={data.partial} />
        : data.partial && <PartialResultNote sentence={data.partial.sentence} resume={{ studyId, study, step: "comparator" }} />}

      <Stale note={data.stale}>
        <div className="flex flex-col gap-6">
          {(data.headline || data.verdict) && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {data.headline && <Headline parts={[data.headline]} />}
              {data.verdict && (
                <span data-vcr-verdict="" className="inline-flex items-center">
                  <ConclusionChip state={data.verdict.conclusion} />
                  <span className="sr-only">{conclusionLabel(data.verdict.conclusion)}</span>
                </span>
              )}
            </div>
          )}

          <MasterDetail
            className="h-auto"
            narrow="swap"
            selected={!listed}
            listLabel="对照路线"
            detailLabel="路线的记录"
            list={list}
            detail={({ split }) => (
              <div className={cn("flex min-w-0 flex-col gap-6", split && "pl-6")}>
                {!split && (
                  <div>
                    <Button size="sm" variant="text" onClick={() => setListed(true)}><ChevronLeft size={16} aria-hidden="true" />全部路线</Button>
                  </div>
                )}
                {viewed && (viewed.route === used
                  ? <UsedRoute data={data} />
                  : <OtherRoute data={data} route={viewed} />)}
              </div>
            )}
          />
        </div>
      </Stale>
    </div>
  );
}

/* ------------------------------------------------------------------------- the route the study uses */

function UsedRoute({ data }: { data: ComparatorData }) {
  const frame = useStudyFrame();
  const prior = data.prior ?? [];
  const estimand = data.estimand && (data.estimand.rows.length > 0 || data.estimand.note) ? data.estimand : null;

  const cells: ChartGridCell[] = [];
  if (data.curves.length > 0) {
    cells.push({
      key: "curves",
      span: 2,
      node: (
        <ChartCard
          title="对照组的生存曲线与合并估计"
          legend={(
            <>
              <VcrSeriesLegend series={data.curves} />
              {data.rmst?.tau != null && (
                <span className="inline-flex items-center gap-1.5 text-caption text-text-2">
                  <span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-tag bg-chart-band" />
                  {`${data.rmst.tau} 个月内曲线下面积`}
                </span>
              )}
            </>
          )}
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
            <VcrSurvivalChart curves={data.curves} rmst={data.rmst ? { tau: data.rmst.tau ?? null, label: data.rmst.label } : null} />
            <ComparatorNumbers data={data} />
          </div>
        </ChartCard>
      ),
    });
  } else if (data.rmst || data.median) {
    cells.push({ key: "numbers", span: 2, node: <ChartCard title="对照组的生存估计"><ComparatorNumbers data={data} /></ChartCard> });
  }
  const second: ChartGridCell[] = [];
  if (data.comparability.length > 0) {
    second.push({ key: "balance", node: <ChartCard title="与本研究人群的可比性"><BalancePlot rows={data.comparability} /></ChartCard> });
  }
  if (data.diagnostics.length > 0) {
    second.push({
      key: "weights",
      node: (
        <ChartCard title="权重与重叠">
          <div data-vcr-diagnostics=""><FactList rows={data.diagnostics.map((row): Fact => ({ label: row.label, value: <span className="tabular-nums"><VcrNumber value={row.value} label={row.label} /></span> }))} /></div>
        </ChartCard>
      ),
    });
  }
  const grid = [...cells.map((cell) => [cell]), ...pairRows(second)];

  const estimandRows: Fact[] = estimand
    ? [...estimand.rows.map((row) => ({ label: row.label, value: row.value })), ...(estimand.note ? [{ label: "说明", value: estimand.note }] : [])]
    : [];
  const priorRows: Fact[] = prior.map((row) => ({
    label: row.label,
    value: <span data-vcr-prior={row.key} className="tabular-nums"><VcrNumber value={row.value} label={row.label} /></span>,
  }));

  return (
    <>
      {estimandRows.length > 0 && (
        <Section title="估计目标" toolbar={estimand?.source ? <SourceTag source={estimand.source} /> : undefined}>
          <FactList rows={estimandRows} />
        </Section>
      )}

      {grid.length > 0 && <ChartGrid rows={grid} />}

      {data.dimensions.length > 0 && (
        <Section title="可比性">
          <DimensionBand dimensions={data.dimensions} onAssess={frame ? () => frame.openChat(VCR_ASSESS_COMPARABILITY_DRAFT) : null} />
        </Section>
      )}

      {priorRows.length > 0 && (
        <Section
          title="先验借用"
          toolbar={(
            <Tooltip content="先验相当于多少例本研究患者的信息量">
              <button type="button" aria-label="先验有效样本量是什么" className="inline-flex rounded text-text-3 hover:text-text"><Info size={16} aria-hidden="true" /></button>
            </Tooltip>
          )}
        >
          <FactList rows={priorRows} />
        </Section>
      )}

      {data.robustness && (data.robustness.rows.length > 0 || data.robustness.qualification || data.robustness.notes.length > 0) && (
        <RobustnessSection robustness={data.robustness} />
      )}

      {data.gaps && <Gaps gaps={data.gaps} />}

      {data.methods && data.methods.length > 0 && <Methods methods={data.methods} />}
    </>
  );
}

/** A route that is not the one in use: what it is, what it would need and where that is brought in. */
function OtherRoute({ data, route }: { data: ComparatorData; route: ComparatorData["routes"][number] }) {
  const frame = useStudyFrame();
  const needs = route.state === "not_applicable" || route.state === "not_estimable";
  // A route with its gaps listed says its state and what it needs in the list's own card; the facts would be the same words twice.
  const gaps = route.route === "external_control" ? data.gaps : null;
  const rows: Fact[] = gaps
    ? []
    : [
      { label: "状态", value: CONCLUSIONS.has(route.state) ? <ConclusionChip state={route.state as "estimable" | "limited" | "not_estimable"} /> : ROUTE_STATE_WORDS[route.state] ?? route.state },
      ...(route.reason ? [{ label: needs ? "需要什么" : "原因", value: route.reason }] : []),
      ...(route.note ? [{ label: "说明", value: route.note }] : []),
    ];
  return (
    <>
      <Section
        title={ROUTE_LABELS[route.route] ?? route.route}
        toolbar={needs && frame ? <Button size="sm" variant="secondary" onClick={() => frame.openPanel("intake")}>接入数据</Button> : undefined}
      >
        <div data-vcr-route-record={route.route} className="flex flex-col gap-4">
          {rows.length > 0 && <FactList rows={rows} />}
          {gaps && <Gaps gaps={gaps} />}
        </div>
      </Section>
      {route.route === "external_control" && data.e10 && data.e10.length > 0 && <Conditions conditions={data.e10} />}
    </>
  );
}

function Gaps({ gaps }: { gaps: NonNullable<ComparatorData["gaps"]> }) {
  return (
    <NotEstimableCard
      title={gaps.title ?? "真实外部对照：不可估计"}
      needs={gaps.needs}
      items={gaps.items}
      conclusion={[gaps.conclusion, gaps.rule ? `判定依据：${gaps.rule}` : null].filter(Boolean).join(" ") || null}
    />
  );
}

/** 外部对照适用情境: the conditions under which an external control may stand in, each met, partly met or in doubt. */
function Conditions({ conditions }: { conditions: NonNullable<ComparatorData["e10"]> }) {
  return (
    <Section title="外部对照适用情境" count={conditions.length}>
      <FactList
        max={conditions.length}
        rows={conditions.map((condition): Fact => ({
          label: condition.label,
          value: (
            <span className="flex flex-wrap items-center gap-2">
              <Tag tone={condition.state === "met" ? "neutral" : "warn"} className={cn(condition.state === "met" && "bg-ok-soft text-ok")}>
                {condition.state === "met" ? "满足" : condition.state === "partial" ? "部分" : "存疑"}
              </Tag>
              {condition.note && <span className="text-caption text-text-3">{condition.note}</span>}
            </span>
          ),
        }))}
      />
    </Section>
  );
}

/** 方法与版本: which methods made the numbers, folded — a reviewer checks them, a reader of the curves does not need them first. */
function Methods({ methods }: { methods: NonNullable<ComparatorData["methods"]> }) {
  return (
    <Disclosure summary={`方法与版本 · ${methods.length}`}>
      <FactList
        max={methods.length}
        rows={methods.map((method): Fact => ({
          label: method.version ?? "",
          value: (
            <span className="flex flex-wrap items-center gap-2">
              {method.passed && <CircleCheck size={16} aria-hidden="true" className="shrink-0 text-ok" />}
              {method.label}
              {method.note && <span className="text-caption text-text-3">{method.note}</span>}
            </span>
          ),
        }))}
      />
    </Disclosure>
  );
}

/**
 * 稳健性与预后校正: what the study's robustness analyses found beside the comparison, and — for a prognostic adjustment of a binary
 * or time-to-event endpoint — the plain statement that no regulator has qualified it. The statement sits with the numbers it is about.
 */
function RobustnessSection({ robustness }: { robustness: NonNullable<ComparatorData["robustness"]> }) {
  const rows: Fact[] = [
    ...robustness.rows.map((row) => ({ label: row.label, value: <span data-vcr-robustness-row={row.key} className="tabular-nums"><VcrNumber value={row.value} label={row.label} /></span> })),
    ...(robustness.qualification ? [{ label: "监管认可", value: <span data-vcr-qualification="">{robustness.qualification}</span> }] : []),
    ...robustness.notes.map((note) => ({ label: "说明", value: note })),
  ];
  return (
    <Section title="稳健性与预后校正分析">
      <div data-vcr-robustness=""><FactList rows={rows} /></div>
    </Section>
  );
}

/** The two numbers a comparator page is read for, beside the curves, and the reconstruction's quality check folded under them. */
function ComparatorNumbers({ data }: { data: ComparatorData }) {
  const passed = data.qc.filter((check) => check.passed).length;
  const checks: ReactNode = data.qc.length > 0 && (
    <Disclosure summary={`重建质控 ${passed} / ${data.qc.length} 通过`}>
      <FactList
        max={data.qc.length}
        rows={data.qc.map((check): Fact => ({
          label: check.label,
          value: (
            <span className="flex flex-wrap items-center gap-2 tabular-nums">
              {check.passed && <CircleCheck size={16} aria-hidden="true" className="shrink-0 text-ok" />}
              {check.value}
              {check.threshold && <span className="text-caption text-text-3">{`界值 ${check.threshold}`}</span>}
            </span>
          ),
        }))}
      />
    </Disclosure>
  );
  return (
    <div className="flex flex-col gap-4">
      {data.rmst && (
        <div data-vcr-rmst="">
          <p className="flex items-center gap-1.5 text-caption text-text-3">
            {data.rmst.label ?? "限制平均生存时间"}
            <SourceTag source={data.rmst.value.source} />
          </p>
          <p className="mt-1 text-metric font-semibold tabular-nums text-text">
            <VcrNumber value={data.rmst.value} label={data.rmst.label ?? "限制平均生存时间"} />
          </p>
          <p className="text-caption tabular-nums text-text-3">{intervalText(data.rmst.value.interval, data.rmst.value.precision)}</p>
        </div>
      )}
      {data.median && (
        <div data-vcr-median="">
          <p className="flex items-center gap-1.5 text-caption text-text-3">
            中位数
            <SourceTag source={data.median.source} />
          </p>
          <p className="mt-1 text-heading font-semibold tabular-nums text-text"><VcrNumber value={data.median} label="中位数" /></p>
          <p className="text-caption tabular-nums text-text-3">{intervalText(data.median.interval, data.median.precision)}</p>
        </div>
      )}
      {checks}
    </div>
  );
}
