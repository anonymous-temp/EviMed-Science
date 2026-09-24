import { render as renderView, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { directionVerdict, STOPPING_RULES } from "@evimed/domain";
import { AutopilotPage } from "./AutopilotPage";

const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), createAgenda: vi.fn(), startAgenda: vi.fn(), stopAgenda: vi.fn(), scheduleAgenda: vi.fn(), listEpisodes: vi.fn(), getDigest: vi.fn(), markDigestOpened: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
const inbox = vi.hoisted(() => ({ listInbox: vi.fn() }));
vi.mock("@/lib/inboxClient", () => inbox);
// Partial: only the project identity is stubbed. A total mock listing two
// exports by hand is a list that goes stale — it did, the moment the error
// dictionary gained `webErrorMessage`, and this page stopped rendering at all
// while the failure read as three missing strings.
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<object>()),
  getWebProjectId: () => "project-one",
}));

/** This year, so a day is dated without one (「9月6日」). */
const year = new Date().getFullYear();

const agenda = { id: "agenda-one", projectId: "project-one", revision: 2, payload: { title: "心衰证据追踪", topics: ["heart failure"],
  taskTypes: ["evidence-update"], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 1, timeZone: "Asia/Shanghai",
  enabled: true, status: "active", pauseReason: null, outcomes: [] } };
const paused = { ...agenda, payload: { ...agenda.payload, status: "paused", enabled: false,
  pauseReason: "Waiting for the researcher to start proactive research." } };
const episode = (id: string, date: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, projectId: "project-one", revision: 1,
  payload: { agendaId: "agenda-one", taskType: "evidence-update", date, budgetCny: 8, status, runId: `run-${id}`, createdAt: "", updatedAt: "", ...extra },
});
// Newest first, as the service lists them.
const runs = [
  episode("episode-one", `${year}-09-06`, "merged", { sessionId: "ses-one", digestId: "digest-one" }),
  episode("episode-two", `${year}-09-05`, "failed", { sessionId: "ses-two" }),
];
const digest = { id: "digest-one", projectId: "project-one", revision: 1, payload: { agendaId: "agenda-one", date: `${year}-09-06`, costCny: 3.2,
  episodeIds: ["episode-one"], headlines: [{ id: "claim-one", statement: "新增直接证据" }], leads: [], decisions: [] } };

