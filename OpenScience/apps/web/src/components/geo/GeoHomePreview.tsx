import { Link } from "react-router";
import { formatRelativeTime } from "@/lib/format";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import { GEO_STEP_KEYS, type GeoProjectSummary, type GeoStep } from "@/lib/geoClient";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Note } from "@/components/ui/Note";
import { RAIL_STATE_WORDS, RailMark, type RailState } from "@/components/ui/ProgressRail";
import { Section } from "@/components/ui/Section";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import { geoSampleText } from "./GeoCellText";
import { GeoSparkline } from "./GeoSparkline";
import { tileValue } from "./geoOverviewModel";
import { geoJourney, geoActionPermission } from "./geoJourney";
import { GEO_STEP_HOME, geoDestinationPath, geoTabPath } from "./geoTabs";
import { coverageText, engineName, GEO_STEP_EMPTY, GEO_STEP_NAMES, GEO_STEP_WAITING, GEO_STEP_WORK, weekOf } from "./geoText";

/**
 * What the 循证 GEO home shows of one project beside the list, from what `GET /api/geo/projects` already carries — a peek, not the
 * project's page (`打开项目` goes there): its name, what stands in the way (a pause, errors an AI engine still makes), the two numbers
 * the list is read by with the sample under each, the eight steps with where each one is, and the window, the engines and the last
 * activity. Nothing here is read a second time and nothing is invented: a number that does not exist yet says so, and why.
 */

/** What is open on the project, in the list's own words: the severe errors first (their badge carries the red), then the errors an engine still makes, then articles stopped on a safety finding. */
export function alertText(project: GeoProjectSummary): string | null {
  const { severe, wrongOurs, safety } = project.alert;
  if (severe > 0) return `${severe} 条严重讲错待处理`;
  if (wrongOurs > 0) return `${wrongOurs} 条讲错待处理`;
  if (safety > 0) return `${safety} 篇稿件的安全问题待确认`;
  return null;
}

/** “10月1日～12月31日 · 第 3 周”, or what a project that has done one step only did, or “还没开始”. */
export function progressLine(project: GeoProjectSummary): string {
  const journey = geoJourney(project);
  const asked = journey.workflow.requested as typeof GEO_STEP_KEYS[number][];
  if (journey.requested === "历史工作范围待确认") return journey.requested;
  const touched = GEO_STEP_KEYS.filter((key) => project.steps[key] && project.steps[key]!.status !== "none");
  if (asked.length > 0 && asked.length < GEO_STEP_KEYS.length) {
    const names = asked.map((key) => GEO_STEP_WORK[key]).join("、");
    // A step that ended without finishing is not under way: it says so, and the project's page says what to do about it.
    const failed = asked.filter((key) => project.steps[key]?.status === "failed");
    if (failed.length > 0) return `${failed.map((key) => GEO_STEP_WORK[key]).join("、")}没有做完`;
    return asked.every((key) => project.steps[key]?.status === "done") ? `只做了${names}` : `正在做${names}`;
  }
  if (touched.length === 0) return "还没开始";
  const start = project.startedAt ?? project.createdAt ?? null;
  const week = weekOf(start);
  return [coverageText(project.coverageDays, start), ...(week ? [`第 ${week} 周`] : [])].join(" · ");
}

/** The tab an open alert is handled in: the errors and the safety stops are 准确与安全's. */
const ALERT_TAB = "accuracy";

/**
 * A step as the project page's rail draws it, from the list's own record of it. The page's rail also knows a budget a person still
 * has to set, which the list does not carry: a step the allowance would not start is the one 「等你」 it can tell.
 */
export function stepMark(step: GeoStep | undefined): { state: RailState; word: string } {
  if (stepAllowanceWait(step)) return { state: "waiting", word: RAIL_STATE_WORDS.waiting };
  switch (step?.status ?? "none") {
    case "done": return { state: "done", word: RAIL_STATE_WORDS.done };
    case "running": return { state: "active", word: RAIL_STATE_WORDS.active };
    case "queued": return { state: "active", word: "排队中" };
    case "failed": return { state: "attention", word: RAIL_STATE_WORDS.attention };
    case "minimal": return { state: "partial", word: RAIL_STATE_WORDS.partial };
    default: return { state: "todo", word: step?.requestOrigin === "legacy" && step.requested ? "待确认" : step?.requested === true ? "待开始" : step?.requested === false ? "未请求" : RAIL_STATE_WORDS.todo };
  }
}

/**
 * Why a number is not there yet, said once under the two figures: the diagnosis, which asks the AI engines, is what measures them. Once
 * it has run, the number's own word (「样本不足」, 「未测」) is the reason and nothing more is said.
 */
function unmeasuredWhy(project: GeoProjectSummary): string | null {
  const diagnosis = project.steps.diagnosis;
  const status = diagnosis?.status ?? "none";
  if (status === "running") return "正在问各家 AI。";
  if (status === "none" || status === "queued") return diagnosis?.requested === true ? GEO_STEP_WAITING.diagnosis : GEO_STEP_EMPTY.diagnosis;
  return null;
}

