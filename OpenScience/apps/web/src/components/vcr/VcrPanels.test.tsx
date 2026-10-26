import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy } from "@/lib/vcrClient";
import { cpuTimeText, VcrBudgetDialog } from "./VcrBudgetDialog";
import { VcrModelRecord } from "./VcrModelRecord";
import { runFilePath, VcrPackageReader } from "./VcrPackageReader";
import { VcrPrecedentsPanel } from "./VcrPrecedentsPanel";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";
import { fakeRoom, ToolbarSlotFrame } from "./__fixtures__/tabFrame";

// Only the network is doubled; every payload is the server's own fixture, or
// a copy of one with one field changed.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const draw = (node: React.ReactElement) => render(<MemoryRouter><ToolbarSlotFrame>{node}</ToolbarSlotFrame></MemoryRouter>);
const off = () => { throw new WebApiError("off", { status: 404, code: "vcr_not_enabled" }); };

let server: ReturnType<typeof installVcrServer>;
let restoreRoom: () => void;

beforeEach(() => {
  restoreRoom = fakeRoom();
  server = installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(() => restoreRoom());

/* ------------------------------------------------------------------ 参考试验 */

describe("参考试验", () => {
  it("keeps planned and actual apart, and opens a row to the registry's own words", async () => {
    draw(<VcrPrecedentsPanel />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-precedent='CTR20990001']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(screen.getByRole("columnheader", { name: "计划入组" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "实际入组" })).toBeInTheDocument();
    expect(row).toHaveTextContent("420");
    expect(row).toHaveTextContent("426");
    // The registry number is the keyboard's way into the record; the record is a drawer, as every record is.
    await userEvent.click(within(row).getByRole("button", { name: "打开 CTR20990001 的登记记录" }));
    const opened = (await screen.findByRole("dialog", { name: "CTR20990001" })).querySelector("[data-vcr-precedent-detail='CTR20990001']") as HTMLElement;
    expect(within(opened).getByText("中国")).toBeInTheDocument();
    expect(within(opened).getByText("多西他赛")).toBeInTheDocument();
    expect(within(opened).getByText("无进展生存期（PFS）")).toBeInTheDocument();
    expect(within(opened).getByText("入组人数").nextElementSibling).toHaveTextContent("实际");
    // The eligibility as written, beside the population it was reduced to.
    expect(within(opened).getByText("人群（标准化）").nextElementSibling).toHaveTextContent("非小细胞肺癌");
    expect(opened.querySelector("[data-vcr-eligibility-text]")).toHaveTextContent("组织学或细胞学确诊的晚期 NSCLC；一线含铂化疗后进展。");
    expect(within(opened).getByRole("link", { name: /打开登记记录/ })).toHaveAttribute("href", "https://example.org/CTR20990001");
  });

  it("says a trial's design in words — 「3 期 · 随机 · 开放」 — and never as the registry's enumerations", async () => {
    draw(<VcrPrecedentsPanel />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-precedent='CTR20990001']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row).toHaveTextContent("3 期 · 随机 · 开放");
    expect(document.body.textContent).not.toMatch(/PHASE\d|RANDOMIZED|QUADRUPLE/);
  });

  it("puts the search and the precedents first and the registries' coverage one click under them, summed up in a phrase that counts", async () => {
    const payload = fixture("ev201/precedents.json");
    payload.registryCoverage = [
      { key: "ctgov", label: "ClinicalTrials.gov", configured: true, coverage: "structured", availability: "available", reason: null, lastCheckedAt: null },
      { key: "ctis", label: "EU CTIS", configured: true, coverage: "structured", availability: "not_queried", reason: null, lastCheckedAt: null },
      { key: "chictr", label: "ChiCTR", configured: false, coverage: "list_only", availability: "unavailable", reason: "registry_not_configured", lastCheckedAt: null },
      { key: "ictrp", label: "WHO ICTRP", configured: false, coverage: "unsupported", availability: "unavailable", reason: "registry_terms_forbid_commercial_use", lastCheckedAt: null },
    ];
    installVcrServer(network.productRequest, { "GET /vcr/precedents": payload });
    const { container } = draw(<VcrPrecedentsPanel />);
    const table = await screen.findByRole("table", { name: "参考试验" });
    const summary = await screen.findByText("注册源覆盖");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("2 个来源可查，2 个仅列表或未接入")).toBeInTheDocument();
    // Order: the search, the table, then the coverage.
    const order = [screen.getByLabelText("搜索登记试验"), table, details];
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The commercial-use limit is one click away, and is not read as 「没有记录」.
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText(/使用条款禁止商业使用/)).toBeInTheDocument();
    // The Disclosure names the block once: the coverage's own heading is not repeated inside it.
    expect(container.querySelectorAll("h3")).toHaveLength(0);
  });

  it("draws no coverage block where the server sent none", async () => {
    draw(<VcrPrecedentsPanel />);
    await screen.findByRole("table", { name: "参考试验" });
    expect(screen.queryByText("注册源覆盖")).toBeNull();
  });

  it("is the shared table, whose scroller is a named region a keyboard can reach once it overflows (held by the table's own tests), and whose rows open a record", async () => {
    draw(<VcrPrecedentsPanel />);
    const table = await screen.findByRole("table", { name: "参考试验" });
    expect(table.closest("[data-row-open], table")).not.toBeNull();
    expect(document.querySelector("tr[data-row-open]")).not.toBeNull();
  });

  it("never links a source that is not an http(s) address", async () => {
    const payload = fixture("ev201/precedents.json");
    payload.precedents[0].source = "javascript:alert(1)";
    server = installVcrServer(network.productRequest, { "GET /vcr/precedents": payload });
    draw(<VcrPrecedentsPanel />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-precedent='CTR20990001']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(row).getByRole("button", { name: "打开 CTR20990001 的登记记录" }));
    expect(await screen.findByRole("dialog", { name: "CTR20990001" })).toHaveTextContent("中国");
    expect(screen.queryByRole("link", { name: /打开登记记录/ })).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
  });

  // CW-12: `q` is the server's query word.
  it("asks the server with q= on Enter", async () => {
    draw(<VcrPrecedentsPanel />);
    await waitFor(() => expect(document.querySelector("[data-vcr-precedent]")).not.toBeNull());
    await userEvent.type(screen.getByLabelText("搜索登记试验"), "多西他赛{Enter}");
    await waitFor(() => expect(server.calls.some((call) => new URL(call.path, "http://x").searchParams.get("q") === "多西他赛")).toBe(true));
  });

  // A library that is not composed here is not an empty one.
  it("says the library is not here, in the server's words, with no table that reads as 「没有先例」", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/precedents": fixture("ev201/precedents-unavailable.json") });
    draw(<VcrPrecedentsPanel />);
    expect(await screen.findByText("参考试验库在本部署尚未接入。")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/没有找到先例|还没有先例/)).toBeNull();
    expect(screen.queryByText("0 项")).toBeNull();
  });

  it("is the module-off sentence when the module is off", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/precedents": off });
    draw(<VcrPrecedentsPanel />);
    expect(await screen.findByText("虚拟临床研究还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ the package */

describe("the package reader", () => {
  it("prints the cover — the intended use and the seal, with no review state — then the sections, the contents and the file", async () => {
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "研究包 v1" })).toBeInTheDocument();
    expect(screen.getByText("预期用途")).toBeInTheDocument();
    expect(screen.getByText("结局封存")).toBeInTheDocument();
    expect(screen.queryByText(/已复核|未复核|复核后有变更/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /研究与分析概要/ })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "研究包目录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开完整研究包" })).toHaveAttribute("href", "/app/runs/run_12/files/package.pdf");
  });

  // CW-16: a reader with no body promises no numbers to click.
  it("with no sections is the cover and the file, and claims nothing about numbers", async () => {
    const payload = fixture("ev201/export.json");
    payload.document.sections = [];
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/export/exp_2`]: payload });
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "研究包 v1" })).toBeInTheDocument();
    expect(screen.getByText("预期用途")).toBeInTheDocument();
    expect(screen.queryByText(/点开任何一个数字/)).toBeNull();
    expect(screen.queryByRole("navigation", { name: "研究包目录" })).toBeNull();
    expect(screen.getByRole("link", { name: "打开完整研究包" })).toBeInTheDocument();
  });

  it("encodes every segment of the file's path, and drops segments that climb", () => {
    expect(runFilePath("run 1", "out dir/研究包 v1.pdf")).toBe(`/app/runs/run%201/files/out%20dir/${encodeURIComponent("研究包 v1.pdf")}`);
    expect(runFilePath("run_1", "../../admin/x?y#z")).toBe("/app/runs/run_1/files/admin/x%3Fy%23z");
  });
});

/* ------------------------------------------------------------------ the budget */

describe("the compute budget", () => {
  const ev201 = () => readVcrStudy(fixture("ev201/study.json"));
  const dialog = (onSaved = vi.fn()) => {
    const study = ev201();
    draw(<VcrBudgetDialog studyId={STUDY_ID} budget={study.budget} jobs={study.jobs} onClose={() => undefined} onSaved={onSaved} />);
    return screen.getByRole("dialog", { name: "计算预算" });
  };

  it("says CPU time in the unit a reader reads", () => {
    expect(cpuTimeText(45)).toBe("45 秒");
    expect(cpuTimeText(222)).toBe("4 分钟");
    expect(cpuTimeText(7_200)).toBe("2 小时");
    expect(cpuTimeText(9_000)).toBe("2.5 小时");
    expect(cpuTimeText(null)).toBe("—");
  });

  it("shows used, what running work has reserved and the limit in time, and the job that waits with what it needs — never money", () => {
    const panel = dialog();
    for (const [label, value] of [["已用", "4 分钟"], ["运行中预留", "0 秒"], ["上限", "2 小时"]]) {
      expect(within(panel).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(panel.querySelector("[data-vcr-budget-job='job_seed_17']")).toHaveTextContent("设计网格需要 2.5 小时 CPU 时间");
    expect(panel.textContent).not.toMatch(/¥|元/);
    // UI-27: no paragraph explaining the budget.
    expect(panel.textContent).not.toMatch(/不会被静默降级/);
  });

  it("releases one job by its id, all of them by the time they need, and adds time in minutes", async () => {
    const onSaved = vi.fn();
    const panel = dialog(onSaved);
    const row = panel.querySelector("[data-vcr-budget-job='job_seed_17']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await userEvent.click(within(panel).getByRole("button", { name: "全部确认" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    await userEvent.type(within(panel).getByLabelText("增加计算时间（分钟）"), "30");
    await userEvent.click(within(panel).getByRole("button", { name: "增加" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(3));
    expect(server.calls.map((call) => call.body)).toEqual([{ jobId: "job_seed_17" }, { cpuSeconds: 9000 }, { cpuSeconds: 1800 }]);
    expect(server.calls.every((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/budget`)).toBe(true);
  });

  it("sends one confirmation however often it is pressed while the first is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/budget`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    const panel = dialog();
    const all = within(panel).getByRole("button", { name: "全部确认" });
    await userEvent.click(all);
    await userEvent.click(all);
    await userEvent.click(within(panel.querySelector("[data-vcr-budget-job='job_seed_17']") as HTMLElement).getByRole("button"));
    expect(server.calls).toHaveLength(1);
    await act(async () => { finish({ released: [], budget: null }); });
  });
});

it("names source inputs in human terms and distinguishes original percentages from computation proportions", async () => {
  const payload = fixture("ev201/models.json"); payload.models[0].inputs = ["研究设计人数", "truth.controlRate（%）"];
  payload.models[0].revisionCard = { parameterBindings: [{ field: "truth.controlRate", value: 30, mappedValue: 0.3, unit: "%", quote: "Control response was 30%.", quoteStart: 10, quoteEnd: 34, sourceId: "src_original", textSha256: "a".repeat(64) }] };
  installVcrServer(network.productRequest, { "GET /vcr/models": payload }); draw(<VcrModelRecord model={payload.models[0]} />);
  const table = await screen.findByRole("table", { name: "文献参数与来源" }); expect(table).toHaveTextContent("30 %"); expect(table).toHaveTextContent("0.3 比例（0–1）");
  expect(document.body.textContent).not.toContain("truth.controlRate（%）"); expect(document.body.textContent).toContain("对照发生率（计算单位：比例（0–1））");
});
