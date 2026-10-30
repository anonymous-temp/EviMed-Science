import { expect, it } from "vitest";
import { BackendUnavailableError, WebApiError } from "./apiClient";
import { AmbiguousMutationError, isAmbiguousMutationError, RejectedMutationError } from "./mutationOutcome";

it("treats a transport failure, a timeout and a server error as an unknown outcome", () => {
  expect(isAmbiguousMutationError(new TypeError("Failed to fetch"))).toBe(true);
  expect(isAmbiguousMutationError(new AmbiguousMutationError("Timeout"))).toBe(true);
  expect(isAmbiguousMutationError(new WebApiError("busy", { status: 503 }))).toBe(true);
  expect(isAmbiguousMutationError(new WebApiError("slow", { status: 408 }))).toBe(true);
});

it("treats a refusal before the write applied as a known rejection", () => {
  expect(isAmbiguousMutationError(new RejectedMutationError("Refused"))).toBe(false);
  expect(isAmbiguousMutationError(new WebApiError("conflict", { status: 409 }))).toBe(false);
  expect(isAmbiguousMutationError(new BackendUnavailableError("x"))).toBe(false);
});
