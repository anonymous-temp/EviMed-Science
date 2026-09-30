import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VCR_DEFERRED_SENTENCE } from "@/components/vcr/useVcrRun";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { VcrStudyPage } from "./VcrStudyPage";

// Only the network is doubled: the readers, the route functions and every
// component above them are the real ones, fed the server's own answers.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebMe: me.fetchWebMe,
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }, { id: "prj_empty" }], select: store.select, load: store.load }) },
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
  server = installVcrServer(network.productRequest);
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  toasts.success.mockReset();
  toasts.error.mockReset();
  store.select.mockClear();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("the study page's header", () => {
  it("carries the study's name, its data tier and — within its ceiling — the plain intended use", async () => {
    draw();
    expect(await heading()).toBeInTheDocument();
    expect(screen.getByText("T0 公开资料")).toBeInTheDocument();
    expect(screen.getByText("研究设计支持")).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-ceiling]")).toBeNull();
  });

  // UI-17: a study whose results cannot carry the use it asked for says both,
  // and says why.
  it("names a downgraded intended use as request → ceiling and opens the reasons", async () => {
    const study = fixture("ev201/study.json");
    study.intendedUse = "specified_analysis";
    study.ceiling = {
      ceiling: "design_support", requested: "specified_analysis", withinCeiling: false,
      reasons: [{ code: "model_tier", detail: "所用模型的可信度层级最多支持「研究设计支持」" }, { code: "review", detail: "关键假设还没有复核" }],
    };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    const tag = await screen.findByRole("button", { name: "指定研究分析 → 研究设计支持" });
    await userEvent.click(tag);
    const drawer = await screen.findByRole("dialog", { name: "预期用途" });
    expect(within(drawer).getByText("所用模型的可信度层级最多支持「研究设计支持」")).toBeInTheDocument();
    expect(within(drawer).getByText("关键假设还没有复核")).toBeInTheDocument();
  });

  it("draws the seven steps as one rail, each linking to the tab that holds its result", async () => {
    draw();
    const rail = await screen.findByRole("list", { name: "七步进度" });
    expect(within(rail).getAllByRole("listitem")).toHaveLength(7);
    expect(within(rail).getByText("4 张假设卡")).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: /证据/ })).toHaveAttribute("href", "/app/virtual-research/std_1/data");
  });

  // 2026-09-20 ruling: the study page grows no second composer.
  it("has no composer of its own: 对话 opens the study's conversation", async () => {
    draw();
    await heading();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /对话/ }));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_ev201", expect.any(Function)));
  });
});

describe("the seven tabs", () => {
  it("offers exactly the seven tabs the vocabulary names", async () => {
    draw();
    await heading();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["总览", "人群", "虚拟患者", "对照", "试验", "匹配与招募", "数据与证据"]);
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
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute("id", `vcr-tab-panel-tab-${tab}`);
    expect(errors).not.toHaveBeenCalledWith("VcrTabBoundary", expect.anything(), expect.anything());
  });

  // A payload a tab cannot read is an error card inside that tab; the header,
  // the rail and the other tabs stay where they are.
  it("keeps a tab that cannot read its payload inside the tab, with the header and rail still there", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const junk = { ...fixture("ev201/data.json"), headline: { overview: 5 } };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: junk });
    draw(`/app/virtual-research/${STUDY_ID}/data`);
    const panel = await waitFor(() => {
      const card = document.querySelector("#vcr-tab-panel [data-vcr-tab-error]");
      expect(card).not.toBeNull();
      return card!;
    });
    expect(panel).toHaveTextContent("这一页的内容暂时读不出来");
    expect(screen.getByRole("heading", { level: 1, name: STUDY_NAME })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "七步进度" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "人群" }));
    await waitFor(() => expect(document.querySelector("#vcr-tab-panel [data-vcr-tab-error]")).toBeNull());
  });
});

describe("the study page's addresses", () => {
  it("rewrites a step name to the tab that holds it, in place", async () => {
    draw(`/app/virtual-research/${STUDY_ID}/evidence`);
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
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
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
    expect(document.querySelector("[data-vcr-loading='study']")).not.toBeNull();
    await act(async () => { answer(fixture("empty/study.json")); });
    expect(await screen.findByRole("heading", { level: 1, name: "GLP-1 周制剂 III 期：样本量与脱落情景" })).toBeInTheDocument();
  });

  it("opens a package in the reader on the study's own address", async () => {
    draw(`/app/virtual-research/${STUDY_ID}?package=exp_2`);
    expect(await screen.findByRole("heading", { name: "研究包 v1" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "人群" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /返回研究/ }));
    expect(await screen.findByRole("tab", { name: "人群" })).toBeInTheDocument();
  });
});

