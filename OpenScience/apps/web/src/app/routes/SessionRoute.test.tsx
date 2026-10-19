import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/lib/projects";
import { SessionRoute } from "./SessionRoute";

const mocks = vi.hoisted(() => ({ association: vi.fn(), getProject: vi.fn() }));
vi.mock("@/components/geo/useGeoProjectIds", () => ({ useGeoAssociation: mocks.association }));
vi.mock("@/lib/geoClient", () => ({ getGeoProject: mocks.getProject }));
function Location() {
  const location = useLocation();
  return <pre data-testid="location">{JSON.stringify({ path: location.pathname, search: location.search, state: location.state })}</pre>;
}
function draw() {
  return render(<MemoryRouter initialEntries={[{ pathname: "/app/chat/ses_own", search: "?step=evidence", state: { draft: "kept" } }]}>
    <SessionRoute /><Location />
  </MemoryRouter>);
}
beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ currentId: "p-own" });
  mocks.association.mockReturnValue(null);
});

describe("ordinary conversations associated with GEO", () => {
  it("does no GEO request for an ordinary project", async () => {
    draw();
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses_own");
  });
  it("replaces the address after an authorized exact project match, preserving the session and context", async () => {
    mocks.association.mockReturnValue({ id: "geo_own" });
    mocks.getProject.mockResolvedValue({ id: "geo_own", projectId: "p-own", sessionId: "ses_other" });
    draw();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_own/chat/ses_own"));
    expect(screen.getByTestId("location")).toHaveTextContent("?step=evidence");
    expect(screen.getByTestId("location")).toHaveTextContent("kept");
  });
  it("does not trust a stale association or a refused project", async () => {
    mocks.association.mockReturnValue({ id: "geo_own" });
    mocks.getProject.mockResolvedValue({ id: "geo_own", projectId: "p-other" });
    draw();
    await act(async () => {});
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses_own");
  });
  it("cannot redirect after another project becomes current", async () => {
    let answer!: (project: object) => void;
    mocks.association.mockReturnValue({ id: "geo_own" });
    mocks.getProject.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    draw();
    await act(async () => {
      mocks.association.mockReturnValue(null);
      useProjectStore.setState({ currentId: "p-later" });
      answer({ id: "geo_own", projectId: "p-own", sessionId: "ses_own" });
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses_own");
  });
});
