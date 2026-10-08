import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIMULATED_LOW_CREDITS, SIMULATED_WALLET_LABEL, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import type { WebResearchAllowance } from "@/lib/apiClient";
import { ResearchAllowance } from "./ResearchAllowance";

const mocks = vi.hoisted(() => ({ statements: vi.fn(), usage: vi.fn(), operator: false }));
vi.mock("@/lib/apiClient", async (original) => ({
  ...(await original<typeof import("@/lib/apiClient")>()),
  fetchWebResearchStatements: mocks.statements,
  fetchWebAccountUsage: mocks.usage,
}));
vi.mock("@/lib/useOperator", () => ({ useOperator: () => mocks.operator }));

/** `/api/account/allowance` on a deployment whose wallet is simulated, as the server writes it. */
const simulated: WebResearchAllowance = {
  enabled: true, simulated: true, currency: "CNY", status: "ready", available: 200, held: null, balances: null, membership: null,
  lowThreshold: SIMULATED_LOW_CREDITS,
  month: { since: "2026-10-01T00:00:00.000Z", paid: 4, pending: 2 },
  commerce: {
    rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: null,
    ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: null,
  },
};
/** The same account's answer from a wallet that is real: the same numbers, and no word of simulation. */
const real: WebResearchAllowance = {
  ...simulated, simulated: false, lowThreshold: null,
  commerce: { rechargeUrl: "https://account.example/recharge", membershipUrl: null, ordersUrl: null, refundsUrl: null },
};
/** …and when the simulated wallet's ledger cannot be read. */
const unreadable: WebResearchAllowance = {
  ...simulated, status: "unavailable", available: null, month: null,
  commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null },
};

const grant = { id: "grant_1", runId: null, title: "模拟初始额度", at: "2026-10-01T00:00:00.000Z", status: "settled", amount: 200, kind: "grant", simulated: true };
const topUp = { id: "req_1", runId: null, title: "模拟充值", at: "2026-10-03T00:00:00.000Z", status: "settled", amount: 100, kind: "topup", simulated: true };
const charge = { id: "run_1", runId: "run_1", title: "文献研究", at: "2026-10-02T00:00:00.000Z", status: "settled", amount: 4, kind: "charge", simulated: true };
/** A charge as a control plane older than the simulated wallet writes it: no `kind`, and no word of simulation. */
const silentCharge = { id: "run_0", runId: "run_0", title: "文献研究", at: "2026-10-02T00:00:00.000Z", status: "settled", amount: 4 };
/** A simulated allowance, used up, whose answer carries no threshold field at all. */
const thresholdMissing: WebResearchAllowance = { ...simulated, available: 0 };
delete thresholdMissing.lowThreshold;

