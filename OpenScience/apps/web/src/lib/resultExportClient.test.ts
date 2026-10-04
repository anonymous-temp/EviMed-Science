import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import { exportResult, resultActionFailure, type ResultVersion } from "./resultProvenance";

const fetchAuth = vi.hoisted(() => vi.fn());
vi.mock("./apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("./apiClient")>()), fetchWithWebAuth: fetchAuth, getWebProjectId: () => "p", webApiBase: "/api" }));
const version = { versionId: "rv_old", digest: "a".repeat(64), size: 3 } as ResultVersion;
beforeEach(() => vi.resetAllMocks());

it("downloads exactly the selected version's package", async () => {
  fetchAuth.mockResolvedValue(new Response("zip bytes"));
  expect((await exportResult(version)).size).toBe(9);
  expect(fetchAuth).toHaveBeenCalledWith("/api/results/rv_old/export?projectId=p");
});

it("a refused export carries the server's code, so the reader sees the sentence written for it", async () => {
  fetchAuth.mockResolvedValue(new Response(JSON.stringify({ error: "The selected result package exceeds the export limit.", code: "result_export_limit" }), { status: 413 }));
  const refused = await exportResult(version).catch((error) => error);
  expect(refused).toBeInstanceOf(WebApiError);
  expect(refused.code).toBe("result_export_limit");
  expect(resultActionFailure(refused, () => "导出失败")).toContain("超出单项处理范围");

  fetchAuth.mockResolvedValue(new Response(JSON.stringify({ code: "result_export_authorization_changed", error: "Source access changed during export. Rebuild the package." }), { status: 409 }));
  expect(resultActionFailure(await exportResult(version).catch((error) => error), () => "导出失败")).toContain("来源访问权限已变化");
});

it("a refusal that names no code reads as the fallback, never as a raw body", async () => {
  fetchAuth.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
  const refused = await exportResult(version).catch((error) => error);
  expect(refused).toBeInstanceOf(WebApiError);
  expect(refused.code).toBeNull();
  expect(resultActionFailure(refused, () => "导出失败")).toBe("导出失败");
});
