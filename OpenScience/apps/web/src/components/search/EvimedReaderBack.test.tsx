import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { expect, it } from "vitest";
import { EvimedReaderBack } from "./EvimedReaderBack";

const readerPath = "/app/search/literature?detail=one";
const fallback = "/app/search/literature?q=heart&page=2";
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>;
}
function open(entry: string | { pathname: string; search?: string; state?: unknown }) {
  render(<MemoryRouter initialEntries={[entry]}>
    <Location />
    <Routes>
      <Route path="/app/search/literature" element={<EvimedReaderBack fallback={fallback} />} />
      <Route path="*" element={<Link to={readerPath}>打开详情</Link>} />
    </Routes>
  </MemoryRouter>);
}

it("returns to a different in-app entry page with its query and anchor", async () => {
  const origin = "/app/frontier?view=hot#latest";
  open(origin);
  await userEvent.click(screen.getByRole("link", { name: "打开详情" }));
  await userEvent.click(screen.getByRole("link", { name: "返回" }));
  expect(screen.getByTestId("location").textContent).toBe(origin);
});

it("uses a persisted entry source when a reader is loaded directly or refreshed", async () => {
  const origin = "/app/files?view=collections";
  open({ pathname: "/app/search/literature", search: "?detail=one", state: { returnTo: origin } });
  expect(screen.getByRole("link", { name: "返回" })).toHaveAttribute("href", origin);
  await userEvent.click(screen.getByRole("link", { name: "返回" }));
  expect(screen.getByTestId("location").textContent).toBe(origin);
});

it.each([undefined, "https://example.org/outside", readerPath])("uses the category fallback when the source is missing, external or self-referential: %s", async returnTo => {
  open({ pathname: "/app/search/literature", search: "?detail=one", state: { returnTo } });
  await userEvent.click(screen.getByRole("link", { name: "返回" }));
  expect(screen.getByTestId("location").textContent).toBe(fallback);
});
