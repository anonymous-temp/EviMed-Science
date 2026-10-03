import { beforeEach, expect, it, vi } from "vitest";
import { duplicateEffectiveSkill, effectiveSkill, effectiveSkills, previewPersonalSkillRepository } from "./skillLibraryClient";
const request = vi.hoisted(() => vi.fn());
const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock("./apiClient", async original => ({ ...(await original<object>()), fetchWithWebAuth: authenticatedFetch }));
vi.mock("./productClient", async original => ({ ...(await original<object>()), productRequest: request }));
beforeEach(() => { authenticatedFetch.mockReset(); request.mockReset(); request.mockResolvedValue({}); });
it("encodes actual project/session/opaque key and immutable generation without a caller path", async () => {
  await effectiveSkills("project/a", "session:one"); expect(request).toHaveBeenLastCalledWith("/projects/project%2Fa/skills/effective?sessionId=session%3Aone");
  await effectiveSkill("project/a", "opaque:key", "session:one", "generation:a"); expect(request).toHaveBeenLastCalledWith("/projects/project%2Fa/skills/effective/opaque%3Akey?sessionId=session%3Aone&expectedRuntimeGeneration=generation%3Aa");
});
it("duplicate requests carry only the agreed identity intent and preserve the retry key", async () => {
  const input = { sessionId: "session", key: "opaque", title: "My source check", idempotencyKey: "same-key", expectedRuntimeGeneration: "actual-generation", ownerId: "must-not-forward", path: "/must-not-forward" };
  await duplicateEffectiveSkill("project", input);
  expect(request).toHaveBeenCalledWith("/projects/project/skills/duplicate", "POST", { sessionId: "session", key: "opaque", title: "My source check", idempotencyKey: "same-key", expectedRuntimeGeneration: "actual-generation" });
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
