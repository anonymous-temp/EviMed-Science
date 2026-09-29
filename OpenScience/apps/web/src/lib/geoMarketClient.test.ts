import { beforeEach, expect, it, vi } from "vitest";
import { productRequest } from "./productClient";
import { fetchGeoMarket, listGeoMarketOrders, listGeoMarketTopups, fetchGeoMonthlySettlement,
  confirmGeoMarketTopup, resolveGeoMarketOrder, markGeoMarketOrderLost, clearGeoMarketStop } from "./geoClient";
vi.mock("./productClient", () => ({ productRequest: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.mocked(productRequest).mockClear());
it("uses the guarded account-wide read routes with encoded filters", async () => {
  await fetchGeoMarket();
  await listGeoMarketOrders({ view: "unknown", cursor: "a+b", limit: 2 });
  await listGeoMarketTopups({ status: "all" });
  await fetchGeoMonthlySettlement({ month: "2026-09", cursor: null });
  expect(vi.mocked(productRequest).mock.calls).toEqual([
    ["/geo/market"], ["/geo/market/orders?view=unknown&cursor=a%2Bb&limit=2"],
    ["/geo/market/topups?status=all"], ["/geo/market/settlement?month=2026-09"],
  ]);
});
it("calls only existing operator actions and preserves string vendor order ids", async () => {
  await confirmGeoMarketTopup("t1");
  await resolveGeoMarketOrder("o1", { created: true, vendorOrderNid: "000123" });
  await markGeoMarketOrderLost("o1", "Refund not recoverable");
  await clearGeoMarketStop("Reviewed");
  expect(vi.mocked(productRequest).mock.calls).toEqual([
    ["/geo/market/topups/t1/confirm", "POST", {}],
    ["/geo/market/orders/o1/resolve", "POST", { created: true, vendorOrderNid: "000123" }],
    ["/geo/market/orders/o1/lost", "POST", { reason: "Refund not recoverable" }],
    ["/geo/market/clear-stop", "POST", { note: "Reviewed" }],
  ]);
});
