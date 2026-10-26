import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatTile } from "@/components/ui/StatTile";
import { measurement, type Unmeasured } from "./measurement";
import { safetyReading } from "@/components/geo/geoOverviewModel";
import type { GeoDiagnosis } from "./geoClient";
// @ts-expect-error Unmeasured cannot contain a numeric observation.
const impossible: Unmeasured = { kind: "unmeasured", reason: "missing", value: 0 };
void impossible;
describe("measurement boundaries", () => {
  it("preserves observed zero and rejects missing/nonfinite values", () => {
    expect(measurement(0, "条", "本轮").kind).toBe("measured");
    for (const value of [undefined, null, NaN, Infinity]) expect(measurement(value, "条", "本轮").kind).toBe("unmeasured");
  });
  it("requires a counted, covered safety round before displaying zero", () => {
    const diagnosis = (value: unknown) => value as GeoDiagnosis;
    expect(safetyReading(diagnosis({})).kind).toBe("unmeasured");
    expect(safetyReading(diagnosis({ errorCounts: { severe: 0 } })).kind).toBe("unmeasured");
    expect(safetyReading(diagnosis({ round: { done: 30 }, errors: [] })).kind).toBe("unmeasured");
    expect(safetyReading(diagnosis({ round: { done: 30 }, errorCounts: { severe: 0 } }))).toMatchObject({ kind: "measured", value: 0, scope: "本轮 30 次有效回答", observedAt: null });
  });
  it("retains useful prior measurement after a refresh failure with local retry", () => {
    const retry = vi.fn();
    render(<StatTile label="样本" reading={{ kind: "failed", error: "读取失败", retry, previous: { kind: "measured", value: 0, unit: "例", scope: "本轮", observedAt: null } }} />);
    expect(screen.getByRole("group", { name: "样本" })).toHaveTextContent("0例");
    expect(screen.getByRole("alert")).toHaveTextContent("显示上次读数");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
