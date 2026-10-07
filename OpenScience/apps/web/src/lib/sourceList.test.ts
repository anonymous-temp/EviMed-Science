import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "./sourceClient";
import { listAllSources } from "./sourceList";

const mocks = vi.hoisted(() => ({ listSources: vi.fn() }));
vi.mock("./sourceClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("./sourceClient")>()), listSources: mocks.listSources }));

const record = (id: string) => ({ id } as unknown as SourceRecord);

describe("listAllSources", () => {
  beforeEach(() => mocks.listSources.mockReset());

  it("follows the cursor to the last page, so the fifty-first document can be named", async () => {
    mocks.listSources
      .mockResolvedValueOnce({ items: [record("a"), record("b")], nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [record("c")], nextCursor: "page-3" })
      .mockResolvedValueOnce({ items: [record("d")], nextCursor: null });
    const all = await listAllSources("project-one", { state: "ready" });
    expect(all.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(mocks.listSources.mock.calls).toEqual([
      ["project-one", { state: "ready", limit: 100, cursor: null }],
      ["project-one", { state: "ready", limit: 100, cursor: "page-2" }],
      ["project-one", { state: "ready", limit: 100, cursor: "page-3" }],
    ]);
  });

  it("stops after a bounded walk when a cursor never ends", async () => {
    mocks.listSources.mockResolvedValue({ items: [record("x")], nextCursor: "again" });
    expect(await listAllSources("project-one")).toHaveLength(20);
    expect(mocks.listSources).toHaveBeenCalledTimes(20);
  });

  it("lets a failed page fail the walk rather than answer with part of the library", async () => {
    mocks.listSources.mockResolvedValueOnce({ items: [record("a")], nextCursor: "next" }).mockRejectedValueOnce(new Error("offline"));
    await expect(listAllSources("project-one")).rejects.toThrow("offline");
  });
});
