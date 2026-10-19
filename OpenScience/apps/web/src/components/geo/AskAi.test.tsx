import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { AskAi } from "./AskAi";

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
  subscribe: vi.fn(() => () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ currentId: "prj_geo_1", switching: null, projects: [{ id: "prj_geo_1" }], select: store.select, load: store.load }), subscribe: store.subscribe },
}));

const client = vi.hoisted(() => ({ list: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  listGeoProjects: client.list, getGeoProject: client.project,
}));
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
    expect(state?.runtimeUiIntent).toMatchObject({ kind: "create", projectId: "prj_geo_1", draft: "请开始药品价值分析。", sessionId: "ses_geo_1" });
    expect(state?.runtimeUiIntent).not.toHaveProperty("send");
    expect(client.project).toHaveBeenCalledWith("geo_1");
    expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function));
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("says in a toast when the conversation cannot be opened, and gives the button back", async () => {
    store.select.mockRejectedValueOnce(new Error("project is gone"));
    renderAsk();
    const button = screen.getByRole("button", { name: "开始药品价值分析" });
    await userEvent.click(button);
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(["对话暂时无法打开，请稍后重试。"]));
    expect(client.project).toHaveBeenCalledWith("geo_1");
    expect(store.select).toHaveBeenCalledWith("prj_geo_1", expect.any(Function));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/plan");
  });
});
