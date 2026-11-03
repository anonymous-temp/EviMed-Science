import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { geoProject } from "./__fixtures__/geoTabs";
import { GeoWorkDetails } from "./GeoWorkDetails";

function renderDetails(project = geoProject()) {
  const onOpenRuns = vi.fn(), onOpenSettings = vi.fn();
  render(<MemoryRouter initialEntries={["/app/geo/geo_1/answers/snap?round=r1&conversation=open&session=ses1"]}><GeoWorkDetails project={project} onOpenRuns={onOpenRuns} onOpenSettings={onOpenSettings} /></MemoryRouter>);
  return { onOpenRuns, onOpenSettings };
}

it("shows real product context and no invented progress", async () => {
  renderDetails(geoProject({}, { product: { brandName: "品牌", indication: "适用人群" } }));
  expect(screen.getByText("品牌")).toBeInTheDocument();
  expect(screen.getByText("适用人群")).toBeInTheDocument();
  const disclosure = screen.getByText("任务进度");
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
  await userEvent.click(disclosure);
  expect(screen.getByText("暂无任务进度。")).toBeVisible();
  expect(screen.queryByText("未请求")).toBeNull();
});

it("shows requested and failed steps with scoped destinations", async () => {
  renderDetails(geoProject({ evidence: "failed", journey: "done" }));
  await userEvent.click(screen.getByText(/任务进度/));
  const details = screen.getByText(/任务进度/).closest("details")!;
  expect(within(details).getByText(/未完成|失败/)).toBeVisible();
  const evidence = within(details).getByRole("link", { name: "证据" });
  expect(evidence.getAttribute("href")).toContain("/app/geo/geo_1/evidence");
  expect(evidence.getAttribute("href")).toContain("conversation=open");
  expect(evidence.getAttribute("href")).toContain("session=ses1");
  expect(evidence.getAttribute("href")).toContain("round=r1");
  expect(screen.getByRole("link", { name: "患者旅程" }).getAttribute("href")).toContain("view=journey");
});

it("calls the existing actions without editing project data", async () => {
  const actions = renderDetails(geoProject({}, { access: { owner: false, roles: ["viewer"], abilities: ["view"] } }));
  await userEvent.click(screen.getByRole("button", { name: "执行详情" }));
  await userEvent.click(screen.getByRole("button", { name: "项目设置" }));
  expect(actions.onOpenRuns).toHaveBeenCalledOnce();
  expect(actions.onOpenSettings).toHaveBeenCalledOnce();
});

it("keeps recent activity linked to its exact answer and current scope", async () => {
  const original = geoProject();
  renderDetails({ ...original, overview: { ...original.overview, week: [{ kind: "wrong_ours", text: "发现一条讲错", tab: "diagnosis", ref: { snapshotId: "snap_2" }, at: "2026-10-20T01:00:00Z" }] } });
  await userEvent.click(screen.getByText("本周（1）"));
  const event = screen.getByRole("link", { name: /发现一条讲错/ });
  expect(event).toHaveAttribute("href", expect.stringContaining("/app/geo/geo_1/answers/snap_2"));
  expect(event).toHaveAttribute("href", expect.stringContaining("round=r1"));
  expect(event).toHaveAttribute("href", expect.stringContaining("session=ses1"));
});
