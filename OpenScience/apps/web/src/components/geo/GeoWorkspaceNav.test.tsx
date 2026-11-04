import { sessionOwner } from "@/lib/sessionLifecycle";
import { prepareRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it } from "vitest";
import { geoWorkspaceId, GeoWorkspaceNav } from "./GeoWorkspaceNav";

const state = {
  runtimeUiIntent: prepareRuntimeUiIntent({
    kind: "open", projectId: "p-masi", sessionId: "pending-session",
    requestId: "sidebar-pending", draft: "Only this project's pending draft", owner: sessionOwner(),
  }),
  other: "project private",
};

function Workspace() {
  const location = useLocation();
  const geoId = geoWorkspaceId(location.pathname);
  return <>
    {geoId && <GeoWorkspaceNav geoId={geoId} />}
    <output aria-label="Workspace location">{location.pathname + location.search}</output>
    <output aria-label="Workspace state">{JSON.stringify(location.state)}</output>
  </>;
}

function renderWorkspace() {
  render(<MemoryRouter initialEntries={[{
    pathname: "/app/geo/geo_masi/accuracy",
    search: "?conversation=open&session=pending-session",
    state,
  }]}><Workspace /></MemoryRouter>);
}

it("carries the pending intent to this project's result and settings links, with the same session", async () => {
  renderWorkspace();
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "AI 表现" }));
  expect(screen.getByLabelText("Workspace location")).toHaveTextContent("/geo/geo_masi/visibility?");
  expect(screen.getByLabelText("Workspace location")).toHaveTextContent("session=pending-session");
  expect(JSON.parse(screen.getByLabelText("Workspace state").textContent ?? "{}")).toEqual(state);
  await user.click(screen.getByRole("link", { name: "项目设置" }));
  expect(screen.getByLabelText("Workspace location")).toHaveTextContent("panel=settings");
  expect(JSON.parse(screen.getByLabelText("Workspace state").textContent ?? "{}")).toEqual(state);
});

it("keeps project selection and platform navigation outside the workspace links", () => {
  renderWorkspace();
  expect(screen.queryByRole("button", { name: /选择项目/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "返回平台" })).not.toBeInTheDocument();
});
