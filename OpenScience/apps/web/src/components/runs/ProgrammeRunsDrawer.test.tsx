import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { ProgrammeRun } from "@/lib/programmeRuns";
import { ProgrammeRunsDrawer } from "./ProgrammeRunsDrawer";

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebConversationHistory: api.history,
}));

const RUNS: ProgrammeRun[] = [
  { sessionId: "ses_content", label: "写第 2 批稿件", state: "running", at: "3 分钟前" },
  { sessionId: "ses_weekly", label: "生成周报", state: "finished", at: "昨天 08:12" },
  { sessionId: "ses_stopped", label: "整理产品证据", state: "stopped", at: null },
];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function draw(props: Partial<React.ComponentProps<typeof ProgrammeRunsDrawer>> = {}) {
  const load = props.load ?? vi.fn().mockResolvedValue(RUNS);
  const onClose = props.onClose ?? vi.fn();
  const view = render(
    <MemoryRouter initialEntries={["/app/geo/geo_masi"]}>
      <Where />
      <ProgrammeRunsDrawer projectId="p-masi" load={load} onClose={onClose} {...props} />
    </MemoryRouter>,
  );
  return { ...view, load, onClose };
}

beforeEach(() => {
  api.history.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AI 运行 — the record of what a module's programme did in the background", () => {
  it("lists the runs by what they were, with a state word and a time, and never an id", async () => {
    draw();
    const drawer = await screen.findByRole("dialog", { name: "AI 运行" });
    const rows = await within(drawer).findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["写第 2 批稿件进行中 · 3 分钟前", "生成周报已完成 · 昨天 08:12", "整理产品证据未完成"]);
    expect(drawer.textContent).not.toMatch(/run_|ses_|geo:|vcr:/);
  });

  it("opens the pressed row as a record read where the reader is — no composer, no conversation, the page stays", async () => {
    api.history.mockResolvedValue({
      sessionId: "ses_weekly", capturedAt: null, partial: false,
      messages: [
        { seq: 1, role: "user", text: "生成周报\n\n<evimed-geo-run>geo-export-weekly-2026-10-12-a1</evimed-geo-run>" },
        { seq: 2, role: "assistant", text: "<evimed-geo-brief>先读 geo_read value</evimed-geo-brief>周报已写好：本周被引用 3 篇。" },
      ],
    });
    draw();
    await userEvent.click(await screen.findByRole("button", { name: "生成周报" }));
    const record = await screen.findByRole("dialog", { name: "生成周报" });
    expect(await within(record).findByText("周报已写好：本周被引用 3 篇。")).toBeInTheDocument();
    // What the platform wrote into the messages for the model is not the reader's.
    expect(record.textContent).not.toMatch(/evimed-|geo_read|geo-export/);
    expect(within(record).getByText("生成周报", { selector: "p" })).toBeInTheDocument();
    expect(api.history).toHaveBeenCalledWith("ses_weekly", "p-masi");
    expect(within(record).queryByRole("textbox")).toBeNull();
    expect(within(record).queryByRole("link")).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/geo/geo_masi");
    // And back to the list.
    await userEvent.click(within(record).getByRole("button", { name: /全部运行/ }));
    expect(await screen.findByRole("dialog", { name: "AI 运行" })).toBeInTheDocument();
  });

  it("says plainly when a record cannot be read or has no words, and when the AI has done nothing", async () => {
    api.history.mockRejectedValueOnce(new Error("down"));
    const first = draw();
    await userEvent.click(await screen.findByRole("button", { name: "整理产品证据" }));
    expect(await screen.findByText("这次运行的记录暂时读不到。")).toBeInTheDocument();
    first.unmount();

    api.history.mockResolvedValueOnce({ sessionId: "ses_stopped", capturedAt: null, partial: false, messages: [] });
    const second = draw();
    await userEvent.click(await screen.findByRole("button", { name: "整理产品证据" }));
    expect(await screen.findByText("这次运行还没有留下文字记录。")).toBeInTheDocument();
    second.unmount();

    draw({ load: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText("AI 还没有在后台做过什么。")).toBeInTheDocument();
  });

  it("says a list that cannot be read, with the way to read it again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new WebApiError("no", { status: 503, code: "geo_unavailable" })).mockResolvedValue(RUNS);
    draw({ load });
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("button", { name: "生成周报" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reads the list again, in place, when the module's page has read something new — and keeps what it had if that read fails", async () => {
    const load = vi.fn().mockResolvedValueOnce([RUNS[0]]).mockResolvedValueOnce([{ ...RUNS[0], state: "finished" }, RUNS[1]]).mockRejectedValueOnce(new Error("blip"));
    const { rerender } = render(
      <MemoryRouter><ProgrammeRunsDrawer projectId="p-masi" load={load} version="a" onClose={() => undefined} /></MemoryRouter>,
    );
    expect(await screen.findAllByRole("listitem")).toHaveLength(1);
    rerender(<MemoryRouter><ProgrammeRunsDrawer projectId="p-masi" load={load} version="b" onClose={() => undefined} /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("写第 2 批稿件已完成");
    rerender(<MemoryRouter><ProgrammeRunsDrawer projectId="p-masi" load={load} version="c" onClose={() => undefined} /></MemoryRouter>);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads itself while a step is going on, and stops when nothing is", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const load = vi.fn().mockResolvedValueOnce([RUNS[0]]).mockResolvedValue([{ ...RUNS[0], state: "finished" }]);
    draw({ load });
    expect(await screen.findByText("写第 2 批稿件")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    await waitFor(() => expect(screen.getByRole("listitem")).toHaveTextContent("已完成"));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(load, "nothing is going on: nothing is read").toHaveBeenCalledTimes(2);
  });
});
