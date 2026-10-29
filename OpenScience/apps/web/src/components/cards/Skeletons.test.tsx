import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesSkeleton, MemorySkeleton, RunsSkeleton } from "./Skeletons";

const cases = [
  ["files", <FilesSkeleton key="files" />],
  ["runs", <RunsSkeleton key="runs" />],
  ["runs without the filter bar", <RunsSkeleton key="runs-plain" filter={false} />],
  ["memory", <MemorySkeleton key="memory" />],
] as const;

describe("page skeletons", () => {
  afterEach(() => vi.useRealTimers());
  it.each(cases)("%s renders an aria-hidden pulse placeholder", (_name, ui) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const { container } = render(ui);
    expect(container).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(300));
    const root = container.firstElementChild;
    expect(root).toHaveClass("animate-pulse");
    expect(root).toHaveAttribute("aria-hidden", "true");
  });
});
