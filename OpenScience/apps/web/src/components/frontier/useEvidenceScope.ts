import { useEffect, useRef } from "react";
/** Discard replies after the route, query or mounted owner has changed. */
export function useEvidenceScope(key: string) {
  const scope = useRef({ key, alive: true });
  if (scope.current.key !== key) {
    scope.current.alive = false;
    scope.current = { key, alive: true };
  }
  useEffect(() => {
    const current = scope.current;
    current.alive = true;
    return () => {
      current.alive = false;
    };
  }, [key]);
  return () => {
    const current = scope.current;
    return () => current.alive && scope.current === current;
  };
}

/** Keep a creation key until its submitted content changes. */
export function useEvidenceRequestId() {
  const request = useRef({ payload: "", id: "" });
  return (payload: string) => {
    if (!request.current.id || request.current.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
    return request.current.id;
  };
}
