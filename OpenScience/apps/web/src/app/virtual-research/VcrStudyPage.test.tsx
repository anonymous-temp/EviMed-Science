import { prepareVcrPendingDraft } from "@/lib/vcrPendingDraft";
import { RouterProvider } from "react-router/dom";
import { sessionOwner, WEB_SESSION_STARTED_EVENT } from "@/lib/sessionLifecycle";
import { pendingRuntimeUiIntent, prepareRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { VCR_STUDY_REFRESH_EVENT } from "@/components/vcr/useStudy";
import { expectOpaqueRuntimeUiIntent } from "@/test/runtimeUiIntentAssertions";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, Route, Routes, useBlocker, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { announceVcrStudyRefresh, forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { VcrStudyPage } from "./VcrStudyPage";

// Only the network is doubled: the readers, the route functions and every
// component above them are the real ones, fed the server's own answers.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const me = vi.hoisted(() => ({ fetchWebMe: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebMe: me.fetchWebMe,
  getWebConversationHistory: me.history,
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

// The shell is in the study's own project unless a test says otherwise: the page moves it there once, and only if it is not.
const store = vi.hoisted(() => ({
  currentId: "prj_ev201",
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: store.currentId, projects: [{ id: "prj_ev201" }, { id: "prj_empty" }], select: store.select, load: store.load });
  const useProjectStore = Object.assign(<T,>(selector: (value: ReturnType<typeof state>) => T) => selector(state()), { getState: state });
  return { useProjectStore };
});

// The kernel's frame is not drawn here: what the study's conversation view asks the shell for is what is asserted.
const pane = vi.hoisted(() => ({ requests: [] as Array<{ projectId: string; sessionId: string }> }));
vi.mock("@/lib/taskPane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/taskPane")>()),
  registerTaskPane: (request: { projectId: string; sessionId: string }) => {
    pane.requests.push({ projectId: request.projectId, sessionId: request.sessionId });
    return () => undefined;
  },
}));

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="location">{`${location.pathname}${location.search}`}</div>
      <button type="button" onClick={() => navigate("/app/virtual-research/std_2")}>去另一个研究</button>
    </>
  );
}

