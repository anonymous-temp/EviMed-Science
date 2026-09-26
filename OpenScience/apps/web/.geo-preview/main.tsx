import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import "@/index.css";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { diagnosisFilled, monitoringFilled } from "@/components/geo/__fixtures__/geoTabs";
import { OverviewTab } from "@/components/geo/tabs/OverviewTab";
import { AccuracyTab } from "@/components/geo/tabs/AccuracyTab";
import { VisibilityTab } from "@/components/geo/tabs/VisibilityTab";
import { PageShell } from "@/components/layout/PageShell";
import { ProgressRail } from "@/components/ui/ProgressRail";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { Button } from "@/components/ui/Button";
import { railSteps } from "@/components/geo/geoOverviewModel";
import { GEO_TABS } from "@/components/geo/geoTabs";

const diagnosis = {
  ...diagnosisFilled,
  errors: [
    { ...diagnosisFilled.errors[0], id: "e1", severity: "S3", errorType: "label_conflict", status: "open",
      statement: "甲状腺结节患者禁用信尔美", evidenceQuote: "有甲状腺髓样癌个人或家族史、2 型多发性内分泌腺瘤病者禁用" },
    { ...diagnosisFilled.errors[0], id: "e2", engine: "kimi", severity: "S3", errorType: "unfounded", status: "open",
      statement: "青少年肥胖也可以用信尔美减重", evidenceQuote: "适用于成人" },
    { ...diagnosisFilled.errors[0], id: "e3", engine: "qianwen", severity: "S2", status: "acting" },
    { ...diagnosisFilled.errors[0], id: "e4", engine: "kimi", severity: "S1", status: "closed" },
  ],
  more: [
    { metricId: "M-04", name: "品牌声量份额", cell: { value: 19, numerator: 59, denominator: 310, ciLow: null, ciHigh: null, status: "ok", dataType: "measured" } },
    { metricId: "M-15", name: "风险问句被推荐率", cell: { value: 3, numerator: 9, denominator: 310, ciLow: null, ciHigh: null, status: "ok", dataType: "measured" } },
    { metricId: "M-11", name: "就医红旗覆盖率", cell: { value: 82, numerator: 254, denominator: 310, ciLow: null, ciHigh: null, status: "ok", dataType: "measured" } },
  ],
  byPool: [
    { pool: "P1", mention: diagnosisFilled.byPool[0].mention, topCompetitor: "诺和盈 31%", mainIssue: "两家把用法说成每天一次" },
    { pool: "P2", mention: diagnosisFilled.byPool[1].mention, topCompetitor: "穆峰达 18%", mainIssue: "多数回答只列司美格鲁肽" },
  ],
};

const routes: Record<string, unknown> = {
  "/api/geo/projects/geo_masi/diagnosis": diagnosis,
  "/api/geo/projects/geo_masi/monitoring": monitoringFilled,
};
const original = window.fetch;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.split("?")[0];
  const body = routes[path];
  if (body !== undefined) return new Response(JSON.stringify({ data: body }), { status: 200, headers: { "content-type": "application/json" } });
  return original(input as RequestInfo, init);
}) as typeof window.fetch;

const project = GEO_PROJECT;
const view = (new URLSearchParams(location.search).get("tab") ?? "overview") as "overview" | "visibility" | "accuracy";
const Body = view === "accuracy" ? AccuracyTab : view === "visibility" ? VisibilityTab : OverviewTab;

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/app/geo/geo_masi"]}>
    <PageShell
      title={project.name}
      width="wide"
      meta={<Tag>第 4 周</Tag>}
      actions={<><Button variant="secondary">周报</Button><Button variant="secondary">对话</Button></>}
    >
      <ProgressRail label="进度" steps={railSteps({ ...project, budget: null }, () => "#")} className="mb-6" />
      <Tabs label="项目视图" items={GEO_TABS.map((t) => ({ value: t.key, label: t.label }))} value={view} onChange={() => {}} />
      <div className="pt-6"><Body geoId="geo_masi" project={project} /></div>
    </PageShell>
  </MemoryRouter>,
);
