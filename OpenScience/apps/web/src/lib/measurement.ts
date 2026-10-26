/** An observed finite value retains its unit, scope and explicit time provenance. */
export interface Measured { kind: "measured"; value: number; unit: string; scope: string; observedAt: string | null }
export interface Unmeasured { kind: "unmeasured"; reason: string; value?: never }
export interface Failed { kind: "failed"; error: string; retry: () => void; previous?: Measured }
export type MetricReading = Measured | Unmeasured | Failed | { kind: "loading" };

/** Preserve missingness at the boundary; zero is an observation, not a fallback. */
export function measurement(value: number | null | undefined, unit: string, scope: string, observedAt: string | null = null, reason = "未测"): Measured | Unmeasured {
  return typeof value === "number" && Number.isFinite(value)
    ? { kind: "measured", value, unit, scope, observedAt }
    : { kind: "unmeasured", reason };
}