function draw(path = `/app/virtual-research/${STUDY_ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/virtual-research/:studyId/:tab?" element={<><VcrStudyPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const STUDY_NAME = "EV-201 二线 NSCLC：单臂 II 期还是随机";
const heading = () => screen.findByRole("heading", { level: 1, name: STUDY_NAME });

async function openMenu(item: string) {
  await heading();
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  forgetStudies();
  server = installVcrServer(network.productRequest);
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  toasts.success.mockReset();
  toasts.error.mockReset();
  store.select.mockClear();
  store.load.mockClear();
  store.currentId = "prj_ev201";
  pane.requests.length = 0;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("the study page's header", () => {
  it("carries the study's name and its data tier as plain text — and, within its ceiling, no intended-use mark: that is a line of the definition", async () => {
    draw();
    expect(await heading()).toBeInTheDocument();
    expect(screen.getByText("T0 公开资料")).toBeInTheDocument();
    expect(screen.queryByText("研究设计支持")).toBeNull();
    expect(document.querySelector("[data-vcr-ceiling]")).toBeNull();
    // A tag is a label, never a control: the tier is not one.
    expect(document.querySelector("[data-tag]")).toBeNull();
  });

  it("goes back to the list from a link over the title, and has no second rail of seven steps", async () => {
    draw();
    await heading();
    expect(screen.getByRole("link", { name: /虚拟临床研究/ })).toHaveAttribute("href", "/app/virtual-research");
    expect(screen.queryByRole("list", { name: "七步进度" })).toBeNull();
    expect(document.querySelectorAll("[data-step-rail]")).toHaveLength(0);
  });

  // UI-17: a study whose results cannot carry the use it asked for says both,
  // and says why.
  it("names a downgraded intended use as request → ceiling, as a text button, and opens the reasons", async () => {
    const study = fixture("ev201/study.json");
    study.intendedUse = "specified_analysis";
    study.ceiling = {
      ceiling: "design_support", requested: "specified_analysis", withinCeiling: false,
      reasons: [{ code: "model_tier", detail: "所用模型的可信度层级最多支持“研究设计支持”" }, { code: "review", detail: "关键假设还没有复核" }],
    };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    const mark = await screen.findByRole("button", { name: "指定研究分析 → 研究设计支持" });
    expect(mark).not.toHaveAttribute("data-tag");
    expect(mark).toHaveClass("h-sm", "text-ui", "text-warn-strong");
    expect(mark).not.toHaveClass("text-caption");
    expect(mark).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(mark);
    const drawer = await screen.findByRole("dialog", { name: "预期用途" });
    expect(within(drawer).getByText("所用模型的可信度层级最多支持“研究设计支持”")).toBeInTheDocument();
    expect(within(drawer).getByText("关键假设还没有复核")).toBeInTheDocument();
  });

  // 2026-09-20 ruling: the study page grows no second composer. The conversation is a view of this page (R19).
  it("has no composer of its own: 对话 opens the study's conversation as a view of the same page, with the study's step bar still above it", async () => {
    const study = fixture("ev201/study.json");
    study.conversation = { sessionId: "ses_own", exists: true };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    await heading();
    // The bar only holds what is typed until the conversation opens: it has no way to send.
    expect(screen.queryByRole("button", { name: /发送/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开对话" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1/chat"));
    // Not the chat surface, and no switch of project for it: the shell was in the study's project already.
    expect(screen.getByTestId("location")).not.toHaveTextContent("/app/chat");
    expect(store.select).not.toHaveBeenCalled();
    // The band is still there, with the same tabs; none of them is the open view.
    expect(document.querySelectorAll("[data-rail-step]")).toHaveLength(0);
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
    // The shell is asked to place the kernel's frame over the pane, for the study's own conversation, in the study's project.
    await waitFor(() => expect(pane.requests).toEqual([{ projectId: "prj_ev201", sessionId: "ses_own" }]));
    expect(screen.queryByRole("button", { name: "对话" })).toBeNull();
  });

  it("says nothing of the engine: its state is not a sentence on a person's page", async () => {
    for (const engine of ["missing", "not_answering", "answering", "wired"]) {
      const study = fixture("ev201/study.json");
      study.engine = engine;
      server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
      const view = draw();
      await heading();
      expect(document.querySelector("[data-vcr-engine]")).toBeNull();
      expect(document.body.textContent).not.toMatch(/计算引擎暂不可用/);
      view.unmount();
    }
  });
});

describe("the seven tabs", () => {
  // One row of tabs replaces the step rail and the tabs: five of the seven steps were named like five of the seven tabs.




  it("tells when a step moved in the overview's list, and says nothing of time for a step nobody has started", async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const study = fixture("ev201/study.json");
    study.steps.trial = { ...study.steps.trial, status: "done", updatedAt: recent };
    study.steps.matching = { ...study.steps.matching, status: "none", updatedAt: recent };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    await heading();
    const rowOf = (step: string) => document.querySelector(`[data-vcr-step-row="${step}"]`)!.closest("li") as HTMLElement;
    await waitFor(() => expect(rowOf("trial")).toHaveTextContent("5 分钟前"));
    expect(rowOf("matching")).toHaveTextContent("待开始");
    expect(rowOf("matching")).not.toHaveTextContent("分钟前");
  });

  // Contract §5: every tab renders from what the server sends, and none of
  // them takes the page down.
  it.each(["overview", "population", "patients", "comparator", "trial", "matching", "data"])("renders %s from the server's own payload", async (tab) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    draw(`/app/virtual-research/${STUDY_ID}${tab === "overview" ? "" : `/${tab}`}`);
    await heading();
    const panel = document.getElementById("vcr-tab-panel")!;
    if (tab !== "overview") await waitFor(() => expect(server.calls.some((call) => call.path.startsWith(`/vcr/studies/std_1/${tab}`))).toBe(true));
    await waitFor(() => expect(panel.querySelector("[data-vcr-loading]")).toBeNull());
    expect(panel.querySelector("[data-vcr-tab-error]")).toBeNull();
    expect(panel.textContent?.trim().length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^查看：/ })).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalledWith("VcrTabBoundary", expect.anything(), expect.anything());
  });

  // A payload a tab cannot read is an error card inside that tab; the header,
  // the rail and the other tabs stay where they are.
  it("keeps a tab that cannot read its payload inside the tab, with the header and the other tabs still there", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A registry number that is an object cannot be drawn: React refuses it, and the tab's boundary is what keeps the page up.
    const base = fixture("ev201/data.json");
    const junk = { ...base, precedents: [{ ...base.precedents[0], registryId: { overview: 5 } }] };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: junk });
    draw(`/app/virtual-research/${STUDY_ID}/data`);
    const panel = await waitFor(() => {
      const card = document.querySelector("#vcr-tab-panel [data-vcr-tab-error]");
      expect(card).not.toBeNull();
      return card!;
    });
    expect(panel).toHaveTextContent("这一页的内容暂时读不出来");
    expect(screen.getByRole("heading", { level: 1, name: STUDY_NAME })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-rail-step]")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /^查看/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "人群与患者" }));
    await waitFor(() => expect(document.querySelector("#vcr-tab-panel [data-vcr-tab-error]")).toBeNull());
  });
});

describe("the study page's addresses", () => {
  it("rewrites a step name to the tab that holds it, in place — 定义 and 证据 are one tab now", async () => {
    draw(`/app/virtual-research/${STUDY_ID}/evidence`);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1/data"));
  });

  it("reads a link to the definition step as the tab that holds it", async () => {
    draw(`/app/virtual-research/${STUDY_ID}/definition`);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1/data"));
  });

  it("says a study is gone rather than showing an error", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: () => { throw new WebApiError("gone", { status: 404, code: "vcr_study_not_found" }); },
    });
    draw();
    expect(await screen.findByText("这个研究不存在或已删除。")).toBeInTheDocument();
  });

  it("falls back to the module-off sentence when the route says the module is off", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: () => { throw new WebApiError("off", { status: 404, code: "vcr_not_enabled" }); },
    });
    draw();
    expect(await screen.findByText("虚拟临床研究还没有在这个工作空间开放。")).toBeInTheDocument();
  });

  // No stale study under a new address: moving to another study shows the
  // skeleton until that study's own answer arrives.
  it("shows nothing of the previous study while the next one loads", async () => {
    let answer: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies/std_2": () => new Promise((resolve) => { answer = resolve; }),
    });
    draw();
    await heading();
    await userEvent.click(screen.getByRole("button", { name: "去另一个研究" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: STUDY_NAME })).toBeNull());
    await waitFor(() => expect(document.querySelector("[data-vcr-loading='study']")).not.toBeNull());
    await act(async () => { answer(fixture("empty/study.json")); });
    expect(await screen.findByRole("heading", { level: 1, name: "GLP-1 周制剂 III 期：样本量与脱落情景" })).toBeInTheDocument();
  });

  it("opens a package in the reader on the study's own address, under the same band: the step bar is on every view", async () => {
    draw(`/app/virtual-research/${STUDY_ID}?package=exp_2`);
    expect(await screen.findByRole("heading", { name: "研究包 v1" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-rail-step]")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /返回研究/ }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "研究包 v1" })).toBeNull());
    expect(screen.getByRole("button", { name: "查看：总览" })).toBeInTheDocument();
  });
});

/** The study as the server reads it while a run is out for the given steps. */
function studyWith(activity: unknown, patch: (study: any) => void = () => undefined) {
  const study = fixture("ev201/study.json");
  study.activity = activity;
  patch(study);
  return study;
}
const RUN = {
  id: "run_9", step: "population", steps: ["population", "patients"], label: "构建人群、生成虚拟患者", phase: "search",
  counts: { search: 6, included: 23 }, startedAt: new Date(Date.now() - 125_000).toISOString(), placement: "open-runtime", locked: false,
};
const strip = () => document.querySelector("[data-activity='strip']") as HTMLElement | null;

describe("what the study is doing, in the strip under the header", () => {
  it("says the run that is out in the person's own sentence, what it has counted and for how long, with 停止整个研究 — under the header and above the tabs", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith({ run: RUN, queue: [{ step: "comparator", waitingFor: "patients" }], jobs: [], last: null }),
    });
    draw();
    await heading();
    const line = strip()!;
    expect(line).toHaveTextContent("正在构建人群、生成虚拟患者");
    expect(line).toHaveTextContent("检索 6 次 · 纳入 23 篇");
    expect(line).toHaveTextContent("另有 1 项排队");
    expect(within(line).getByRole("button", { name: "停止整个研究" })).toBeInTheDocument();
    // The strip is in the band, above the row of tabs — and says no percentage and no instruction the model was briefed with.
    const tabs = document.querySelector("[data-toolbar]")!;
    expect(line.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector("[data-page-chrome]")!.contains(line)).toBe(true);
    expect(line.textContent).not.toMatch(/%|vcr_|exploratory|数据档位/);
  });

  it("is the engine job that moves when no run is out: its step as a verb and an object, how far it has come, and 停止整个研究", async () => {
    draw();
    await heading();
    const line = strip()!;
    expect(line).toHaveTextContent("正在模拟试验方案");
    expect(line).toHaveTextContent("计算 3 / 10");
    expect(within(line).getByRole("button", { name: "停止整个研究" })).toBeInTheDocument();
    expect(within(line).queryByRole("progressbar")).toBeNull();
  });

  it("says a step in line is in line and what it waits for — nothing is pulsing for it", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith({ run: null, queue: [{ step: "patients", waitingFor: "evidence" }], jobs: [], last: null }),
    });
    draw();
    await heading();
    const line = strip()!;
    expect(line).toHaveAttribute("data-activity-state", "queued");
    expect(line).toHaveTextContent("生成虚拟患者 · 排队中");
    expect(line).toHaveTextContent("等“证据”做完");
    // Nothing is out, and a person may still stop what is waiting: the cancel holds the programme, so it is not taken up in its turn.
    expect(within(line).getByRole("button", { name: "停止整个研究" })).toBeInTheDocument();
  });

  it("holds a step that is only in line with one request — a person who changed their mind has a way to say so", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith({ run: null, queue: [{ step: "evidence", waitingFor: null }], jobs: [], last: null }),
      [`POST /vcr/studies/${STUDY_ID}/cancel`]: { canceled: { runId: null, jobs: 0, held: ["evidence"] } },
    });
    draw();
    await heading();
    await userEvent.click(within(strip()!).getByRole("button", { name: "停止整个研究" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cancel`, "POST", {}));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1");
  });

  it("offers a step that is only in line no 取消 to a reader who cannot run one", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith({ run: null, queue: [{ step: "evidence", waitingFor: null }], jobs: [], last: null }, (study) => { study.abilities = ["read"]; }),
    });
    draw();
    await heading();
    expect(within(strip()!).queryByRole("button")).toBeNull();
  });

  it("says a job waits on an engine that is not answering as a state, in a few words and with nothing to press", async () => {
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies/std_1": () => {
        const study = fixture("ev201/study.json");
        study.jobs = study.jobs.map((job: { id: string }) => (job.id === "job_seed_16" ? { ...job, waitingOn: "engine" } : job));
        return study;
      },
    });
    draw();
    await heading();
    expect(strip()).toHaveTextContent("等计算引擎恢复");
    expect(document.body.textContent).not.toMatch(/暂时没有回应|无需操作/);
  });

  it("is absent when nothing runs or waits, and a job that waits only for the budget is not work under way", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith(null, (study) => {
        study.jobs = study.jobs.filter((job: { state: string }) => job.state === "succeeded");
        study.budget = { ...study.budget, awaitingBudget: 0 };
      }),
    });
    draw();
    await heading();
    expect(strip()).toBeNull();
    expect(document.querySelector("[data-activity]")).toBeNull();
  });

  it("cancels what the study is doing with one request, and reads the study again", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith({ run: RUN, queue: [], jobs: [], last: null }),
      [`POST /vcr/studies/${STUDY_ID}/cancel`]: { canceled: { runId: "run_9", jobs: 1 } },
    });
    draw();
    await heading();
    const reads = () => server.calls.filter((call) => call.method === "GET" && call.path === `/vcr/studies/${STUDY_ID}`).length;
    const before = reads();
    await userEvent.click(within(strip()!).getByRole("button", { name: "停止整个研究" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cancel`, "POST", {}));
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1");
  });

  it("offers no 取消 to a reader who cannot run a step", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: studyWith({ run: RUN, queue: [], jobs: [], last: null }, (study) => { study.abilities = ["read"]; }),
    });
    draw();
    await heading();
    expect(strip()).not.toBeNull();
    expect(within(strip()!).queryByRole("button")).toBeNull();
  });
});

describe("what waits for the lead's word", () => {
  it("is one line over the tab, with the number of computations and the CPU time they need — and the header's primary action is the button that gives it", async () => {
    draw();
    await heading();
    const note = document.querySelector("[data-note]") as HTMLElement;
    expect(note).toHaveTextContent("有 1 项计算等你确认预算，需 2.5 小时 CPU 时间");
    // The budget is CPU time; there is no money anywhere on it.
    expect(note.textContent).not.toMatch(/¥|元/);
    // One primary action on a module page, and it is in the header's row — not in the body (DESIGN.md, template T3).
    expect(within(note).queryByRole("button", { name: "确认预算" })).toBeNull();
    const header = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
    const confirm = within(header).getByRole("button", { name: "确认预算" });
    expect(confirm.className).toMatch(/bg-accent/);
    expect(document.querySelectorAll("main .bg-accent, [data-page-header] .bg-accent")).toHaveLength(1);
    // The figure opens what it counts: the same dialog.
    await userEvent.click(within(note).getByRole("button", { name: "1 项计算等待预算确认" }));
    expect(await screen.findByRole("dialog", { name: "计算预算" })).toBeInTheDocument();
  });

  it("makes the next step the quiet button while the budget waits, so the header still has one primary", async () => {
    draw();
    await heading();
    const header = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
    const next = within(header).queryByRole("button", { name: /^(下一步|接着做|重新做)：/ });
    if (next) expect(next.className).not.toMatch(/bg-accent/);
    expect(header.querySelectorAll(".bg-accent")).toHaveLength(1);
  });

  it("is not said to a reader who cannot confirm it: there is nothing for them to press and the sentence is the lead's", async () => {
    const study = fixture("ev201/study.json");
    study.abilities = ["read", "write", "run"];
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    await heading();
    expect(document.body.textContent).not.toMatch(/等你确认预算/);
    expect(screen.queryByRole("button", { name: "确认预算" })).toBeNull();
  });

  it("confirms one waiting job with exactly its id, then re-reads the study", async () => {
    draw();
    await heading();
    await userEvent.click(screen.getByRole("button", { name: "确认预算" }));
    const dialog = await screen.findByRole("dialog", { name: "计算预算" });
    expect(within(dialog).getByText("4 分钟")).toBeInTheDocument();
    expect(within(dialog).getByText("进行中预留").nextElementSibling).toHaveTextContent("0 秒");
    expect(within(dialog).getByText("2 小时")).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/¥|元/);
    const reads = server.calls.filter((call) => call.method === "GET" && call.path === "/vcr/studies/std_1").length;
    const row = dialog.querySelector("[data-vcr-budget-job='job_seed_17']") as HTMLElement;
    expect(row).toHaveTextContent("需要 2.5 小时 CPU 时间");
    await userEvent.click(within(row).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/budget", "POST", { jobId: "job_seed_17" }));
    await waitFor(() => expect(server.calls.filter((call) => call.method === "GET" && call.path === "/vcr/studies/std_1").length).toBe(reads + 1));
    expect(toasts.success).toHaveBeenCalled();
  });

  it("confirms everything that waits with the CPU time it needs, from the header menu's entry too", async () => {
    draw();
    await openMenu("计算预算");
    const dialog = await screen.findByRole("dialog", { name: "计算预算" });
    await userEvent.click(within(dialog).getByRole("button", { name: "全部确认" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/budget", "POST", { cpuSeconds: 9000 }));
    expect(server.calls.filter((call) => call.path === "/vcr/studies/std_1/budget")).toHaveLength(1);
  });
});

/** Pick what to export in the dialog 「导出…」 opens, and export it. */
async function exportAs(label: string) {
  await openMenu("导出…");
  const dialog = await screen.findByRole("dialog", { name: "导出" });
  await userEvent.click(within(dialog).getByRole("radio", { name: label }));
  await userEvent.click(within(dialog).getByRole("button", { name: "开始导出" }));
}

describe("the 「⋯」 menu", () => {
  // The six exports are one entry that opens a choice, not six entries.
  it("offers the exports as one entry that opens the choice, the study package first", async () => {
    draw();
    await openMenu("导出…");
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    expect(within(dialog).getAllByRole("radio").map((radio) => (radio.closest("label") as HTMLElement).textContent)).toEqual(
      ["研究包", "模拟报告", "CDE 沟通交流资料包", "系统验证文档包", "模型分析计划", "模型分析报告"]);
    expect(within(dialog).getByRole("radio", { name: "研究包" })).toBeChecked();
  });

  // An export is a start like a step's: the page stays, and says in its strip what is being written.
  it("keeps an export that waits for the previous run on the page — in line, not a toast", async () => {
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/export`]: { export: { id: "exp_9" }, accepted: true, runId: null, step: null, queuedBehind: [{ step: "patients", waitingFor: "run" }] },
    });
    draw();
    await exportAs("研究包");
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/export", "POST", { kind: "study_package" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/virtual-research\/std_1$/);
    expect(store.select).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("starts an export that did start and stays on the page: the study is read again, and there is no conversation to be sent to", async () => {
    draw();
    await heading();
    const reads = () => server.calls.filter((call) => call.method === "GET" && call.path === "/vcr/studies/std_1").length;
    const before = reads();
    await exportAs("CDE 沟通交流资料包");
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/export", "POST", { kind: "cde_communication_pack" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/virtual-research\/std_1$/);
    expect(store.select).not.toHaveBeenCalled();
  });

  it.each([
    ["模拟报告", "simulation_report"],
    ["系统验证文档包", "validation_pack"],
    ["模型分析计划", "model_analysis_plan"],
    ["模型分析报告", "model_analysis_report"],
  ])("exports the %s through the current reader's export ability", async (label, kind) => {
    const study = fixture("ev201/study.json");
    study.abilities = ["read", "export"];
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    await exportAs(label);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/export", "POST", { kind }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/virtual-research\/std_1$/);
    expect(server.calls.filter((call) => call.path === "/vcr/studies/std_1/export")).toHaveLength(1);
  });

  // CW-16: the pause toast says what the server did, nothing more.
  it("pauses the study and says only that", async () => {
    draw();
    await openMenu("暂停研究");
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1", "PATCH", { status: "paused" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已暂停。"));
  });

  // A pause is the project's, and the page used to show nothing of it: the toast said 已暂停 once and every tab went on reading as work.
  describe("a paused study", () => {
    const paused = (abilities?: string[]) => {
      const study = fixture("ev201/study.json");
      study.status = "paused";
      if (abilities) study.abilities = abilities;
      server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    };

    it("says 已暂停 in the header beside the tier, and says what a pause means", async () => {
      paused();
      draw();
      await heading();
      expect(document.querySelector("[data-vcr-paused]")).toHaveTextContent("已暂停");
      expect(screen.getByText(/已暂停：新的步骤不会开始/)).toBeInTheDocument();
    });

    it("offers the lead 继续 beside the sentence, which sets the study active again and nothing else", async () => {
      paused();
      draw();
      await heading();
      const go = await screen.findByRole("button", { name: "继续" });
      expect(go).toHaveAttribute("data-action-kind", "set");
      await userEvent.click(go);
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1", "PATCH", { status: "active" }));
      expect(server.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    });

    it("tells a reader who is not the lead, and gives them no button the route would refuse", async () => {
      paused(["read", "write", "run"]);
      draw();
      await heading();
      expect(screen.getByText(/已暂停：新的步骤不会开始/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    });

    it("says nothing of a pause for an active study", async () => {
      draw();
      await heading();
      expect(document.querySelector("[data-vcr-paused]")).toBeNull();
      expect(screen.queryByText(/新的步骤不会开始/)).toBeNull();
    });
  });

  // Waits that no page read before: the answer the AI asked for, and the data's own two confirmations.
  describe("what the overview waits for a person to do", () => {
    it("shows the data intake's waits as lines that open 数据接入, and nothing else of them", async () => {
      const study = fixture("ev201/study.json");
      study.overview.attention = [
        { kind: "intake_confirm", tone: "attention", text: "2 份数据的字段映射在等你确认", action: { label: "数据接入", tab: null } },
        { kind: "intake_freeze", tone: "attention", text: "1 份数据的字段映射已确认，在等你冻结快照", action: { label: "数据接入", tab: null } },
      ];
      server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
      draw();
      await heading();
      const lines = await screen.findAllByText(/字段映射/);
      expect(lines).toHaveLength(2);
      const buttons = await screen.findAllByRole("button", { name: "数据接入" });
      expect(buttons).toHaveLength(2);
      await userEvent.click(buttons[0]);
      expect(await screen.findByRole("dialog", { name: "数据接入" })).toBeInTheDocument();
    });

    it("shows a study that waits for the answer to the AI's question, and takes the reader to where it was asked", async () => {
      const study = fixture("ev201/study.json");
      study.conversation = { sessionId: "submitted_canonical", exists: true, submitted: true, awaitingInput: true };
      server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
      draw();
      await heading();
      expect(await screen.findByText(/等你补充研究信息/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "补充信息" }));
      expect(screen.getByTestId("location")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/chat`);
    });

    it("does not ask a reader who cannot write to answer", async () => {
      const study = fixture("ev201/study.json");
      study.abilities = ["read"];
      study.conversation = { sessionId: "submitted_canonical", exists: true, submitted: true, awaitingInput: true };
      server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
      draw();
      await heading();
      expect(screen.queryByText(/等你补充研究信息/)).toBeNull();
    });
  });

  // A page that silently keeps an old answer looks current, and an error card in place of numbers that were true loses them for a failure of
  // the next request. Both keep what was shown and say so once, with 重试.
  describe("when an update fails after the page has answered", () => {
    it("keeps the study and says the update failed when its own read fails, and takes the sentence away when a read succeeds", async () => {
      let fail = false;
      server = installVcrServer(network.productRequest, {
        [`GET /vcr/studies/${STUDY_ID}`]: () => { if (fail) throw new WebApiError("down", { status: 503, code: "vcr_unavailable" }); return fixture("ev201/study.json"); },
      });
      draw();
      await heading();
      expect(document.querySelector("[data-vcr-refresh-failed]")).toBeNull();
      fail = true;
      act(() => announceVcrStudyRefresh(STUDY_ID));
      expect(await screen.findByText(/更新暂时失败，仍显示上次结果。/)).toBeInTheDocument();
      // The study that was on screen is still on screen.
      expect(screen.getByRole("heading", { level: 1, name: STUDY_NAME })).toBeInTheDocument();
      fail = false;
      await userEvent.click(screen.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(document.querySelector("[data-vcr-refresh-failed]")).toBeNull());
    });

    it("keeps the tab's results and says so when the tab is read again and fails, and 重试 reads it again", async () => {
      let failTab = false;
      let moved = 0;
      server = installVcrServer(network.productRequest, {
        // The study moves (a step's update time), which is what makes the tab read again.
        [`GET /vcr/studies/${STUDY_ID}`]: () => { const raw = fixture("ev201/study.json"); raw.updatedAt = `刚刚 ${moved}`; return raw; },
        [`GET /vcr/studies/${STUDY_ID}/population`]: () => { if (failTab) throw new WebApiError("down", { status: 503, code: "vcr_unavailable" }); return fixture("ev201/population.json"); },
      });
      draw(`/app/virtual-research/${STUDY_ID}/population`);
      await waitFor(() => expect(document.querySelector("[data-headline]")).not.toBeNull());
      const headline = document.querySelector("[data-headline]")!.textContent;
      failTab = true; moved = 1;
      act(() => announceVcrStudyRefresh(STUDY_ID));
      expect(await screen.findByText(/更新暂时失败，仍显示上次结果。/)).toBeInTheDocument();
      // The numbers that were true when they were read are still there, and no error card stands in their place.
      expect(document.querySelector("[data-headline]")?.textContent).toBe(headline);
      expect(document.querySelector("[data-vcr-tab-error]")).toBeNull();
      failTab = false;
      await userEvent.click(screen.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(document.querySelector("[data-vcr-refresh-failed]")).toBeNull());
      expect(document.querySelector("[data-headline]")?.textContent).toBe(headline);
    });
  });

  // CW-10: the study leaves 虚拟临床研究; the project's conversations and files stay.
  it("asks before removing, says what is true about it, and removes once", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`DELETE /vcr/studies/${STUDY_ID}`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    draw();
    await openMenu("删除");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("研究会从虚拟临床研究移除；项目里的对话和文件仍在。")).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/一起删除|不能恢复/);
    expect(server.calls.some((call) => call.method === "DELETE")).toBe(false);
    const confirm = within(dialog).getByRole("button", { name: "删除" });
    await userEvent.click(confirm);
    await userEvent.click(within(dialog).getByRole("button", { name: /删除/ }));
    expect(server.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    await act(async () => { finish({ id: STUDY_ID, projectId: "prj_ev201", deleted: true }); });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/virtual-research$/));
  });
});

describe("重命名", () => {
  it("opens with the name as it is, saves the new one with exactly { name }, re-reads the study and asks for the project list again", async () => {
    draw();
    await openMenu("重命名");
    const dialog = await screen.findByRole("dialog", { name: "重命名研究" });
    const field = within(dialog).getByLabelText("研究名称");
    expect(field).toHaveValue(STUDY_NAME);
    await userEvent.clear(field);
    await userEvent.type(field, "  EV-201 外部对照可行性  ");
    const reads = () => server.calls.filter((call) => call.method === "GET" && call.path === "/vcr/studies/std_1").length;
    const before = reads();
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1", "PATCH", { name: "EV-201 外部对照可行性" }));
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(store.load).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名研究" })).toBeNull());
  });

  it("closes without asking the server when the name did not change, and will not save an empty or too long one", async () => {
    draw();
    await openMenu("重命名");
    const dialog = await screen.findByRole("dialog", { name: "重命名研究" });
    const save = within(dialog).getByRole("button", { name: "保存" });
    await userEvent.clear(within(dialog).getByLabelText("研究名称"));
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("研究名称"), STUDY_NAME);
    await userEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名研究" })).toBeNull());
    expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("says why when the server refuses, and keeps what was typed", async () => {
    server = installVcrServer(network.productRequest, {
      [`PATCH /vcr/studies/${STUDY_ID}`]: () => { throw new WebApiError("no", { status: 403, code: "vcr_forbidden" }); },
    });
    draw();
    await openMenu("重命名");
    const dialog = await screen.findByRole("dialog", { name: "重命名研究" });
    await userEvent.type(within(dialog).getByLabelText("研究名称"), "！");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("研究名称")).toHaveValue(`${STUDY_NAME}！`);
  });
});

describe("变更记录", () => {
  it("holds what changed and the AI reviews, in a drawer — not under the overview's numbers", async () => {
    draw();
    expect(document.querySelector("[data-vcr-changes]")).toBeNull();
    await openMenu("变更记录");
    const drawer = await screen.findByRole("dialog", { name: "变更记录" });
    const log = drawer.querySelector("[data-vcr-changes]") as HTMLElement;
    expect(within(log).getAllByRole("listitem").length).toBeGreaterThan(0);
    // No version label and no model name: a date says when, and a reviewer is said by what it reviewed.
    expect(log.textContent).not.toMatch(/\bv\d+\b|qwen|deepseek/i);
  });
});

describe("AI 运行", () => {
  const runs = { runs: [
    { sessionId: "ses_ev", label: "找证据、整理假设卡", state: "finished", at: "今天 09:01" },
    { sessionId: "ses_an", label: "构建人群、生成虚拟患者", state: "running", at: "今天 09:12" },
  ] };

  it("lists the programme's background runs by what they did, with a state word and a time, and opens the one pressed as a record — not a conversation", async () => {
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/runs`]: runs });
    me.history.mockResolvedValue({ sessionId: "ses_an", capturedAt: null, partial: false,
      messages: [{ seq: 1, role: "user", text: "构建人群、生成虚拟患者" }, { seq: 2, role: "assistant", text: "人群已生成。" }] });
    draw();
    await openMenu("AI 运行");
    const drawer = await screen.findByRole("dialog", { name: "AI 运行" });
    const rows = await within(drawer).findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["找证据、整理假设卡已完成 · 今天 09:01", "构建人群、生成虚拟患者进行中 · 今天 09:12"]);
    expect(drawer.textContent).not.toMatch(/run_|ses_/);
    await userEvent.click(within(drawer).getByRole("button", { name: "构建人群、生成虚拟患者" }));
    // A record of what the AI did, read where the reader is; the page is where it was and no session was opened.
    const record = await screen.findByRole("dialog", { name: "构建人群、生成虚拟患者" });
    expect(await within(record).findByText("人群已生成。")).toBeInTheDocument();
    expect(me.history).toHaveBeenCalledWith("ses_an", "prj_ev201");
    expect(within(record).queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/virtual-research\/std_1$/);
    expect(store.select).not.toHaveBeenCalled();
  });

  it("says plainly when the AI has done nothing in the background", async () => {
    draw();
    await openMenu("AI 运行");
    const drawer = await screen.findByRole("dialog", { name: "AI 运行" });
    expect(await within(drawer).findByText("AI 还没有在后台做过什么。")).toBeInTheDocument();
  });
});

