import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoCell } from "@/lib/geoClient";
import type { GeoMetricMembers } from "@/lib/geoReadScope";
import { CellLink } from "./tabs/geoTabKit";
import { WebApiError } from "@/lib/apiClient";
import { GeoFrameContext, type GeoFrameApi } from "./geoFrame";
import { GeoDataCache } from "./geoProjectData";
const client = vi.hoisted(() => ({ getGeoObservations: vi.fn() }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), ...client }));
const member: GeoMetricMembers = { total: 31, shown: 31, more: false, nextOffset: null, unit: "answer", basis: "answered", exact: true,
  digest: "digest", selectionRef: "gsel_current", metric: { metricId: "M-01", scope: "engine", engine: "kimi", pool: null, groupId: null, arm: null, variant: null, rival: null, observationDate: "2026-10-02" } };
const cell: GeoCell = { value: 0, numerator: 0, denominator: 31, status: "ok", dataType: "measured", ciLow: null, ciHigh: null, members: member };
const answer = (n: number) => ({ id: `s${n}`, question: `原题 ${n}`, engine: "kimi", askedAt: "2026-10-02T00:00:00Z", status: "valid", answerText: "答案", answerTruncated: false });
beforeEach(() => client.getGeoObservations.mockReset());

describe("a GEO metric opens all of its contributors", () => {
  it.each(["first", "next"])("recovers a stale %s page by refreshing the graph rather than retrying a changed frozen set", async stage => {
    const user = userEvent.setup();
    const refresh = vi.fn(); const data = new GeoDataCache(); const invalidate = vi.spyOn(data, "invalidate");
    if (stage === "next") client.getGeoObservations.mockResolvedValueOnce({ items: [answer(0)], total: 2, nextOffset: 1 });
    client.getGeoObservations.mockRejectedValueOnce(new WebApiError("changed", { status: 409 }));
    render(<MemoryRouter><GeoFrameContext.Provider value={{ reload: refresh, data } as unknown as GeoFrameApi}>
      <CellLink geoId="g" cell={cell} label="提及率" />
    </GeoFrameContext.Provider></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: /提及率/ }));
    if (stage === "next") {
      await user.click(await screen.findByRole("button", { name: "继续读取回答" }));
      expect(screen.getByRole("link", { name: "原题 0" })).toBeVisible();
    }
    await user.click(await screen.findByRole("button", { name: "更新图表" }));
    expect(refresh).toHaveBeenCalledTimes(1); expect(invalidate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.getGeoObservations).toHaveBeenCalledTimes(stage === "next" ? 2 : 1);
  });
  it("preserves a measured zero, reads each next page with the same daily member and keeps the return scope", async () => {
    const user = userEvent.setup();
    client.getGeoObservations.mockResolvedValueOnce({ items: Array.from({ length: 30 }, (_, i) => answer(i)), total: 31, nextOffset: 30 })
      .mockResolvedValueOnce({ items: [answer(30)], total: 31, nextOffset: null });
    render(<MemoryRouter initialEntries={["/app/geo/g/visibility?from=2026-10-02&engine=kimi"]}><CellLink geoId="g" cell={cell} unit="percent" label="提及率" /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: /0%.*提及率/ }));
    await screen.findByRole("link", { name: "原题 0" });
    expect(client.getGeoObservations).toHaveBeenCalledWith("g", "gsel_current", member.metric);
    expect(screen.getByRole("link", { name: "原题 0" })).toHaveAttribute("href", "/app/geo/g/answers/s0?from=2026-10-02&engine=kimi");
    await user.click(screen.getByRole("button", { name: "继续读取回答" }));
    await screen.findByRole("link", { name: "原题 30" });
    expect(client.getGeoObservations).toHaveBeenLastCalledWith("g", "gsel_current", member.metric, 30);
    expect(screen.queryByRole("button", { name: "继续读取回答" })).not.toBeInTheDocument();
  });
  it("keeps the first page after a failed continuation and retries the same cursor", async () => {
    const user = userEvent.setup();
    client.getGeoObservations.mockResolvedValueOnce({ items: [answer(0)], total: 2, nextOffset: 1 }).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [answer(1)], total: 2, nextOffset: null });
    render(<MemoryRouter><CellLink geoId="g" cell={cell} label="提及率" /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: /提及率/ }));
    await user.click(await screen.findByRole("button", { name: "继续读取回答" }));
    await screen.findByRole("note");
    expect(screen.getByRole("link", { name: "原题 0" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(client.getGeoObservations).toHaveBeenLastCalledWith("g", "gsel_current", member.metric, 1));
    await screen.findByRole("link", { name: "原题 1" });
  });
});
