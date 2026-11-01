import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { GEO_PROJECT } from "../__fixtures__/geoProjects";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { actionFixture } from "../__fixtures__/geoSpine";
import { OwnedLinkForm } from "./OwnedLinkForm";

const client = vi.hoisted(() => ({ createGeoOwnedLink: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...client }));

const action = actionFixture({ key: "a1", kind: "brand" });
const source = { domain: "example.org", channel: "own_site", name: "官网", kind: "own", layer: null, why: null, citedFor: {}, conditions: {}, price: null, placeable: true } as never;

/** The project, with or without the agreement to monitor automatically (for these engines and this window). */
const withAgreement = (agreed: boolean) => {
  if (!agreed) return { ...GEO_PROJECT, steps: { ...GEO_PROJECT.steps, monitoring: { ...GEO_PROJECT.steps.monitoring, automation: undefined } } };
  return { ...GEO_PROJECT, steps: { ...GEO_PROJECT.steps, monitoring: { ...GEO_PROJECT.steps.monitoring, automation: { state: "confirmed" as const, actorId: "actor", at: "2026-10-01T00:00:00Z", engines: [...GEO_PROJECT.engines], coverageDays: GEO_PROJECT.coverageDays } } } };
};

async function register(agreed: boolean) {
  render(<MemoryRouter><GeoFrameHarness project={withAgreement(agreed)}><OwnedLinkForm geoId="geo_masi" action={action} source={source} articleId="art_1" onRegistered={() => undefined} /></GeoFrameHarness></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "我已发布，贴链接" }));
  await userEvent.type(screen.getByLabelText("发布后的页面链接"), "https://example.org/a");
  const send = screen.getByRole("button", { name: "登记" });
  expect(send).toHaveAttribute("data-action-kind", "set");
  await userEvent.click(send);
  await waitFor(() => expect(client.createGeoOwnedLink).toHaveBeenCalled());
  return useToastStore.getState().toasts.map((toast) => toast.message);
}

beforeEach(() => {
  client.createGeoOwnedLink.mockReset().mockResolvedValue({});
  useToastStore.setState({ toasts: [] });
});

describe("登记链接: what the toast promises about the re-measurements", () => {
  it("promises the weekly rounds after publication when the agreement to monitor is in force", async () => {
    expect(await register(true)).toEqual(["已登记，发布后第 1、2、4、8、12 周会自动复测。"]);
  });

  it("promises none without it: it says they begin once monitoring is turned on", async () => {
    const said = await register(false);
    expect(said).toEqual(["已登记。开启自动监测后，发布后第 1、2、4、8、12 周会自动复测。"]);
    expect(said[0]).not.toBe("已登记，发布后第 1、2、4、8、12 周会自动复测。");
  });
});