// The tier is a claim about data. The page only offers the move the server derived
// from the frozen sources, once, to the lead; one click makes it.
describe("the offer to move up a data tier", () => {
  const offer = { tier: "T1", label: "T1 基线与招募资料", unlocks: ["用你的数据筛真实队列、做患者匹配与招募"], basis: { subjects: 240, treatment: false, outcomes: false } };
  const serve = (patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
    const study = { ...fixture("ev201/study.json"), ...patch };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study, ...overrides });
  };

  it("says what the data open and what moving does, with one button — and moves with one request, then re-reads the study", async () => {
    serve({ tierOffer: offer });
    draw();
    await heading();
    const card = document.querySelector("[data-vcr-tier-offer]") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent("你接入的数据已够 T1：用你的数据筛真实队列、做患者匹配与招募。");
    const reads = () => server.calls.filter((call) => call.method === "GET" && call.path === `/vcr/studies/${STUDY_ID}`).length;
    expect(reads()).toBe(1);
    await userEvent.click(within(card).getByRole("button", { name: "升到 T1" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1", "PATCH", { dataTier: "T1" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已升到 T1。"));
    expect(server.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("says both steps when the data reach T2 from T0, and offers nothing when the server sent no offer", async () => {
    serve({ tierOffer: { ...offer, tier: "T2", label: "T2 完整治疗与纵向结局", unlocks: [...offer.unlocks, "走真实外部对照，用真实结局分布做仿真"] } });
    draw();
    await heading();
    expect(document.querySelector("[data-vcr-tier-offer]")).toHaveTextContent("你接入的数据已够 T2：用你的数据筛真实队列、做患者匹配与招募；走真实外部对照，用真实结局分布做仿真。");
  });

  it("shows nothing without an offer, and nothing to a reader who may not change the study", async () => {
    draw();
    await heading();
    expect(document.querySelector("[data-vcr-tier-offer]")).toBeNull();
  });

  it("is not shown to an account without manage_study even if the payload carries one", async () => {
    serve({ tierOffer: offer, abilities: ["read", "write", "run"] });
    draw();
    await heading();
    expect(document.querySelector("[data-vcr-tier-offer]")).toBeNull();
  });

  it("says why when the server refuses, and leaves the tier where it was", async () => {
    serve({ tierOffer: offer }, {
      [`PATCH /vcr/studies/${STUDY_ID}`]: () => { throw new WebApiError("研究里已冻结的数据还达不到「T1 基线与招募资料」", { status: 409, code: "vcr_tier_unsupported" }); },
    });
    draw();
    await heading();
    await userEvent.click(screen.getByRole("button", { name: "升到 T1" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByText("T0 公开资料")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "升到 T1" })).toBeEnabled();
  });
});

// The menu offers only what will not be refused: the study answers with the
// abilities of the roles the reader holds, and the routes check them again.
describe("the 「⋯」 menu follows the reader's abilities", () => {
  const withAbilities = (abilities: string[]) => {
    const study = fixture("ev201/study.json");
    study.abilities = abilities;
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
  };
  const items = async () => {
    await heading();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  };

  it("offers the lead everything: rename, export, the data intake, members, budget, pause, the record, the AI's runs, and — apart — delete", async () => {
    draw();
    expect(await items()).toEqual(["重命名", "导出…", "数据接入", "成员与角色", "计算预算", "暂停研究", "变更记录", "AI 运行", "删除"]);
  });

  it("offers a reader who only exports the export, and the two records — nothing that changes the study", async () => {
    withAbilities(["read", "review_clinical", "export"]);
    draw();
    expect(await items()).toEqual(["导出…", "数据接入", "变更记录", "AI 运行"]);
  });

  it("keeps the budget, the status, the members and the deletion from a data manager, who is not the lead — and lets them rename", async () => {
    withAbilities(["read", "write", "run", "manage_data", "read_patient_level"]);
    draw();
    expect(await items()).toEqual(["重命名", "数据接入", "变更记录", "AI 运行"]);
  });

  it("says nothing of the budget to a reader who cannot confirm it: the line is the lead's, and a button that would be refused is not offered", async () => {
    withAbilities(["read", "write", "run"]);
    draw();
    await heading();
    expect(document.querySelector("[data-vcr-budget-wait]")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认预算" })).toBeNull();
  });

  it("offers the data intake as one entry on every tier, which opens a drawer over the tab the reader is on", async () => {
    draw(`/app/virtual-research/${STUDY_ID}/population`);
    await openMenu("数据接入");
    const drawer = await screen.findByRole("dialog", { name: "数据接入" });
    await waitFor(() => expect(server.calls.some((call) => call.path === `/vcr/studies/${STUDY_ID}/data`)).toBe(true));
    expect(drawer).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/population`);
  });
});

describe("the delete confirmation holds still while it works", () => {
  it("disables both buttons and cannot be dismissed until the request settles, then closes on a refusal", async () => {
    let refuse: (error: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`DELETE /vcr/studies/${STUDY_ID}`]: () => new Promise((_resolve, reject) => { refuse = reject; }),
    });
    draw();
    await openMenu("删除");
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "删除" })).toHaveAttribute("aria-disabled", "true"));
    expect(within(dialog).getByRole("button", { name: "删除" })).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await act(async () => { refuse(new WebApiError("no", { status: 403, code: "vcr_forbidden" })); });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(toasts.error).toHaveBeenCalled();
    expect(server.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
});

describe("成员与角色", () => {
  const members = {
    members: [
      { userId: "owner_1", name: "刘负责人", owner: true, roles: ["lead"], roleLabels: ["研究负责人"], invitedBy: null, createdAt: null },
      { userId: "u_stat", name: "陈统计", owner: false, roles: ["clinical_reviewer", "statistical_reviewer"], roleLabels: ["临床复核", "统计复核"], invitedBy: "owner_1", createdAt: "2026-09-20T00:00:00Z" },
    ],
  };
  async function openMembers(extra: Record<string, unknown> = {}) {
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/members`]: members, ...extra });
    draw();
    await openMenu("成员与角色");
    return screen.findByRole("dialog", { name: "成员与角色" });
  }

  it("lists the owner as the lead, who has no way out, and the others with a way out for each role", async () => {
    const dialog = await openMembers();
    const owner = await waitFor(() => {
      const found = dialog.querySelector("[data-vcr-member='owner_1']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(owner).toHaveTextContent("研究负责人");
    expect(within(owner).queryByRole("button")).toBeNull();
    const stat = dialog.querySelector("[data-vcr-member='u_stat']") as HTMLElement;
    expect(within(stat).getByRole("button", { name: "移除 陈统计 的“临床复核”" })).toBeInTheDocument();
    expect(within(stat).getByRole("button", { name: "移除 陈统计 的“统计复核”" })).toBeInTheDocument();
  });

  // A person is shown by name. The account id is the remove call's address and is never printed in a person's place.
  it("shows each member by name and never by account id, in the list and in the controls' names", async () => {
    const dialog = await openMembers();
    await within(dialog).findByText("陈统计");
    expect(within(dialog).getByText("刘负责人")).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/u_stat|owner_1/);
    for (const button of within(dialog).getAllByRole("button")) expect(button.getAttribute("aria-label") ?? "").not.toMatch(/u_stat|owner_1/);
  });

  it("says nothing of a person it has no name for, rather than their id", async () => {
    const dialog = await openMembers({
      [`GET /vcr/studies/${STUDY_ID}/members`]: { members: [{ userId: "usr_77aa", owner: false, roles: ["viewer"], roleLabels: ["只读查看者"], invitedBy: null, createdAt: null }] },
    });
    await waitFor(() => expect(dialog.querySelector("[data-vcr-member='usr_77aa']")).not.toBeNull());
    expect(dialog.textContent).not.toMatch(/usr_77aa/);
  });

  // The route takes `{ userId, role }` and removes through `?role=`.
  it("adds an account with exactly { userId, role }", async () => {
    const dialog = await openMembers();
    await within(dialog).findByText("陈统计");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), " u_recruit ");
    await userEvent.selectOptions(within(dialog).getByLabelText("角色"), "data_manager");
    await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/members", "POST", { userId: "u_recruit", role: "data_manager" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已添加。"));
    expect(within(dialog).getByLabelText("成员账号 ID")).toHaveValue("");
  });

  it("takes an id the route would refuse as not addable, without asking it", async () => {
    const dialog = await openMembers();
    await within(dialog).findByText("陈统计");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), "a b/c");
    expect(within(dialog).getByRole("button", { name: "添加" })).toBeDisabled();
  });



  it("removes one role of one account through DELETE …/members/:userId?role=", async () => {
    const dialog = await openMembers();
    const stat = await waitFor(() => {
      const found = dialog.querySelector("[data-vcr-member='u_stat']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(stat).getByRole("button", { name: "移除 陈统计 的“统计复核”" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/members/u_stat?role=statistical_reviewer", "DELETE"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已移除。"));
  });

  it("says a refusal in the reader's words and keeps the list", async () => {
    const dialog = await openMembers({
      [`POST /vcr/studies/${STUDY_ID}/members`]: () => { throw new WebApiError("no", { status: 403, code: "vcr_forbidden" }); },
    });
    await within(dialog).findByText("陈统计");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), "u_x");
    await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(within(dialog).getByLabelText("成员账号 ID")).toHaveValue("u_x");
    expect(within(dialog).getByText("陈统计")).toBeInTheDocument();
  });
});



