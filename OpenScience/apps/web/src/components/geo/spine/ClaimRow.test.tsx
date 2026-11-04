import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ClaimRow } from "./ClaimRow";
import type { ClaimRow as ClaimRowModel } from "./errorModel";

it("labels an open ungraded finding instead of presenting it as a low severity", () => {
  const claim: ClaimRowModel = { key: "claim", statement: "Example", claimId: null, engines: ["deepseek"], count: 1,
    severity: null, status: "open", urgent: false, snapshotId: null, evidenceQuote: null,
    rows: [{ id: "error", engine: "deepseek", statement: "Example", severity: null, errorType: "number", stability: null,
      citedSource: null, action: null, status: "open", snapshotId: null }], traces: [] };
  render(<ClaimRow claim={claim} corrections={[]} selected={false} canRun={false} busy={false} onOpen={vi.fn()} onCorrect={vi.fn()} />);
  expect(screen.getByText(/严重程度未知/)).toBeVisible();
  expect(screen.queryByText("S0")).not.toBeInTheDocument();
});
