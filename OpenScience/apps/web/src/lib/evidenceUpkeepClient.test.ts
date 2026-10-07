import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import {
  EVIDENCE_PUBLIC_BASE_PATHS,
  evidenceUpkeepErrorMessage,
  fetchEvidenceChanges,
  fetchEvidenceFeatures,
  resetEvidenceFeatures,
  listMyEvidenceChallenges,
  setEvidenceUpkeep,
  submitEvidenceChallenge,
} from "./evidenceUpkeepClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

describe("evidence upkeep client", () => {
  beforeEach(() => {
    request.mockReset();
  });
  it("files a challenge on one claim of one card, with the reason as written but trimmed", async () => {
    request.mockResolvedValue({ challenge: { id: "ch_1", state: "open" } });
    const challenge = await submitEvidenceChallenge("ec/1", "CLM-2", "  原文里没有这个数字  ");
    expect(request).toHaveBeenCalledWith("/frontier/evidence/ec%2F1/challenges", "POST", { claimId: "CLM-2", reason: "原文里没有这个数字" });
    expect(challenge).toEqual({ id: "ch_1", state: "open" });
  });
  it("lists the reader's own challenges on a card", async () => {
    request.mockResolvedValue({ items: [{ id: "ch_1" }] });
    expect(await listMyEvidenceChallenges("ec_1")).toEqual([{ id: "ch_1" }]);
    expect(request).toHaveBeenCalledWith("/frontier/evidence/ec_1/challenges");
  });
  it("reads a zone's change log, narrowed to a card and paged by the last entry", async () => {
    request.mockResolvedValue({ items: [], nextBefore: null });
    await fetchEvidenceChanges("z1");
    expect(request).toHaveBeenLastCalledWith("/frontier/zones/z1/changes");
    await fetchEvidenceChanges("z/1", { cardId: "ec_1", before: "77", limit: 10 });
    expect(request).toHaveBeenLastCalledWith("/frontier/zones/z%2F1/changes?cardId=ec_1&before=77&limit=10");
  });
  it("posts a producer's word about their card to its own path", async () => {
    request.mockResolvedValue({ currency: "no_longer_updated" });
    await setEvidenceUpkeep("ec_1", "retire");
    expect(request).toHaveBeenCalledWith("/frontier/evidence/ec_1/upkeep", "POST", { action: "retire" });
  });
  it("reads where the public pages are served from the capabilities, only from the closed set, and the closed set is the domain's", async () => {
    const { EVIDENCE_PUBLIC_BASE_PATHS: domainPaths } = await import("@evimed/domain");
    expect([...EVIDENCE_PUBLIC_BASE_PATHS]).toEqual([...domainPaths]);
    resetEvidenceFeatures();
    request.mockResolvedValue({ capabilities: { evidencePublicPages: true, evidencePublicBasePath: "/evimed-evidence" } });
    expect(await fetchEvidenceFeatures()).toEqual({ publicPages: true, publicBasePath: "/evimed-evidence", upkeep: false });
    resetEvidenceFeatures();
    request.mockResolvedValue({ capabilities: { evidencePublicPages: true, evidencePublicBasePath: "https://elsewhere.example/evidence" } });
    expect(await fetchEvidenceFeatures()).toEqual({ publicPages: true, upkeep: false });
    resetEvidenceFeatures();
  });
  it("says a refusal in the registry's words and falls back to a sentence for anything else", () => {
    expect(evidenceUpkeepErrorMessage(new WebApiError("x", { status: 409, code: "evidence_challenge_exists" }))).toMatch(/已经对这条结论提出过质疑/);
    expect(evidenceUpkeepErrorMessage(new WebApiError("x", { status: 429, code: "evidence_challenge_rate_limited" }))).toMatch(/上限/);
    expect(evidenceUpkeepErrorMessage(new Error("offline"))).toBe("操作没有完成，请稍后重试。");
  });
  it("reads which evidence features the deployment has from the status capabilities, once a minute, and none when it cannot tell", async () => {
    resetEvidenceFeatures();
    request.mockResolvedValue({ capabilities: { evidencePublicPages: true, evidenceUpkeep: "yes", saveToLibrary: true } });
    expect(await fetchEvidenceFeatures()).toEqual({ publicPages: true, upkeep: false });
    expect(await fetchEvidenceFeatures()).toEqual({ publicPages: true, upkeep: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/frontier/status");
    resetEvidenceFeatures();
    request.mockResolvedValue({});
    expect(await fetchEvidenceFeatures()).toEqual({ publicPages: false, upkeep: false });
    resetEvidenceFeatures();
    request.mockRejectedValue(new WebApiError("down", { status: 502 }));
    expect(await fetchEvidenceFeatures()).toEqual({ publicPages: false, upkeep: false });
    resetEvidenceFeatures();
  });
});
