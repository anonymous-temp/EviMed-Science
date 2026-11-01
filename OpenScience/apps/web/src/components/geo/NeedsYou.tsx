import { geoActionPermission } from "./geoJourney";
import { useGeoPath } from "./useGeoPath";
import { useGeoDestinationPath } from "./useGeoPath";
import { useState } from "react";
import { Link } from "react-router";
import { PenLine } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { runGeoStep, skipGeoAction, type GeoNeedsYou, type GeoProject, type GeoStepKey } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { isSeverityLevel, SeverityBadge } from "@/components/ui/SeverityBadge";
import { measurementPause, type MeasurementPause } from "./geoBand";
import { geoMayConverse, useGeoFrame } from "./geoFrame";
import { useGeoMonitoring } from "./geoProjectData";
import { engineName, GEO_STEP_NAMES, zh } from "./geoText";
import { GEO_STEP_HOME } from "./geoTabs";
import { answerPath } from "./tabs/geoTabText";
import { useOpenGeoConversation } from "./useOpenGeoConversation";

/**
 * 「需要你」: what the project really asks of its person, from the server's `needsYou` (R19, audit C A.3 / §2.3). It replaces the
 * 「下一步」 card, which restated the rail and listed what was **done**: a to-do list is never a log.
 *
 * Each row is one verb and the object it opens — 设置投放预算 opens the budget, 去放行 the articles, 写纠错稿 the correction with
 * the wrong sentence in it — and the row itself goes where its object is read. Nothing here is an approval: a person is asked only
 * for a thing that is theirs to do (money, a safety stop, an act outside the platform) or that went wrong; the programme goes on by
 * itself. A project with nothing to ask draws nothing: no sentence says so.
 *
 * One row is the page's own: while no AI engine can be asked, the measurement is paused, and the person is told so here — when it
 * stopped, that it goes on by itself — so the numbers above are not read as this week's. A step that failed because nothing could
 * be asked offers no 接着做 until it can be (a retry would ask nobody again).
 */
export function NeedsYou({ geoId, project, showMeasurement = true }: { geoId: string; project: GeoProject; showMeasurement?: boolean }) {
  const geoDestinationPath = useGeoDestinationPath();
  const monitoring = useGeoMonitoring(geoId);
  const pause = measurementPause(monitoring.state.kind === "ready" ? monitoring.state.data.measurement : null);
  const items = project.needsYou;
  const paused = pause?.paused ? pause : null;
  if (items.length === 0 && !pause) return null;
  return (
    <>
    {showMeasurement && pause && (
      <Section title="监测状态" className="mt-0">
        {/* The way on is where the numbers above come from: the trend, which says what the last round measured. */}
        <div role="status" data-geo-measurement="paused">
          <Note action={<Link className="text-link hover:underline" to={geoDestinationPath(geoId, GEO_STEP_HOME.monitoring)}>查看监测走势</Link>}>{pause.short}：{pause.detail}</Note>
        </div>
      </Section>
    )}
    {items.length > 0 && <Section title="需要你" count={items.length} className="mt-0">
      <List divided label="需要你处理的事">
        {items.map((item) => <NeedsYouRow key={item.key} geoId={geoId} project={project} item={item} pause={paused} />)}
      </List>
    </Section>}
    </>
  );
}

/** The steps that ask the AI engines: while measurement is paused, a retry of one of them would ask nobody. */
const MEASURING_STEPS: ReadonlySet<GeoStepKey> = new Set(["diagnosis", "monitoring"]);

