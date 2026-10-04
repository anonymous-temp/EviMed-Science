import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIMULATED_TOPUP_PACKAGES, SIMULATED_WALLET_LABEL, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import { forgetResearchBilling } from "@/lib/useResearchBilling";
import { SimulatedWalletPage } from "./SimulatedWalletPage";

const mocks = vi.hoisted(() => ({ allowance: vi.fn(), orders: vi.fn(), topUp: vi.fn() }));
// The error dictionary lives in this module and the page words its failures by
// it, so the real exports come through; only the three calls are replaced.
vi.mock("@/lib/apiClient", async (original) => ({
  ...(await original<typeof import("@/lib/apiClient")>()),
  fetchWebResearchAllowance: mocks.allowance,
  fetchWebSimulatedOrders: mocks.orders,
  topUpWebSimulatedWallet: mocks.topUp,
}));

const NO_LINKS = { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null };
/** `/api/account/allowance` on a deployment whose wallet is simulated, as the server writes it. */
const simulated = {
  enabled: true, simulated: true, currency: "CNY", status: "ready", available: 200, held: null, balances: null, membership: null,
  lowThreshold: 20, month: { since: "2026-10-01T00:00:00.000Z", paid: 4, pending: 0 },
  commerce: {
    rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: SIMULATED_WALLET_PAGES.membership,
    ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: SIMULATED_WALLET_PAGES.refunds,
  },
};
/** …on one that bills research from a real wallet, on one that does not bill at all, and from a control plane older than the simulated wallet. */
const real = { ...simulated, simulated: false, lowThreshold: null, commerce: NO_LINKS };
const off = { ...real, enabled: false, status: "disabled", available: null };
const older = { enabled: true, currency: "CNY", status: "ready", available: 200, held: null, month: simulated.month, commerce: NO_LINKS };

const order = (id: string, amount: number, at: string) => ({ id, packageId: `topup-${amount}`, title: "模拟充值", amount, at, status: "paid" });
/** `POST /api/simulated-wallet/topups` answering: the order it made and the balance after it. */
const applied = (amount: number, available: number, duplicate = false) => ({
  simulated: true, order: order("ord_new", amount, "2026-10-04T08:00:00.000Z"), available, duplicate,
});
const unreachable = () => new WebApiError("HTTP 503", { status: 503, code: "evimed_credits_unreachable" });

/** Where the router is, for a page this one sends the reader to. */
function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/account/simulated/:page" element={<SimulatedWalletPage />} />
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
/** The package buttons, which are the only way this page can top anything up. */
const packages = () => within(screen.getByRole("region", { name: "充值额度" })).getAllByRole("button");
const settle = () => act(async () => {});
/** The two things a top-up was asked with. */
const asked = (call: number) => mocks.topUp.mock.calls[call] as [string, string];

beforeEach(() => {
  for (const mock of [mocks.allowance, mocks.orders, mocks.topUp]) mock.mockReset();
  forgetResearchBilling();
  mocks.allowance.mockResolvedValue(simulated);
  mocks.orders.mockResolvedValue({ simulated: true, currency: "CNY", items: [], nextCursor: null });
});

