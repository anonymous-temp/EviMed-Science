import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { SearchWorkspaceNav } from "./SearchWorkspaceNav";

const open = (entry: string) => render(<MemoryRouter initialEntries={[entry]}><SearchWorkspaceNav /></MemoryRouter>);

it("lists the four categories, marking the open one, and carries the keyword", () => {
  open("/app/search/guidelines?q=%E9%AB%98%E8%A1%80%E5%8E%8B&page=3");
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["搜文献", "查指南", "找药品", "临床试验"]);
  expect(screen.getByRole("link", { name: "查指南" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "查指南" })).toHaveAttribute("href", `/app/search/guidelines?q=${encodeURIComponent("高血压")}&page=3`);
  expect(screen.getByRole("link", { name: "找药品" })).toHaveAttribute("href", `/app/search/drugs?q=${encodeURIComponent("高血压")}`);
});
it("treats the bare address as literature and adds no query without a keyword", () => {
  open("/app/search");
  expect(screen.getByRole("link", { name: "搜文献" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "临床试验" })).toHaveAttribute("href", "/app/search/trials");
});
