import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { diagnosisFilled, monitoringFilled } from "@/components/geo/__fixtures__/geoTabs";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GeoProjectPage } from "./GeoProjectPage";

const client = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  getGeoProject: vi.fn(),
  getGeoDiagnosis: vi.fn(),
  getGeoMonitoring: vi.fn(),
  runGeoStep: vi.fn(),
  exportGeo: vi.fn(),
  patchGeoProject: vi.fn(),
  deleteGeoProject: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  useGeoFeature: client.useGeoFeature,
  getGeoProject: client.getGeoProject,
  getGeoDiagnosis: client.getGeoDiagnosis,
  getGeoMonitoring: client.getGeoMonitoring,
  runGeoStep: client.runGeoStep,
  exportGeo: client.exportGeo,
  patchGeoProject: client.patchGeoProject,
  deleteGeoProject: client.deleteGeoProject,
}));

vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

// The tabs other than 总览 have their own tests; here each is a marker that
// says the page gave it the project.
const marker = vi.hoisted(() => (name: string) => ({ geoId, project }: { geoId: string; project: { name: string } }) => (
  <div data-testid={`${name}-tab`}>{geoId}:{project.name}</div>
));
vi.mock("@/components/geo/tabs/VisibilityTab", () => ({ VisibilityTab: marker("visibility") }));
vi.mock("@/components/geo/tabs/AccuracyTab", () => ({ AccuracyTab: marker("accuracy") }));
vi.mock("@/components/geo/tabs/QuestionsTab", () => ({ QuestionsTab: marker("questions") }));
vi.mock("@/components/geo/tabs/SourcesTab", () => ({ SourcesTab: marker("sources") }));
vi.mock("@/components/geo/tabs/ActionsTab", () => ({ ActionsTab: marker("actions") }));
vi.mock("@/components/geo/tabs/PlanTab", () => ({ PlanTab: marker("plan") }));

function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{location.pathname}</p>;
}

function renderProject(path = "/app/geo/geo_masi") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/geo/:geoId/:tab?" element={<><GeoProjectPage /><Landed /></>} />
        <Route path="/app/geo" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The measured round, with one statement severe enough to reach a patient. */
const severeDiagnosis = {
  ...diagnosisFilled,
  errors: [
    { ...diagnosisFilled.errors[0], id: "err_s3", severity: "S3" as const, statement: "甲状腺结节患者禁用信尔美", status: "open" as const },
    diagnosisFilled.errors[0],
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  client.useGeoFeature.mockReturnValue("on");
  client.getGeoProject.mockResolvedValue(GEO_PROJECT);
  client.getGeoDiagnosis.mockResolvedValue(severeDiagnosis);
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
  client.open.mockResolvedValue(undefined);
  client.patchGeoProject.mockResolvedValue({});
  client.deleteGeoProject.mockResolvedValue({});
});

