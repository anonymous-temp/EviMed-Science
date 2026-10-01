/**
 * Small values for the components that are pure functions of their props — a
 * number, a count band, a state card. A page is never built from these: the
 * page and tab tests render from the server's own fixtures (`serverFixtures`).
 */
import type { VcrCounts, VcrValue } from "@/lib/vcrClient";

export const value = (input: Partial<VcrValue> & Pick<VcrValue, "source">): VcrValue => ({
  value: null,
  ...input,
});

export const counts = (input: Partial<VcrCounts> = {}): VcrCounts => ({
  realPatients: 0,
  events: null,
  effectiveSampleSize: null,
  generatedRecords: 6_480_000,
  note: "设计阶段：尚无真实患者",
  scope: "方案 B",
  ...input,
});
