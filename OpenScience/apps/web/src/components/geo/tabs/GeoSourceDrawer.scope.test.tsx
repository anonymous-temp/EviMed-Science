import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { WebApiError } from "@/lib/apiClient";
import { GeoFrameContext, type GeoFrameApi } from "../geoFrame";
import { GeoSourceDrawer } from "./GeoSourceDrawer";
import { geoProject, sourceDetailOf, sourcesFilled } from "../__fixtures__/geoTabs";
import type { GeoSelection } from "@/lib/geoReadScope";
const client = vi.hoisted(() => ({ getGeoSource: vi.fn() }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), ...client }));
vi.mock("../useOpenGeoConversation", () => ({ useOpenGeoConversation: () => vi.fn() }));
beforeEach(() => client.getGeoSource.mockReset());

describe("source detail refresh and navigation", () => {
  it.each(["first", "next"])("uses the list's exact reference and refreshes a stale %s page without retrying it", async stage => {
    const user = userEvent.setup(); const onClose = vi.fn(); const refreshScope = vi.fn();
    const source = sourcesFilled.sources[0]; const detail = sourceDetailOf(source);
    if (stage === "next") client.getGeoSource.mockResolvedValueOnce({ ...detail, answers: [detail.answers[0]], selection: { reference: "list_ref" },
      answerPage: { total: 2, nextOffset: 1 } });
    client.getGeoSource.mockRejectedValueOnce(new WebApiError("changed", { status: 409 }));
    render(<MemoryRouter><GeoFrameContext.Provider value={{ scope: { engines: ["deepseek"] }, refreshScope } as unknown as GeoFrameApi}>
      <GeoSourceDrawer geoId="g" project={geoProject()} source={source} engine="deepseek" selectionRef="list_ref" focus={null} onClose={onClose} />
    </GeoFrameContext.Provider></MemoryRouter>);
    await waitFor(() => expect(client.getGeoSource).toHaveBeenCalledWith("g", source.id, { selectionRef: "list_ref" }));
    if (stage === "next") {
      await user.click(await screen.findByRole("button", { name: /继续读取回答/ }));
      expect(screen.getByRole("link", { name: /第 1 个问题/ })).toBeVisible();
      expect(client.getGeoSource).toHaveBeenLastCalledWith("g", source.id, { selectionRef: "list_ref" }, { answerOffset: 1 });
    }
    await user.click(await screen.findByRole("button", { name: "更新信源列表" }));
    expect(refreshScope).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.getGeoSource).toHaveBeenCalledTimes(stage === "first" ? 1 : 2);
  });
  it("refreshes its observations when the parent data revision changes and keeps the analytical return path", async () => {
    const source = sourcesFilled.sources[0];
    const detail = sourceDetailOf(source);
    const first = { ...detail, answers: [{ ...detail.answers[0], question: "原修订的回答" }] };
    const next = { ...detail, answers: [{ ...detail.answers[0], snapshotId: "new_snapshot", question: "新修订的回答" }] };
    client.getGeoSource.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const project = geoProject();
    const node = (revision: string) => <MemoryRouter initialEntries={["/app/geo/g/sources?from=2026-10-01&engines=kimi&session=s1"]}>
      <GeoSourceDrawer geoId="g" project={{ ...project, selection: { dataRevision: revision } as GeoSelection }} source={source} engine="all" focus={null} onClose={vi.fn()} />
    </MemoryRouter>;
    const shown = render(node("first"));
    const before = await screen.findByRole("link", { name: /原修订的回答/ });
    expect(before.getAttribute("href")).toContain("from=2026-10-01");
    expect(before.getAttribute("href")).toContain("session=s1");
    shown.rerender(node("changed"));
    await waitFor(() => expect(client.getGeoSource).toHaveBeenCalledTimes(2));
    await screen.findByRole("link", { name: /新修订的回答/ });
    expect(screen.queryByRole("link", { name: /原修订的回答/ })).not.toBeInTheDocument();
  });
});
