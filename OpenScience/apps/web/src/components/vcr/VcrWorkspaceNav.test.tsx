import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it } from "vitest";
import { sessionOwner } from "@/lib/sessionLifecycle";
import { prepareRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { VcrWorkspaceNav } from "./VcrWorkspaceNav";
function Workspace() { const location = useLocation(); return <><VcrWorkspaceNav /><output aria-label="Location">{location.pathname + location.search}</output><output aria-label="State">{JSON.stringify(location.state)}</output></>; }
it("exposes six module directories with the selected area", () => {
  render(<MemoryRouter initialEntries={["/app/virtual-research?area=virtual-trial"]}><Workspace /></MemoryRouter>);
  const nav = screen.getByRole("navigation", { name: "虚拟临床研究工作区" });
  expect(within(nav).getAllByRole("link").map(link => link.textContent)).toEqual(["研究记录", "虚拟队列", "虚拟患者", "合成对照臂", "虚拟试验", "患者匹配"]);
  expect(within(nav).getByRole("link", { name: "虚拟试验" })).toHaveAttribute("aria-current", "page");
});
it("preserves pending native intent and the same study conversation through result navigation", async () => {
  const state = { runtimeUiIntent: prepareRuntimeUiIntent({ kind: "open", projectId: "p1", sessionId: "s1", requestId: "vcr-pending", draft: "Continue this research", owner: sessionOwner() }) };
  render(<MemoryRouter initialEntries={[{ pathname: "/app/virtual-research/std_1/chat", search: "?session=s1&conversation=open&result=trial", state }]}><Workspace /></MemoryRouter>);
  await userEvent.click(screen.getByRole("link", { name: "虚拟患者" }));
  expect(screen.getByLabelText("Location")).toHaveTextContent("/app/virtual-research/std_1/chat?session=s1&conversation=open&level=individual&result=population");
  expect(JSON.parse(screen.getByLabelText("State").textContent!)).toEqual(state);
  expect(screen.getByRole("link", { name: "虚拟患者" })).toHaveAttribute("aria-current", "page");
});
it("sanitizes legacy payloads before copying native history state", async () => {
  render(<MemoryRouter initialEntries={[{ pathname: "/app/virtual-research", state: { runtimeUiIntent: { draft: "legacy", projectId: "p1" }, kept: "value" } }]}><Workspace /></MemoryRouter>);
  await userEvent.click(screen.getByRole("link", { name: "虚拟队列" }));
  expect(JSON.parse(screen.getByLabelText("State").textContent!)).toEqual({ kept: "value" });
});
