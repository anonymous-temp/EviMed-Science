import { describe, expect, it } from "vitest";
import { resultCardClaims } from "./resultCardClaims";

const matrix = JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "卒中更少。", claimType: "direct" },
  { claimId: "CLM-002", claim: "出血减半。" },
  { claimId: "CLM-003", claim: "约少 50 例。", claimType: "derived" },
  { claimId: "CLM-004", claim: "  方向一致。  ", claimType: "synthesized" },
  { claimId: 7, claim: "no id" },
  { claimId: "CLM-005", claim: "   " },
] });
const verification = { counts: { verified: 1, quote_not_found: 1, derived: 1 }, claims: [
  { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [] },
  { claimId: "CLM-002", claimType: "direct", status: "quote_not_found", sources: [] },
  { claimId: "CLM-003", claimType: "derived", status: "derived", sources: [] },
] };

describe("the claims the publish dialog lists", () => {
  it("joins each claim of the matrix to the verdict the run's gate stored", () => {
    expect(resultCardClaims({ review: { status: "available", matrixText: matrix, verification } })).toEqual([
      { claimId: "CLM-001", text: "卒中更少。", claimType: "direct", status: "verified" },
      { claimId: "CLM-002", text: "出血减半。", claimType: "direct", status: "quote_not_found" },
      { claimId: "CLM-003", text: "约少 50 例。", claimType: "derived", status: "derived" },
      { claimId: "CLM-004", text: "方向一致。", claimType: "synthesized", status: "unknown" },
    ]);
  });
  it("is empty when no matrix can be read: not clinical, withheld, or not JSON", () => {
    expect(resultCardClaims({})).toEqual([]);
    expect(resultCardClaims({ review: { status: "unavailable", matrixVersionId: "rv_1" } })).toEqual([]);
    expect(resultCardClaims({ review: { status: "available", matrixText: "not json" } })).toEqual([]);
    expect(resultCardClaims({ review: { status: "available", matrixText: JSON.stringify({ claims: "no" }) } })).toEqual([]);
  });
});
