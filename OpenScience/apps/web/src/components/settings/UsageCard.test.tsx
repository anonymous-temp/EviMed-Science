import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageCard } from "./UsageCard";
import { WebApiError } from "@/lib/apiClient";

const mocks = vi.hoisted(() => ({ fetchWebAccountUsage: vi.fn() }));

// The error dictionary (`webErrorMessage`) lives in this module and the code
// under test calls it, so the real exports come through and only the calls
// this test drives are replaced.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
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
    // One model serves every run; its id is an engine internal and stays off
    // a researcher's bill.
    expect(screen.queryByText(/deepseek-v4-pro/)).not.toBeInTheDocument();
    expect(screen.getByText(/不是账单，也不会触发收款/)).toBeInTheDocument();
  });

  it("distinguishes active reservations from calls awaiting reconciliation", async () => {
    mocks.fetchWebAccountUsage.mockResolvedValue({ ...summary, reservedCalls: 2, uncertainCalls: 1, reservedCost: 0.75 });
    render(<UsageCard />);
    expect(await screen.findByText(/2 次调用已预留额度/)).toBeInTheDocument();
    expect(screen.getByText(/1 次调用的实际用量还在核对，先按预估的 0\.75 CNY 计入额度/)).toBeInTheDocument();
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
    mocks.fetchWebAccountUsage.mockRejectedValue(
      new WebApiError("HTTP 503", { status: 503, code: "runtime_unavailable" }),
    );
    render(<UsageCard />);
    expect(await screen.findByText(/读取用量失败：运行时出现问题，稍后重试。/)).toBeInTheDocument();
    expect(screen.queryByText("本月还没有模型调用。")).not.toBeInTheDocument();
  });
});
