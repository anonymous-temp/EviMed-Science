import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentsSkeleton, FilesSkeleton, MemorySkeleton, RunsSkeleton } from "./Skeletons";

const cases = [
  ["files", <FilesSkeleton key="files" />],
  ["runs", <RunsSkeleton key="runs" />],
  ["runs without the filter bar", <RunsSkeleton key="runs-plain" filter={false} />],
  ["memory", <MemorySkeleton key="memory" />],
  ["agents", <AgentsSkeleton key="agents" />],
] as const;

describe("page skeletons", () => {
  it.each(cases)("%s renders an aria-hidden pulse placeholder", (_name, ui) => {
    const { container } = render(ui);
    const root = container.firstElementChild;
    expect(root).toHaveClass("animate-pulse");
    expect(root).toHaveAttribute("aria-hidden", "true");
  });
});