describe("「运行」 and the second human stop", () => {
  it("lists what is running and what waits, with the budget line and its CPU time", async () => {
    draw();
    await heading();
    const strip = document.querySelector("[data-vcr-jobs]") as HTMLElement;
    expect(strip).not.toBeNull();
    const running = strip.querySelector("[data-vcr-job='job_seed_16']") as HTMLElement;
    expect(running).toHaveTextContent("方案的模拟运行");
    expect(running).toHaveTextContent("3 / 10");
    expect(running).toHaveTextContent("进行中");
    expect(strip.querySelector("[data-vcr-job='job_seed_17']")).toHaveTextContent("待确认预算");
    // A succeeded job is history, not something going on.
    expect(strip.querySelector("[data-vcr-job='job_seed_18']")).toBeNull();
    expect(within(strip).getByText("有 1 项计算等待预算确认 · 需 2.5 小时 CPU 时间")).toBeInTheDocument();
    // The budget is CPU time; there is no money anywhere on it.
    expect(strip.textContent).not.toMatch(/¥|元/);
  });

  it("confirms one waiting job with exactly its id, then re-reads the study", async () => {
    draw();
    await heading();
    await userEvent.click(screen.getByRole("button", { name: "确认预算" }));
    const dialog = await screen.findByRole("dialog", { name: "计算预算" });
    expect(within(dialog).getByText("4 分钟")).toBeInTheDocument();
    expect(within(dialog).getByText("10 分钟")).toBeInTheDocument();
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
    await openMenu("设定计算预算");
    const dialog = await screen.findByRole("dialog", { name: "计算预算" });
    await userEvent.click(within(dialog).getByRole("button", { name: "全部确认" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/budget", "POST", { cpuSeconds: 9000 }));
    expect(server.calls.filter((call) => call.path === "/vcr/studies/std_1/budget")).toHaveLength(1);
  });

  it("cancels a running job by its id and re-reads the study", async () => {
    draw();
    await heading();
    const row = document.querySelector("[data-vcr-job='job_seed_16']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/jobs/job_seed_16/cancel", "POST", {}));
    expect(toasts.success).toHaveBeenCalledWith("已取消。");
  });

  it("shows a job that did not finish with the reason it gave", async () => {
    const study = fixture("ev201/study.json");
    study.jobs[0] = { ...study.jobs[0], state: "failed", cancelable: false, error: { code: "vcr_engine_failed", message: "引擎在第 3 批重复时退出", partial: true } };
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: study });
    draw();
    await heading();
    const row = document.querySelector("[data-vcr-job='job_seed_18']") as HTMLElement;
    expect(row).toHaveTextContent("未完成");
    expect(row).toHaveTextContent("引擎在第 3 批重复时退出");
  });
});

