import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeoMarketCard } from "./GeoMarketCard";

const api = vi.hoisted(() => ({
  fetchGeoMarket: vi.fn(), listGeoMarketOrders: vi.fn(), listGeoMarketTopups: vi.fn(), fetchGeoMonthlySettlement: vi.fn(),
  confirmGeoMarketTopup: vi.fn(), resolveGeoMarketOrder: vi.fn(), markGeoMarketOrderLost: vi.fn(), clearGeoMarketStop: vi.fn(),
}));
vi.mock("@/lib/geoClient", () => ({ ...api, isGeoOff: () => false }));
const overview = { operationsAvailable: true, configured: true, timeZone: "Asia/Shanghai", currentMonth: "2026-09", balance: { money: 12.5 },
  counts: { unknownOrders: 1, problemOrders: 0, requestedTopups: 1 }, stopNewOrders: { stopped: false }, reconciliation: null };
const order = { id: "o1", state: "unknown", articleTitle: "试验研究", mediaName: "医学媒体", reserveCny: 110, priceCny: 100,
  canResolve: true, canMarkLost: false, vendorOrderNid: null };
const settlement = (month = "2026-09", net = 100) => ({ period: { month, timeZone: "Asia/Shanghai" },
  summary: { netSettledCny: net, settledCny: 100, refundedCny: net < 0 ? 200 : 0, topupConfirmedCny: 500, topupRequestedCny: 0,
    reservedDuringPeriodCny: 110, releasedDuringPeriodCny: 10, adjustmentCny: 0, budgetChangeCount: 2, entryCount: 0 },
  entries: [], nextCursor: null, reconciliations: [] });
beforeEach(() => {
  vi.resetAllMocks();
  api.fetchGeoMarket.mockResolvedValue(overview);
  api.listGeoMarketOrders.mockResolvedValue({ items: [order], total: 1, nextCursor: null });
  api.listGeoMarketTopups.mockResolvedValue({ items: [{ id: "t1", amountCny: 500, status: "requested", requestedAt: "2026-09-01T00:00:00Z" }], total: 1, nextCursor: null });
  api.fetchGeoMonthlySettlement.mockResolvedValue(settlement());
});

describe("GEO market operations", () => {
  it("keeps local records readable without configuration or automatic mutations", async () => {
    api.fetchGeoMarket.mockResolvedValue({ ...overview, configured: false, balance: null });
    render(<GeoMarketCard />);
    expect(await screen.findByText("未配置投放连接")).toBeInTheDocument();
    expect(await screen.findByText("试验研究")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "核对订单" }));
    expect(screen.getByRole("button", { name: "已找到订单" })).toBeDisabled();
    expect(api.resolveGeoMarketOrder).not.toHaveBeenCalled();
    expect(api.confirmGeoMarketTopup).not.toHaveBeenCalled();
    expect(api.clearGeoMarketStop).not.toHaveBeenCalled();
  });

  it("keeps an unverified top-up pending after a confirmation attempt", async () => {
    api.confirmGeoMarketTopup.mockResolvedValue({ id: "t1", status: "awaiting_balance" });
    render(<GeoMarketCard />);
    fireEvent.click(await screen.findByRole("tab", { name: /充值记录/ }));
    fireEvent.click(await screen.findByRole("button", { name: "核对到账" }));
    expect(await screen.findByText("尚未核实到账")).toBeInTheDocument();
    expect(api.confirmGeoMarketTopup).toHaveBeenCalledWith("t1");
  });

  it("resolves an unknown order with its exact vendor identifier and never writes it off", async () => {
    api.resolveGeoMarketOrder.mockResolvedValue({ id: "o1", state: "submitted" });
    render(<GeoMarketCard />);
    fireEvent.click(await screen.findByRole("button", { name: "核对订单" }));
    fireEvent.change(screen.getByLabelText("平台订单号"), { target: { value: "000123" } });
    fireEvent.click(screen.getByRole("button", { name: "已找到订单" }));
    await waitFor(() => expect(api.resolveGeoMarketOrder).toHaveBeenCalledWith("o1", { created: true, vendorOrderNid: "000123" }));
    expect(api.markGeoMarketOrderLost).not.toHaveBeenCalled();
  });

  it("ignores a slow statement from the previously selected month", async () => {
    let finish!: (value: ReturnType<typeof settlement>) => void;
    api.fetchGeoMonthlySettlement.mockImplementation(({ month }) => month === "2026-09"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(settlement("2026-10", -100)));
    render(<GeoMarketCard />);
    fireEvent.click(await screen.findByRole("tab", { name: "月度结算" }));
    await waitFor(() => expect(api.fetchGeoMonthlySettlement).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("结算月份"), { target: { value: "2026-10" } });
    expect(await screen.findByTestId("geo-net-settled")).toHaveTextContent("-100.00");
    await act(async () => finish(settlement()));
    expect(screen.getByTestId("geo-net-settled")).toHaveTextContent("-100.00");
  });

  it("offers retry on a list failure without pretending the list is empty", async () => {
    api.listGeoMarketOrders.mockRejectedValueOnce(new Error("unavailable"));
    render(<GeoMarketCard />);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("试验研究")).toBeInTheDocument();
    expect(api.listGeoMarketOrders).toHaveBeenCalledTimes(2);
  });
});

