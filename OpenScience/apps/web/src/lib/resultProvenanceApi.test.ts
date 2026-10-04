import { beforeEach, expect, it, vi } from "vitest";
import { getResultLineage, listRelatedResultVersions, readResultBytes, type ResultVersion } from "./resultProvenance";
const fetchAuth = vi.hoisted(() => vi.fn());
vi.mock("./apiClient", () => ({ fetchWithWebAuth: fetchAuth, getWebProjectId: () => "p", webApiBase: "/api" }));
const version = { versionId: "rv_old", digest: "a".repeat(64), size: 3 } as ResultVersion;
beforeEach(() => vi.resetAllMocks());
it("loads related history by the selected immutable version and preserves its pagination cursor", async () => {
  const page = { items: [], nextCursor: "next" };
  fetchAuth.mockResolvedValue(new Response(JSON.stringify({ data: page })));
  await expect(listRelatedResultVersions("rv_old", "opaque cursor")).resolves.toEqual(page);
  expect(fetchAuth).toHaveBeenCalledWith("/api/results?projectId=p&relatedTo=rv_old&cursor=opaque+cursor", undefined);
});
it("reads only the selected immutable endpoint with its matching digest and byte size", async () => {
  fetchAuth.mockResolvedValue(new Response("old", { headers: { ETag: `"${version.digest}"` } }));
  const blob = await readResultBytes(version);
  expect(blob.size).toBe(3);
  expect(fetchAuth).toHaveBeenCalledWith("/api/results/rv_old/raw?projectId=p");
});
it("refuses an unavailable, unsigned, mismatched or incomplete snapshot", async () => {
  fetchAuth.mockResolvedValueOnce(new Response("missing", { status: 404 }));
  await expect(readResultBytes(version)).rejects.toThrow("此版本的文件无法读取");
  fetchAuth.mockResolvedValueOnce(new Response("old"));
  await expect(readResultBytes(version)).rejects.toThrow("无法确认此文件的版本");
  fetchAuth.mockResolvedValueOnce(new Response("old", { headers: { ETag: `"${"b".repeat(64)}"` } }));
  await expect(readResultBytes(version)).rejects.toThrow("文件版本发生冲突");
  fetchAuth.mockResolvedValueOnce(new Response("truncated", { headers: { ETag: `"${version.digest}"` } }));
  await expect(readResultBytes(version)).rejects.toThrow("此版本文件不完整");
});
it("reads the numerical chain of exactly the selected immutable version, in the project it belongs to", async () => {
  const lineage = { versionId: "rv_old", role: "report", calculations: [], dependents: [], changes: [] };
  fetchAuth.mockResolvedValue(new Response(JSON.stringify({ data: lineage })));
  await expect(getResultLineage("rv_old")).resolves.toEqual(lineage);
  expect(fetchAuth).toHaveBeenCalledWith("/api/results/rv_old/lineage?projectId=p", undefined);
});
