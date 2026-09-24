import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { UsageSection } from "./UsageSection";

const mocks = vi.hoisted(() => ({
  fetchWebAccountUsage: vi.fn(),
  fetchWebAccountUsageRuns: vi.fn(),
  lastWebUsageBudgetRefusal: vi.fn(),
  operator: false,
}));

// The error dictionary and the ceiling sentence live in this module and the
// code under test calls them, so the real exports come through.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebAccountUsage: mocks.fetchWebAccountUsage,
  fetchWebAccountUsageRuns: mocks.fetchWebAccountUsageRuns,
  lastWebUsageBudgetRefusal: mocks.lastWebUsageBudgetRefusal,
}));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => mocks.operator }));

const summary = {
  since: "2026-09-01T00:00:00.000Z",
  calls: 9040,
  cost: 116.9612,
  currency: "CNY",
  promptTokens: 1_300_914_220,
  completionTokens: 89_012,
  unpricedCalls: 0,
  byModel: [{ model: "deepseek-v4-pro", calls: 9040, cost: 116.9612 }],
  uncertainCalls: 161,
  uncertainCost: 12.5,
};

const runs = {
  since: "2026-09-01T00:00:00.000Z",
  currency: "CNY",
  items: [
    { runId: "run_b", projectId: "default", title: "中医药治疗儿童疳证的 Meta 分析检索", at: "2026-09-22T02:00:00.000Z", cost: 4.81, calls: 171, inputTokens: 40_100_000, outputTokens: 90_000 },
    { runId: "run_a", projectId: "paper", title: null, at: "2026-09-12T02:00:00.000Z", cost: 0.004, calls: 3, inputTokens: 1_000, outputTokens: 100 },
  ],
  other: { calls: 40, cost: 1.23 },
};

function open() {
  return render(<MemoryRouter><UsageSection /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operator = false;
  mocks.fetchWebAccountUsage.mockResolvedValue(summary);
  mocks.fetchWebAccountUsageRuns.mockResolvedValue(runs);
  mocks.lastWebUsageBudgetRefusal.mockReturnValue(null);
});

describe("用量", () => {
  it("is one number, the month and its calls, and 「明细」 — no tokens, no paragraph about the ledger", async () => {
    open();
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
    expect(screen.getByText("9 月 · 9,040 次模型调用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "明细" })).toBeInTheDocument();
    expect(screen.queryByText(/token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/1,300,914,220/)).not.toBeInTheDocument();
    for (const gone of [/不是账单/, /回答结束前中断/, /按模型供应商价目折算/, /deepseek-v4-pro/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("opens the detail: one row per research run — date, conversation, cost — and 其他", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "明细" }));
    const list = await screen.findByRole("list", { name: "本月用量明细" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("9月22日")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "中医药治疗儿童疳证的 Meta 分析检索" })).toHaveAttribute("href", "/app/runs?run=run_b");
    expect(within(rows[0]).getByText("¥4.81")).toBeInTheDocument();
    expect(within(rows[1]).getByText("未命名的研究")).toBeInTheDocument();
    expect(within(rows[1]).getByText("不足 ¥0.01")).toBeInTheDocument();
    expect(within(rows[2]).getByText("其他")).toBeInTheDocument();
    expect(within(rows[2]).getByText("¥1.23")).toBeInTheDocument();
    // Tokens are an operator's; the unreported calls are one small line at the foot.
    expect(screen.queryByText(/token/)).not.toBeInTheDocument();
    expect(screen.getByText("另有 161 次调用未回报用量，未计入金额。")).toHaveClass("text-caption");
    await user.click(screen.getByRole("button", { name: "本月用量" }));
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
  });

  it("shows an operator the tokens and the per-model split", async () => {
    const user = userEvent.setup();
    mocks.operator = true;
    open();
    expect(await screen.findByText("deepseek-v4-pro")).toBeInTheDocument();
    expect(screen.getByText("1,300,914,220 / 89,012 token")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "明细" }));
    expect(await screen.findByText("171 次调用 · 读入 40,100,000 · 生成 90,000 token")).toBeInTheDocument();
  });

  it("says one sentence when the month has no spend", async () => {
    const user = userEvent.setup();
    mocks.fetchWebAccountUsage.mockResolvedValue({ ...summary, calls: 0, cost: 0, byModel: [], uncertainCalls: 0 });
    mocks.fetchWebAccountUsageRuns.mockResolvedValue({ ...runs, items: [], other: { calls: 0, cost: 0 } });
    open();
    expect(await screen.findByText("9 月 · 还没有模型调用")).toBeInTheDocument();
    expect(screen.getByText("¥0.00")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "明细" }));
    expect(await screen.findByText("本月还没有用量")).toBeInTheDocument();
  });

  it("reports a read failure instead of showing zero usage", async () => {
    mocks.fetchWebAccountUsage.mockRejectedValue(new WebApiError("HTTP 503", { status: 503, code: "runtime_unavailable" }));
    open();
    expect(await screen.findByText(/读取用量失败：运行时出现问题，稍后重试。/)).toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });

  // The ledger measures spend over rolling 24-hour and 7-day windows, so
  // nothing resets at midnight or on Monday: the ceiling is said in the
  // dictionary's own words, never as a reset time.
  it.each([
    ["day", "近 24 小时额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。"],
    ["week", "近 7 天额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。"],
    ["run", "单次任务额度已达上限：上限 12.00 CNY，已占用 12.40 CNY，本次请求还需 0.30 CNY。"],
  ] as const)("names the %s ceiling a request was refused at, and no reset", async (window, sentence) => {
    mocks.lastWebUsageBudgetRefusal.mockReturnValue({
      window, limit: 12, committed: 12.4, requested: 0.3, currency: "CNY", observedAt: "2026-09-07T02:30:00.000Z",
    });
    open();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText(/次日重置|明天|每周一|本周额度|今日额度|记录于/)).not.toBeInTheDocument();
  });
});
