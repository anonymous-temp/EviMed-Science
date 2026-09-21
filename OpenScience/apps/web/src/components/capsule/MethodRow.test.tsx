import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MethodRow } from "./MethodRow";

vi.mock("@/lib/memoryClient", () => ({ announceMemoryChanged: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** A learned method with only the fields a row reads. */
function method(overrides: Record<string, unknown> = {}) {
  return {
    id: "method:learned:pre-submission-freeze-check", projectId: null, revision: 1,
    name: "pre-submission-freeze-check",
    description: "Runs the last guards on a finished, source-grounded deliverable before its bytes are frozen.",
    whenToUse: "When a finished deliverable is one step away from submission.",
    status: "approved", statusReason: null, origin: "inferred", counts: null, evaluations: [],
    promotion: { status: "approved", reasons: [], missing: [] }, body: "",
    statusChangedAt: null, createdAt: "2026-09-21T06:00:00Z", updatedAt: "2026-09-21T06:00:00Z",
    ...overrides,
  } as never;
}

afterEach(cleanup);

describe("one learned method, as a line of 我的做法", () => {
  it("reads the researcher's own line, never the model's English name, when it has one", () => {
    // 2026-09-21: the page printed 「claim-verdict-audit：Re-verifies the
    // statements of…」 to a Chinese reader.
    render(<ul><MethodRow method={method({ title: "定稿前的冻结检查", summary: "提交前先固定每个附件的副本，再在要冻结的那一版上跑最后几道检查。" })} onChanged={vi.fn()} /></ul>);
    expect(screen.getByText(/定稿前的冻结检查：提交前先固定每个附件的副本/)).toBeInTheDocument();
    expect(screen.queryByText(/pre-submission-freeze-check/)).not.toBeInTheDocument();
  });

  it("falls back to the method's own name and description until it has a line", () => {
    render(<ul><MethodRow method={method()} onChanged={vi.fn()} /></ul>);
    expect(screen.getByText(/pre-submission-freeze-check：Runs the last guards/)).toBeInTheDocument();
  });
});