it("restores a submitted intake awaiting information as its canonical conversation after handoff and reload", async () => {
  const study = fixture("empty/study.json");
  study.id = STUDY_ID; study.projectId = "prj_ev201"; study.status = "draft"; study.activity = null;
  study.conversation = { sessionId: "submitted_canonical", exists: true, submitted: true, awaitingInput: true };
  study.steps.definition = { status: "none", requested: true, held: true, note: "请在研究对话中补充尚缺的研究信息。" };
  server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
  const page = draw(`/app/virtual-research/${STUDY_ID}/chat`);
  await screen.findByRole("region", { name: "研究对话" });
  expect(screen.queryByRole("button", { name: "开始研究" })).toBeNull();
  expect(pane.requests.at(-1)).toEqual({ projectId: "prj_ev201", sessionId: "submitted_canonical" });
  page.unmount(); forgetStudies(); draw(`/app/virtual-research/${STUDY_ID}/chat`);
  await screen.findByRole("region", { name: "研究对话" });
  expect(screen.queryByRole("button", { name: "开始研究" })).toBeNull();
  expect(document.querySelectorAll("[data-rail-step]")).toHaveLength(0);
});

it("opens the existing protected data intake on its addressed study view", async () => {
  draw(`/app/virtual-research/${STUDY_ID}/data?intake=1`);
  expect(await screen.findByRole("dialog", { name: "数据接入" })).toBeInTheDocument();
  expect(server.calls.some(call => call.path === `/vcr/studies/${STUDY_ID}/data`)).toBe(true);
});

