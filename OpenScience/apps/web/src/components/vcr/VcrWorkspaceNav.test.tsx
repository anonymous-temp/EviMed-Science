import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it } from "vitest";
import { sessionOwner } from "@/lib/sessionLifecycle";
import { prepareRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { VcrWorkspaceNav } from "./VcrWorkspaceNav";
function Workspace() { const location = useLocation(); return <><VcrWorkspaceNav /><output aria-label="Location">{location.pathname + location.search}</output><output aria-label="State">{JSON.stringify(location.state)}</output></>; }
it("exposes five entrances, no records row, with the selected entrance", () => {
  render(<MemoryRouter initialEntries={["/app/virtual-research?area=virtual-lab"]}><Workspace /></MemoryRouter>);
  const nav = screen.getByRole("navigation", { name: "虚拟临床研究工作区" });
  expect(within(nav).getAllByRole("link").map(link => link.textContent)).toEqual(["虚拟人群", "患者轨迹预测", "虚拟实验室", "合成对照臂", "患者匹配"]);
  expect(within(nav).getByRole("link", { name: "虚拟实验室" })).toHaveAttribute("aria-current", "page");
});
it("preserves pending native intent and the same study conversation through result navigation", async () => {
  const state = { runtimeUiIntent: prepareRuntimeUiIntent({ kind: "open", projectId: "p1", sessionId: "s1", requestId: "vcr-pending", draft: "Continue this research", owner: sessionOwner() }) };
  render(<MemoryRouter initialEntries={[{ pathname: "/app/virtual-research/std_1/chat", search: "?session=s1&conversation=open&result=trial", state }]}><Workspace /></MemoryRouter>);
  await userEvent.click(screen.getByRole("link", { name: "患者轨迹预测" }));
  expect(screen.getByLabelText("Location")).toHaveTextContent("/app/virtual-research/std_1/chat?session=s1&conversation=open&level=individual&view=forecast&result=population");
  expect(JSON.parse(screen.getByLabelText("State").textContent!)).toEqual(state);
  expect(screen.getByRole("link", { name: "患者轨迹预测" })).toHaveAttribute("aria-current", "page");
});
it("sanitizes legacy payloads before copying native history state", async () => {
  render(<MemoryRouter initialEntries={[{ pathname: "/app/virtual-research", state: { runtimeUiIntent: { draft: "legacy", projectId: "p1" }, kept: "value" } }]}><Workspace /></MemoryRouter>);
  await userEvent.click(screen.getByRole("link", { name: "虚拟人群" }));
  expect(JSON.parse(screen.getByLabelText("State").textContent!)).toEqual({ kept: "value" });
});
it("reads a legacy area address as its entrance and marks nothing for the archive", () => {
  const { unmount } = render(<MemoryRouter initialEntries={["/app/virtual-research?area=virtual-patient"]}><Workspace /></MemoryRouter>);
  expect(screen.getByRole("link", { name: "患者轨迹预测" })).toHaveAttribute("aria-current", "page"); unmount();
  render(<MemoryRouter initialEntries={["/app/virtual-research?area=records"]}><Workspace /></MemoryRouter>);
  expect(within(screen.getByRole("navigation", { name: "虚拟临床研究工作区" })).queryAllByRole("link").filter(link => link.getAttribute("aria-current"))).toEqual([]);
});
it("leaves a modified click to the browser", () => {
  render(<MemoryRouter initialEntries={["/app/virtual-research"]}><Workspace /></MemoryRouter>);
  const link = screen.getByRole("link", { name: "患者匹配" });
  expect(link).toHaveAttribute("href", "/app/virtual-research?area=patient-matching");
  // The router must not intercept it (the browser opens the new tab); jsdom has no navigation, so the test stops the default itself.
  let routerHandled = true;
  const observe = (event: Event) => { routerHandled = event.defaultPrevented; event.preventDefault(); };
  document.addEventListener("click", observe);
  fireEvent.click(link, { ctrlKey: true });
  document.removeEventListener("click", observe);
  expect(routerHandled).toBe(false);
  expect(screen.getByLabelText("Location")).toHaveTextContent("/app/virtual-research");
  expect(screen.getByLabelText("Location")).not.toHaveTextContent("area=");
});
