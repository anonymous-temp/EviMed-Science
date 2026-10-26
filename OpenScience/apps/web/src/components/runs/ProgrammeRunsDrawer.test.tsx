import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { ProgrammeRun } from "@/lib/programmeRuns";
import { ProgrammeRunsDrawer } from "./ProgrammeRunsDrawer";

const api = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebConversationHistory: api.history,
  listWebAgentRuns: api.runs,
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

it("reads a long record a page at a time: the first page, then 显示更多 for the next", async () => {
  const loadMore = vi.fn().mockResolvedValue({ runs: [RUNS[2]], nextCursor: null });
  draw({ load: vi.fn().mockResolvedValue({ runs: RUNS.slice(0, 2), nextCursor: "c_2" }), loadMore });
  const drawer = await screen.findByRole("dialog", { name: "AI 运行" });
  expect(await within(drawer).findAllByRole("listitem")).toHaveLength(2);
  await userEvent.click(within(drawer).getByRole("button", { name: "显示更多" }));
  await waitFor(() => expect(within(drawer).getAllByRole("listitem")).toHaveLength(3));
  expect(loadMore).toHaveBeenCalledWith("c_2");
  expect(within(drawer).queryByRole("button", { name: "显示更多" })).not.toBeInTheDocument();
});

beforeEach(() => {
  api.history.mockReset();
  api.runs.mockReset();
  api.runs.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AI 运行 — the record of what a module's programme did in the background", () => {
  it('uses the supplied exact module reader without reaching owner-only generic history or file APIs', async () => {
    const run = { ...RUNS[0], runId: 'exact' };
    const readRecord = vi.fn().mockResolvedValue({ history: { sessionId: run.sessionId, capturedAt: null, partial: false, messages: [{ seq: 1, role: 'assistant', text: 'Shared run answer' }] },
      files: [{ runId: run.runId, path: 'report.txt', href: '/app/runs/exact/files/report.txt?geoProject=geo&signal=signal&version=version' }] });
    draw({ initialRun: run, readRecord });
    expect(await screen.findByText('Shared run answer')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'report.txt' })).toHaveAttribute('href', '/app/runs/exact/files/report.txt?geoProject=geo&signal=signal&version=version');
    expect(api.runs).not.toHaveBeenCalled(); expect(api.history).not.toHaveBeenCalled();
  });
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

  it("opens real recorded outputs, including partial files, from the exact session and authorized project", async () => {
    api.history.mockResolvedValue({ messages: [] });
    api.runs.mockResolvedValue([
      { id: "run_weekly", sessionId: "ses_weekly", artifacts: ["deliverables/report.md"], unverifiedArtifacts: ["deliverables/partial.docx"], outputFiles: ["deliverables/report.md", "../private.md"] },
      { id: "run_other", sessionId: "ses_other", artifacts: ["deliverables/wrong.md"] },
    ]);
    draw();
    await userEvent.click(await screen.findByRole("button", { name: "生成周报" }));
    expect(await screen.findByRole("link", { name: "report.md" })).toHaveAttribute("href", "/app/runs/run_weekly/files/deliverables/report.md");
    expect(screen.getByRole("link", { name: "partial.docx" })).toHaveAttribute("href", "/app/runs/run_weekly/files/deliverables/partial.docx");
    expect(screen.queryByRole("link", { name: "wrong.md" })).toBeNull();
    expect(screen.queryByRole("link", { name: "private.md" })).toBeNull();
    expect(api.runs).toHaveBeenCalledWith({ projectId: "p-masi" });
  });

  it("draws a path inside the run's workspace as its name, not as a link to a page that does not exist; an address on the web is a link that opens in a tab of its own", async () => {
    api.history.mockResolvedValue({
      sessionId: "ses_weekly", capturedAt: null, partial: false,
      messages: [
        { seq: 1, role: "user", text: "生成周报" },
        { seq: 2, role: "assistant", text: "文件：[claims.json](deliverables/geo-insight/claims.json)，来源：[药监局](https://www.nmpa.gov.cn/x)。" },
      ],
    });
    draw();
    await userEvent.click(await screen.findByRole("button", { name: "生成周报" }));
    const record = await screen.findByRole("dialog", { name: "生成周报" });
    expect(await within(record).findByText("claims.json")).toBeInTheDocument();
    expect(within(record).queryByRole("link", { name: "claims.json" })).toBeNull();
    const external = within(record).getByRole("link", { name: "药监局" });
    expect(external).toHaveAttribute("href", "https://www.nmpa.gov.cn/x");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", expect.stringContaining("noopener"));
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
    const alert = await screen.findByRole("note");
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
    expect(screen.queryByRole("note")).toBeNull();
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

it('two executions in one native session retain separate rows, files and request-scoped prose', async () => {
  const runs: ProgrammeRun[] = [{ sessionId: 'shared', runId: 'run_first', label: 'First task', state: 'finished', at: null }, { sessionId: 'shared', runId: 'run_second', label: 'Second task', state: 'finished', at: null }];
  api.runs.mockResolvedValue([{ id: 'run_first', sessionId: 'shared', outputFiles: ['first.md'] }, { id: 'run_second', sessionId: 'shared', outputFiles: ['second.md'] }]);
  api.history.mockImplementation(async (_session: string, _project: string, runId: string) => ({ messages: [{ seq: 1, role: 'assistant', text: runId === 'run_first' ? 'First result' : 'Second result' }] }));
  draw({ load: vi.fn().mockResolvedValue(runs) });
  const user = userEvent.setup(); await user.click(await screen.findByRole('button', { name: 'First task' }));
  expect(await screen.findByRole('link', { name: 'first.md' })).toHaveAttribute('href', '/app/runs/run_first/files/first.md');
  expect(screen.queryByRole('link', { name: 'second.md' })).not.toBeInTheDocument();
  expect(await screen.findByText('First result')).toBeInTheDocument();
  expect(api.history).toHaveBeenLastCalledWith('shared', 'p-masi', 'run_first');
  await user.click(screen.getByRole('button', { name: /全部运行/ })); await user.click(screen.getByRole('button', { name: 'Second task' }));
  expect(await screen.findByRole('link', { name: 'second.md' })).toHaveAttribute('href', '/app/runs/run_second/files/second.md');
  expect(screen.queryByRole('link', { name: 'first.md' })).not.toBeInTheDocument();
  expect(await screen.findByText('Second result')).toBeInTheDocument();
  expect(api.history).toHaveBeenLastCalledWith('shared', 'p-masi', 'run_second');
});
