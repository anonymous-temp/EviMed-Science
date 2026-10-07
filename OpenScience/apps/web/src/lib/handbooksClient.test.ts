import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

import { handbookDetail, handbookVersions, listAllHandbooks, retireHandbook, rollbackHandbook } from "./handbooksClient";

describe("the handbooks client", () => {
  beforeEach(() => { request.mockReset(); });

  it("reads every page of a status to the end, and no more", async () => {
    request
      .mockResolvedValueOnce({ items: [{ id: "a" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "b" }], nextCursor: "c2" })
      .mockResolvedValueOnce({ items: [{ id: "c" }], nextCursor: null });
    expect((await listAllHandbooks("active")).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/handbooks?status=active&limit=50", "/handbooks?status=active&limit=50&cursor=c1", "/handbooks?status=active&limit=50&cursor=c2",
    ]);
  });

  it("stops at its bound when a server keeps answering with a cursor", async () => {
    request.mockResolvedValue({ items: [{ id: "a" }], nextCursor: "again" });
    expect(await listAllHandbooks("retired")).toHaveLength(40);
    expect(request).toHaveBeenCalledTimes(40);
  });

  it("names a handbook by its encoded id, and sends the revision it read", async () => {
    request.mockResolvedValue({});
    const id = "method:capability-handbook:geo-content:x y";
    await handbookDetail({ id });
    await handbookVersions({ id });
    await retireHandbook({ id, revision: 5 } as never, "在记忆页里停用");
    await rollbackHandbook({ id, revision: 6 }, 4);
    const encoded = encodeURIComponent(id);
    expect(request.mock.calls).toEqual([
      [`/handbooks/${encoded}`],
      [`/handbooks/${encoded}/history`],
      [`/handbooks/${encoded}/retire`, "POST", { expectedRevision: 5, reason: "在记忆页里停用" }],
      [`/handbooks/${encoded}/rollback`, "POST", { expectedRevision: 6, targetRevision: 4 }],
    ]);
  });
});
