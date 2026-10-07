import { useState } from "react";
import type { VcrDesign, VcrForecast } from "@/lib/vcrClient";
import { Drawer } from "@/components/ui/Drawer";
import { Tabs } from "@/components/ui/Tabs";
import { VcrFilePrediction, hasPredictableDesign } from "./VcrFilePrediction";

/**
 * 登记预测, in the drawer 「登记预测」 on the trial tab opens (2026-10-07: the form and the list used to stand under the results, two more
 * sections of a page that is one comparison).
 *
 * Two views of one thing — what has been registered, and registering another — as the drawer's own tabs when both exist; with nothing
 * registered the drawer is the form, and a reader who may not register (only the lead may) sees what has been. Each forecast is shown as
 * the numbers it predicted and, once the trial's data are in, beside what happened (plan §5.4, AC-23); the hash that proves it is the
 * registry's and never on a page.
 */
export function VcrPredictionsDrawer({ studyId, designs, forecasts, canFile, onFiled, onClose }: {
  studyId: string;
  designs: readonly VcrDesign[];
  forecasts: readonly VcrForecast[];
  /** The lead's, and only where the deployment has a registry. */
  canFile: boolean;
  /** A prediction was filed: the page reads its forecasts again. */
  onFiled: () => void;
  onClose: () => void;
}) {
  const fileable = canFile && hasPredictableDesign(designs);
  const [view, setView] = useState<"filed" | "new">(forecasts.length > 0 || !fileable ? "filed" : "new");
  const both = forecasts.length > 0 && fileable;
  // A reader who may register and has nothing to register from (no design with a probability yet) is shown what there is; with
  // neither, the drawer says so rather than opening empty.
  const shown = both ? view : fileable ? "new" : "filed";
  return (
    <Drawer title="登记预测" onClose={onClose} widthClassName="max-w-md">
      <div className="flex flex-col gap-6">
        {both && (
          <Tabs
            label="登记预测"
            items={[{ value: "filed", label: "已登记", count: forecasts.length }, { value: "new", label: "新登记" }]}
            value={view}
            onChange={setView}
          />
        )}
        {shown === "filed" && (forecasts.length > 0 ? <ForecastList forecasts={forecasts} /> : <p className="text-ui text-text-3">还没有登记过预测。</p>)}
        {shown === "new" && <VcrFilePrediction studyId={studyId} designs={designs} onFiled={() => { onFiled(); setView("filed"); }} />}
      </div>
    </Drawer>
  );
}

/** Every forecast, with the time it was frozen at and — once the actual data are in — what was predicted beside what happened. */
function ForecastList({ forecasts }: { forecasts: readonly VcrForecast[] }) {
  return (
    <ul className="flex flex-col gap-5">
      {forecasts.map((forecast) => {
        const compared = forecast.lines.some((line) => line.actual != null);
        return (
          <li key={forecast.id} data-vcr-forecast={forecast.id}>
            <p className="text-ui font-medium text-text">{forecast.label}</p>
            {(forecast.frozenAt || forecast.comparedAt) && (
              <p className="mt-0.5 text-caption text-text-3">
                {[forecast.frozenAt ? `冻结于 ${forecast.frozenAt}` : null, forecast.comparedAt ? `与实际对照于 ${forecast.comparedAt}` : null]
                  .filter(Boolean).join(" · ")}
              </p>
            )}
            <table className="mt-2 w-full border-collapse text-caption">
              <caption className="sr-only">{forecast.label}</caption>
              {compared && (
                <thead>
                  <tr className="border-b border-border text-text-3">
                    <th scope="col" className="py-1 pr-2 text-left font-normal"><span className="sr-only">指标</span></th>
                    <th scope="col" className="px-2 py-1 text-right font-normal">预测</th>
                    <th scope="col" className="py-1 pl-2 text-right font-normal">实际</th>
                  </tr>
                </thead>
              )}
              <tbody>
                {forecast.lines.map((line) => (
                  <tr key={line.key} data-vcr-forecast-line={line.key} className="border-b border-faint">
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text-2">{line.label}</th>
                    <td className="px-2 py-1.5 text-right tabular-nums text-text">{line.predicted}</td>
                    {compared && <td className="py-1.5 pl-2 text-right tabular-nums text-text">{line.actual ?? "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        );
      })}
    </ul>
  );
}
