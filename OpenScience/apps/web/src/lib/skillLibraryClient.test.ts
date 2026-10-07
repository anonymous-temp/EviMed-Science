import { beforeEach, expect, it, vi } from "vitest";
import { copyPlatformSkill, listPlatformSkills, previewPersonalSkillRepository, readPlatformSkill } from "./skillLibraryClient";
const request = vi.hoisted(() => vi.fn());
const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock("./apiClient", async original => ({ ...(await original<object>()), fetchWithWebAuth: authenticatedFetch }));
vi.mock("./productClient", async original => ({ ...(await original<object>()), productRequest: request }));
beforeEach(() => { authenticatedFetch.mockReset(); request.mockReset(); request.mockResolvedValue({}); });
it("the platform's skills are read without a project or session, and an id is one encoded segment", async () => {
  await listPlatformSkills(); expect(request).toHaveBeenLastCalledWith("/skills/platform");
  await readPlatformSkill("curated:survival-analysis"); expect(request).toHaveBeenLastCalledWith("/skills/platform/curated%3Asurvival-analysis");
});
it("a copy request carries only the title and the retry key", async () => {
  await copyPlatformSkill("core:stats-integrity", { title: "我的核查", idempotencyKey: "same-key", ownerId: "must-not-forward", path: "/must-not-forward" } as never);
  expect(request).toHaveBeenCalledWith("/skills/platform/core%3Astats-integrity/copy", "POST", { title: "我的核查", idempotencyKey: "same-key" });
});
it("repository preview cannot forward user URLs, credentials or plugin-install authority", async () => {
  await previewPersonalSkillRepository({ repository: "example/skills", commit: "a".repeat(40), subdirectory: "skills/check", url: "https://must-not-forward.invalid", token: "must-not-forward" } as never);
  expect(request).toHaveBeenCalledWith("/skills/repository-preview", "POST", { repository: "example/skills", commit: "a".repeat(40), subdirectory: "skills/check" });
});
it("transfer preview/confirm forward only owned references, selected source IDs and one retry key", async () => {
  const client = await import("./skillLibraryClient");
  await client.previewPersonalSkillTransfer({ reference: "transfer:one", sourceSkillIds: ["skill:source"], ownerId: "no", role: "owner" } as never);
  expect(request).toHaveBeenLastCalledWith("/skills/transfers/preview", "POST", { reference: "transfer:one", sourceSkillIds: ["skill:source"] });
  await client.confirmPersonalSkillTransfer({ reference: "transfer:one", idempotencyKey: "same", sourceSkillIds: ["skill:source"], activate: true } as never);
  expect(request).toHaveBeenLastCalledWith("/skills/transfers/confirm", "POST", { reference: "transfer:one", idempotencyKey: "same", sourceSkillIds: ["skill:source"] });
});
it("bounded transfer upload uses raw bytes and the existing authenticated transport", async () => {
  const client = await import("./skillLibraryClient"), file = new File(['{}'], "account.json");
  authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { reference: "transfer:owned", format: "account", sourceSkills: [] } }) });
  await client.uploadPersonalSkillTransfer(file, "account");
  expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining("/skills/transfers/uploads?format=account"), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
  await expect(client.uploadPersonalSkillTransfer(new File([], "empty.json"), "portable")).rejects.toThrow("32 MB");
  const oversized = new File(['{}'], "large.json"); Object.defineProperty(oversized, "size", { value: 32 * 1024 * 1024 + 1 });
  await expect(client.uploadPersonalSkillTransfer(oversized, "portable")).rejects.toThrow("32 MB"); expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});
it("recovery reads owned server journals without caller identity or browser storage", async () => {
  const client = await import("./skillLibraryClient"); await client.pendingPersonalSkillTransfers(); expect(request).toHaveBeenLastCalledWith("/skills/transfers/pending");
});
it("pending recovery forwards an encoded page cursor only", async () => { const client = await import("./skillLibraryClient"); await client.pendingPersonalSkillTransfers("page:/older"); expect(request).toHaveBeenLastCalledWith("/skills/transfers/pending?cursor=page%3A%2Folder"); });
