import { expect, it } from "vitest";
import { completeMethodCatalogue } from "./vcrMethodDisplay";
it("preserves a saved method and fills only missing forecast identities", () => {
  const saved = { id: "forecast.compare", method: "forecast.compare", name: "保存的预测比较", version: "1" };
  const result = completeMethodCatalogue([saved]);
  expect(result[0]).toBe(saved);
  expect(result.filter(row => row.id === saved.id)).toHaveLength(1);
  expect(result.find(row => row.id === "forecast.trajectories")?.name).toBe("预测后续轨迹");
});