it("keeps a truly unsubmitted saved draft in the brief even when its canonical session already exists", async () => {
  me.fetchWebMe.mockResolvedValue({ user: { id: "draft-owner", tenantId: "tenant" }, features: { vcr: true } });
  const study = fixture("empty/study.json");
  study.id = STUDY_ID; study.projectId = "prj_ev201"; study.status = "draft"; study.question = "尚未提交的问题"; study.activity = null;
  study.conversation = { sessionId: "unsubmitted_canonical", exists: true };
  study.steps.definition = { status: "none", requested: true, held: true, note: null };
  installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
  draw(`/app/virtual-research/${STUDY_ID}/chat`);
  expect(await screen.findByRole("region", { name: "研究对话" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
  expect(screen.queryByRole("button", { name: "开始研究" })).toBeNull();
  await waitFor(() => expect(pane.requests.at(-1)).toMatchObject({ sessionId: "unsubmitted_canonical" }));
});

// F4 (VCR remediation 2026-11-01): a study opens on what it holds. A conversation's study that only did a matching was never asked a
// question and defined nothing; its overview has nothing to say, so the bare address lands on 匹配 once.
describe("where a study opens", () => {
  const matchingOnly = () => {
    const study = fixture("empty/study.json");
    study.id = STUDY_ID; study.projectId = "prj_ev201"; study.name = "帮我匹配患者和临床试验"; study.purpose = "task";
    study.question = null; study.definition = null; study.steps = {}; study.stepSummaries = {}; study.activity = null; study.holds = ["matching"];
    return study;
  };
  const located = () => screen.getByTestId("location").textContent;

  it("lands a study that holds only matching results on 匹配, and does not ask for a question", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: matchingOnly() });
    draw();
    await waitFor(() => expect(located()).toBe(`/app/virtual-research/${STUDY_ID}/matching`));
    expect(await screen.findByRole("heading", { level: 1, name: "帮我匹配患者和临床试验" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "说明研究问题" })).toBeNull();
  });

  it("honours an address that names a tab, and a study with a question of its own stays on its overview", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: matchingOnly() });
    const page = draw(`/app/virtual-research/${STUDY_ID}/data`);
    await screen.findByRole("heading", { level: 1, name: "帮我匹配患者和临床试验" });
    expect(located()).toBe(`/app/virtual-research/${STUDY_ID}/data`);
    page.unmount(); forgetStudies();
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: { ...matchingOnly(), question: "核对这位患者的试验入排条件" } });
    draw();
    await screen.findByRole("heading", { level: 1, name: "帮我匹配患者和临床试验" });
    expect(located()).toBe(`/app/virtual-research/${STUDY_ID}`);
  });

  it("does not send the reader back to 匹配 when they open 总览 afterwards: it lists where the results are", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: matchingOnly() });
    draw();
    await waitFor(() => expect(located()).toBe(`/app/virtual-research/${STUDY_ID}/matching`));
    await screen.findByRole("heading", { level: 1, name: "帮我匹配患者和临床试验" });
    await userEvent.click(screen.getByRole("button", { name: "查看：匹配" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "总览" }));
    expect(await screen.findByRole("list", { name: "已有结果的页签" })).toBeInTheDocument();
    expect(located()).toBe(`/app/virtual-research/${STUDY_ID}`);
    expect(screen.queryByRole("button", { name: "说明研究问题" })).toBeNull();
  });

  it("keeps a study that holds nothing on its overview, asking for the first sentence", async () => {
    const empty = matchingOnly(); empty.holds = [];
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: empty });
    draw();
    expect(await screen.findByRole("button", { name: "说明研究问题" })).toBeInTheDocument();
    expect(located()).toBe(`/app/virtual-research/${STUDY_ID}`);
  });
});

