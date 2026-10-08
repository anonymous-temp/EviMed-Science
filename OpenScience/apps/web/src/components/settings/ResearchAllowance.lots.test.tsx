import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIMULATED_WALLET_LABEL, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import type { WebResearchAllowance, WebResearchStatement, WebResearchStatementDetail } from "@/lib/apiClient";
import { allowanceText } from "./SimulatedAllowance";
import { ResearchAllowance } from "./ResearchAllowance";

const mocks = vi.hoisted(() => ({ statements: vi.fn(), detail: vi.fn(), usage: vi.fn(), operator: false }));
vi.mock("@/lib/apiClient", async (original) => ({
  ...(await original<typeof import("@/lib/apiClient")>()),
  fetchWebResearchStatements: mocks.statements,
  fetchWebResearchStatementDetail: mocks.detail,
  fetchWebAccountUsage: mocks.usage,
}));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => mocks.operator }));

/** `/api/account/allowance` from the platform's own wallet: 可用 = 充值 + 赠送 − 冻结, and the next gift to end. */
const lots: WebResearchAllowance = {
  enabled: true, simulated: true, currency: "CNY", status: "ready",
  available: "7.80000000", held: "1.50000000", balances: { purchased: "6.10000000", gifted: "3.20000000" },
  nextExpiry: { amount: "3.20000000", at: "2026-10-31T16:00:00.000Z" }, low: false, lowThreshold: 20, membership: null,
  month: { since: "2026-09-30T16:00:00.000Z", paid: 4.5, pending: 0 },
  commerce: {
    rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: null,
    ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: null,
  },
};

const line = (extra: Partial<WebResearchStatement> & Pick<WebResearchStatement, "id" | "title">): WebResearchStatement => ({
  runId: null, at: "2026-10-05T03:00:00.000Z", status: "settled", amount: "0.00000000", kind: "charge", simulated: true, ...extra,
});
const paid = line({ id: "research_1", runId: "run_1", title: "深度研究 · 司美格鲁肽减重 Meta 分析", amount: "6.42000000", requestedAmount: "6.42000000",
  paidBy: { gifted: "1.20000000", purchased: "5.22000000" }, balanceAfter: "7.80000000" });
const tiny = line({ id: "run_2", runId: "run_2", title: "快速问答", amount: "0.00430000", requestedAmount: "0.00430000", paidBy: { gifted: "0.00430000", purchased: "0.00000000" }, balanceAfter: "13.60000000" });
const absorbed = line({ id: "run_3", runId: "run_3", title: "文献综述", status: "absorbed", amount: "6.00000000", requestedAmount: "7.30000000", absorbed: "1.30000000",
  paidBy: { gifted: "5.00000000", purchased: "1.00000000" }, balanceAfter: "0.00000000" });
const failed = line({ id: "run_4", runId: "run_4", title: "药物安全分析", status: "waived", amount: "0.00000000", notChargedReason: "没有完成，不收费" });
const topUp = line({ id: "topup_1", title: "模拟充值", kind: "topup", amount: "100.00000000", balanceAfter: "120.00000000" });
const gift = line({ id: "grant_1", title: "模拟赠送 · 注册赠送", kind: "grant", amount: "20.00000000", sourceLabel: "注册赠送", source: "signup",
  expiresAt: "2026-11-04T16:00:00.000Z", balanceAfter: "20.00000000" });
const expired = line({ id: "expire_1", title: "模拟赠送到期 · 活动赠送", kind: "expire", amount: "17.50000000", balanceAfter: "50.00000000" });

function open(allowance: WebResearchAllowance) {
  return render(<MemoryRouter><ResearchAllowance allowance={allowance} /></MemoryRouter>);
}
/** The allowance group itself: 「充值」 is also the name of a commerce row further down. */
const header = () => {
  const found = screen.getByRole("heading", { name: "科研额度" }).closest("section");
  if (!found) throw new Error("no allowance group");
  return found;
};
/** One row of the allowance group — its label and the value beside it — by the label. */
function panelRow(label: string): HTMLElement {
  const found = within(header()).getByText(label).parentElement?.parentElement;
  if (!found) throw new Error(`no row labelled ${label}`);
  return found;
}
const rows = async () => within(await screen.findByRole("list", { name: "研究消费记录" })).getAllByRole("listitem");
const rowOf = async (title: string) => {
  const found = (await rows()).find((item) => within(item).queryByText(title));
  if (!found) throw new Error(`no statement line titled ${title}`);
  return found;
};

