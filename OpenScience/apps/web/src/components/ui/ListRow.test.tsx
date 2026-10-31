import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router";
import { describe, expect, it } from "vitest";
import { ListRow } from "./ListRow";

function Probe() {
  const location = useLocation();
  const action = useNavigationType();
  return <output>{`${location.pathname}${location.search} ${action}`}</output>;
}

describe("ListRow history", () => {
  it("a click on the row already open adds no history entry, so Back leaves it in one press", async () => {
    render(<MemoryRouter initialEntries={["/list"]}><ListRow title="文档" to="/doc?q=a" /><Probe /></MemoryRouter>);
    fireEvent.click(screen.getByRole("link", { name: "文档" }));
    expect((await screen.findByText("/doc?q=a PUSH")).tagName).toBe("OUTPUT");
    fireEvent.click(screen.getByRole("link", { name: "文档" }));
    expect((await screen.findByText("/doc?q=a REPLACE")).tagName).toBe("OUTPUT");
  });

  it("a row told to replace replaces on its first click", async () => {
    render(<MemoryRouter initialEntries={["/list"]}><ListRow title="文档" to="/doc" replace /><Probe /></MemoryRouter>);
    fireEvent.click(screen.getByRole("link", { name: "文档" }));
    expect((await screen.findByText("/doc REPLACE")).tagName).toBe("OUTPUT");
  });
});
