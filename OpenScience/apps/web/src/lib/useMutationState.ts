import { BackendUnavailableError, WebApiError, webErrorMessage } from "./apiClient";
import { useRef, useState } from "react";

/** A network timeout is not proof that a write was rejected. Callers classify known rejections explicitly. */
export class AmbiguousMutationError extends Error {}
/** Use only when the operation positively refused the write before applying it. */
export class RejectedMutationError extends Error {}
export function isAmbiguousMutationError(error: unknown): boolean {
  if (error instanceof RejectedMutationError || error instanceof BackendUnavailableError) return false;
  if (error instanceof WebApiError && error.status >= 400 && error.status < 500 && error.status !== 408) return false;
  return true;
}
export function useMutationState() {
  const lock = useRef(false);
  const [state, setState] = useState<{ pending: boolean; error: string | null; ambiguous: boolean }>({ pending: false, error: null, ambiguous: false });
  const run = async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    if (lock.current) return undefined;
    lock.current = true;
    setState({ pending: true, error: null, ambiguous: false });
    let ambiguous = false;
    try {
      const result = await operation();
      setState({ pending: false, error: null, ambiguous: false });
      return result;
    } catch (error) {
      ambiguous = isAmbiguousMutationError(error);
      setState({ pending: false, error: webErrorMessage(error, { fallback: "操作未能完成，请重试。" }), ambiguous });
      throw error;
    } finally { lock.current = ambiguous; }
  };
  return { ...state, run, reconcile: () => { lock.current = false; setState({ pending: false, error: null, ambiguous: false }); } };
}
