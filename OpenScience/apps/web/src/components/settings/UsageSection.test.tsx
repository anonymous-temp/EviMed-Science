import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { forgetResearchBilling } from "@/lib/useResearchBilling";
import { UsageSection } from "./UsageSection";

const mocks = vi.hoisted(() => ({
  allowance: vi.fn(), statements: vi.fn(), usage: vi.fn(), runs: vi.fn(), refusal: vi.fn(), operator: false,
}));
// The error dictionary and the ceiling sentence live in this module and the
// code under test calls them, so the real exports come through.
vi.mock("@/lib/apiClient", async (original) => ({
  ...(await original<typeof import("@/lib/apiClient")>()),
  fetchWebResearchAllowance: mocks.allowance,
  fetchWebResearchStatements: mocks.statements,
  fetchWebAccountUsage: mocks.usage,
  fetchWebAccountUsageRuns: mocks.runs,
  lastWebUsageBudgetRefusal: mocks.refusal,
}));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => mocks.operator }));

/** `/api/account/allowance` on a deployment that does not bill research — every deployment today — as the server writes it. */
const off = {
  enabled: false, currency: "CNY", status: "disabled", available: null, held: null, balances: null, membership: null,
  month: { since: "2026-10-01T00:00:00.000Z", paid: 0, pending: 0 },
  commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null },
};
/** …and on one that does. */
const allowance = { enabled: true, status: "ready", available: 20, held: null, month: { since: "2026-10-01", paid: 0.004, pending: 1.23 }, commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null } };
const settled = { id: "s1", runId: "run1", title: "文献研究", at: "2026-10-01", status: "settled", amount: 0.004 };

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

function open() { return render(<MemoryRouter><UsageSection /></MemoryRouter>); }

beforeEach(() => {
  for (const mock of [mocks.allowance, mocks.statements, mocks.usage, mocks.runs, mocks.refusal]) mock.mockReset();
  forgetResearchBilling(); mocks.operator = false;
  mocks.allowance.mockResolvedValue(off);
  mocks.statements.mockResolvedValue({ items: [settled, { ...settled, id: "s2", title: "进行中的研究", status: "pending", amount: 99 }], nextCursor: null });
  mocks.usage.mockResolvedValue(summary);
  mocks.runs.mockResolvedValue(runs);
  mocks.refusal.mockReturnValue(null);
});

/** Everything the allowance page says: a deployment without billing must show none of it, and no placeholder row for what does not exist. */
function expectNoResearchBilling() {
  for (const gone of [/科研额度/, /充值/, /会员/, /订单/, /退款/, /尚未开放/, /尚未启用/, /尚未关联/, /研究消费/, /平台运行成本/]) {
    expect(screen.queryAllByText(gone)).toEqual([]);
  }
}

describe("用量 on a deployment without research billing", () => {
  it("is the month's usage and 「明细」, with no word of research billing", async () => {
    open();
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "本月用量" })).toBeInTheDocument();
    expect(screen.getByText("9 月 · 9,040 次模型调用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "明细" })).toBeInTheDocument();
    // 「科研额度尚未启用」 and four 「尚未开放」 rows, for things that do not exist, were the regression.
    expectNoResearchBilling();
    expect(screen.queryByRole("heading", { name: "科研额度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "充值与会员" })).not.toBeInTheDocument();
    // The allowance's statements are not this page's data, and the detail is read only when asked for.
    expect(mocks.statements).not.toHaveBeenCalled();
    expect(mocks.runs).not.toHaveBeenCalled();
    // No tokens, no paragraph about the ledger.
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
    expectNoResearchBilling();
    await user.click(screen.getByRole("button", { name: "本月用量" }));
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
  });

  it("shows an operator the per-model split in calls and money, and not the allowance page's supplier-cost panel", async () => {
    const user = userEvent.setup();
    mocks.operator = true;
    open();
    expect(await screen.findByText("deepseek-v4-pro")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "模型调用" })).toBeInTheDocument();
    expect(screen.getByText("9040 次 · ¥116.96")).toBeInTheDocument();
    expect(screen.queryByText(/token/)).not.toBeInTheDocument();
    expectNoResearchBilling();
    // One read of the month's usage: the supplier-cost panel would have been a second.
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "明细" }));
    expect(await screen.findByText("171 次调用")).toBeInTheDocument();
    expect(screen.queryByText(/token/)).not.toBeInTheDocument();
  });

  it("says one sentence when the month has no spend", async () => {
    const user = userEvent.setup();
    mocks.usage.mockResolvedValue({ ...summary, calls: 0, cost: 0, byModel: [], uncertainCalls: 0 });
    mocks.runs.mockResolvedValue({ ...runs, items: [], other: { calls: 0, cost: 0 } });
    open();
    expect(await screen.findByText("9 月 · 还没有模型调用")).toBeInTheDocument();
    expect(screen.getByText("¥0.00")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "明细" }));
    expect(await screen.findByText("本月还没有用量")).toBeInTheDocument();
  });

  it("reports a read failure instead of showing zero usage", async () => {
    mocks.usage.mockRejectedValue(new WebApiError("HTTP 503", { status: 503, code: "runtime_unavailable" }));
    open();
    expect(await screen.findByText(/无法读取用量：运行时出现问题，稍后重试。/)).toBeInTheDocument();
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
    mocks.refusal.mockReturnValue({
      window, limit: 12, committed: 12.4, requested: 0.3, currency: "CNY", observedAt: "2026-09-07T02:30:00.000Z",
    });
    open();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByText(sentence)).toHaveAttribute("role", "status");
    expect(screen.queryByText(/次日重置|明天|每周一|本周额度|今日额度|记录于/)).not.toBeInTheDocument();
  });

  it("is not held up by another read of the allowance when it is opened again", async () => {
    const first = open();
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
    first.unmount();
    open();
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
    // The deployment's setting is final for the page, so the answer is asked for once.
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
  });
});

