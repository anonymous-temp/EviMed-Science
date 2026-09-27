import { describe, expect, it } from "vitest";
import { navItemClasses } from "./NavItem";

const classes = (value: string) => value.split(/\s+/);

describe("navItemClasses", () => {
  // Spec §20.6: 36 high, 8 px padding and corner, 14 px text 8 px after its
  // icon; surface-2 under the pointer, the current one on accent-soft at 500.
  it("is the spec's navigation item, and the current one sits on accent-soft at 500", () => {
    const rest = classes(navItemClasses());
    expect(rest).toEqual(expect.arrayContaining(["h-control", "px-2", "rounded", "gap-2", "text-ui", "hover:bg-surface-2"]));
    expect(rest).not.toContain("bg-accent-soft");
    expect(rest).not.toContain("font-medium");

    const current = classes(navItemClasses({ current: true }));
    expect(current).toEqual(expect.arrayContaining(["h-control", "bg-accent-soft", "font-medium", "text-text"]));
    expect(current).not.toContain("hover:bg-surface-2");
  });

  it("lets a caller move the padding, never the height", () => {
    const indented = classes(navItemClasses({ className: "pl-7" }));
    expect(indented).toContain("pl-7");
    expect(indented).toContain("h-control");
  });
});
