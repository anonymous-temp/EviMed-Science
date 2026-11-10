import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { MemoryWorkspaceNav, memoryNavTab } from "./MemoryWorkspaceNav";

const open = (entry: string, overviewOffered = true) => render(<MemoryRouter initialEntries={[entry]}><MemoryWorkspaceNav overviewOffered={overviewOffered} /></MemoryRouter>);

it("lists the sections with their addresses and marks the open one", () => {
  open("/app/memory?tab=methods");
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["总览", "关于你", "做法", "收到的"]);
  expect(screen.getAllByRole("link").map(link => link.getAttribute("href"))).toEqual(["/app/memory/overview", "/app/memory?tab=self", "/app/memory?tab=methods", "/app/memory?tab=received"]);
  expect(screen.getByRole("link", { name: "做法" })).toHaveAttribute("aria-current", "page");
});
it("leaves 总览 out where it is not offered, unless it is open", () => {
  open("/app/memory?tab=self", false);
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["关于你", "做法", "收到的"]);
});
it("reads the addresses of each section", () => {
  expect(memoryNavTab("/app/memory/overview", "")).toBe("overview");
  expect(memoryNavTab("/app/memory/shared/tok", "")).toBe("received");
  expect(memoryNavTab("/app/memory/delivered/d1", "")).toBe("received");
  expect(memoryNavTab("/app/memory", "?method=m1")).toBe("methods");
  expect(memoryNavTab("/app/memory", "")).toBeNull();
});
