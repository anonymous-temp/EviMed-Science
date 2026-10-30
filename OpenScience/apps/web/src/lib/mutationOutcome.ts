import { BackendUnavailableError, WebApiError } from "./apiClient";

/** A write that may or may not have been applied. A network timeout is not proof that a write was rejected. */
export class AmbiguousMutationError extends Error {}
/** Use only when the operation positively refused the write before applying it. */
export class RejectedMutationError extends Error {}
/** Whether a failed write leaves its outcome unknown: everything but a positive refusal (a 4xx other than 408, a missing backend). */
export function isAmbiguousMutationError(error: unknown): boolean {
  if (error instanceof RejectedMutationError || error instanceof BackendUnavailableError) return false;
  if (error instanceof WebApiError && error.status >= 400 && error.status < 500 && error.status !== 408) return false;
  return true;
}