/** Where the router is, so a link that is followed in place can be told from one that is not. */
function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function open(allowance: WebResearchAllowance) {
  return render(
    <MemoryRouter initialEntries={["/app/account?tab=usage"]}>
      <Routes>
        <Route path="/app/account" element={<ResearchAllowance allowance={allowance} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** One row of a settings group — its label and the value beside it — by the label. */
function row(label: string): HTMLElement {
  const found = screen.getByText(label).parentElement?.parentElement;
  if (!found) throw new Error(`no row labelled ${label}`);
  return found;
}
/** Every mark on the page: the tags that read exactly 「模拟」. */
const marks = () => screen.queryAllByText(SIMULATED_WALLET_LABEL);
const statementRows = async () => within(await screen.findByRole("list", { name: "研究消费记录" })).getAllByRole("listitem");

beforeEach(() => {
  mocks.statements.mockReset(); mocks.usage.mockReset(); mocks.operator = false;
  mocks.statements.mockResolvedValue({ simulated: true, items: [topUp, charge, grant], nextCursor: null });
});

describe("科研额度 on a deployment whose wallet is simulated", () => {
  it("opens with the line that says so, above everything else", async () => {
    open(simulated);
    const line = screen.getByText("模拟数据，不涉及真实资金");
    expect(line).toHaveClass("text-warn-strong");
    expect(line.compareDocumentPosition(screen.getByRole("heading", { name: "科研额度" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await statementRows();
  });

  // Eleven tags on one screen read as a warning, not as a label. The group says it once; its amounts are covered by it.
  it("marks the allowance once, in the header of the group that holds its amounts, and not on each row", async () => {
    open(simulated);
    const group = screen.getByRole("heading", { name: "科研额度" }).closest("section") as HTMLElement;
    expect(within(group).getAllByText(SIMULATED_WALLET_LABEL)).toHaveLength(1);
    expect(within(group.querySelector("h2")!.parentElement as HTMLElement).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    for (const [label, amount] of [["可用科研额度", "200.00 灵豆"], ["本月研究消费", "4.00 灵豆"], ["本月待结算", "2.00 灵豆"]] as const) {
      expect(within(row(label)).getByText(amount)).toBeInTheDocument();
      expect(within(row(label)).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
    }
    await statementRows();
  });

  // The same page from a real wallet, read with the same eyes: the walk that
  // finds seven marks above finds none here, so finding none means something.
  it("shows no line, no mark and no prompt where the wallet is not simulated", async () => {
    const first = open(simulated);
    await statementRows();
    // One for the allowance, one for the commerce group and one for the statement list — and none on their rows.
    expect(marks()).toHaveLength(3);
    first.unmount();

    mocks.statements.mockResolvedValue({ simulated: false, items: [{ ...charge, simulated: false }], nextCursor: null });
    open({ ...real, available: 0 });
    expect(await statementRows()).toHaveLength(1);
    expect(within(row("可用科研额度")).getByText("0.00 灵豆")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看充值" })).toBeInTheDocument();
    expect(marks()).toEqual([]);
    expect(screen.queryAllByText(/模拟/)).toEqual([]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says an allowance that cannot be read is unavailable, with no amount to mark and no zero", () => {
    open(unreadable);
    expect(screen.getByText("科研额度暂不可用")).toBeInTheDocument();
    expect(screen.getByText("模拟数据，不涉及真实资金")).toBeInTheDocument();
    expect(marks()).toEqual([]);
    expect(screen.queryByText(/灵豆/)).not.toBeInTheDocument();
  });
});

describe("the low-allowance prompt", () => {
  it("says a low allowance is running out, marked, with the way to the simulated recharge page", async () => {
    open({ ...simulated, available: 12 });
    const prompt = screen.getByRole("status");
    expect(prompt).toHaveTextContent("科研额度即将用完，还剩 12.00 灵豆。");
    expect(within(prompt).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    // At the top of the section: before the allowance itself.
    expect(prompt.compareDocumentPosition(screen.getByRole("heading", { name: "科研额度" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const link = within(prompt).getByRole("link", { name: "去模拟充值" });
    expect(link).toHaveAttribute("href", SIMULATED_WALLET_PAGES.recharge);
    await userEvent.click(link);
    expect(screen.getByTestId("where")).toHaveTextContent(SIMULATED_WALLET_PAGES.recharge);
  });

  it("says an empty allowance is used up", async () => {
    open({ ...simulated, available: 0 });
    const prompt = screen.getByRole("status");
    expect(prompt).toHaveTextContent("科研额度已用完，模拟充值后可以继续研究。");
    expect(prompt).not.toHaveTextContent("即将用完");
    expect(within(prompt).getByRole("link", { name: "去模拟充值" })).toHaveAttribute("href", SIMULATED_WALLET_PAGES.recharge);
    await statementRows();
  });

  it("begins at the threshold the server names, and not above it", async () => {
    const at = open({ ...simulated, available: SIMULATED_LOW_CREDITS });
    expect(screen.getByRole("status")).toHaveTextContent("科研额度即将用完");
    await statementRows();
    at.unmount();
    open({ ...simulated, available: SIMULATED_LOW_CREDITS + 1 });
    expect(within(row("可用科研额度")).getByText("21.00 灵豆")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await statementRows();
  });

  // Unknown is not empty: nobody is told their allowance ran out on a failed read.
  it.each([
    ["the balance could not be read", unreadable],
    ["the server names no threshold", { ...simulated, available: 0, lowThreshold: null }],
    ["the answer carries no threshold at all", thresholdMissing],
  ] as [string, WebResearchAllowance][])("is not shown when %s", async (_, allowance) => {
    open(allowance);
    expect(screen.getByText("模拟数据，不涉及真实资金")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("offers no link when the server named no recharge page", async () => {
    open({ ...simulated, available: 0, commerce: { ...simulated.commerce, rechargeUrl: null } });
    const prompt = screen.getByRole("status");
    expect(prompt).toHaveTextContent("科研额度已用完");
    expect(within(prompt).queryByRole("link")).not.toBeInTheDocument();
    await statementRows();
  });
});

describe("充值与订单 on a deployment whose wallet is simulated", () => {
  // A simulated wallet takes a top-up and lists its orders; there is no plan to open and no money to return, so there is no row for it.
  it("links the two destinations the server gave as pages of this app, followed in place, and names the group for them", async () => {
    open(simulated);
    expect(screen.getByRole("heading", { name: "充值与订单" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "充值与会员" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /^查看/ }).map((link) => link.textContent)).toEqual(["查看充值", "查看订单"]);
    for (const gone of ["会员", "退款"]) expect(screen.queryAllByText(gone)).toEqual([]);
    for (const [name, to] of [["查看充值", SIMULATED_WALLET_PAGES.recharge], ["查看订单", SIMULATED_WALLET_PAGES.orders]] as const) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", to);
      // The router's link, not a document of its own: nothing sends it elsewhere.
      expect(link).not.toHaveAttribute("rel");
      expect(link).not.toHaveAttribute("target");
    }
    await userEvent.click(screen.getByRole("link", { name: "查看订单" }));
    expect(screen.getByTestId("where")).toHaveTextContent(SIMULATED_WALLET_PAGES.orders);
    expect(screen.queryByRole("heading", { name: "科研额度" })).not.toBeInTheDocument();
  });

  it("keeps a configured HTTPS page a document of its own", async () => {
    open(real);
    const link = screen.getByRole("link", { name: "查看充值" });
    expect(link).toHaveAttribute("href", "https://account.example/recharge");
    expect(link).toHaveAttribute("rel", "noreferrer");
    await statementRows();
  });

  it("draws no placeholder row, and no group, when the server gave no destination", async () => {
    open({ ...simulated, commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null } });
    expect(within(row("可用科研额度")).getByText("200.00 灵豆")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^充值与/ })).not.toBeInTheDocument();
    expect(screen.queryAllByText(/尚未开放/)).toEqual([]);
    expect(screen.queryByRole("link", { name: /^查看/ })).not.toBeInTheDocument();
    for (const gone of ["充值", "会员", "订单", "退款"]) expect(screen.queryAllByText(gone)).toEqual([]);
    await statementRows();
  });

  it("keeps the real hosted handoffs of a deployment that is not simulated: 会员 and 退款 are rows there, and the group says so", async () => {
    open({ ...real, commerce: { rechargeUrl: "https://account.example/recharge", membershipUrl: "https://account.example/membership",
      ordersUrl: "https://account.example/orders", refundsUrl: "https://account.example/refunds" } });
    expect(screen.getByRole("heading", { name: "充值与会员" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /^查看/ }).map((link) => link.textContent)).toEqual(["查看充值", "查看会员", "查看订单", "查看退款"]);
    expect(marks()).toEqual([]);
    await statementRows();
  });

  it("draws a row for each destination given and for no other", async () => {
    open({ ...simulated, commerce: { rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: null, ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: null } });
    expect(screen.getAllByRole("link", { name: /^查看/ }).map((link) => link.textContent)).toEqual(["查看充值", "查看订单"]);
    for (const gone of ["会员", "退款"]) expect(screen.queryAllByText(gone)).toEqual([]);
    expect(screen.queryAllByText(/尚未开放/)).toEqual([]);
    await statementRows();
  });
});

describe("the statement list", () => {
  it("draws credits going in with a plus sign and 已入账, opening no run, and keeps a charge as it was", async () => {
    open(simulated);
    const rows = await statementRows();
    expect(rows).toHaveLength(3);

    expect(within(rows[0]).getByText("模拟充值")).toBeInTheDocument();
    expect(within(rows[0]).getByText("+100.00 灵豆")).toBeInTheDocument();
    expect(within(rows[0]).getByText("已入账")).toBeInTheDocument();
    expect(within(rows[0]).queryByRole("link")).not.toBeInTheDocument();

    expect(within(rows[1]).getByRole("link", { name: "文献研究" })).toHaveAttribute("href", "/app/runs?run=run_1");
    expect(within(rows[1]).getByText("已结算")).toBeInTheDocument();
    expect(within(rows[1]).getByText("4.00 灵豆")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("已入账")).not.toBeInTheDocument();
    expect(within(rows[1]).queryByText(/\+/)).not.toBeInTheDocument();

    expect(within(rows[2]).getByText("模拟初始额度")).toBeInTheDocument();
    expect(within(rows[2]).getByText("+200.00 灵豆")).toBeInTheDocument();
    expect(within(rows[2]).getByText("已入账")).toBeInTheDocument();
    expect(within(rows[2]).queryByRole("link")).not.toBeInTheDocument();

    // The list says 「模拟」 once, in its header; its rows do not say it again.
    const list = screen.getByRole("region", { name: "研究消费明细" });
    expect(within(list.querySelector("h2")!.parentElement as HTMLElement).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    for (const each of rows) expect(within(each).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
  });

  it("never opens a run from credits going in, whatever the row carries", async () => {
    mocks.statements.mockResolvedValue({ simulated: true, items: [{ ...topUp, runId: "run_9", waivedCny: "0.00000000" }], nextCursor: null });
    open(simulated);
    const [only] = await statementRows();
    expect(within(only).getByText("+100.00 灵豆")).toBeInTheDocument();
    expect(within(only).queryByRole("link")).not.toBeInTheDocument();
    expect(within(only).queryByText(/已减免/)).not.toBeInTheDocument();
  });

  it("draws no amount for credits whose amount is not there, rather than a zero", async () => {
    mocks.statements.mockResolvedValue({ simulated: true, items: [{ ...topUp, amount: null }], nextCursor: null });
    open(simulated);
    const [only] = await statementRows();
    expect(within(only).getByText("已入账")).toBeInTheDocument();
    expect(within(only).queryByText(/灵豆/)).not.toBeInTheDocument();
  });

  // A row says for itself whether its wallet is simulated; one that says
  // nothing is read by the list's answer, and then by the allowance's.
  it("marks a row by its own word, then the list's, then the allowance's", async () => {
    expect(silentCharge).not.toHaveProperty("simulated");
    mocks.statements.mockResolvedValue({ simulated: true, items: [silentCharge, { ...charge, id: "run_b", simulated: false }], nextCursor: null });
    const first = open(simulated);
    let rows = await statementRows();
    expect(within(rows[0]).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    expect(within(rows[1]).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
    first.unmount();

    // A list that says nothing either: the rows are this allowance's, and a list of them says 「模拟」 once in its header.
    mocks.statements.mockResolvedValue({ items: [silentCharge], nextCursor: null });
    const second = open(simulated);
    rows = await statementRows();
    expect(within(rows[0]).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "研究消费明细" }).querySelector("h2")!.parentElement as HTMLElement).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    second.unmount();

    // …and where nothing says so — an older control plane — it is a charge of a real wallet.
    open(real);
    rows = await statementRows();
    expect(within(rows[0]).getByText("4.00 灵豆")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "文献研究" })).toBeInTheDocument();
    expect(within(rows[0]).queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
  });

  it("is not drawn, and not read, when the month could not be read", async () => {
    open(unreadable);
    expect(screen.getByText("科研额度暂不可用")).toBeInTheDocument();
    for (const gone of [/本月研究消费/, /本月待结算/, /研究消费明细/, /还没有研究消费记录/]) expect(screen.queryAllByText(gone)).toEqual([]);
    expect(screen.queryByRole("list", { name: "研究消费记录" })).not.toBeInTheDocument();
    await act(async () => {});
    expect(mocks.statements).not.toHaveBeenCalled();
  });

  it("is read once the month can be read", async () => {
    open(simulated);
    await statementRows();
    expect(screen.getByRole("heading", { name: "研究消费明细" })).toBeInTheDocument();
    expect(mocks.statements).toHaveBeenCalledTimes(1);
  });
});