beforeEach(() => {
  mocks.statements.mockReset(); mocks.detail.mockReset(); mocks.usage.mockReset(); mocks.operator = false;
  mocks.statements.mockResolvedValue({ simulated: true, items: [expired, absorbed, failed, tiny, paid, topUp, gift], nextCursor: null });
});

describe("the allowance header on the platform's wallet", () => {
  it("shows 可用 with the 充值, 赠送 and 冻结 it is made of, and says 模拟 once — in the group's header, not on each row", async () => {
    open(lots);
    expect(within(panelRow("可用科研额度")).getByText("7.80 灵豆")).toBeInTheDocument();
    expect(within(header()).getByText("充值 ＋ 赠送 − 冻结")).toBeInTheDocument();
    for (const [label, amount] of [["可用科研额度", "7.80 灵豆"], ["充值", "6.10 灵豆"], ["赠送", "3.20 灵豆"], ["冻结", "1.50 灵豆"]] as const) {
      expect(within(panelRow(label)).getByText(amount), label).toBeInTheDocument();
      expect(within(panelRow(label)).queryByText(SIMULATED_WALLET_LABEL), label).not.toBeInTheDocument();
    }
    expect(within(header()).getAllByText(SIMULATED_WALLET_LABEL)).toHaveLength(1);
    await rows();
  });

  it("says in words which part of the gift ends next, and when", async () => {
    open(lots);
    // 24:00 Asia/Shanghai on 31 October is the end of that day, not the start of the next.
    expect(screen.getByText("其中 3.20 灵豆将于 10 月 31 日到期")).toBeInTheDocument();
    expect(screen.getByText("不会过期")).toBeInTheDocument();
    await rows();
  });

  it("draws what is held rounded down, and a small amount with its first two significant digits, never as 0.00", async () => {
    open({ ...lots, available: "12.34999999", balances: { purchased: "0.00430000", gifted: "12.34569999" }, held: "0.00000000", nextExpiry: null });
    expect(within(panelRow("可用科研额度")).getByText("12.34 灵豆")).toBeInTheDocument();
    expect(within(panelRow("充值")).getByText("0.0043 灵豆")).toBeInTheDocument();
    expect(within(panelRow("赠送")).getByText("12.34 灵豆")).toBeInTheDocument();
    expect(within(panelRow("冻结")).getByText("0.00 灵豆")).toBeInTheDocument();
    expect(screen.queryByText(/将于/)).not.toBeInTheDocument();
    await rows();
  });

  it("shows no 充值/赠送/冻结 breakdown for a wallet that says only one number", async () => {
    open({ ...lots, simulated: false, available: 120, held: null, balances: null, nextExpiry: null, low: null, lowThreshold: null });
    expect(within(panelRow("可用科研额度")).getByText("120.00 灵豆")).toBeInTheDocument();
    for (const gone of ["充值", "赠送", "冻结", "充值 ＋ 赠送 − 冻结"]) expect(within(header()).queryByText(gone)).not.toBeInTheDocument();
    mocks.statements.mockResolvedValue({ simulated: false, items: [], nextCursor: null });
  });

  it("keeps the nothing-available prompt for an allowance the control plane says is low", async () => {
    open({ ...lots, available: "0.00000000", balances: { purchased: "0.00000000", gifted: "0.00000000" }, held: "0.00000000", nextExpiry: null, low: true });
    expect(screen.getByRole("status")).toHaveTextContent("科研额度已用完，模拟充值后可以继续研究。");
    await rows();
  });
});

