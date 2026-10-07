import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClaimMatrix } from "./useClaimMatrix";

const mocks = vi.hoisted(() => ({ readArtifact: vi.fn(), readClaimVerification: vi.fn() }));
vi.mock("@/lib/artifactFile", () => ({ readArtifact: mocks.readArtifact, readClaimVerification: mocks.readClaimVerification }));

const MATRIX = "deliverables/d1/clinical-evidence-matrix.json";
const file = (data: string) => ({ path: MATRIX, mime: "application/json", encoding: "utf8", size: data.length, data });
const matrix = JSON.stringify({ claims: [{ claimId: "CLM-001", claim: "结论。", claimType: "direct", supportQuote: "q" }] });
const checks = { claims: [{ claimId: "CLM-001", claimType: "direct", status: "verified", sources: [] }], counts: { verified: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readArtifact.mockResolvedValue(file(matrix));
});

describe("useClaimMatrix: what an empty set of checks means", () => {
  it("is loading until the checks are read, then ready with them", async () => {
    let arrive!: (value: unknown) => void;
    mocks.readClaimVerification.mockReturnValue(new Promise((resolve) => { arrive = resolve; }));
    const { result } = renderHook(() => useClaimMatrix(MATRIX, "workspace"));
    expect(result.current.verificationState).toBe("loading");
    await waitFor(() => expect(result.current.document?.claims.size).toBe(1));
    // The matrix is there and its checks are not: still loading, and an empty map is not "unchecked".
    expect(result.current.verificationState).toBe("loading");
    expect(result.current.verified.size).toBe(0);
    await act(async () => { arrive(checks); });
    expect(result.current.verificationState).toBe("ready");
    expect(result.current.verified.get("CLM-001")?.status).toBe("verified");
  });

  it("is unavailable when the checks cannot be read, whether the read fails or answers nothing", async () => {
    mocks.readClaimVerification.mockRejectedValue(new Error("offline"));
    const failed = renderHook(() => useClaimMatrix(MATRIX, "workspace"));
    await waitFor(() => expect(failed.result.current.verificationState).toBe("unavailable"));
    // The matrix itself still reads.
    expect(failed.result.current.document?.claims.size).toBe(1);
    failed.unmount();

    mocks.readClaimVerification.mockResolvedValue(null);
    const none = renderHook(() => useClaimMatrix(MATRIX, "workspace"));
    await waitFor(() => expect(none.result.current.verificationState).toBe("unavailable"));
  });

  it("is unavailable, not loading for ever, when there is no matrix to read", async () => {
    mocks.readArtifact.mockResolvedValue(null);
    const missing = renderHook(() => useClaimMatrix(MATRIX, "workspace"));
    await waitFor(() => expect(missing.result.current.verificationState).toBe("unavailable"));
    expect(missing.result.current.document).toBeNull();
    missing.unmount();

    mocks.readArtifact.mockRejectedValue(new Error("gone"));
    const failed = renderHook(() => useClaimMatrix(MATRIX, "workspace"));
    await waitFor(() => expect(failed.result.current.verificationState).toBe("unavailable"));

    const disabled = renderHook(() => useClaimMatrix(MATRIX, "workspace", false));
    await waitFor(() => expect(disabled.result.current.verificationState).toBe("unavailable"));
  });

  it("starts reading again, as loading, when another matrix is asked for", async () => {
    mocks.readClaimVerification.mockResolvedValue(checks);
    const { result, rerender } = renderHook(({ path }) => useClaimMatrix(path, "workspace"), { initialProps: { path: MATRIX } });
    await waitFor(() => expect(result.current.verificationState).toBe("ready"));
    mocks.readClaimVerification.mockReturnValue(new Promise(() => {}));
    rerender({ path: "deliverables/d2/clinical-evidence-matrix.json" });
    await waitFor(() => expect(result.current.verificationState).toBe("loading"));
    expect(result.current.verified.size).toBe(0);
  });

  it("reads an old version's frozen review, never the current workspace", () => {
    const version = (review: unknown) => ({ review, inputs: [], producer: { runId: "run_1" } }) as unknown as import("@/lib/resultProvenance").ResultVersion;
    const frozen = renderHook(() => useClaimMatrix(MATRIX, "workspace", false, version({ status: "available", matrixText: matrix, verification: checks })));
    expect(frozen.result.current.verificationState).toBe("ready");
    expect(frozen.result.current.verified.size).toBe(1);
    const noChecks = renderHook(() => useClaimMatrix(MATRIX, "workspace", false, version({ status: "available", matrixText: matrix })));
    expect(noChecks.result.current.verificationState).toBe("unavailable");
    const noReview = renderHook(() => useClaimMatrix(MATRIX, "workspace", false, version({ status: "unavailable" })));
    expect(noReview.result.current.verificationState).toBe("unavailable");
    expect(mocks.readClaimVerification).not.toHaveBeenCalled();
  });
});
