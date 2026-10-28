import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UnsavedRouteGuard } from "@/app/layout/UnsavedRouteGuard";
import { NewTaskPane } from "./NewTaskPane";

const mocks = vi.hoisted(() => ({ createAgenda: vi.fn(), startAgenda: vi.fn(), updateAgenda: vi.fn(), getAgenda: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/sourceList", () => ({ listAllSources: vi.fn() }));
vi.mock("@/lib/evolutionClient", () => ({ useEvolutionAccess: () => ({ enabled: false }), listEvolutionOpportunities: vi.fn(), adoptEvolutionOpportunity: vi.fn() }));

const NativeRequest = globalThis.Request;
beforeAll(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init ? { ...init, signal: undefined } : init); }
  };
});
afterAll(() => { globalThis.Request = NativeRequest; });

const noop = () => {};
/** The page's own wiring in miniature: the form at /new, 取消 going to the list the way `leaveDraft` does, the shell's route guard mounted beside it. */
function Page() {
  const navigate = useNavigate();
  return <><UnsavedRouteGuard /><NewTaskPane projectId="project-one" onChooseExample={noop} onDraftChange={noop} onRecorded={noop} onSaved={noop} onAdopted={noop}
    onCancel={() => void navigate("/list", { replace: true })} /></>;
}
const routed = () => createMemoryRouter([{ path: "/new", element: <Page /> }, { path: "/list", element: <h1>Tasks</h1> }, { path: "/other", element: <h1>Other</h1> }], { initialEntries: ["/new"] });

describe("the new-task pane under the shell's route guard", () => {
  it("leaves the form on 取消 then 放弃修改, with no second question", async () => {
    const router = routed();
    render(<RouterProvider router={router} />);
    await userEvent.type(screen.getByLabelText("任务指令"), "没写完");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" })).getByRole("button", { name: "放弃修改" }));
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/list");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps the edit on 取消 then 返回编辑, and the route guard then asks once for a link away", async () => {
    const router = routed();
    render(<RouterProvider router={router} />);
    await userEvent.type(screen.getByLabelText("任务指令"), "没写完");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" })).getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("任务指令")).toHaveValue("没写完");
    expect(router.state.location.pathname).toBe("/new");
    await act(() => router.navigate("/other"));
    expect(await screen.findAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/other"));
  });
});
