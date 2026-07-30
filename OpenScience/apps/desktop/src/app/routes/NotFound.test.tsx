import { isValidElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { routes } from "@/app/router";
import { NotFound } from "./NotFound";

describe("NotFound", () => {
  it("shows a Chinese 404 with a link back home", () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByText("404 · 页面不存在")).toBeInTheDocument();
    expect(screen.getByText("你访问的页面不存在或已被移动。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute("href", "/");
  });

  it("is the catch-all route now that the legacy redirects are gone", () => {
    const shell = routes.find((route) => route.path === "/");
    const paths = shell?.children?.map((route) => route.path) ?? [];
    expect(paths).not.toContain("skills");
    expect(paths).not.toContain("example/:sessionId");

    const catchAll = shell?.children?.find((route) => route.path === "*");
    expect(isValidElement(catchAll?.element)).toBe(true);
    if (isValidElement(catchAll?.element)) {
      expect(catchAll.element.type).toBe(NotFound);
    }
  });
});