describe("the 「⋯」 menu", () => {
  // CW-19: an export that could not start now stays on the page with its sentence.
  it("keeps a deferred export on the page, with the sentence", async () => {
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/export`]: { export: { id: "exp_9" }, sessionId: null, runId: null, deferred: "前一个运行还没结束" },
    });
    draw();
    await openMenu("导出研究包");
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/export", "POST", { kind: "study_package" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(VCR_DEFERRED_SENTENCE));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1");
    expect(store.select).not.toHaveBeenCalled();
  });

  it("opens the conversation of an export that did start", async () => {
    draw();
    await openMenu("导出 CDE 沟通交流资料包");
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/export", "POST", { kind: "cde_communication_pack" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
  });

  // CW-16: the pause toast says what the server did, nothing more.
  it("pauses the study and says only that", async () => {
    draw();
    await openMenu("暂停");
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1", "PATCH", { status: "paused" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已暂停。"));
  });

  // CW-10: the study leaves 虚拟临研; the project's conversations and files stay.
  it("asks before removing, says what is true about it, and removes once", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`DELETE /vcr/studies/${STUDY_ID}`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    draw();
    await openMenu("删除");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("研究会从虚拟临研移除；项目里的对话和文件仍在。")).toBeInTheDocument();
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

  it("offers the lead everything, the members entry included", async () => {
    draw();
    expect(await items()).toEqual(["导出研究包", "导出 CDE 沟通交流资料包", "设定计算预算", "成员与角色", "暂停", "删除"]);
  });

  it("offers a reader who only exports the two exports and nothing that changes the study", async () => {
    withAbilities(["read", "review_clinical", "export"]);
    draw();
    expect(await items()).toEqual(["导出研究包", "导出 CDE 沟通交流资料包"]);
  });

  it("keeps the budget, the status, the members and the deletion from a data manager, who is not the lead", async () => {
    withAbilities(["read", "write", "run", "manage_data", "read_patient_level"]);
    draw();
    await heading();
    // Nothing in the menu is theirs: no menu at all rather than an empty one.
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("shows a reader who cannot confirm the budget the line that jobs wait, and no button that would be refused", async () => {
    withAbilities(["read", "write", "run"]);
    draw();
    await heading();
    const line = document.querySelector("[data-vcr-budget-wait]") as HTMLElement;
    expect(line).toHaveTextContent("有 1 项计算等待预算确认");
    expect(within(line).queryByRole("button", { name: "确认预算" })).toBeNull();
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
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "删除" })).toBeDisabled());
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
      { userId: "owner_1", owner: true, roles: ["lead"], roleLabels: ["研究负责人"], invitedBy: null, createdAt: null },
      { userId: "u_stat", owner: false, roles: ["clinical_reviewer", "statistical_reviewer"], roleLabels: ["临床复核", "统计复核"], invitedBy: "owner_1", createdAt: "2026-09-20T00:00:00Z" },
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
    expect(within(stat).getByRole("button", { name: "移除 u_stat 的“临床复核”" })).toBeInTheDocument();
    expect(within(stat).getByRole("button", { name: "移除 u_stat 的“统计复核”" })).toBeInTheDocument();
  });

  // The route takes `{ userId, role }` and removes through `?role=`.
  it("adds an account with exactly { userId, role }", async () => {
    const dialog = await openMembers();
    await within(dialog).findByText("u_stat");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), " u_recruit ");
    await userEvent.selectOptions(within(dialog).getByLabelText("角色"), "recruiter");
    await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/members", "POST", { userId: "u_recruit", role: "recruiter" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已添加。"));
    expect(within(dialog).getByLabelText("成员账号 ID")).toHaveValue("");
  });

  it("takes an id the route would refuse as not addable, without asking it", async () => {
    const dialog = await openMembers();
    await within(dialog).findByText("u_stat");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), "a b/c");
    expect(within(dialog).getByRole("button", { name: "添加" })).toBeDisabled();
  });

  it("names the site a site member belongs to, from the study's own sites", async () => {
    const dialog = await openMembers();
    await within(dialog).findByText("u_stat");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), "u_site");
    await userEvent.selectOptions(within(dialog).getByLabelText("角色"), "site");
    const site = await within(dialog).findByLabelText("所属中心");
    expect(within(dialog).getByRole("button", { name: "添加" })).toBeDisabled();
    await waitFor(() => expect(within(site).getByRole("option", { name: "中心 01" })).toBeInTheDocument());
    await userEvent.selectOptions(site, "ste_01");
    await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/members", "POST",
      { userId: "u_site", role: "site", detail: { siteId: "ste_01" } }));
  });

  it("removes one role of one account through DELETE …/members/:userId?role=", async () => {
    const dialog = await openMembers();
    const stat = await waitFor(() => {
      const found = dialog.querySelector("[data-vcr-member='u_stat']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(stat).getByRole("button", { name: "移除 u_stat 的“统计复核”" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/members/u_stat?role=statistical_reviewer", "DELETE"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已移除。"));
  });

  it("says a refusal in the reader's words and keeps the list", async () => {
    const dialog = await openMembers({
      [`POST /vcr/studies/${STUDY_ID}/members`]: () => { throw new WebApiError("no", { status: 403, code: "vcr_forbidden" }); },
    });
    await within(dialog).findByText("u_stat");
    await userEvent.type(within(dialog).getByLabelText("成员账号 ID"), "u_x");
    await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(within(dialog).getByLabelText("成员账号 ID")).toHaveValue("u_x");
    expect(within(dialog).getByText("u_stat")).toBeInTheDocument();
  });
});