function NeedsYouRow({ geoId, project, item, pause }: { geoId: string; project: GeoProject; item: GeoNeedsYou; pause: MeasurementPause | null }) {
  const path = useGeoPath();
  const geoDestinationPath = useGeoDestinationPath();
  const frame = useGeoFrame();
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const done = (fallback: string) => (error: unknown) => toast.error(webErrorMessage(error, { fallback }));
  const step = item.object.type === "step" && item.object.id ? (item.object.id as GeoStepKey) : null;

  if (item.kind === "set_budget") {
    return (
      <ListRow
        title="设置投放预算"
        meta="预算还没有定，稿件写好之后要在预算里才会投放"
        onOpen={geoActionPermission(project,"manage_money").allowed ? () => frame?.openPanel("budget") : undefined}
      />
    );
  }

  if (item.kind === "release_articles") {
    return (
      <ListRow
        title={`放行 ${item.count ?? item.object.ids?.length ?? 0} 篇稿件`}
        meta="稿件里有没处理完的安全问题，看过之后才会投放"
        to={geoDestinationPath(geoId, { tab: "actions", section: item.target.section ?? "review" })}
      />
    );
  }

  if (item.kind === "correct_severe_error") {
    const answer = item.target.snapshotId ?? null;
    const draft = zh`${engineName(item.engine ?? null)}在回答里说“${item.statement ?? ""}”，和${product}的说明书不一致。写一篇纠错稿，把正确的说法讲清楚。`;
    return (
      <ListRow
        title={<span className="max-w-measure">{`“${item.statement ?? ""}”`}</span>}
        to={answer ? path(answerPath(geoId, answer)) : undefined}
        meta={(
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {isSeverityLevel(item.severity) && <SeverityBadge level={item.severity} />}
            <span>{`${engineName(item.engine ?? null)}讲错了`}</span>
          </span>
        )}
        actions={geoMayConverse(project) ? (
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void open({ projectId: project.projectId }, draft).finally(() => setBusy(false));
            }}
          >
            {!busy && <PenLine size={16} aria-hidden="true" />}
            在对话中写纠错稿
          </Button>
        ) : undefined}
      />
    );
  }

  if (item.kind === "client_action") {
    return (
      <ListRow
        title={<span className="max-w-measure">{item.text ?? ""}</span>}
        meta="信源布局里需要你这边来做"
        to={geoDestinationPath(geoId, { tab: "plan", section: item.target.section ?? "client_actions" })}
        actions={geoActionPermission(project,"edit").allowed ? (
          <Button
            variant="text"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void skipGeoAction(geoId, item.key, true)
                .then(() => frame?.reload())
                .catch(done("这件事暂时无法标为已做，请稍后重试。"))
                .finally(() => setBusy(false));
            }}
          >
            已经做了
          </Button>
        ) : undefined}
      />
    );
  }

  if (item.kind === "credits_waiting" && step) {
    const waiting = item.waiting === "simulated_allowance" ? "simulated_allowance" : "allowance";
    return (
      <ListRow
        title={`${GEO_STEP_NAMES[step]}在等额度`}
        meta="额度补上之后会自己接着做"
        chevron={false}
        actions={geoActionPermission(project,"run").allowed ? <AllowanceTopUp waiting={waiting} /> : undefined}
      />
    );
  }

  if (item.kind === "step_failed" && step) {
    // A measurement that asked nobody kept nothing; while nobody can be asked, there is nothing to retry yet.
    const measuring = MEASURING_STEPS.has(step);
    const held = measuring && pause !== null;
    return (
      <ListRow
        title={`${GEO_STEP_NAMES[step]}没有做完`}
        meta={held ? "测量服务暂时不可用，已有结果仍可查看" : project.steps[step]?.summary?.text ? `已保留：${project.steps[step]?.summary?.text}` : project.steps[step]?.error || project.steps[step]?.note || "打开这一步查看运行记录和保留结果"}
        to={geoDestinationPath(geoId, GEO_STEP_HOME[step])}
        actions={held || !geoActionPermission(project,"run").allowed ? undefined : (
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void runGeoStep(geoId, step)
                .then(() => frame?.reload())
                .catch(done("这一步无法重试，请稍后重试。"))
                .finally(() => setBusy(false));
            }}
          >
            接着做
          </Button>
        )}
      />
    );
  }

  return null;
}
