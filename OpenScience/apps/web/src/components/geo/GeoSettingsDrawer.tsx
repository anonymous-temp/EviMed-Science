import { useState, type ReactNode } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { patchGeoProject, type GeoEngine, type GeoProject } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChip } from "@/components/ui/FilterChips";
import type { GeoPanel } from "./geoFrame";
import { coverageText, engineName, GEO_COVERAGE_DAYS, GEO_DEFAULT_ENGINES, GEO_OPTIONAL_ENGINES } from "./geoText";
import { marketConnected } from "./geoOverviewModel";
import { yuan } from "./tabs/geoTabText";

/**
 * 项目设置 — how this project is measured and who speaks for it, in the header's 「⋯」 (R19 audit C §2.3). They are settings and not
 * a block of the plan: a page that opens on 「按什么口径算的」 had them as its first block, above what the programme is aiming at.
 *
 * Five rows, each with the one edit it has: the engines and the coverage window are written here (`PATCH …`, which the route has always
 * accepted and the page never offered); the budget, the producer and the members are dialogs the layout owns, opened from here.
 * Reading is for everyone in the project; a row's edit is offered only to who may make it, and the server judges all the same.
 */
export function GeoSettingsDrawer({
  geoId,
  project,
  onClose,
  onOpen,
  onChanged,
}: {
  geoId: string;
  project: GeoProject;
  onClose: () => void;
  onOpen: (panel: GeoPanel) => void;
  /** The project changed: read it again. */
  onChanged: () => void;
}) {
  const abilities = project.access?.abilities;
  const can = (ability: string) => !abilities || abilities.includes(ability);
  const offered: GeoEngine[] = [
    ...GEO_DEFAULT_ENGINES,
    ...GEO_OPTIONAL_ENGINES.filter((engine) => project.engines.includes(engine) || project.availableEngines?.includes(engine)),
  ];
  const [engines, setEngines] = useState<GeoEngine[]>(project.engines);
  const [days, setDays] = useState<number>(project.coverageDays);
  const [busy, setBusy] = useState<"engines" | "days" | null>(null);
  const enginesChanged = engines.length !== project.engines.length || engines.some((engine) => !project.engines.includes(engine));
  const toggle = (engine: GeoEngine) => setEngines((now) => (now.includes(engine) ? now.filter((entry) => entry !== engine) : offered.filter((entry) => entry === engine || now.includes(entry))));

  const save = (key: "engines" | "days") => {
    setBusy(key);
    void patchGeoProject(geoId, key === "engines" ? { engines } : { coverageDays: days })
      .then(() => {
        toast.success(key === "engines" ? "测量的 AI 引擎已改，下一轮测量按新的引擎问。" : "覆盖周期已改。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "设置暂时无法保存，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  const budget = project.budget && project.budget.totalCny > 0
    ? `${yuan(project.budget.totalCny)} · 每天最多 ${yuan(project.budget.dailyCny)}`
    : marketConnected(project) ? "还没有设" : "等媒介集市接通";
  const producer = project.producer?.name || (project.producer ? (project.producer.kind === "doctor" ? "医生" : "企业") : "还没有说明");
  // A dialog opens over the page, not over a drawer: this one closes first.
  const open = (panel: GeoPanel) => () => { onClose(); onOpen(panel); };

  return (
    <Drawer title="项目设置" onClose={onClose}>
      <div data-geo-settings="" className="flex flex-col divide-y divide-faint">
        <Row label="测量的 AI 引擎">
          <div role="group" aria-label="测量的 AI 引擎" className="flex flex-wrap items-center gap-1 -ml-3">
            {offered.map((engine) => (
              <FilterChip
                key={engine}
                pressed={engines.includes(engine)}
                disabled={!can("edit") || busy !== null}
                onClick={() => toggle(engine)}
              >
                {engineName(engine)}
              </FilterChip>
            ))}
          </div>
          {can("edit") && enginesChanged && (
            <div className="mt-2">
              <Button size="sm" loading={busy === "engines"} disabled={engines.length === 0} onClick={() => save("engines")}>保存</Button>
            </div>
          )}
        </Row>
        <Row label="覆盖周期">
          <p className="text-ui text-text">{coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)}</p>
          {can("edit") && (
            <div role="group" aria-label="覆盖周期" className="mt-2 flex flex-wrap items-center gap-1 -ml-3">
              {GEO_COVERAGE_DAYS.map((option) => (
                <FilterChip key={option} pressed={days === option} disabled={busy !== null} onClick={() => setDays(option)}>{`${option} 天`}</FilterChip>
              ))}
            </div>
          )}
          {can("edit") && days !== project.coverageDays && (
            <div className="mt-2"><Button size="sm" loading={busy === "days"} onClick={() => save("days")}>保存</Button></div>
          )}
        </Row>
        <Row label="投放预算" action={can("manage_money") && marketConnected(project) ? <Button variant="text" size="sm" onClick={open("budget")}>{project.budget && project.budget.totalCny > 0 ? "修改" : "设置"}</Button> : undefined}>
          <p className="text-ui text-text">{budget}</p>
        </Row>
        <Row label="出品方" action={can("edit") ? <Button variant="text" size="sm" onClick={open("producer")}>修改</Button> : undefined}>
          <p className="text-ui text-text">{producer}</p>
        </Row>
        <Row label="成员" action={<Button variant="text" size="sm" onClick={open("members")}>{can("manage_members") ? "管理" : "查看"}</Button>}>
          <p className="text-ui text-text-2">{can("manage_members") ? "负责人、协作者和外部机构，按角色" : "项目里的人，和各自的角色"}</p>
        </Row>
      </div>
    </Drawer>
  );
}

function Row({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-start gap-3 py-4">
      <h3 className="text-caption font-normal text-text-3">{label}</h3>
      <div className="min-w-0">{children}</div>
      {action ?? <span />}
    </section>
  );
}
