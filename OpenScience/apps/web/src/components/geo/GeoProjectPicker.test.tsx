import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { GeoProjectPicker } from "./GeoProjectPicker";
import { GEO_SUMMARIES } from "./__fixtures__/geoProjects";

vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), listGeoProjects: async () => GEO_SUMMARIES }));
function Scene({ destination }: { destination?: "evidence" } = {}) {
  const location = useLocation();
  return <><GeoProjectPicker project={{ id: "geo_masi", name: "玛仕度肽注射液" }} destination={destination} /><output aria-label="Location">{location.pathname + location.search}</output><output aria-label="State">{JSON.stringify(location.state)}</output></>;
}
it("switches the entire project without carrying its session, objects or pending draft", async () => {
  render(<MemoryRouter initialEntries={[{ pathname: "/app/geo/geo_masi/accuracy", search: "?session=private&groupIds=old&conversation=open", state: { privateDraft: "keep with original" } }]}><Scene /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: /当前项目：玛仕度肽注射液/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /米曲菌胰酶片/ }));
  expect(screen.getByLabelText("Location")).toHaveTextContent("/app/geo/geo_mitiao/accuracy");
  expect(screen.getByLabelText("Location")).not.toHaveTextContent("?");
  expect(screen.getByLabelText("State")).toHaveTextContent("null");
});
it("reselects the current project without discarding the current scope or draft", async () => {
  render(<MemoryRouter initialEntries={[{ pathname: "/app/geo/geo_masi/accuracy", search: "?session=kept&round=r1", state: { draft: "kept" } }]}><Scene /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: /当前项目：玛仕度肽注射液/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /玛仕度肽注射液/ }));
  expect(screen.getByLabelText("Location")).toHaveTextContent("?session=kept&round=r1");
  expect(screen.getByLabelText("State")).toHaveTextContent('"draft":"kept"');
});

it("keeps the resolved work area of a legacy analysis while clearing project-specific selections", async () => {
  render(<MemoryRouter initialEntries={["/app/geo/geo_masi/visibility?analysis=V10&selectionRef=old"]}><Scene destination="evidence" /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: /当前项目：玛仕度肽注射液/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /米曲菌胰酶片/ }));
  expect(screen.getByLabelText("Location")).toHaveTextContent("/app/geo/geo_mitiao/evidence");
  expect(screen.getByLabelText("Location")).not.toHaveTextContent("?");
});