export function GeoProjectPreview({ project, label, heading, resuming, onResume, onConversation }: {
  project: GeoProjectSummary;
  /** The name the list shows (two projects of one name are told apart by their start day). */
  label: string;
  /** Beside the list the preview names the project; in the drawer the drawer's title does. */
  heading: boolean;
  resuming: boolean;
  onResume: () => void;
  onConversation: () => void;
}) {
  const paused = project.status === "paused";
  const journey = geoJourney(project);
  const alert = paused ? null : alertText(project);
  const start = project.startedAt ?? project.createdAt ?? null;
  const week = weekOf(start);
  const marks = GEO_STEP_KEYS.map((key) => ({ key, ...stepMark(project.steps[key]) }));
  const done = marks.filter((mark) => mark.state === "done").length;

  const { gvi, mention } = project.headline;
  const figures = [
    { cell: gvi, unit: "index" as const, name: "综合可见度指数", line: gvi.trend, target: gvi.target },
    { cell: mention, unit: "percent" as const, name: "品牌提及率", line: [] as number[], target: null },
  ].map((figure) => ({ ...figure, read: tileValue(figure.cell, figure.unit) }));
  // A number under the sample floor has its sample as its words; one that does not exist is explained once, under both.
  const missing = figures.some((figure) => figure.read.placeholder && figure.cell?.status !== "insufficient");

  const updated = formatRelativeTime(project.updatedAt);
  const facts: Fact[] = [
    ...(project.product.brandName && project.product.brandName !== project.name ? [{ label: "品牌", value: project.product.brandName }] : []),
    { label: "覆盖窗口", value: [coverageText(project.coverageDays, start), ...(week ? [`第 ${week} 周`] : [])].join(" · ") },
    ...(project.engines.length > 0 ? [{ label: "测量的 AI", value: project.engines.map((engine) => engineName(engine)).join("、") }] : []),
    ...(updated ? [{ label: "最近活动", value: <time dateTime={project.updatedAt}>{updated}</time> }] : []),
  ];

  return (
    <div data-geo-preview={project.id} className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {heading && (
          <div className="min-w-0 flex-1 basis-48">
            <h2 className="line-clamp-2 text-section font-semibold text-text">{label}</h2>
            <p data-geo-subline="" className="mt-1 text-caption text-text-3">{paused ? "已暂停" : progressLine(project)}</p>
          </div>
        )}
        {/* The preview's own way on is secondary: the page's one solid button is 新建项目, in the list's header. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link to={`/app/geo/${encodeURIComponent(project.id)}`} className={buttonClasses({ variant: "secondary" })}>打开项目</Link>
          {journey.canConverse && <Button variant="text" onClick={onConversation}>在对话中继续</Button>}
        </div>
      </div>

      {paused && (
        <Note tone="warn" action={geoActionPermission(project, "edit").allowed ? <Button variant="text" size="sm" loading={resuming} onClick={onResume} aria-label={`继续“${label}”`}>恢复项目</Button> : undefined}>
          项目已暂停。
        </Note>
      )}
      {alert && (
        <Note tone="warn" action={<Link to={geoTabPath(project.id, ALERT_TAB)} className="shrink-0 rounded text-link hover:underline">去处理</Link>}>
          {project.alert.severe > 0 && project.alert.severity && <SeverityBadge level={project.alert.severity} className="mr-1.5 align-middle" />}
          <span data-geo-alert="">{alert}</span>
        </Note>
      )}

      <section aria-label="当前工作" data-geo-journey={journey.stage} className="flex flex-col gap-2">
        <p className="text-caption text-text-3">{journey.requested}</p>
        <h3 className="text-ui font-semibold">{journey.title}</h3>
        <p className="text-ui text-text-2">{journey.detail}</p>
        {journey.retained.length > 0 && <p className="text-caption text-text-3">{`已保留：${journey.retained.join('、')}`}</p>}
        <Link className="self-start rounded text-ui text-link hover:underline" to={journey.next.step ? geoDestinationPath(project.id, GEO_STEP_HOME[journey.next.step]) : `/app/geo/${encodeURIComponent(project.id)}`}>继续当前工作</Link>
      </section>
      {figures.some(figure => !figure.read.placeholder || figure.cell.denominator != null || figure.cell.numerator != null) && <StatBand label="项目指标" columns={2} separate dense footnote={(missing ? unmeasuredWhy(project) : null) ?? undefined}>
        {figures.map((figure) => (
          <StatTile
            key={figure.name}
            label={figure.name}
            dense
            reading={figure.read.reading}
            renderMeasured={() => figure.read.value}
            note={geoSampleText(figure.cell, figure.unit)}
            chart={!figure.read.placeholder && figure.line.length > 0 ? <GeoSparkline values={figure.line} target={figure.target} width={140} height={28} className="w-full" /> : undefined}
          />
        ))}
      </StatBand>}

      <Section title="进度" count={`${done} / ${GEO_STEP_KEYS.length}`}>
        <ol aria-label="八步进度" className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {marks.map((mark) => (
            <li key={mark.key} data-geo-step={mark.key} className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5"><RailMark state={mark.state} /></span>
              <Link to={geoDestinationPath(project.id, GEO_STEP_HOME[mark.key])} className="min-w-0 rounded text-ui text-text hover:underline">
                {GEO_STEP_NAMES[mark.key]}
                <span className="block text-caption text-text-3">{mark.word}</span>
              </Link>
            </li>
          ))}
        </ol>
      </Section>

      <FactList rows={facts} ruled={false} />
    </div>
  );
}
