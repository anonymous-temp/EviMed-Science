import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GeoFrameContext, type GeoFrameApi } from "./geoFrame";
import { GeoDataCache, useGeoDiagnosis, useGeoMonitoring, useGeoSources } from "./geoProjectData";
import { useGeoClusters } from "./spine/spineData";
const reads = vi.hoisted(() => ({ getGeoDiagnosis: vi.fn(), getGeoMonitoring: vi.fn(), getGeoSources: vi.fn(), getGeoClusters: vi.fn() }));
vi.mock("@/lib/geoClient", async (original) => ({ ...await original<typeof import("@/lib/geoClient")>(), ...reads }));

function View() {
  const diagnosis = useGeoDiagnosis("g");
  const monitoring = useGeoMonitoring("g");
  const sources = useGeoSources("g");
  const clusters = useGeoClusters("g");
  return <div>{[diagnosis, monitoring, sources, clusters].map((read, i) => <output key={i} data-testid={`read-${i}`}>
    {read.state.kind === "ready" ? JSON.stringify(read.state.data) : read.state.kind}
  </output>)}</div>;
}

describe("measured GEO reads share the frame's scope", () => {
  it("isolates cache entries and ignores a late result from the previous range", async () => {
    const scopeA = { from: "2026-10-01", engines: ["kimi"] };
    const scopeB = { from: "2026-10-02", engines: ["deepseek"] };
    let resolveOld: (value: unknown) => void = () => undefined;
    const old = new Promise(resolve => { resolveOld = resolve; });
    Object.values(reads).forEach(read => read.mockReset().mockImplementation((_id, scope) => scope.from === scopeA.from ? old : Promise.resolve({ marker: "range-b" })));
    const data = new GeoDataCache();
    const frame = (scope: GeoFrameApi["scope"]) => ({ geoId: "g", scope, data, setToolbar: vi.fn() } as unknown as GeoFrameApi);
    const shown = render(<GeoFrameContext.Provider value={frame(scopeA)}><View /></GeoFrameContext.Provider>);
    await waitFor(() => expect(reads.getGeoDiagnosis).toHaveBeenCalledWith("g", scopeA));
    shown.rerender(<GeoFrameContext.Provider value={frame(scopeB)}><View /></GeoFrameContext.Provider>);
    for (const read of Object.values(reads)) await waitFor(() => expect(read).toHaveBeenLastCalledWith("g", scopeB));
    await waitFor(() => expect(screen.getByTestId("read-0")).toHaveTextContent("range-b"));
    await act(async () => { resolveOld({ marker: "range-a" }); await old; });
    for (let i = 0; i < 4; i++) expect(screen.getByTestId(`read-${i}`)).toHaveTextContent("range-b");
  });
});