it("requires a reason and a deliberate confirmation before recording a loss", async () => {
  api.listGeoMarketOrders.mockResolvedValue({ items: [{ ...order, state: "problem", canResolve: false, canMarkLost: true, vendorOrderNid: "000123" }], total: 1, nextCursor: null });
  api.markGeoMarketOrderLost.mockResolvedValue({ id: "o1", state: "lost" });
  render(<GeoMarketCard />);
  fireEvent.click(await screen.findByRole("tab", { name: /问题订单/ }));
  fireEvent.click(await screen.findByRole("button", { name: "记为损失" }));
  expect(screen.getByRole("button", { name: "确认记损" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("损失原因"), { target: { value: "已确认无法退款" } });
  fireEvent.click(screen.getByRole("button", { name: "确认记损" }));
  expect(api.markGeoMarketOrderLost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(api.markGeoMarketOrderLost).toHaveBeenCalledWith("o1", "已确认无法退款"));
});

it("does not clear a reconciliation stop when its page is merely viewed", async () => {
  api.fetchGeoMarket.mockResolvedValue({ ...overview, stopNewOrders: { stopped: true } });
  api.clearGeoMarketStop.mockResolvedValue({ cleared: true });
  render(<GeoMarketCard />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复新订单" }));
  expect(api.clearGeoMarketStop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() => expect(api.clearGeoMarketStop).toHaveBeenCalledTimes(1));
});

it("resets the cursor when the operator switches lists", async () => {
  api.listGeoMarketOrders.mockResolvedValue({ items: [order], total: 2, nextCursor: "page-two" });
  render(<GeoMarketCard />);
  fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
  await waitFor(() => expect(api.listGeoMarketOrders).toHaveBeenLastCalledWith({ view: "unknown", cursor: "page-two", limit: 50 }));
  fireEvent.click(screen.getByRole("tab", { name: /问题订单/ }));
  await waitFor(() => expect(api.listGeoMarketOrders).toHaveBeenLastCalledWith({ view: "problems", cursor: null, limit: 50 }));
});

it("does not claim an unknown order was resolved when its transition did not take effect", async () => {
  api.resolveGeoMarketOrder.mockResolvedValue({ id: "o1", state: "unknown" });
  render(<GeoMarketCard />);
  fireEvent.click(await screen.findByRole("button", { name: "核对订单" }));
  fireEvent.change(screen.getByLabelText("平台订单号"), { target: { value: "000123" } });
  fireEvent.click(screen.getByRole("button", { name: "已找到订单" }));
  expect(await screen.findByText("状态尚未更新，请重新核对。")).toBeInTheDocument();
  expect(screen.queryByText("订单已核对")).not.toBeInTheDocument();
});

it("closes the previous order editor on pagination so offscreen orders cannot be changed", async () => {
  api.listGeoMarketOrders.mockResolvedValueOnce({ items: [order], total: 2, nextCursor: "page-two" })
    .mockResolvedValueOnce({ items: [{ ...order, id: "o2", articleTitle: "第二项研究" }], total: 2, nextCursor: null });
  render(<GeoMarketCard />);
  fireEvent.click(await screen.findByRole("button", { name: "核对订单" }));
  expect(screen.getByLabelText("平台订单号")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("第二项研究")).toBeInTheDocument();
  expect(screen.queryByLabelText("平台订单号")).not.toBeInTheDocument();
  expect(api.resolveGeoMarketOrder).not.toHaveBeenCalled();
});
