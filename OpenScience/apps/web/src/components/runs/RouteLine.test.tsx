import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WebAgentRun, WebResearchAgent } from "@/lib/apiClient";
import { RouteLine } from "./RouteLine";

function run(over: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id: "run_1",
    sessionId: "web-1",
    status: "running",
    mode: "specialist",
    agentId: "clinical-evidence-synthesis",
    effectiveAgentId: "clinical-evidence-synthesis",
    routeReason: "题面是一个需要逐条核验文献的临床问题",
    estimatedMinutes: { min: 15, max: 30 },
    artifacts: [],
    ...over,
  } as WebAgentRun;
}

const catalog = [
  { id: "clinical-evidence-synthesis", version: "2.13.0", title: "x", category: "x", estimatedMinutes: [15, 30] },
  { id: "meta-analysis", version: "1.0.0", title: "x", category: "x", estimatedMinutes: [30, 180] },
  { id: "adr-analysis", version: "1.0.0", title: "x", category: "x", estimatedMinutes: [20, 40] },
] as unknown as WebResearchAgent[];

describe("RouteLine", () => {
  it("says which line, how long it usually takes, and why", () => {
    const { container } = render(<RouteLine run={run()} />);
    expect(container.textContent).toContain("按 临床证据深度分析 处理");
    expect(container.textContent).toContain("通常 15–30 分钟");
    expect(screen.getByText("题面是一个需要逐条核验文献的临床问题")).toBeInTheDocument();
    // Informative only without a change handler.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers the answer line and the other capabilities, grouped, when the line can change", async () => {
    const onReroute = vi.fn();
    render(<RouteLine run={run()} catalog={catalog} onReroute={onReroute} />);

    await userEvent.click(screen.getByRole("button", { name: "改为普通问答" }));
    expect(onReroute).toHaveBeenLastCalledWith({ kind: "open-domain" }, "普通问答");

    const more = screen.getByRole("button", { name: /其他能力/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    // The current capability is not offered as a change to itself.
    expect(screen.queryByRole("button", { name: "改为临床证据深度分析" })).not.toBeInTheDocument();
    const group = screen.getByRole("group", { name: "其他能力" });
    expect(within(group).getByRole("button", { name: "改为药品安全性分析" })).toHaveAttribute("title", "药学评价");
    await userEvent.click(within(group).getByRole("button", { name: "改为药品安全性分析" }));
    expect(onReroute).toHaveBeenLastCalledWith(
      { kind: "capability", agentId: "adr-analysis", agentVersion: "1.0.0" },
      "药品安全性分析",
    );
    // The list closes once a line is chosen.
    expect(screen.queryByRole("group", { name: "其他能力" })).not.toBeInTheDocument();
  });

  it("does not offer the answer line to a run already on it", () => {
    render(
      <RouteLine
        run={run({ mode: "open-domain", agentId: null, effectiveAgentId: "open-domain-answer", routeReason: null, estimatedMinutes: null })}
        catalog={catalog}
        onReroute={vi.fn()}
      />,
    );
    expect(screen.getByText("普通问答", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "改为普通问答" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /其他能力/ })).toBeInTheDocument();
  });

  it("disables the changes while one is in flight", () => {
    render(<RouteLine run={run()} catalog={catalog} onReroute={vi.fn()} busy />);
    expect(screen.getByRole("button", { name: "改为普通问答" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /其他能力/ })).toBeDisabled();
  });
});
