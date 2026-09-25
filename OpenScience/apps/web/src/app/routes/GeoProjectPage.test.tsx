import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { GeoProject } from "@/lib/geoClient";
import { GEO_PROJECT } from "@/components/geo/__fixtures__/geoProjects";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GeoProjectPage } from "./GeoProjectPage";

const client = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  getGeoProject: vi.fn(),
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
  runGeoStep: client.runGeoStep,
  exportGeo: client.exportGeo,
  patchGeoProject: client.patchGeoProject,
  deleteGeoProject: client.deleteGeoProject,
}));

vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

// The tabs' contents are another package's (D2) and have their own tests;
// here each is a marker that says it was given the project.
vi.mock("@/components/geo/tabs/DiagnosisTab", () => ({
  DiagnosisTab: ({ geoId, project }: { geoId: string; project: GeoProject }) => <div data-testid="diagnosis-tab">{geoId}:{project.name}</div>,
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  client.useGeoFeature.mockReturnValue("on");
  client.getGeoProject.mockResolvedValue(GEO_PROJECT);
  client.open.mockResolvedValue(undefined);
  client.patchGeoProject.mockResolvedValue({});
  client.deleteGeoProject.mockResolvedValue({});
});

describe("a GEO project's page", () => {
  it("is one header line and nine underlined tabs, 概览 first", async () => {
    renderProject();
    expect(await screen.findByRole("heading", { level: 1, name: "玛仕度肽注射液" })).toBeInTheDocument();
    expect(screen.getByText("10月1日 – 12月31日")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeInTheDocument();
    const tabs = within(screen.getByRole("tablist", { name: "项目视图" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["概览", "证据", "旅程", "问题", "诊断", "信源", "内容", "投放", "监测"]);
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the eight steps, the four numbers with their samples and targets, and 本周 with jumps", async () => {
    renderProject();
    const steps = await screen.findByRole("list", { name: "进度" });
    const marks = [...steps.querySelectorAll("[data-geo-step]")].map((step) => [step.getAttribute("data-geo-step"), step.getAttribute("data-mark")]);
    expect(marks).toEqual([
      ["evidence", "done"], ["journey", "done"], ["questions", "done"], ["diagnosis", "done"], ["sources", "done"],
      ["content", "current"], ["distribution", "none"], ["monitoring", "none"],
    ]);
    expect(within(steps).getByRole("link", { name: /内容\s*，进行中/ })).toHaveAttribute("href", "/app/geo/geo_masi/content");
    expect(steps).toHaveTextContent("14/20");

    const gvi = screen.getByRole("region", { name: "综合可见度指数" });
    expect(gvi).toHaveTextContent("38");
    expect(gvi).toHaveTextContent("目标 55");
    expect(gvi).toHaveTextContent("1,240 次回答");
    expect(gvi).toHaveTextContent("比上周 +5");
    const mention = screen.getByRole("region", { name: "品牌提及率" });
    expect(mention).toHaveTextContent("18%");
    expect(mention).toHaveTextContent("目标 35%");
    expect(mention).toHaveTextContent("310 次里 56 次");
    // 24 answers: the rate is withheld, and the sample said.
    const citation = screen.getByRole("region", { name: "引用命中率" });
    expect(citation).toHaveTextContent("样本不足");
    expect(citation).toHaveTextContent("24 次回答");
    expect(citation).not.toHaveTextContent("6%");
    // 「问 AI」 beside every number.
    expect(screen.getAllByRole("button", { name: "问 AI" })).toHaveLength(4);

    const week = screen.getByRole("list", { name: "本周" });
    const rows = within(week).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByRole("link")).toHaveAttribute("href", "/app/geo/geo_masi/answers/snap_1");
    expect(rows[0]).toHaveTextContent("看回答");
    // 讲错我方 is the one red line.
    expect(within(rows[1]).getByText(/DeepSeek 仍把用法说成/)).toHaveClass("text-danger");
    expect(within(rows[0]).getByText(/豆包在/)).not.toHaveClass("text-danger");
    expect(within(rows[2]).getByRole("link")).toHaveAttribute("href", "/app/geo/geo_masi/sources");
    expect(rows[3]).toHaveTextContent("看投放");
  });

  it("「问 AI」 opens the project's conversation with the number, its name, date and sample as a draft", async () => {
    renderProject();
    const mention = await screen.findByRole("region", { name: "品牌提及率" });
    await userEvent.click(within(mention).getByRole("button", { name: "问 AI" }));
    expect(client.open).toHaveBeenCalledWith(
      { projectId: "p-masi", sessionId: "ses_geo_masi" },
      "玛仕度肽注射液 · 品牌提及率：18%，310 次里 56 次（10月20日测量）。这个数说明了什么，接下来该做什么？",
    );
  });

  it("gives an untouched step one sentence and 「让 AI 做」, which starts it in the conversation", async () => {
    client.getGeoProject.mockResolvedValue({ ...GEO_PROJECT, steps: { ...GEO_PROJECT.steps, journey: { status: "none", requested: false } } });
    client.runGeoStep.mockResolvedValue({ sessionId: "ses_run" });
    renderProject("/app/geo/geo_masi/journey");
    expect(await screen.findByText("还没有画出患者和医生从起疑到用药的旅程。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-masi", sessionId: "ses_run" }));
    expect(client.runGeoStep).toHaveBeenCalledWith("geo_masi", "journey");
  });

  it("renders a worked step's tab with the project, and switches tabs by address", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("tab", { name: "诊断" }));
    expect(screen.getByTestId("landed")).toHaveTextContent("/app/geo/geo_masi/diagnosis");
    expect(await screen.findByTestId("diagnosis-tab")).toHaveTextContent("geo_masi:玛仕度肽注射液");
    await userEvent.click(screen.getByRole("tab", { name: "概览" }));
    expect(screen.getByTestId("landed")).toHaveTextContent(/^\/app\/geo\/geo_masi$/);
  });

  it("「对话」 opens the project's latest conversation", async () => {
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "对话" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-masi", sessionId: "ses_geo_masi" }));
  });

  it("「⋯」 exports, pauses and deletes — deleting only after a confirmation", async () => {
    client.exportGeo.mockResolvedValue({ sessionId: "ses_export", runId: "run_1" });
    renderProject();
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["导出提案资料包", "导出周报", "暂停", "删除"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "导出提案资料包" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-masi", sessionId: "ses_export" }));
    expect(client.exportGeo).toHaveBeenCalledWith("geo_masi", "proposal");

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
