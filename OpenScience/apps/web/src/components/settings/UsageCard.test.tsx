import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageCard } from "./UsageCard";

const mocks = vi.hoisted(() => ({ fetchWebAccountUsage: vi.fn() }));

vi.mock("@/lib/apiClient", () => ({
  fetchWebAccountUsage: mocks.fetchWebAccountUsage,
}));

const summary = {
  since: "2026-09-01T00:00:00.000Z",
  calls: 12,
  cost: 3.4567,
  currency: "CNY",
  promptTokens: 1_234_567,
  completionTokens: 89_012,
  unpricedCalls: 0,
  byModel: [{ model: "deepseek-v4-pro", calls: 12, cost: 3.4567 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchWebAccountUsage.mockResolvedValue(summary);
});

describe("UsageCard", () => {
  it("shows the month's calls, tokens and converted amount", async () => {
    render(<UsageCard />);
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("3.46")).toBeInTheDocument();
    expect(screen.getByText(/deepseek-v4-pro/)).toBeInTheDocument();
  });

  // A zero cost that means "free" and one that means "we have no price for
  // this model" lead to different actions, so the second one says which.
  it("says when a call was counted but not priced", async () => {
    mocks.fetchWebAccountUsage.mockResolvedValue({ ...summary, unpricedCalls: 3 });
    render(<UsageCard />);
    expect(await screen.findByText(/3 次调用的模型不在价目表里/)).toBeInTheDocument();
  });

  it("says so when nothing has been spent yet", async () => {
    mocks.fetchWebAccountUsage.mockResolvedValue({ ...summary, calls: 0, cost: 0, byModel: [] });
    render(<UsageCard />);
    expect(await screen.findByText("本月还没有模型调用。")).toBeInTheDocument();
  });

  it("reports a read failure instead of showing zero usage", async () => {
    mocks.fetchWebAccountUsage.mockRejectedValue(new Error("HTTP 503"));
    render(<UsageCard />);
    expect(await screen.findByText(/读取用量失败：HTTP 503/)).toBeInTheDocument();
    expect(screen.queryByText("本月还没有模型调用。")).not.toBeInTheDocument();
  });
});
