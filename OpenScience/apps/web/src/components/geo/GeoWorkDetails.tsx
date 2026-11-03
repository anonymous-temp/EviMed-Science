import { Link } from "react-router";
import type { GeoProject, GeoStepKey } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { bandSteps } from "./geoBand";
import { GEO_STEP_HOME, geoDestinationPath } from "./geoTabs";
import { useGeoPath } from "./useGeoPath";
import { GeoWeekActivity } from "./GeoWeekActivity";

/** Project context beside the native conversation; this surface never changes project data. */
export function GeoWorkDetails({ project, onOpenRuns, onOpenSettings }: { project: GeoProject; onOpenRuns: () => void; onOpenSettings: () => void }) {
  const path = useGeoPath();
  const destination = (step: GeoStepKey) => path(geoDestinationPath(project.id, GEO_STEP_HOME[step]));
  const steps = project.overview?.steps && Object.keys(project.overview.steps).length ? project.overview.steps : project.steps;
  const progress = bandSteps(project, destination).filter((step) => !step.outside || steps[step.id as GeoStepKey]?.requested === true);
  const product = project.product;
  const identities = [product?.brandName, product?.genericName].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  return (
    <aside aria-label="项目资料" className="flex min-w-0 flex-col gap-5 text-ui">
      <section aria-labelledby="geo-work-product">
        <h2 id="geo-work-product" className="font-semibold text-text">产品与范围</h2>
        {identities.length > 0 && <p className="mt-2 text-text">{identities.join(" · ")}</p>}
        {product?.indication && <p className="mt-2 whitespace-pre-wrap text-text-2">{product.indication}</p>}
        {identities.length === 0 && !product?.indication && <p className="mt-2 text-text-3">产品资料尚未填写。</p>}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          <Link className="text-link hover:underline" to={destination("evidence")}>产品依据</Link>
          <Link className="text-link hover:underline" to={destination("journey")}>患者旅程</Link>
        </div>
      </section>
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer font-semibold text-text">任务进度{progress.length > 0 ? `（${progress.length}）` : ""}</summary>
        {progress.length ? <ul className="mt-3 flex flex-col gap-2">{progress.map((step) => <li key={step.id} className="flex justify-between gap-3">
          <Link className="min-w-0 text-link hover:underline" to={step.href!}>{step.label}</Link>
          <span className="shrink-0 text-text-2">{step.outside && steps[step.id as GeoStepKey]?.automation?.state === "declined" ? "已关闭" : step.stateLabel}</span>
        </li>)}</ul> : <p className="mt-3 text-text-3">暂无任务进度。</p>}
      </details>
      <GeoWeekActivity geoId={project.id} project={project} compact />
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button variant="secondary" size="sm" onClick={onOpenRuns}>执行详情</Button>
        <Button variant="secondary" size="sm" onClick={onOpenSettings}>项目设置</Button>
      </div>
    </aside>
  );
}
