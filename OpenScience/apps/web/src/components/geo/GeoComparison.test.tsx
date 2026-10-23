import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { GeoReadScope, GeoScopedView, GeoSelection } from "@/lib/geoReadScope";
import { GeoComparison } from "./GeoComparison";
import { readGeoCell } from "@/lib/geoClient";
const client = vi.hoisted(() => ({ getGeoObservations: vi.fn().mockResolvedValue({ items: [], total: 0, nextOffset: null }) }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), ...client }));
const metric = { metricId: "M-06", scope: "project", engine: null, pool: null, groupId: null, arm: null, variant: null, rival: null };
const selection = { reference: "main" } as GeoSelection;
const cell = (reference: string, value: number) => readGeoCell({ value, numerator: value, denominator: 100, status: "ok", dataType: "measured",
  members: { selectionRef: reference, metric, total: 100, exact: true } });
const view = (scope: GeoReadScope = {}): GeoScopedView => ({ scope, comparison: { mode: "common", comparable: true, commonQuestionEngineModes: 100,
  currentSelection: selection, previousSelection: selection, cells: [{ ...metric, current: cell("current-subset", 20), previous: cell("previous-subset", 0), comparable: true, reason: null, delta: 20 }] } });

describe("GEO period comparison", () => {
  it("keeps zero and percentage points, and drills into the comparison subset rather than the main selection", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><GeoComparison geoId="g" view={view()} /></MemoryRouter>);
    const table = screen.getByRole("table", { name: "区间指标比较" });
    expect(table).toHaveTextContent("+20 个百分点");
    await user.click(within(table).getByRole("button", { name: /0%.*对比区间/ }));
    await screen.findByRole("dialog");
    expect(client.getGeoObservations).toHaveBeenCalledWith("g", "previous-subset", metric);
  });
  it("does not derive a change when the server says the ingredients changed", () => {
    const data = view();
    data.comparison!.cells[0] = { ...data.comparison!.cells[0], comparable: false, delta: null, reason: "comparison_basis_changed" };
    render(<MemoryRouter><GeoComparison geoId="g" view={data} /></MemoryRouter>);
    expect(screen.getByRole("table")).toHaveTextContent("组成变化");
    expect(screen.getByRole("table")).not.toHaveTextContent("百分点");
  });
});