describe("the statement's lines", () => {
  it("a charge says its amount, which kind of 灵豆 paid, and the balance after", async () => {
    open(lots);
    const item = await rowOf("深度研究 · 司美格鲁肽减重 Meta 分析");
    expect(within(item).getByText("已结算")).toBeInTheDocument();
    expect(within(item).getByText("6.42 灵豆")).toBeInTheDocument();
    expect(item).toHaveTextContent("赠送 1.20 灵豆 ＋ 充值 5.22 灵豆");
    expect(item).toHaveTextContent("余额 7.80 灵豆");
    // The list says 「模拟」 once, in its header; a line of a list that is all simulated does not say it again.
    expect(within(item).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
  });

  it("a part that paid nothing is not listed, and a charge under a cent is not drawn as free", async () => {
    open(lots);
    const item = await rowOf("快速问答");
    expect(within(item).getByText("0.0043 灵豆")).toBeInTheDocument();
    expect(item).toHaveTextContent("赠送 0.0043 灵豆");
    expect(item).not.toHaveTextContent(/充值 \d/);
  });

  it("a charge the balance could not cover says the platform carried the rest, with the amount", async () => {
    open(lots);
    const item = await rowOf("文献综述");
    expect(within(item).getByText("平台承担")).toBeInTheDocument();
    expect(within(item).getByText("6.00 灵豆")).toBeInTheDocument();
    expect(item).toHaveTextContent("平台承担 1.30 灵豆");
    expect(item).toHaveTextContent("赠送 5.00 灵豆 ＋ 充值 1.00 灵豆");
  });

  it("a run that was not charged says so, with its reason in words, and shows no amount", async () => {
    open(lots);
    const item = await rowOf("药物安全分析");
    expect(within(item).getByText("未计费")).toBeInTheDocument();
    expect(item).toHaveTextContent("没有完成，不收费");
    expect(item).not.toHaveTextContent("灵豆");
    expect(within(item).queryByRole("button", { name: "查看明细" })).not.toBeInTheDocument();
  });

  it("the other lines: 充值, 赠送 with its source and the date it ends, and 到期", async () => {
    open(lots);
    const top = await rowOf("模拟充值");
    expect(top).toHaveTextContent("已入账");
    expect(within(top).getByText("+100.00 灵豆")).toBeInTheDocument();
    const given = await rowOf("模拟赠送 · 注册赠送");
    expect(within(given).getByText("+20.00 灵豆")).toBeInTheDocument();
    expect(given).toHaveTextContent("11 月 4 日到期");
    const ended = await rowOf("模拟赠送到期 · 活动赠送");
    expect(within(ended).getByText("已到期")).toBeInTheDocument();
    expect(within(ended).getByText("−17.50 灵豆")).toBeInTheDocument();
    expect(ended).toHaveTextContent("余额 50.00 灵豆");
  });

  it("a charge's detail opens in place, only when asked for, and is what the charge is made of", async () => {
    const detail: WebResearchStatementDetail = { ...paid, detail: {
      calls: 12, cacheHitTokens: "1500000", cacheMissTokens: "230000", outputTokens: "41000", priceVersions: ["deepseek-v4-flash-2026-10"],
      pricingVersion: "research-allowance-v2-20261005", walletContract: "precision-v1", amount: "6.42000000", requestedAmount: "6.42000000", absorbed: "0.00000000",
      lots: [{ kind: "gifted", source: "signup", expiresAt: null, amount: "1.20000000" }, { kind: "purchased", source: "topup", expiresAt: null, amount: "5.22000000" }],
    } };
    mocks.detail.mockResolvedValue(detail);
    open(lots);
    const item = await rowOf("深度研究 · 司美格鲁肽减重 Meta 分析");
    expect(mocks.detail).not.toHaveBeenCalled();
    const toggle = within(item).getByRole("button", { name: "查看明细" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(item).toHaveTextContent("12 次模型调用"));
    expect(mocks.detail).toHaveBeenCalledWith("research_1");
    expect(item).toHaveTextContent("命中缓存输入 1,500,000 · 未命中输入 230,000 · 输出 41,000 tokens");
    expect(item).toHaveTextContent("价目表 deepseek-v4-flash-2026-10 · 金额 6.42000000");
    expect(within(item).getByRole("button", { name: "收起明细" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.setup().click(within(item).getByRole("button", { name: "收起明细" }));
    expect(item).not.toHaveTextContent("次模型调用");
  });

  it("a detail that cannot be read says so in the row and nothing else on the page moves", async () => {
    mocks.detail.mockRejectedValue(new Error("down"));
    open(lots);
    const item = await rowOf("深度研究 · 司美格鲁肽减重 Meta 分析");
    await userEvent.setup().click(within(item).getByRole("button", { name: "查看明细" }));
    expect(await within(item).findByRole("alert")).toBeInTheDocument();
    expect(item).toHaveTextContent("6.42 灵豆");
  });
});

describe("the one display rule", () => {
  it("is shared with the server's sentences: the web and the domain draw an amount the same way", () => {
    expect(allowanceText("0.0043")).toBe("0.0043 灵豆");
    expect(allowanceText("12.349", "down")).toBe("12.34 灵豆");
    expect(allowanceText("12.345", "nearest")).toBe("12.35 灵豆");
    expect(allowanceText(0)).toBe("0.00 灵豆");
    expect(allowanceText(null)).toBe("");
    expect(allowanceText(undefined)).toBe("");
    expect(allowanceText("not an amount")).toBe("");
  });
});
