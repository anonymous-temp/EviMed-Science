import { expect, it, vi } from "vitest";
import { batchPageState, runBatch, toggleBatch } from "./batchSelection";
it("clears on changed scope, preserves IDs through sort and calculates mixed page selection", () => {
 const selected = toggleBatch({ scope: "one", ids: ["a"] }, "one", "b"); expect(batchPageState(selected.ids, ["c", "b", "a"])).toEqual({ checked: false, mixed: true });
 expect(toggleBatch(selected, "two", "c")).toEqual({ scope: "two", ids: ["c"] });
});
it("deduplicates operations and retries only failed IDs", async () => {
 const operation = vi.fn(async (id: string) => { if (id === "b") throw new Error("offline"); return id; });
 const first = await runBatch(["a", "b", "a"], operation); expect(first.succeeded.map(row => row.id)).toEqual(["a"]); expect(operation).toHaveBeenCalledTimes(2);
 operation.mockClear(); await runBatch(first.failed.map(row => row.id), operation); expect(operation).toHaveBeenCalledTimes(1); expect(operation).toHaveBeenCalledWith("b");
});
