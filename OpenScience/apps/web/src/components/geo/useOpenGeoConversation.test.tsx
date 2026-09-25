import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { useOpenGeoConversation } from "./useOpenGeoConversation";

const mocks = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string }>,
  listWebProjects: vi.fn(),
  fetchWebMe: vi.fn(),
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebProjects: mocks.listWebProjects,
  fetchWebMe: mocks.fetchWebMe,
}));

vi.mock("@/lib/runtimeWarm", () => ({ warmWebRuntime: vi.fn() }));

function Opener({ sessionId, draft }: { sessionId: string | null; draft?: string }) {
  const open = useOpenGeoConversation();
  return <button type="button" onClick={() => { void open({ projectId: "p-new", sessionId }, draft); }}>open</button>;
}

function Probe() {
  const location = useLocation();
  return <pre data-testid="probe">{JSON.stringify({ path: location.pathname, intent: location.state?.runtimeUiIntent ?? null })}</pre>;
}

function renderOpener(props: { sessionId: string | null; draft?: string }) {
  render(
    <MemoryRouter initialEntries={["/app/geo"]}>
      <Routes><Route path="*" element={<><Opener {...props} /><Probe /></>} /></Routes>
    </MemoryRouter>,
  );
}

const probe = () => JSON.parse(screen.getByTestId("probe").textContent!) as { path: string; intent: Record<string, unknown> | null };

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  useProjectStore.getState().clear();
  mocks.projects = [{ id: "default", name: "我的研究" }];
  mocks.listWebProjects.mockImplementation(async () => mocks.projects);
  mocks.fetchWebMe.mockImplementation(async ({ projectId }: { projectId?: string } = {}) => ({
    user: { id: "u", name: "u" }, project: { id: projectId ?? getWebProjectId(), name: "x" }, projects: mocks.projects,
  }));
});

afterEach(() => useProjectStore.getState().clear());

describe("opening a GEO project's conversation", () => {
  it("switches the shell to the GEO project first, then opens the conversation with the draft unsent", async () => {
    // Created a moment ago: not in the list the shell read at start.
    mocks.projects = [...mocks.projects, { id: "p-new", name: "玛仕度肽注射液" }];
    renderOpener({ sessionId: "ses_new", draft: "品牌提及率：18%" });
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(probe().path).toBe("/app/chat"));
    expect(probe().intent).toMatchObject({ kind: "create", projectId: "p-new", sessionId: "ses_new", draft: "品牌提及率：18%" });
    expect(useProjectStore.getState().currentId).toBe("p-new");
    expect(getWebProjectId()).toBe("p-new");
    expect(mocks.listWebProjects).toHaveBeenCalled();
    expect(mocks.fetchWebMe).toHaveBeenCalledWith({ projectId: "p-new" });
  });

  it("opens a new conversation in the project when it has none yet", async () => {
    mocks.projects = [...mocks.projects, { id: "p-new", name: "玛仕度肽注射液" }];
    renderOpener({ sessionId: null });
    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() => expect(probe().path).toBe("/app/chat"));
    const intent = probe().intent!;
    expect(intent).toMatchObject({ kind: "create", projectId: "p-new" });
    expect(intent.draft).toBeUndefined();
    expect(typeof intent.sessionId).toBe("string");
  });
});