describe("科研额度 on a deployment that bills research", () => {
  beforeEach(() => {
    mocks.allowance.mockResolvedValue(allowance);
    // What the supplier-cost panel reads: a figure of its own, not the usage page's.
    mocks.usage.mockResolvedValue({ ...summary, cost: 120 });
  });

  it("separates tiny confirmed charges, pending and supplier charges", async () => {
    open(); expect(await screen.findByText("¥20.00")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "科研额度" })).toBeInTheDocument();
    expect(screen.queryByText("占用额度")).not.toBeInTheDocument();
    expect(screen.getByText("本月待结算")).toBeInTheDocument();
    expect(screen.getByText("¥1.23")).toBeInTheDocument();
    const rows = within(await screen.findByRole("list", { name: "研究消费记录" })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("不足 ¥0.01")).toBeInTheDocument();
    expect(within(rows[1]).getByText("待结算")).toBeInTheDocument();
    expect(screen.queryByText("¥99.00")).not.toBeInTheDocument(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("is the allowance page, not the month's usage", async () => {
    open(); expect(await screen.findByText("¥20.00")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "本月用量" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "明细" })).not.toBeInTheDocument();
    expect(screen.queryByText(/次模型调用/)).not.toBeInTheDocument();
    expect(mocks.runs).not.toHaveBeenCalled(); expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("does not invent commerce or membership", async () => {
    open(); expect(await screen.findAllByText("尚未开放")).toHaveLength(4);
    expect(screen.queryByRole("link", { name: "查看充值" })).not.toBeInTheDocument();
    expect(screen.queryByText("会员额度")).not.toBeInTheDocument();
  });

  it("keeps confirmed monthly charges readable when the wallet is unavailable", async () => {
    mocks.allowance.mockResolvedValue({ ...allowance, status: "unavailable", available: null, month: { ...allowance.month, paid: 4.27 } });
    open(); expect(await screen.findByText("科研额度暂不可用")).toBeInTheDocument();
    expect(screen.getByText("¥4.27")).toBeInTheDocument();
    expect(screen.queryByText("¥20.00")).not.toBeInTheDocument();
  });

  it("uses configured HTTPS destinations only", async () => {
    mocks.allowance.mockResolvedValue({ ...allowance, commerce: { ...allowance.commerce, rechargeUrl: "https://account.example/recharge", ordersUrl: "javascript:alert(1)" } });
    open(); expect(await screen.findByRole("link", { name: "查看充值" })).toHaveAttribute("href", "https://account.example/recharge");
    expect(screen.getByRole("link", { name: "查看充值" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByRole("link", { name: "查看订单" })).not.toBeInTheDocument();
  });

  it("appends statements from the next cursor", async () => {
    mocks.statements.mockResolvedValueOnce({ items: [settled], nextCursor: "next" }).mockResolvedValueOnce({ items: [{ ...settled, id: "s3", title: "另一项研究", status: "waived" }], nextCursor: null });
    open(); await userEvent.setup().click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("另一项研究")).toBeInTheDocument(); expect(screen.getByText("文献研究")).toBeInTheDocument();
    expect(mocks.statements).toHaveBeenLastCalledWith("next");
  });

  it("shows an empty statement list", async () => {
    mocks.statements.mockResolvedValue({ items: [], nextCursor: null });
    open(); expect(await screen.findByText("还没有研究消费记录")).toBeInTheDocument();
  });

  // With billing on, `status` says how far this account's wallet is linked.
  it.each([["unlinked", "尚未关联科研额度账户"], ["unavailable", "科研额度暂不可用"]])("states %s honestly", async (status, copy) => {
    mocks.allowance.mockResolvedValue({ ...allowance, status }); open();
    expect(await screen.findByText(copy)).toBeInTheDocument(); expect(screen.queryByText("¥20.00")).not.toBeInTheDocument();
  });

  it("retries a failed later page without losing existing statements", async () => {
    mocks.statements.mockResolvedValueOnce({ items: [settled], nextCursor: "next" }).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ items: [{ ...settled, id: "s4", title: "恢复后的研究" }], nextCursor: null });
    open(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "加载更多" }));
    await user.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("恢复后的研究")).toBeInTheDocument();
    expect(screen.getByText("文献研究")).toBeInTheDocument();
    expect(mocks.statements).toHaveBeenLastCalledWith("next");
  });

  it("shows waived amounts without exposing pricing internals", async () => {
    mocks.statements.mockResolvedValue({ items: [{ ...settled, amount: 0, waivedCny: "0.04", pricingVersion: "legacy-v1", settlementPrecision: "legacy-integer-floor" }], nextCursor: null });
    open(); expect(await screen.findByText(/已减免 ¥0.04/)).toBeInTheDocument();
    expect(screen.queryByText(/legacy/)).not.toBeInTheDocument();
  });

  it("labels operator supplier costs, and has no per-model split of the month's usage", async () => {
    mocks.operator = true; open(); expect(await screen.findByText("¥120.00")).toBeInTheDocument(); expect(screen.getByText("平台运行成本")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "模型调用" })).not.toBeInTheDocument();
    expect(screen.queryByText("deepseek-v4-pro")).not.toBeInTheDocument();
  });

  // The numbers move, so opening the section reads them again; until they come
  // it is a skeleton, as it always was, and not last time's balance.
  it("reads the numbers again when it opens, with a skeleton until they come", async () => {
    const first = open(); expect(await screen.findByText("¥20.00")).toBeInTheDocument();
    first.unmount();
    let answer!: (value: object) => void;
    mocks.allowance.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { container } = open();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("¥20.00")).not.toBeInTheDocument();
    await act(async () => { answer({ ...allowance, available: 35 }); });
    expect(await screen.findByText("¥35.00")).toBeInTheDocument();
    expect(screen.queryByText("¥20.00")).not.toBeInTheDocument();
    expect(mocks.allowance).toHaveBeenCalledTimes(2);
  });

  it("says so when the numbers cannot be read again, rather than showing the ones it held", async () => {
    const first = open(); expect(await screen.findByText("¥20.00")).toBeInTheDocument();
    first.unmount();
    mocks.allowance.mockRejectedValueOnce(new Error("network"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成，请重试。");
    expect(screen.queryByText("¥20.00")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("¥20.00")).toBeInTheDocument();
  });
});

describe("the section while the deployment's answer is read", () => {
  it("is a skeleton, and names neither usage nor billing, until the answer comes", async () => {
    mocks.operator = true;
    mocks.allowance.mockReturnValue(new Promise(() => {}));
    const { container } = open();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expectNoResearchBilling();
    // Neither page's data is read on a guess: an operator would see the wrong panel for a moment.
    expect(mocks.usage).not.toHaveBeenCalled(); expect(mocks.statements).not.toHaveBeenCalled();
  });

  it("reports a failed read with its retry, naming neither page, and shows no zero", async () => {
    mocks.operator = true;
    mocks.allowance.mockRejectedValueOnce(new Error("network")); open();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("操作未完成，请重试。");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    expectNoResearchBilling();
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("retries into the usage page when the deployment turns out not to bill", async () => {
    mocks.allowance.mockRejectedValueOnce(new Error("network")); open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("¥116.96")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "明细" })).toBeInTheDocument();
    expectNoResearchBilling();
  });

  it("retries into the allowance page when it does, without showing zero", async () => {
    mocks.allowance.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(allowance); open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("¥20.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "明细" })).not.toBeInTheDocument();
  });
});
