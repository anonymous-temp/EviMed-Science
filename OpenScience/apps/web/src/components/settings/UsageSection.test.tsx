import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageSection } from "./UsageSection";
const mocks = vi.hoisted(() => ({ allowance: vi.fn(), statements: vi.fn(), usage: vi.fn(), operator: false }));
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<typeof import("@/lib/apiClient")>()), fetchWebResearchAllowance: mocks.allowance, fetchWebResearchStatements: mocks.statements, fetchWebAccountUsage: mocks.usage }));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => mocks.operator }));
const allowance = { enabled: true, status: "ready", available: 20, held: null, month: { since: "2026-10-01", paid: 0.004, pending: 1.23 }, commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null } };
const settled = { id: "s1", runId: "run1", title: "文献研究", at: "2026-10-01", status: "settled", amount: 0.004 };
function open() { return render(<MemoryRouter><UsageSection /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.operator = false;
  mocks.allowance.mockResolvedValue(allowance);
  mocks.statements.mockResolvedValue({ items: [settled, { ...settled, id: "s2", title: "进行中的研究", status: "pending", amount: 99 }], nextCursor: null });
  mocks.usage.mockResolvedValue({ cost: 120 });
});
describe("research allowance", () => {
  it("separates tiny confirmed charges, pending and supplier charges", async () => {
    open(); expect(await screen.findByText("¥20.00")).toBeInTheDocument();
    expect(screen.queryByText("占用额度")).not.toBeInTheDocument();
    expect(screen.getByText("本月待结算")).toBeInTheDocument();
    expect(screen.getByText("¥1.23")).toBeInTheDocument();
    const rows = within(await screen.findByRole("list", { name: "研究消费记录" })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("不足 ¥0.01")).toBeInTheDocument();
    expect(within(rows[1]).getByText("待结算")).toBeInTheDocument();
    expect(screen.queryByText("¥99.00")).not.toBeInTheDocument(); expect(mocks.usage).not.toHaveBeenCalled();
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
  it("retries initial errors without showing zero", async () => {
    mocks.allowance.mockRejectedValueOnce(new Error("network")); open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("¥20.00")).toBeInTheDocument();
  });
  it("shows loading and empty states", async () => {
    mocks.allowance.mockReturnValueOnce(new Promise(() => {})); const view = open();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument(); view.unmount();
    mocks.allowance.mockResolvedValue(allowance); mocks.statements.mockResolvedValue({ items: [], nextCursor: null });
    open(); expect(await screen.findByText("还没有研究消费记录")).toBeInTheDocument();
  });
  it.each([["disabled", "科研额度尚未启用"], ["unlinked", "尚未关联科研额度账户"], ["unavailable", "科研额度暂不可用"]])("states %s honestly", async (status, copy) => {
    mocks.allowance.mockResolvedValue({ ...allowance, enabled: false, status }); open();
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
  it("labels operator supplier costs", async () => {
    mocks.operator = true; open(); expect(await screen.findByText("¥120.00")).toBeInTheDocument(); expect(screen.getByText("平台运行成本")).toBeInTheDocument();
  });
});
