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

  it("catches unknown paths inside the workbench and outside it", () => {
    const shell = routes.find((route) => route.path === "/app");
    const inside = shell?.children?.find((route) => route.path === "*");
    expect(isValidElement(inside?.element)).toBe(true);
    if (isValidElement(inside?.element)) expect(inside.element.type).toBe(NotFound);

    // A URL that never reaches the shell — a mistyped path at the root — must
    // land somewhere too. Without this the app renders nothing at all for it,
    // which reads as a broken deployment rather than a wrong address.
    const outside = routes.find((route) => route.path === "*");
    expect(isValidElement(outside?.element)).toBe(true);
    if (isValidElement(outside?.element)) expect(outside.element.type).toBe(NotFound);
  });

  it("keeps the pre-prefix paths reachable as redirects", () => {
    // These were linked to. A redirect costs one route each; dropping them
    // turns every existing link into a 404 that says nothing.
    const paths = routes.map((route) => route.path);
    for (const legacy of ["/live", "/live/:sessionId", "/runs", "/files", "/notebooks", "/memory", "/agents", "/settings"]) {
      expect(paths).toContain(legacy);
    }
  });
});
