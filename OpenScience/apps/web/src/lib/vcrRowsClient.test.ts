import { describe, expect, it } from "vitest";
import { readVcrPatientRecord } from "./vcrRowsClient";

describe("patient record provenance", () => {
  it("keeps a prediction separate from a synthetic target declaration", () => {
    const predicted = readVcrPatientRecord({ id: "p", source: "predicted" });
    expect(predicted.source).toBe("predicted");
    expect(predicted.targetClass).toBeUndefined();
    const generated = readVcrPatientRecord({ id: "p", source: "predicted", targetClass: "synthetic" });
    expect(generated.targetClass).toBe("synthetic");
  });
  it("preserves every observation and missing value for one longitudinal identity", () => {
    const record = readVcrPatientRecord({ id: "p", observationCount: 3, observations: [{ visit: 1, time: 0, y: 12 }, { visit: 2, time: 6, y: null }, { visit: 3, time: 12, y: 18 }] });
    expect(record.id).toBe("p"); expect(record.observationCount).toBe(3);
    expect(record.observations?.map(row => row.y)).toEqual([12, null, 18]);
  });
});