describe("a GEO project's page", () => {
  it("is one header line, the eight steps as a rail, and seven tabs by question", async () => {
    renderProject();
    expect(await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "周报" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();

    const tabs = within(screen.getByRole("tablist", { name: "项目视图" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["总览", "可见度", "准确与安全", "问题与回答", "信源", "行动", "方案"]);
    expect(screen.getByRole("tab", { name: "总览" })).toHaveAttribute("aria-selected", "true");

    const rail = screen.getByRole("list", { name: "进度" });
    const states = [...rail.querySelectorAll("[data-rail-step]")].map((step) => [step.getAttribute("data-rail-step"), step.getAttribute("data-rail-state")]);
    expect(states).toEqual([
      ["evidence", "done"], ["journey", "done"], ["questions", "done"], ["diagnosis", "done"], ["sources", "done"],
      ["content", "active"], ["distribution", "active"], ["monitoring", "active"],
    ]);
    expect(rail).toHaveTextContent("14/20");
    // A step opens the tab that now holds its result.
    expect(within(rail).getByRole("link", { name: /诊断/ })).toHaveAttribute("href", "/app/geo/geo_masi/accuracy");
    // The rail is the only progress there is: no second bar underneath it.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("marks the step that is waiting on the reader, and says what it waits for", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, budget: null });
    renderProject();
    const rail = await screen.findByRole("list", { name: "进度" });
    const distribution = rail.querySelector("[data-rail-step='distribution']") as HTMLElement;
    expect(distribution).toHaveAttribute("data-rail-state", "waiting");
    expect(within(distribution).getByText("待你确认预算")).toBeInTheDocument();
  });

  it("opens with one sentence, six numbers with their targets, and the denominator said once", async () => {
    renderProject();
    // One sentence, and the whole of it: the measurement it needs has to have
    // arrived before any of it is asserted.
    expect(await screen.findByText(/综合可见度 38，比上次高 5，目标 55；还有 1 条严重讲错待处理。/)).toBeInTheDocument();

    const gvi = screen.getByRole("region", { name: "综合可见度指数" });
    expect(gvi).toHaveTextContent("38");
    expect(gvi).toHaveTextContent("目标 55");
    const mention = screen.getByRole("region", { name: "品牌提及率" });
    expect(mention).toHaveTextContent("18");
    expect(mention).toHaveTextContent("目标 35%");
    // 24 answers: the rate is withheld and the number never printed.
    const citation = screen.getByRole("region", { name: "引用命中率" });
    expect(citation).toHaveTextContent("样本不足");
    expect(citation).not.toHaveTextContent("6%");
    // The safety cell is the one red number, and it counts S3 and above only.
    expect(screen.getByRole("region", { name: "用药安全" })).toHaveTextContent("1");

    // The denominator is declared once for the band, not in每 cell.
    const band = screen.getByRole("region", { name: "本轮指标" });
    expect(within(band).getByText(/按 3 个引擎、310 次有效回答计算/)).toBeInTheDocument();
    expect(within(band).getAllByText(/次有效回答计算/)).toHaveLength(1);
  });

  it("has one AI entry, in the header — not one beside every number", async () => {
    renderProject();
    await screen.findByText(/按 3 个引擎、310 次有效回答计算/);
    expect(screen.queryAllByRole("button", { name: "问 AI" })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "对话" })).toHaveLength(1);
  });

  it("names the engines the round did not cover, and never counts them as zero", async () => {
    renderProject();
    await screen.findByText(/按 3 个引擎、310 次有效回答计算/);
    const missing = document.querySelectorAll("[data-heat-unmeasured]");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]).toHaveTextContent("本轮未测");
    const qianwen = document.querySelector("[data-heat-row='qianwen']") as HTMLElement;
    expect(within(qianwen).queryByText("0")).not.toBeInTheDocument();
  });

  it.each([
    ["/app/geo/geo_masi/diagnosis", "/app/geo/geo_masi/accuracy", "accuracy"],
    ["/app/geo/geo_masi/monitoring", "/app/geo/geo_masi/visibility", "visibility"],
    ["/app/geo/geo_masi/content", "/app/geo/geo_masi/actions", "actions"],
    ["/app/geo/geo_masi/distribution", "/app/geo/geo_masi/actions", "actions"],
    ["/app/geo/geo_masi/evidence", "/app/geo/geo_masi/plan", "plan"],
    ["/app/geo/geo_masi/journey", "/app/geo/geo_masi/plan", "plan"],
    ["/app/geo/geo_masi/questions", "/app/geo/geo_masi/questions", "questions"],
    ["/app/geo/geo_masi/sources", "/app/geo/geo_masi/sources", "sources"],
  ])("an old address (%s) still lands: %s", async (from, to, testid) => {
    renderProject(from);
    expect(await screen.findByTestId(`${testid}-tab`)).toHaveTextContent("geo_masi:玛仕度肽注射液");
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(to));
  });

  it("switches tabs by address", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("tab", { name: "准确与安全" }));
    expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/accuracy");
    expect(await screen.findByTestId("accuracy-tab")).toHaveTextContent("geo_masi:玛仕度肽注射液");
    await userEvent.click(screen.getByRole("tab", { name: "总览" }));
    expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi$/);
  });

  it("「对话」 opens the project's latest conversation, 「周报」 exports it", async () => {
    client.exportGeo.mockResolvedValue({ sessionId: "ses_export", runId: "run_1" });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "对话" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-masi", sessionId: "ses_geo_masi" }));

    await userEvent.click(screen.getByRole("button", { name: "周报" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "weekly"));
  });

  it("「⋯」 exports the pack, pauses and deletes — deleting only after a confirmation", async () => {
    client.exportGeo.mockResolvedValue({ sessionId: "ses_export", runId: "run_1" });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["导出提案资料包", "暂停", "删除"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "导出提案资料包" }));
    await waitFor(() => expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "proposal"));

    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "暂停" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_masi", { status: "paused" }));

    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(client.deleteGeoProject).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(client.deleteGeoProject).toHaveBeenCalledWith("geo_masi"));
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo$/));
  });

  it("reads as a new project before anything was measured: 「—」 and a sentence, never a zero", async () => {
    client.getGeoProject.mockResolvedValue({
      ...GEO_PROJECT, name: "新 GEO 项目", steps: {}, budget: null, sessionId: "ses_new",
      overview: { metrics: [], week: [], steps: {} },
    });
    client.getGeoDiagnosis.mockResolvedValue({ round: null, rounds: [], byEngine: [], byPool: [], failureModes: {}, errors: [], noise: null, more: [] });
    client.getGeoMonitoring.mockResolvedValue({ series: [], arms: { pilot: [], control: [], netEffect: {} }, byEngine: [], cited: [], newErrors: [], next: null });
    renderProject();
    const rail = await screen.findByRole("list", { name: "进度" });
    expect([...rail.querySelectorAll("[data-rail-state]")].map((step) => step.getAttribute("data-rail-state"))).toEqual(Array(8).fill("todo"));
    expect(await screen.findByText(/还没有测过各家 AI 怎么回答这个产品/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "品牌提及率" })).toHaveTextContent("—");
    expect(screen.queryByRole("button", { name: "问 AI" })).not.toBeInTheDocument();
  });

  it("says a project that is gone is gone", async () => {
    client.getGeoProject.mockRejectedValue(new WebApiError("missing", { status: 404, code: "not_found" }));
    renderProject("/app/geo/geo_gone");
    expect(await screen.findByText("这个项目不存在或已删除。")).toBeInTheDocument();
  });

  it("is the off page where the module is off", async () => {
    client.useGeoFeature.mockReturnValue("off");
    renderProject();
    expect(screen.getByText(GEO_OFF_SENTENCE)).toBeInTheDocument();
    expect(client.getGeoProject).not.toHaveBeenCalled();
  });
});
