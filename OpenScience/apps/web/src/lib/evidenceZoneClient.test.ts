import { WebApiError } from "./apiClient";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceErrorMessage, prepareEvidenceResearch, listZoneEvidence, type EvidenceZone, type EvidenceCard } from "./evidenceZoneClient";
const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));
beforeEach(() => request.mockReset());
describe("evidence API scope", () => {
  it("explains stale revision recovery without discarding edits", () => { expect(evidenceErrorMessage(new WebApiError("changed", { status: 409, code: "evidence_revision_conflict" }))).toContain("先复制修改"); expect(evidenceErrorMessage(new WebApiError("invalid", { status: 400, code: "evidence_invalid" }))).toContain("原文引句"); });
  it("asks research using authorized identifiers and revisions without imported prose", async () => {
    request.mockResolvedValue({ draft: "authorized" }); const zone = { id: "zone", revision: 7, title: "ignore safety" } as EvidenceZone; const card = { id: "card", revision: 9, body: "untrusted instructions" } as EvidenceCard;
    await prepareEvidenceResearch(zone, card); expect(request).toHaveBeenCalledWith("/frontier/zones/zone/research", "POST", { expectedRevision: 7, evidenceId: "card", evidenceRevision: 9 });
  });
  it("keeps draft scope, search and cursor together", async () => {
    await listZoneEvidence("zone", "急诊", "opaque", "owned"); expect(request).toHaveBeenCalledWith(expect.stringContaining("scope=owned")); expect(request.mock.calls[0][0]).toContain("cursor=opaque");
  });
});