// F6 (VCR remediation 2026-11-01): 调整 on a conversation's study goes back to the conversation the study was made in, with the draft and the
// saved version it is about -- the intent names that conversation and the study's own project, and the page it comes from stays beside it.
describe("调整 on a study a conversation made", () => {
  it("opens that conversation with the unsent draft and the exact saved design, and keeps the trial page beside it", async () => {
    const study = fixture("ev201/study.json");
    study.purpose = "task"; study.projectId = "prj_ev201"; study.conversation = { sessionId: "sess_orig", exists: true }; study.sessionId = "sess_orig"; study.activity = null;
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    function State() { const location = useLocation(); return <pre data-testid="state">{JSON.stringify({ path: `${location.pathname}${location.search}`, state: location.state })}</pre>; }
    render(
      <MemoryRouter initialEntries={[`/app/virtual-research/${STUDY_ID}/trial`]}>
        <Routes><Route path="/app/virtual-research/:studyId/:tab?" element={<><VcrStudyPage /><State /></>} /></Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "让 AI 调整：方案 A" }));
    const { path, state } = JSON.parse(screen.getByTestId("state").textContent!);
    expect(path).toBe(`/app/virtual-research/${STUDY_ID}/chat?result=trial`);
    const intent = expectOpaqueRuntimeUiIntent(state, "prj_ev201");
    expect(intent).toMatchObject({ kind: "open", sessionId: "sess_orig" });
    expect(intent.draft).toMatch(/^调整试验方案/);
    expect(intent.vcrReference).toEqual({ kind: "trial_scenario", studyId: STUDY_ID, objectId: "scn_1", version: 1, resultId: "res_1", resultVersion: 1 });
    // Nothing is sent from here: the draft waits in that conversation's composer.
    expect(server.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

it("keeps a committed study draft while its native pane is locked, then makes it available when the same pane unlocks", async () => {
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("1180"), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }));
  try {
    const sessionId = "vcr-locked-session";
    const draft = { kind: "open", owner: sessionOwner(), projectId: "prj_ev201", sessionId, requestId: "vcr-locked-draft", draft: "Draft during locked research" } as const;
    const state = { runtimeUiIntent: prepareRuntimeUiIntent(draft) };
    let locked = true;
    const readStudy = () => studyWith(locked ? { run: { ...RUN, locked: true }, jobs: [], queue: [], last: null } : null, study => {
      study.conversation = { sessionId, exists: true };
    });
    const other = studyWith({ run: { ...RUN, locked: true }, jobs: [], queue: [], last: null }, study => {
      study.id = "std_2"; study.projectId = "prj_empty"; study.conversation = { sessionId, exists: true };
    });
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: readStudy, "GET /vcr/studies/std_2": other });
    const State = () => {
      const location = useLocation();
      const navigate = useNavigate();
      return <>
        <output data-testid="locked-study-address">{location.pathname}{location.search}</output>
        <output data-testid="locked-study-state">{JSON.stringify(location.state)}</output>
        <button onClick={() => { void navigate("/app/virtual-research/std_2/chat?result=trial", { state }); }}>Open another locked study</button>
      </>;
    };
    render(<MemoryRouter initialEntries={[{ pathname: `/app/virtual-research/${STUDY_ID}/chat`, search: "?result=trial", state }]}>
      <Routes><Route path="/app/virtual-research/:studyId/:tab?" element={<><VcrStudyPage /><State /></>} /></Routes>
    </MemoryRouter>);
    expect(await screen.findByText("结束后可以在这里继续")).toBeInTheDocument();
    expect(pane.requests).toHaveLength(0);
    expect(pendingRuntimeUiIntent(draft.projectId, sessionId)).toEqual(draft);
    await userEvent.click(screen.getByRole("button", { name: "查看：试验" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /人群/ }));
    expect(screen.getByTestId("locked-study-address")).toHaveTextContent("result=population");
    expect(JSON.parse(screen.getByTestId("locked-study-state").textContent ?? "{}")).toEqual(state);
    expect(pane.requests).toHaveLength(0);
    locked = false;
    await act(async () => { window.dispatchEvent(new CustomEvent(VCR_STUDY_REFRESH_EVENT, { detail: { studyId: STUDY_ID } })); });
    await waitFor(() => expect(pane.requests.at(-1)).toMatchObject({ projectId: draft.projectId, sessionId }));
    expect(pendingRuntimeUiIntent(draft.projectId, sessionId)).toEqual(draft);

    await userEvent.click(screen.getByRole("button", { name: "Open another locked study" }));
    await screen.findByText("结束后可以在这里继续");
    expect(pendingRuntimeUiIntent("prj_empty", sessionId)).toBeNull();
  } finally { media.mockRestore(); }
});

