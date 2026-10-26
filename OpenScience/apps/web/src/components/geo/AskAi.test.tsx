import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { AskAi } from "./AskAi";
import { GeoFrameHarness } from "./__fixtures__/geoFrameHarness";
import { geoProject } from "./__fixtures__/geoTabs";

// The person's own project selection is never touched: a GEO conversation opens through the module's descriptor, in place.
const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
  subscribe: vi.fn(() => () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ currentId: "prj_geo_1", switching: null, projects: [{ id: "prj_geo_1" }], select: store.select, load: store.load }), subscribe: store.subscribe },
}));

const client = vi.hoisted(() => ({ list: vi.fn(), project: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  listGeoProjects: client.list, getGeoProject: client.project,
}));
vi.mock("@/lib/geoNativeClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoNativeClient")>()),
  openGeoConversation: client.open,
}));
const descriptor = (sessionId = "ses_geo_1") => ({ projectId: "prj_geo_1", projectName: "GEO", sessionId, scope: { kind: "geo" as const, geoProjectId: "geo_1", sessionId } });
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebProjectId: () => "prj_geo_1",
}));

function Probe() {
  const location = useLocation();
  return <><div data-testid="location">{location.pathname}</div><div data-testid="state">{JSON.stringify(location.state ?? null)}</div></>;
}

function renderAsk() {
  return render(
    <MemoryRouter initialEntries={["/app/geo/geo_1/plan"]}>
      <Routes>
        <Route path="/app/geo/geo_1/plan" element={<><AskAi project={{ projectId: "prj_geo_1", sessionId: "ses_geo_1" }} label="开始药品价值分析" draft="请开始药品价值分析。" /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.list.mockReset();
  client.project.mockReset();
  client.open.mockReset();
  client.open.mockImplementation(async (_geoId: string, target: { sessionId?: string }) => descriptor(target.sessionId));
  client.list.mockResolvedValue([{ id: "geo_1", projectId: "prj_geo_1" }]);
  client.project.mockResolvedValue({ id: "geo_1", projectId: "prj_geo_1", sessionId: "ses_geo_1" });
  store.subscribe.mockClear();
  store.select.mockReset();
  store.select.mockImplementation(async (_projectId: string, land?: () => void) => { land?.(); });
  useToastStore.setState({ toasts: [] });
});

describe("问 AI", () => {
  it("opens the project's conversation with the draft, unsent", async () => {
    renderAsk();
    await userEvent.click(screen.getByRole("button", { name: "开始药品价值分析" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/chat/ses_geo_1"));
    const state = JSON.parse(screen.getByTestId("state").textContent ?? "null") as { runtimeUiIntent?: { draft?: string; sessionId?: string } } | null;
    expect(state?.runtimeUiIntent).toMatchObject({ kind: "open", projectId: "prj_geo_1", draft: "请开始药品价值分析。", sessionId: "ses_geo_1", scope: descriptor().scope });
    expect(state?.runtimeUiIntent).not.toHaveProperty("send");
    expect(client.open).toHaveBeenCalledWith("geo_1", { kind: "primary" });
    expect(store.select).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("says in a toast when the conversation cannot be opened, and gives the button back", async () => {
    client.open.mockRejectedValueOnce(new Error("project is gone"));
    renderAsk();
    const button = screen.getByRole("button", { name: "开始药品价值分析" });
    await userEvent.click(button);
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(["对话暂时无法打开，请稍后重试。"]));
    expect(client.open).toHaveBeenCalledWith("geo_1", { kind: "primary" });
    expect(store.select).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/plan");
  });
});

it("is not offered to a role that may not open the conversation: there is nothing for it to do but be refused", () => {
  for (const roles of [["viewer"], ["medical_reviewer"]]) {
    const project = geoProject({}, { access: { roles, abilities: roles[0] === "viewer" ? ["read"] : ["read", "review"], owner: false } });
    const view = render(<MemoryRouter><GeoFrameHarness project={project}><AskAi project={{ projectId: "prj_geo_1", sessionId: "ses_geo_1" }} draft="这个数说明了什么？" /></GeoFrameHarness></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "问 AI" })).not.toBeInTheDocument();
    view.unmount();
  }
  render(<MemoryRouter><GeoFrameHarness project={geoProject()}><AskAi project={{ projectId: "prj_geo_1", sessionId: "ses_geo_1" }} draft="这个数说明了什么？" /></GeoFrameHarness></MemoryRouter>);
  expect(screen.getByRole("button", { name: "问 AI" })).toBeInTheDocument();
});
