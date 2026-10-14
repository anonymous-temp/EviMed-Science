import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { StudyPane } from "./StudyPane";
import { fixture } from "./__fixtures__/serverFixtures";

const shell = vi.hoisted(() => ({ currentId: "prj_ev201", requests: [] as Array<{ element: HTMLElement; projectId: string; sessionId: string }>, withdrawn: 0 }));
vi.mock("@/lib/projects", () => ({
  useProjectStore: Object.assign((selector: (state: { currentId: string }) => unknown) => selector({ currentId: shell.currentId }), { getState: () => ({ currentId: shell.currentId }) }),
}));
vi.mock("@/lib/taskPane", () => ({
  registerTaskPane: (request: { element: HTMLElement; projectId: string; sessionId: string }) => {
    shell.requests.push(request);
    return () => { shell.withdrawn += 1; };
  },
}));

const study = (patch: (raw: any) => void = () => undefined): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.activity = null;
  patch(raw);
  return readVcrStudy(raw);
};

function draw(value: VcrStudy, props: { unreachable?: boolean; onRetry?: () => void; onStop?: () => void } = {}) {
  return render(
    <MemoryRouter>
      <StudyPane study={value} unreachable={props.unreachable ?? false} onRetry={props.onRetry ?? (() => undefined)} onStop={props.onStop} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  shell.currentId = "prj_ev201";
  shell.requests.length = 0;
  shell.withdrawn = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe("the study's conversation view", () => {
  it("is an empty pane and a request: the shell's resident frame, for the study's own conversation, in the study's project", () => {
    draw(study((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }));
    const pane = screen.getByRole("region", { name: "研究对话" });
    expect(pane).toHaveAttribute("data-study-pane", "conversation");
    // It holds nothing of the kernel's: the frame is placed over it by the shell, which does not reload it on a tab switch.
    expect(pane.querySelector("iframe")).toBeNull();
    expect(shell.requests).toHaveLength(1);
    expect(shell.requests[0]).toMatchObject({ projectId: "prj_ev201", sessionId: "ses_own" });
    expect(shell.requests[0].element).toBe(pane);
  });

  it("withdraws its request when the reader goes to a tab, so the frame is only hidden and never unmounted", () => {
    const view = draw(study((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }));
    expect(shell.withdrawn).toBe(0);
    view.unmount();
    expect(shell.withdrawn).toBe(1);
  });

  it("says it is opening while the shell is not yet in the study's project, and nothing once it is", () => {
    shell.currentId = "default";
    const first = draw(study((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }));
    expect(screen.getByRole("status")).toHaveTextContent("正在打开对话");
    first.unmount();
    shell.currentId = "prj_ev201";
    draw(study((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the progress of a step that holds the project's runtime, instead of a conversation that would be refused", async () => {
    const onStop = vi.fn();
    draw(study((raw) => {
      raw.conversation = { sessionId: "ses_own", exists: true };
      raw.activity = { run: { id: "run_1", step: "comparator", steps: ["comparator"], label: "设计对照", phase: "search", counts: { search: 4 },
        startedAt: new Date(Date.now() - 90_000).toISOString(), placement: "bounded", locked: true }, queue: [], jobs: [], last: null };
    }), { onStop });
    const pane = screen.getByRole("region", { name: "研究对话" });
    expect(pane).toHaveAttribute("data-study-pane", "progress");
    expect(shell.requests).toHaveLength(0);
    expect(pane).toHaveTextContent("正在设计对照");
    expect(pane).toHaveTextContent("检索 · 检索 4 次");
    expect(pane).toHaveTextContent("结束后可以在这里继续");
    await userEvent.click(within(pane).getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("waits for a conversation the kernel has not made yet, then offers to try again — never an alert, never a made-up id", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    draw(study((raw) => { raw.conversation = { sessionId: null, exists: false }; raw.sessionId = null; }), { onRetry });
    expect(screen.getByRole("region", { name: "研究对话" })).toHaveAttribute("data-study-pane", "preparing");
    expect(screen.getByRole("status")).toHaveTextContent("正在准备对话");
    expect(shell.requests).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
    vi.useRealTimers();
    const retry = await screen.findByRole("button", { name: "重试" });
    await userEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says whose the conversation is for a member of the study whose account the project is not in, and leaves the tabs theirs", () => {
    draw(study((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }), { unreachable: true });
    const pane = screen.getByRole("region", { name: "研究对话" });
    expect(pane).toHaveAttribute("data-study-pane", "unreachable");
    expect(pane).toHaveTextContent("这项研究的对话在负责人的项目里");
    expect(shell.requests).toHaveLength(0);
    expect(within(pane).queryByRole("button")).toBeNull();
  });

  it("fits the height the page has left: the kernel's application needs a box with a height, not a column that grows", async () => {
    draw(study((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }));
    const pane = screen.getByRole("region", { name: "研究对话" });
    await waitFor(() => expect(pane.style.height).toMatch(/^\d+px$/));
    // jsdom has no layout: the floor is what it computes, and it is never below a usable conversation.
    expect(parseInt(pane.style.height, 10)).toBeGreaterThanOrEqual(360);
  });
});
