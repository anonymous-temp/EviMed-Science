import { expect, it } from "vitest";
import { isPanePath } from "./taskPane";
it("admits only the active research page itself as a native conversation pane", () => {
  expect(isPanePath("/app/active-research")).toBe(true);
  expect(isPanePath("/app/active-research/")).toBe(true);
  expect(isPanePath("/app/active-research/other")).toBe(false);
});
