import { describe, expect, it } from "vitest";
import { displaySessionTitle } from "./sessionTitle";

describe("displaySessionTitle", () => {
  it("localizes OpenCode default session titles", () => {
    expect(displaySessionTitle("New session")).toBe("新科研会话");
    expect(displaySessionTitle("New session - 2026-07-17T03:39:59.605Z")).toMatch(/^科研会话 · /);
  });

  it("preserves meaningful model-generated titles", () => {
    expect(displaySessionTitle("利妥昔单抗证据分析")).toBe("利妥昔单抗证据分析");
    expect(displaySessionTitle(null)).toBe("科研会话");
  });
});
