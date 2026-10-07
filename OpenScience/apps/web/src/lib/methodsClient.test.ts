import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

import { listAllMethods, methodSources, methodTitle, methodVersions, retireMethod, rollbackMethod } from "./methodsClient";

describe("the methods client", () => {
  beforeEach(() => { request.mockReset(); });

  // 2026-10-07 walk (D-P1-2): the page read the first page of fifty and ignored `nextCursor`, so an account past fifty methods saw fifty.
  it("reads every page of a status to the end", async () => {
    request
      .mockResolvedValueOnce({ items: [{ id: "a" }, { id: "b" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "c" }], nextCursor: null });
    expect((await listAllMethods("approved")).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/methods?limit=50&status=approved", "/methods?limit=50&status=approved&cursor=c1"]);
  });

  it("stops at its bound when a server keeps answering with a cursor", async () => {
    request.mockResolvedValue({ items: [{ id: "a" }], nextCursor: "again" });
    expect(await listAllMethods()).toHaveLength(40);
  });

  it("names a method by its encoded id for its versions, sources, stopping and going back", async () => {
    request.mockResolvedValue({});
    const id = "method:learned:x y";
    await methodVersions({ id });
    await methodSources({ id });
    await retireMethod({ id, revision: 3 } as never, "在记忆页里停用");
    await rollbackMethod({ id, revision: 3 } as never, 2);
    const encoded = encodeURIComponent(id);
    expect(request.mock.calls).toEqual([
      [`/methods/${encoded}/history`],
      [`/methods/${encoded}/sources`],
      [`/methods/${encoded}/retire`, "POST", { expectedRevision: 3, reason: "在记忆页里停用" }],
      [`/methods/${encoded}/rollback`, "POST", { expectedRevision: 3, targetRevision: 2 }],
    ]);
  });

  it("reads a method by the researcher's own title, else its name", () => {
    expect(methodTitle({ title: "引用标记对齐", name: "citation-alignment" })).toBe("引用标记对齐");
    expect(methodTitle({ title: null, name: "citation-alignment" })).toBe("citation-alignment");
  });
});