it("does not reopen a cancelled VCR draft when the study session arrives later", async () => {
  let sessionId: string | null = null;
  installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: () => studyWith(null, study => {
    study.conversation = { sessionId, exists: Boolean(sessionId) };
  }) });
  function GuardedStudy() {
    const blocker = useBlocker(({ nextLocation }) => nextLocation.pathname.endsWith("/chat"));
    return <>
      <VcrStudyPage />
      {blocker.state === "blocked" && <button onClick={() => blocker.reset()}>Stay with the results</button>}
    </>;
  }
  const NativeRequest = globalThis.Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init ? { ...init, signal: undefined } : init);
    }
  });
  try {
    const router = createMemoryRouter([{ path: "/app/virtual-research/:studyId/:tab?", element: <GuardedStudy /> }], { initialEntries: [`/app/virtual-research/${STUDY_ID}/trial`] });
    render(<RouterProvider router={router} />);
    await userEvent.click(await screen.findByRole("button", { name: "让 AI 调整：方案 A" }));
    await userEvent.click(screen.getByRole("button", { name: "Stay with the results" }));
    expect(router.state.location.pathname).toContain("/trial");
    expect(router.state.location.state).toBeNull();
    sessionId = "vcr-cancelled-provisioned";
    await act(async () => { window.dispatchEvent(new CustomEvent(VCR_STUDY_REFRESH_EVENT, { detail: { studyId: STUDY_ID } })); });
    expect(router.state.location.pathname).toContain("/trial");
    expect(screen.queryByRole("button", { name: "Stay with the results" })).not.toBeInTheDocument();
    expect(pendingRuntimeUiIntent("prj_ev201", sessionId)).toBeNull();
  } finally {
    vi.stubGlobal("Request", NativeRequest);
  }
});

