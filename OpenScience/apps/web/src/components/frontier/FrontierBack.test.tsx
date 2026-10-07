import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { FrontierBack, evidenceFromState } from "./FrontierBack";

const mount = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("the way back from the evidence pages", () => {
  it("is 「‹ 前沿动态」 by default, with the pages in between after it", () => {
    mount(<FrontierBack trail={[{ label: "证据专区", to: "/app/frontier/zones" }, { label: "房颤抗凝", to: "/app/frontier/zones/ez_1" }]} />);
    const nav = screen.getByRole("navigation", { name: "返回" });
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["前沿动态", "/app/frontier"], ["证据专区", "/app/frontier/zones"], ["房颤抗凝", "/app/frontier/zones/ez_1"],
    ]);
  });

  it("names the page the reader came from instead of 前沿动态 when it is told one", () => {
    mount(<FrontierBack to="/app/frontier/zones/ez_1/evidence/ec_1" label="试验药能预防卒中吗" />);
    const link = within(screen.getByRole("navigation", { name: "返回" })).getByRole("link");
    expect(link).toHaveAccessibleName("试验药能预防卒中吗");
    expect(link).toHaveAttribute("href", "/app/frontier/zones/ez_1/evidence/ec_1");
  });
});

describe("evidenceFrom in a link's router state", () => {
  it("is a path inside the app and a label, and nothing else", () => {
    expect(evidenceFromState({ evidenceFrom: { to: "/app/frontier/zones/ez_1/evidence/ec_1", label: " 试验药能预防卒中吗 " } })).toEqual({ to: "/app/frontier/zones/ez_1/evidence/ec_1", label: "试验药能预防卒中吗" });
  });
  it("is read as untrusted: a history entry can hold anything", () => {
    for (const state of [null, undefined, "x", 3, {}, { evidenceFrom: null }, { evidenceFrom: "x" }, { evidenceFrom: { to: "/app/x" } }, { evidenceFrom: { label: "卡" } },
      { evidenceFrom: { to: "https://example.org/", label: "卡" } }, { evidenceFrom: { to: "//example.org/app/", label: "卡" } }, { evidenceFrom: { to: "javascript:alert(1)", label: "卡" } },
      { evidenceFrom: { to: "/app/x", label: "   " } }, { evidenceFrom: { to: "/app/x", label: 4 } }, { evidenceFrom: { to: "/app/ x", label: "卡" } }]) {
      expect(evidenceFromState(state)).toBeNull();
    }
  });
});
