import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs";

function Example() {
  const [value, setValue] = useState("daily");
  return <Tabs label="简报周期" items={[{ value: "daily", label: "日报" }, { value: "weekly", label: "周报" }]} value={value} onChange={setValue} panelId="brief" />;
}
describe("Tabs", () => {
  it("keeps mobile tabs on a scrolling row and preserves keyboard selection", async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(screen.getByRole("tablist")).toHaveClass("overflow-x-auto");
    const daily = screen.getByRole("tab", { name: "日报" });
    const weekly = screen.getByRole("tab", { name: "周报" });
    expect(daily).toHaveClass("shrink-0", "whitespace-nowrap");
    daily.focus();
    await user.keyboard("{ArrowRight}");
    expect(weekly).toHaveFocus();
    expect(weekly).toHaveAttribute("aria-selected", "true");
    expect(daily).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{Home}");
    expect(daily).toHaveFocus();
    expect(daily).toHaveAttribute("aria-controls", "brief");
    await user.keyboard("{End}{ArrowRight}");
    expect(daily).toHaveFocus();
  });
});