it("restores an accepted provisional draft after leaving the study and coming back before its session exists", async () => {
  let sessionId: string | null = null;
  installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: () => studyWith(null, study => {
    study.conversation = { sessionId, exists: Boolean(sessionId) };
  }) });
  function Navigation() {
    const navigate = useNavigate();
    const location = useLocation();
    return <>
      <output data-testid="provisional-state">{JSON.stringify(location.state)}</output>
      <button onClick={() => { void navigate("/outside-study"); }}>Leave study</button>
      <button onClick={() => { void navigate(-1); }}>Return through history</button>
    </>;
  }
  render(<MemoryRouter initialEntries={[`/app/virtual-research/${STUDY_ID}/trial`]}>
    <Routes><Route path="/app/virtual-research/:studyId/:tab?" element={<VcrStudyPage />} /><Route path="/outside-study" element={<p>Outside the study</p>} /></Routes>
    <Navigation />
  </MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "让 AI 调整：方案 A" }));
  await screen.findByText(/请求已保留/);
  const provisional = JSON.parse(screen.getByTestId("provisional-state").textContent ?? "{}");
  expect(provisional).toEqual({ vcrPendingDraft: { version: 1, studyId: STUDY_ID, requestId: expect.any(String) } });
  await userEvent.click(screen.getByRole("button", { name: "Leave study" }));
  expect(screen.getByText("Outside the study")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Return through history" }));
  await screen.findByText(/请求已保留/);
  sessionId = "vcr-return-provisioned";
  await act(async () => { announceVcrStudyRefresh(STUDY_ID); });
  await waitFor(() => expect(pane.requests.at(-1)).toMatchObject({ projectId: "prj_ev201", sessionId }));
  const state = JSON.parse(screen.getByTestId("provisional-state").textContent ?? "{}");
  expect(state).not.toHaveProperty("vcrPendingDraft");
  const intent = expectOpaqueRuntimeUiIntent(state, "prj_ev201");
  expect(intent.draft).toMatch(/^调整试验方案/);
  expect(intent.sessionId).toBe(sessionId);
  expect(pendingRuntimeUiIntent("prj_ev201", sessionId)).toEqual(intent);
});

it.each(["new document", "new account"])("shows a generic recovery prompt after a %s cannot resolve a provisional marker", async (boundary) => {
  const sessionId = `vcr-${boundary.replace(" ", "-")}`;
  installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: studyWith(null, study => {
    study.conversation = { sessionId, exists: true };
  }) });
  const oldText = "Previous account private provisional draft";
  const marker = boundary === "new account"
    ? prepareVcrPendingDraft(STUDY_ID, "prj_ev201", { draft: oldText, restoreDraft: false })
    : { version: 1, studyId: STUDY_ID, requestId: "old-document-marker" };
  if (boundary === "new account") window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT));
  render(<MemoryRouter initialEntries={[{
    pathname: `/app/virtual-research/${STUDY_ID}/chat`, search: "?result=trial", state: { vcrPendingDraft: marker },
  }]}><Routes><Route path="/app/virtual-research/:studyId/:tab?" element={<VcrStudyPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByText("先前等待连接的草稿未恢复。请重新输入。")).toBeVisible();
  expect(screen.queryByText(oldText)).not.toBeInTheDocument();
  expect(pendingRuntimeUiIntent("prj_ev201", sessionId)).toBeNull();
});
