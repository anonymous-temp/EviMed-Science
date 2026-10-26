import { expect, it, vi } from "vitest";
import { BATCH_CONCURRENCY, batchPageState, runBatch, toggleBatch } from "./batchSelection";
it("clears on changed scope, preserves IDs through sort and calculates mixed page selection", () => {
 const selected = toggleBatch({ scope: "one", ids: ["a"] }, "one", "b"); expect(batchPageState(selected.ids, ["c", "b", "a"])).toEqual({ checked: false, mixed: true });
 expect(toggleBatch(selected, "two", "c")).toEqual({ scope: "two", ids: ["c"] });
});
it("deduplicates operations and retries only failed IDs", async () => {
 const operation = vi.fn(async (id: string) => { if (id === "b") throw new Error("offline"); return id; });
 const first = await runBatch(["a", "b", "a"], operation); expect(first.succeeded.map(row => row.id)).toEqual(["a"]); expect(operation).toHaveBeenCalledTimes(2);
 operation.mockClear(); await runBatch(first.failed.map(row => row.id), operation); expect(operation).toHaveBeenCalledTimes(1); expect(operation).toHaveBeenCalledWith("b");
});
it("keeps at most four requests in flight, runs every id, and reports each outcome in the order given", async () => {
 let flying = 0, peak = 0;
 const ids = Array.from({ length: 11 }, (_, index) => `n${index}`);
 const result = await runBatch(ids, async id => {
  flying += 1; peak = Math.max(peak, flying);
  await new Promise(resolve => setTimeout(resolve, 5));
  flying -= 1;
  if (id === "n3" || id === "n9") throw new Error(`no ${id}`);
  return id.toUpperCase();
 });
 expect(BATCH_CONCURRENCY).toBe(4);
 expect(peak).toBe(4);
 expect(result.succeeded.map(row => row.value)).toEqual(["N0", "N1", "N2", "N4", "N5", "N6", "N7", "N8", "N10"]);
 expect(result.failed.map(row => row.id)).toEqual(["n3", "n9"]);
 expect(await runBatch([], async id => id)).toEqual({ succeeded: [], failed: [] });
});