describe("the simulated wallet's four pages", () => {
  const PAGES = [["recharge", "模拟充值"], ["membership", "模拟会员"], ["orders", "模拟订单"], ["refunds", "模拟退款"]] as const;

  it("are the pages the domain names, and no others", () => {
    expect(Object.keys(SIMULATED_WALLET_PAGES).sort()).toEqual(PAGES.map(([name]) => name).sort());
  });

  it.each(PAGES)("%s is 「%s」, opens with the line that says the data is simulated, and leads back to the allowance", async (name, title) => {
    open(SIMULATED_WALLET_PAGES[name]);
    const line = await screen.findByText("模拟数据，不涉及真实资金");
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    // The first thing in the page's body, before anything it qualifies.
    expect(line.parentElement?.firstElementChild).toBe(line);
    expect(line).toHaveClass("text-warn-strong");
    expect(screen.getByRole("link", { name: "返回科研额度" })).toHaveAttribute("href", "/app/account?tab=usage");
    await settle();
  });

  it("follows the way back in place", async () => {
    open(SIMULATED_WALLET_PAGES.membership);
    await userEvent.click(await screen.findByRole("link", { name: "返回科研额度" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/account?tab=usage");
  });

  it("says an address that names no page of the wallet does not exist, and asks the deployment nothing", async () => {
    open("/app/account/simulated/checkout");
    expect(await screen.findByText("页面不存在")).toBeInTheDocument();
    expect(screen.queryByText("模拟数据，不涉及真实资金")).not.toBeInTheDocument();
    await settle();
    expect(mocks.allowance).not.toHaveBeenCalled();
  });

  it.each([
    ["membership", "这里的会员只是演示：没有可以开通的套餐，也不会发放任何会员权益。"],
    ["refunds", "这里的退款只是演示：不会退回任何额度，也没有资金流动。"],
  ] as const)("%s says in one paragraph that it is a demonstration, and does nothing", async (name, sentence) => {
    open(SIMULATED_WALLET_PAGES[name]);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
    await settle();
    expect(mocks.topUp).not.toHaveBeenCalled();
    expect(mocks.orders).not.toHaveBeenCalled();
  });
});

describe("模拟充值", () => {
  const openRecharge = async () => {
    const view = open(SIMULATED_WALLET_PAGES.recharge);
    await screen.findByText("可用科研额度");
    return view;
  };

  it("shows the balance, marked, and one button per package of the domain's list", async () => {
    await openRecharge();
    expect(within(row("可用科研额度")).getByText("¥200.00")).toBeInTheDocument();
    expect(within(row("可用科研额度")).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    expect(SIMULATED_TOPUP_PACKAGES.length).toBeGreaterThan(1);
    expect(packages().map((button) => button.textContent)).toEqual(SIMULATED_TOPUP_PACKAGES.map((item) => `¥${item.credits}`));
    // The amounts on the buttons are simulated too, and say so.
    expect(within(screen.getByRole("region", { name: "充值额度" })).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    expect(mocks.topUp).not.toHaveBeenCalled();
  });

  it("tops up with the package and one identity, then shows the new balance and the way to the orders", async () => {
    mocks.topUp.mockResolvedValue(applied(100, 300));
    mocks.allowance.mockResolvedValueOnce(simulated).mockResolvedValue({ ...simulated, available: 300 });
    const { container } = await openRecharge();
    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    expect(mocks.topUp).toHaveBeenCalledTimes(1);
    expect(asked(0)[0]).toBe("topup-100");
    // What the route accepts as a request id.
    expect(asked(0)[1]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    const done = await screen.findByRole("status");
    expect(done).toHaveTextContent("模拟充值 ¥100.00 已入账。");
    expect(within(done).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
    expect(within(done).getByRole("link", { name: "查看模拟订单" })).toHaveAttribute("href", SIMULATED_WALLET_PAGES.orders);
    expect(within(row("可用科研额度")).getByText("¥300.00")).toBeInTheDocument();
    expect(screen.queryByText("¥200.00")).not.toBeInTheDocument();
    // The allowance every other surface shares is read again, and this page
    // does not blank while it is: it already holds the newer balance.
    await waitFor(() => expect(mocks.allowance).toHaveBeenCalledTimes(2));
    await settle();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(within(row("可用科研额度")).getByText("¥300.00")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("模拟充值 ¥100.00 已入账。");

    await userEvent.click(screen.getByRole("link", { name: "查看模拟订单" }));
    expect(screen.getByRole("heading", { level: 1, name: "模拟订单" })).toBeInTheDocument();
  });

  it("stays on screen, with the new balance, while the allowance is being read again", async () => {
    mocks.topUp.mockResolvedValue(applied(100, 300));
    mocks.allowance.mockResolvedValueOnce(simulated).mockReturnValue(new Promise(() => {}));
    const { container } = await openRecharge();
    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    expect(await screen.findByRole("status")).toHaveTextContent("模拟充值 ¥100.00 已入账。");
    await waitFor(() => expect(mocks.allowance).toHaveBeenCalledTimes(2));
    await settle();
    // That read has not come back, and the page is not waiting for it.
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(within(row("可用科研额度")).getByText("¥300.00")).toBeInTheDocument();
    for (const each of packages()) expect(each).toBeEnabled();
  });

  it("keeps the balance the top-up answered with when the allowance cannot be read again", async () => {
    mocks.topUp.mockResolvedValue(applied(50, 250));
    mocks.allowance.mockResolvedValueOnce(simulated).mockRejectedValue(new Error("network"));
    await openRecharge();
    await userEvent.click(screen.getByRole("button", { name: "¥50" }));
    expect(await screen.findByRole("status")).toHaveTextContent("模拟充值 ¥50.00 已入账。");
    await waitFor(() => expect(mocks.allowance).toHaveBeenCalledTimes(2));
    await settle();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(row("可用科研额度")).getByText("¥250.00")).toBeInTheDocument();
  });

  // The identity is what makes a top-up apply once: the same one goes out again
  // on a retry, and a new one only for a top-up the reader asks for afterwards.
  it("retries a failed top-up with the same identity, and gives the next top-up a new one", async () => {
    const refused = unreachable();
    mocks.topUp.mockRejectedValueOnce(refused).mockResolvedValueOnce(applied(100, 300)).mockResolvedValueOnce(applied(100, 400));
    await openRecharge();
    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(webErrorMessage(refused));
    // Nothing was added and nothing reads as zero: the balance is the one read.
    expect(within(row("可用科研额度")).getByText("¥200.00")).toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("status")).toHaveTextContent("模拟充值 ¥100.00 已入账。");
    expect(mocks.topUp).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual(asked(0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(row("可用科研额度")).getByText("¥300.00")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    await waitFor(() => expect(within(row("可用科研额度")).getByText("¥400.00")).toBeInTheDocument());
    expect(mocks.topUp).toHaveBeenCalledTimes(3);
    expect(asked(2)[0]).toBe("topup-100");
    expect(asked(2)[1]).not.toBe(asked(0)[1]);
  });

  it("sends the same identity when the same package is pressed again after a failure, and another for another package", async () => {
    mocks.topUp.mockRejectedValueOnce(new Error("network")).mockRejectedValueOnce(new Error("network")).mockRejectedValueOnce(new Error("network"));
    await openRecharge();
    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    // A failure that never reached the control plane is worded by the page.
    expect(await screen.findByRole("alert")).toHaveTextContent("模拟充值没有完成，请重试。");
    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    await waitFor(() => expect(mocks.topUp).toHaveBeenCalledTimes(2));
    expect(asked(1)).toEqual(asked(0));
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "¥50" }));
    await waitFor(() => expect(mocks.topUp).toHaveBeenCalledTimes(3));
    expect(asked(2)[0]).toBe("topup-50");
    expect(asked(2)[1]).not.toBe(asked(0)[1]);
    await screen.findByRole("alert");
    // The retry is of the package that failed last.
    mocks.topUp.mockResolvedValueOnce(applied(50, 250));
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("status")).toHaveTextContent("模拟充值 ¥50.00 已入账。");
    expect(asked(3)).toEqual(asked(2));
  });

  it("cannot be sent twice by a second click, and holds every package while one is on its way", async () => {
    let answer!: (value: object) => void;
    mocks.topUp.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await openRecharge();
    const button = screen.getByRole("button", { name: "¥200" });
    // Both clicks land before the page has drawn the first.
    act(() => { button.click(); button.click(); });
    expect(mocks.topUp).toHaveBeenCalledTimes(1);
    for (const each of packages()) expect(each).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(screen.getByRole("button", { name: "¥50" }));
    expect(mocks.topUp).toHaveBeenCalledTimes(1);
    await act(async () => { answer(applied(200, 400)); });
    expect(within(row("可用科研额度")).getByText("¥400.00")).toBeInTheDocument();
    for (const each of packages()) expect(each).toBeEnabled();
  });

  it("says so when the request had already been applied, and adds nothing twice", async () => {
    mocks.topUp.mockResolvedValue(applied(100, 300, true));
    await openRecharge();
    await userEvent.click(screen.getByRole("button", { name: "¥100" }));
    const done = await screen.findByRole("status");
    expect(done).toHaveTextContent("这笔模拟充值此前已经入账，没有重复入账。");
    expect(within(row("可用科研额度")).getByText("¥300.00")).toBeInTheDocument();
  });

  it("says a balance that cannot be read is unavailable, never zero, and still offers the packages", async () => {
    mocks.allowance.mockResolvedValue({ ...simulated, status: "unavailable", available: null, month: null, commerce: NO_LINKS });
    open(SIMULATED_WALLET_PAGES.recharge);
    expect(await screen.findByText("科研额度暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("可用科研额度")).not.toBeInTheDocument();
    expect(screen.queryByText(/¥\d+\.\d\d/)).not.toBeInTheDocument();
    expect(packages()).toHaveLength(SIMULATED_TOPUP_PACKAGES.length);
  });

  // The balance moves, so the page reads it again on opening rather than
  // drawing the one another surface left behind.
  it("reads the balance again when it opens, with a skeleton until it comes", async () => {
    const first = open(SIMULATED_WALLET_PAGES.membership);
    await screen.findByText("模拟数据，不涉及真实资金");
    first.unmount();
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
    let answer!: (value: object) => void;
    mocks.allowance.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { container } = open(SIMULATED_WALLET_PAGES.recharge);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("¥200.00")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => { answer({ ...simulated, available: 35 }); });
    expect(within(row("可用科研额度")).getByText("¥35.00")).toBeInTheDocument();
    expect(mocks.allowance).toHaveBeenCalledTimes(2);
  });
});

describe("模拟订单", () => {
  const first = order("ord_2", 100, "2026-10-04T08:30:00.000Z");
  const second = order("ord_1", 50, "2026-10-03T02:05:00.000Z");
  const orderRows = async () => within(await screen.findByRole("list", { name: "模拟充值订单" })).getAllByRole("listitem");

  it("lists the top-ups in the order served, each with its amount, 已入账 and the mark", async () => {
    mocks.orders.mockResolvedValue({ simulated: true, currency: "CNY", items: [first, second], nextCursor: null });
    open(SIMULATED_WALLET_PAGES.orders);
    const rows = await orderRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("模拟充值")).toBeInTheDocument();
    expect(within(rows[0]).getByText("¥100.00")).toBeInTheDocument();
    expect(within(rows[1]).getByText("¥50.00")).toBeInTheDocument();
    for (const each of rows) {
      expect(within(each).getByText("已入账")).toBeInTheDocument();
      expect(within(each).getByText(SIMULATED_WALLET_LABEL)).toBeInTheDocument();
      // When it was made, and nothing to open: an order is not a run.
      expect(within(each).getByText(/\d+月\d+日/)).toBeInTheDocument();
      expect(within(each).queryByRole("link")).not.toBeInTheDocument();
    }
    expect(mocks.orders).toHaveBeenCalledTimes(1);
    expect(mocks.orders).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("appends the next page from the cursor", async () => {
    mocks.orders.mockResolvedValueOnce({ simulated: true, currency: "CNY", items: [first], nextCursor: "next" })
      .mockResolvedValueOnce({ simulated: true, currency: "CNY", items: [first, second], nextCursor: null });
    open(SIMULATED_WALLET_PAGES.orders);
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(async () => expect(await orderRows()).toHaveLength(2));
    expect(mocks.orders).toHaveBeenLastCalledWith("next");
    const rows = await orderRows();
    // An order the second page repeats is drawn once.
    expect(within(rows[0]).getByText("¥100.00")).toBeInTheDocument();
    expect(within(rows[1]).getByText("¥50.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  });

  it("says there are no orders yet, with the way to make one", async () => {
    open(SIMULATED_WALLET_PAGES.orders);
    expect(await screen.findByText("还没有模拟充值订单")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "模拟充值订单" })).not.toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "去模拟充值" }));
    expect(await screen.findByRole("heading", { level: 1, name: "模拟充值" })).toBeInTheDocument();
  });

  it("shows a skeleton while the orders are read", async () => {
    mocks.orders.mockReturnValue(new Promise(() => {}));
    const { container } = open(SIMULATED_WALLET_PAGES.orders);
    await screen.findByText("模拟数据，不涉及真实资金");
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("还没有模拟充值订单")).not.toBeInTheDocument();
  });

  it("reports a failed read with its retry, and never as an empty list", async () => {
    const refused = unreachable();
    mocks.orders.mockRejectedValueOnce(refused).mockResolvedValueOnce({ simulated: true, currency: "CNY", items: [first], nextCursor: null });
    open(SIMULATED_WALLET_PAGES.orders);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(webErrorMessage(refused));
    expect(screen.queryByText("还没有模拟充值订单")).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await orderRows()).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries a failed later page without losing the orders it has", async () => {
    mocks.orders.mockResolvedValueOnce({ simulated: true, currency: "CNY", items: [first], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ simulated: true, currency: "CNY", items: [second], nextCursor: null });
    open(SIMULATED_WALLET_PAGES.orders);
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(async () => expect(await orderRows()).toHaveLength(2));
    expect(mocks.orders).toHaveBeenLastCalledWith("next");
  });
});

describe("a deployment whose wallet is not simulated", () => {
  it.each([
    ["bills research from a real wallet", real],
    ["does not bill research", off],
    ["answers without a word about a simulated wallet", older],
  ])("says so in one sentence on every page, with the way back to 设置 and nothing to top up, when it %s", async (_, answer) => {
    mocks.allowance.mockResolvedValue(answer);
    for (const path of Object.values(SIMULATED_WALLET_PAGES)) {
      const view = open(path);
      expect(await screen.findByText("这个部署没有开启模拟额度")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "返回设置" })).toHaveAttribute("href", "/app/account?tab=usage");
      // Never the buttons, the line, a mark or an amount.
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByText("模拟数据，不涉及真实资金")).not.toBeInTheDocument();
      expect(screen.queryByText(SIMULATED_WALLET_LABEL)).not.toBeInTheDocument();
      expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
      // A page of 科研额度 is not named where there may be no such page.
      expect(screen.queryByRole("link", { name: "返回科研额度" })).not.toBeInTheDocument();
      await settle();
      view.unmount();
    }
    expect(mocks.topUp).not.toHaveBeenCalled();
    expect(mocks.orders).not.toHaveBeenCalled();
  });

  it("follows the way back in place", async () => {
    mocks.allowance.mockResolvedValue(off);
    open(SIMULATED_WALLET_PAGES.recharge);
    await userEvent.click(await screen.findByRole("link", { name: "返回设置" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/account?tab=usage");
  });
});

describe("the pages while the deployment's answer is read", () => {
  it("are a skeleton until it comes: no line, no top-up, and nothing said about the deployment", async () => {
    mocks.allowance.mockReturnValue(new Promise(() => {}));
    const { container } = open(SIMULATED_WALLET_PAGES.recharge);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "模拟充值" })).toBeInTheDocument();
    expect(screen.queryByText("模拟数据，不涉及真实资金")).not.toBeInTheDocument();
    expect(screen.queryByText("这个部署没有开启模拟额度")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "返回科研额度" })).not.toBeInTheDocument();
  });

  it("report a failed read with its retry, and open once it can be read", async () => {
    mocks.allowance.mockRejectedValueOnce(new Error("network")).mockResolvedValue(simulated);
    open(SIMULATED_WALLET_PAGES.recharge);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("操作未完成，请重试。");
    expect(screen.queryByText("这个部署没有开启模拟额度")).not.toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("可用科研额度")).toBeInTheDocument();
    expect(within(row("可用科研额度")).getByText("¥200.00")).toBeInTheDocument();
    expect(packages()).toHaveLength(SIMULATED_TOPUP_PACKAGES.length);
  });

  it("ask nothing again on a page that draws no balance, once the answer is held", async () => {
    const first = open(SIMULATED_WALLET_PAGES.membership);
    await screen.findByText("模拟数据，不涉及真实资金");
    first.unmount();
    const { container } = open(SIMULATED_WALLET_PAGES.refunds);
    // Drawn at once from the answer held: no skeleton, no second read.
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByText("模拟数据，不涉及真实资金")).toBeInTheDocument();
    await settle();
    expect(mocks.allowance).toHaveBeenCalledTimes(1);
  });
});
