import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { KnowledgeWorkspaceNav } from "./KnowledgeWorkspaceNav";

const open = (entry: string, pagesOffered: boolean) => render(<MemoryRouter initialEntries={[entry]}><KnowledgeWorkspaceNav pagesOffered={pagesOffered} /></MemoryRouter>);

it("shows 资料 and 对话产出 only where pages are not offered", () => {
  open("/app/files", false);
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["资料", "对话产出"]);
  expect(screen.getByRole("link", { name: "资料" })).toHaveAttribute("aria-current", "page");
});
it("shows all four, keeps the project and marks the open view", () => {
  open("/app/files?scope=p1&kind=wiki&view=graph", true);
  expect(screen.getAllByRole("link").map(link => link.textContent)).toEqual(["资料", "知识页", "图谱", "对话产出"]);
  expect(screen.getByRole("link", { name: "图谱" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "知识页" })).toHaveAttribute("href", "/app/files?scope=p1&kind=wiki");
  expect(screen.getByRole("link", { name: "对话产出" })).toHaveAttribute("href", "/app/files?scope=p1&view=outputs");
  expect(screen.getByRole("link", { name: "资料" })).toHaveAttribute("href", "/app/files");
});
it("keeps pages and graph while one is open even if not offered", () => {
  open("/app/files?scope=p1&kind=wiki", false);
  expect(screen.getAllByRole("link")).toHaveLength(4);
});
