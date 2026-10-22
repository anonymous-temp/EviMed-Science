import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { getWebProjectId, setWebProjectId } from "@/lib/apiClient";
import { GlobalHomeRoute, SessionRoute } from "./SessionRoute";

const mocks = vi.hoisted(() => ({ me: vi.fn() }));
vi.mock("@/lib/apiClient", async (original) => ({
  ...await original<typeof import("@/lib/apiClient")>(), fetchWebMe: mocks.me, warmWebRuntime: vi.fn(),
}));
vi.mock("@/components/geo/useGeoProjectIds", () => ({ useGeoAssociation: () => null }));
vi.mock("./RuntimeUiFrame", () => ({ FrameSkeleton: () => <p>Opening conversation</p> }));
function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><pre data-testid="where">{JSON.stringify({ path: location.pathname, project: useProjectStore(state => state.currentId), state: location.state })}</pre>
    <button onClick={() => navigate("/app/knowledge")}>Leave</button>
    <button onClick={() => { setWebProjectId("geo_project"); useProjectStore.setState({ currentId: "geo_project" }); navigate("/app/knowledge"); }}>Project</button>
    <button onClick={() => navigate(-1)}>Back</button>
    <button onClick={() => navigate(1)}>Forward</button></>;
}
function draw(path = "/app/home", state: unknown = null) {
  const [pathname, search] = path.split("?");
  return render(<MemoryRouter initialEntries={[{ pathname, search: search ? `?${search}` : "", state }]}><Probe /><Routes>
    <Route path="/app/home" element={<GlobalHomeRoute />} />
    <Route path="/app/chat/:sessionId?" element={<SessionRoute />} />
    <Route path="*" element={null} />
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clear();
  mocks.me.mockResolvedValue({ project: { id: "default" } });
});
describe("global assistant entry", () => {
  it.each(["geo_project", "vcr_project", "ordinary_project"])("proves default before creating a conversation after %s", async (project) => {
    setWebProjectId(project);
    useProjectStore.setState({ currentId: project });
    let answer!: (value: object) => void;
    mocks.me.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    draw();
    await waitFor(() => expect(mocks.me).toHaveBeenCalledWith({ projectId: "default" }));
    expect(screen.getByTestId("where")).toHaveTextContent('"path":"/app/home"');
    expect(screen.getByTestId("where")).not.toHaveTextContent("runtimeUiIntent");
    await act(async () => { answer({ project: { id: "default" } }); });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent('"path":"/app/chat"'));
    const landed = JSON.parse(screen.getByTestId("where").textContent!);
    expect(landed.project).toBe("default");
    expect(landed.state).toMatchObject({ globalAssistant: true, runtimeUiIntent: { kind: "create", projectId: "default" } });
    expect(getWebProjectId()).toBe("default");
  });
  it("restores the global project on Back without replacing its native intent, and keeps Forward", async () => {
    setWebProjectId("default");
    useProjectStore.setState({ currentId: "default" });
    draw();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("runtimeUiIntent"));
    const original = JSON.parse(screen.getByTestId("where").textContent!).state.runtimeUiIntent;
    await userEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(useProjectStore.getState().currentId).toBe("geo_project");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(useProjectStore.getState().currentId).toBe("default"));
    expect(JSON.parse(screen.getByTestId("where").textContent!).state.runtimeUiIntent).toEqual(original);
    await userEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/knowledge");
  });
  it.each(["foreign-project", "deleted-project"])("refuses %s in a copied URL even when history claims a different project", async (project) => {
    setWebProjectId("default"); useProjectStore.setState({ currentId: "default" });
    mocks.me.mockResolvedValue({ project: { id: "default" } });
    draw(`/app/chat/session-other?project=${project}`, { conversationProjectId: "default" });
    expect(await screen.findByRole("alert")).toHaveTextContent("对话暂时无法打开");
    expect(mocks.me).toHaveBeenCalledWith({ projectId: project });
    expect(useProjectStore.getState().currentId).toBe("default");
  });
  it("recovers a copied ordinary project URL after refresh using ownership proof", async () => {
    setWebProjectId("default"); useProjectStore.setState({ currentId: "default" });
    mocks.me.mockResolvedValue({ project: { id: "project-p" } });
    draw("/app/chat/session-p?project=project-p");
    await waitFor(() => expect(useProjectStore.getState().currentId).toBe("project-p"));
    expect(mocks.me).toHaveBeenCalledWith({ projectId: "project-p" });
    expect(screen.getByTestId("where")).toHaveTextContent("/app/chat/session-p");
  });
  it("does not switch or redirect if the reader leaves while ownership is being checked", async () => {
    setWebProjectId("geo_project");
    useProjectStore.setState({ currentId: "geo_project" });
    let answer!: (value: object) => void;
    mocks.me.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    draw();
    await waitFor(() => expect(mocks.me).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    await act(async () => { answer({ project: { id: "default" } }); });
    expect(screen.getByTestId("where")).toHaveTextContent("/app/knowledge");
    expect(useProjectStore.getState().currentId).toBe("geo_project");
  });
  it("keeps the current project and offers retry on a refused default project", async () => {
    setWebProjectId("vcr_project");
    useProjectStore.setState({ currentId: "vcr_project" });
    mocks.me.mockResolvedValue({ project: { id: "different" } });
    draw();
    expect(await screen.findByRole("alert")).toHaveTextContent("对话暂时无法打开");
    expect(useProjectStore.getState().currentId).toBe("vcr_project");
    mocks.me.mockResolvedValue({ project: { id: "default" } });
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(useProjectStore.getState().currentId).toBe("default"));
  });
});