/** Where the page sent the reader. */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function render(page = "/app/autopilot") {
  return renderView(
    <MemoryRouter initialEntries={[page]}>
      <Routes>
        <Route path="/app/autopilot" element={<><AutopilotPage /><LocationProbe /></>} />
        <Route path="/app/chat/:sessionId" element={<LocationProbe />} />
        <Route path="/app/runs" element={<LocationProbe />} />
        <Route path="/app/inbox" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The ⋯ menu of a task's row, opened. */
async function openMenu(title = "心衰证据追踪") {
  await userEvent.click(await screen.findByRole("button", { name: `「${title}」的更多操作` }));
}

describe("AutopilotPage", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listAgendas.mockResolvedValue({ items: [agenda], nextCursor: null });
    mocks.listEpisodes.mockResolvedValue({ items: runs, nextCursor: null });
    mocks.createAgenda.mockResolvedValue(agenda); mocks.startAgenda.mockResolvedValue(agenda); mocks.stopAgenda.mockResolvedValue(agenda);
    mocks.scheduleAgenda.mockResolvedValue({ episode: { id: "episode-three" } });
    mocks.getDigest.mockResolvedValue(digest); mocks.markDigestOpened.mockResolvedValue(digest);
    inbox.listInbox.mockReset();
    inbox.listInbox.mockResolvedValue({ items: [], nextCursor: null });
  });

  // 2026-09-23 plan §5.7, mockup m09: a list of tasks — name, frequency and
  // next run, the last result, a switch. No sentence under the title, no
  // briefing cards, no 「需要你决定」 block, no budgets or time zones on a row.
  it("is one list of scheduled tasks, with nothing under the title and no briefing", async () => {
    render();
    const heading = await screen.findByRole("heading", { level: 1, name: "主动科研" });
    expect(heading.closest("header")?.querySelectorAll("p")).toHaveLength(0);
    const tasks = await screen.findByRole("list", { name: "定时研究" });
    const row = within(tasks).getByText("心衰证据追踪").closest("li")!;
    expect(row).toHaveTextContent("每天 01:00 · 下次 今天");
    expect(within(row).getByRole("switch", { name: "定时运行「心衰证据追踪」" })).toHaveAttribute("aria-checked", "true");
    expect(row).toHaveTextContent("上次结果 ›");
    const page = document.body.textContent ?? "";
    for (const gone of [/简报/, /重点发现/, /待验证线索/, /需要你决定/, /Asia\/Shanghai/, /每日 ¥/, /heart failure/, /证据更新/, /运行中/]) {
      expect(page).not.toMatch(gone);
    }
    // Drawing the page reads no briefing: a read is recorded only when a result is opened.
    expect(mocks.getDigest).not.toHaveBeenCalled();
    expect(mocks.markDigestOpened).not.toHaveBeenCalled();
  });

  // The owner's ruling of 09-22: the result of a scheduled run is a finished
  // conversation the researcher opens.
  it("opens the last result's conversation from the row, and counts that as reading its briefing", async () => {
    render();
    await userEvent.click(await screen.findByRole("button", { name: /^心衰证据追踪\s*：打开上次结果$/ }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-one"));
    // The stopping rule pauses a task whose results nobody opens; opening one
    // is what it counts.
    expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one");
  });

  it("says how the last run went: still going, or not finished", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [episode("episode-three", `${year}-09-07`, "running", { sessionId: "ses-three" }), ...runs], nextCursor: null });
    const view = render();
    expect(await screen.findByText("进行中 ›")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^心衰证据追踪\s*：打开正在进行的这次运行$/ }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-three"));
    view.unmount();

    mocks.listEpisodes.mockResolvedValue({ items: [runs[1]], nextCursor: null });
    render();
    expect(await screen.findByText("上次未完成 ›")).toBeInTheDocument();
  });

  it("says 还没有结果 for a task that has not run, and its row opens nothing", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [], nextCursor: null });
    render();
    expect(await screen.findByText("还没有结果")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^心衰证据追踪/ })).not.toBeInTheDocument();
  });

  it("pauses and starts a task with its switch", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [agenda, { ...paused, id: "agenda-two", payload: { ...paused.payload, title: "疳证临床试验注册跟踪" } }], nextCursor: null });
    render();
    await userEvent.click(await screen.findByRole("switch", { name: "定时运行「心衰证据追踪」" }));
    await waitFor(() => expect(mocks.stopAgenda).toHaveBeenCalledWith("agenda-one", 2));
    const off = screen.getByRole("switch", { name: "定时运行「疳证临床试验注册跟踪」" });
    expect(off).toHaveAttribute("aria-checked", "false");
    await userEvent.click(off);
    await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith("agenda-two", 2));
  });

  it("says why a stopping rule paused a task, and only 已暂停 when the researcher's own switch did", async () => {
    const rules = STOPPING_RULES;
    const failures = directionVerdict({ episodesWithoutGatedClaim: 0, consecutiveFailures: rules.consecutiveFailuresBeforePausingTaskType,
      daysSinceDigestOpened: 0, userRejected: false }).reason;
    mocks.listAgendas.mockResolvedValue({ items: [
      { ...agenda, payload: { ...agenda.payload, status: "paused", enabled: false, pauseReason: failures } },
      { ...paused, id: "agenda-two", payload: { ...paused.payload, title: "新建的跟踪" } },
    ], nextCursor: null });
    render();
    expect(await screen.findByText(`每天 01:00 · 已暂停：连续 ${rules.consecutiveFailuresBeforePausingTaskType} 次未完成`)).toBeInTheDocument();
    // The service's English note for a task that was never started is not shown.
    expect(screen.getByText("新建的跟踪").closest("li")).toHaveTextContent("每天 01:00 · 已暂停");
    expect(document.body.textContent).not.toMatch(/Waiting for the researcher|同一类型连续失败/);
  });

  it("names tomorrow as the next run once today's run is scheduled", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    mocks.listAgendas.mockResolvedValue({ items: [{ ...agenda, payload: { ...agenda.payload, lastScheduledDate: today } }], nextCursor: null });
    render();
    expect(await screen.findByText("每天 01:00 · 下次 明天")).toBeInTheDocument();
  });

  it("runs a task now from its menu, after saying what it may cost", async () => {
    render();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "立即运行" }));
    const dialog = await screen.findByRole("alertdialog", { name: "立即运行？" });
    expect(dialog).toHaveTextContent("最多花费 ¥8。");
    expect(mocks.scheduleAgenda).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "立即运行" }));
    // The date is the agenda's own, not UTC: `toISOString()` named yesterday
    // between 00:00 and 08:00 Beijing time.
    await waitFor(() => expect(mocks.scheduleAgenda).toHaveBeenCalledWith("agenda-one", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
  });

  it("offers no run-now for a paused task", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [paused], nextCursor: null });
    render();
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: "历史" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "立即运行" })).not.toBeInTheDocument();
  });

  it("lists every run in the task's history, each a conversation to open", async () => {
    render();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "历史" }));
    const dialog = await screen.findByRole("dialog", { name: "心衰证据追踪" });
    await waitFor(() => expect(mocks.listEpisodes).toHaveBeenCalledWith("project-one", "agenda-one"));
    // The task's settings are the drawer's one line; a run says its state only when it did not simply finish.
    expect(dialog).toHaveTextContent("每天 01:00 · 单次 ¥8 · 每日 ¥20 · 每周 ¥80");
    expect(within(dialog).getByText("9月5日").closest("li")).toHaveTextContent("未完成");
    expect(within(dialog).getByText("9月6日").closest("li")).not.toHaveTextContent(/已完成|merged/);
    // No scrubber, no speed: the conversation's own process view is the replay.
    expect(dialog.textContent).not.toMatch(/回放|倍速|查看简报|文献哨兵|证据更新/);
    await userEvent.click(within(dialog).getByRole("button", { name: "9月5日" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-two"));
  });

  it("creates a task from one sentence, in a panel, and leaves it paused", async () => {
    render();
    await userEvent.click(await screen.findByRole("button", { name: "新建定时研究" }));
    const panel = await screen.findByRole("dialog", { name: "新建定时研究" });
    // No paragraph about defaults and fees: the fields under 「高级」 are the defaults.
    expect(panel.textContent).not.toMatch(/默认每天|产生费用/);
    await userEvent.type(screen.getByLabelText("想持续跟进什么？"), "司美格鲁肽的胰腺炎与心血管结局");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(mocks.createAgenda).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-one", title: "司美格鲁肽的胰腺炎与心血管结局", topics: ["司美格鲁肽的胰腺炎", "心血管结局"],
      taskTypes: ["literature-sentinel"], scheduleHour: 7,
    })));
    expect(panel).not.toBeInTheDocument();
  });

  it("points at the inbox in one line when something waits on the researcher, and shows none of it here", async () => {
    inbox.listInbox.mockResolvedValue({ items: [
      { id: "n1", noticeType: "review", title: "一份交付物等待复核", body: "心衰证据更新", actions: [], count: 1, priority: 1, readAt: null, resolvedAt: null, resolution: null, revision: 1, createdAt: "2026-09-15T00:00:00.000Z" },
      { id: "n2", noticeType: "notify", title: "普通通知", body: "不该计入", actions: [], count: 1, priority: 1, readAt: null, resolvedAt: null, resolution: null, revision: 1, createdAt: "2026-09-15T00:00:00.000Z" },
    ], nextCursor: null });
    render();
    const pointer = await screen.findByRole("link", { name: "1 项待你决定 →" });
    expect(pointer).toHaveAttribute("href", "/app/inbox");
    expect(screen.queryByText("一份交付物等待复核")).not.toBeInTheDocument();
  });

  it("shows an empty page as one sentence, with the header's button the only one", async () => {
    mocks.listAgendas.mockResolvedValue({ items: [], nextCursor: null });
    mocks.listEpisodes.mockResolvedValue({ items: [], nextCursor: null });
    render();
    const empty = await screen.findByText("还没有定时研究。");
    expect(empty.parentElement?.textContent).toBe("还没有定时研究。");
    expect(screen.getAllByRole("button", { name: "新建定时研究" })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/产生费用|默认/);
  });

  // An inbox notice or a Feishu card still carries a briefing's address.
  it("opens a briefing's address as the conversation of the run that produced it", async () => {
    render("/app/autopilot?digest=digest-one");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-one"));
    expect(mocks.getDigest).toHaveBeenCalledWith("digest-one");
    expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one");
  });

  it("opens a briefing from another of the account's projects through its run's address", async () => {
    // A conversation is read in its own project; the run address is what
    // resolves the project and switches to it (RunRedirect, router.tsx).
    mocks.getDigest.mockResolvedValue({ ...digest, projectId: "project-zero" });
    render("/app/autopilot?digest=digest-one");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/runs?run=run-episode-one"));
    expect(mocks.listEpisodes).toHaveBeenCalledWith("project-zero");
  });

  it("lands on the list when a briefing has no conversation to open", async () => {
    mocks.listEpisodes.mockResolvedValue({ items: [runs[1]], nextCursor: null });
    render("/app/autopilot?digest=digest-one");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/autopilot$/));
    expect(await screen.findByText("心衰证据追踪")).toBeInTheDocument();
    expect(mocks.markDigestOpened).not.toHaveBeenCalled();
  });

  it("offers a retry when the tasks could not be read", async () => {
    mocks.listAgendas.mockRejectedValueOnce(new Error("unavailable"));
    render();
    expect(await screen.findByRole("alert")).toHaveTextContent("主动科研状态不可用");
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByText("心衰证据追踪")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
