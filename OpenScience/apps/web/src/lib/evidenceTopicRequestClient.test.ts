import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "./apiClient";
import { fileTopicRequest, listTopicRequests, secondTopicRequest, topicRequestErrorMessage } from "./evidenceTopicRequestClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

describe("topic request client", () => {
  beforeEach(() => request.mockReset());
  it("reads the list, files a request with its trimmed title and the zone only when one is chosen, and seconds by id", async () => {
    request.mockResolvedValue({ items: [], seconded: [], remainingToday: 5 });
    await listTopicRequests();
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/topic-requests");
    await fileTopicRequest("  房颤抗凝的选择  ", "ez_1");
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/topic-requests", "POST", { title: "房颤抗凝的选择", zoneId: "ez_1" });
    await fileTopicRequest("房颤抗凝的选择", "");
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/topic-requests", "POST", { title: "房颤抗凝的选择" });
    await secondTopicRequest("tr_a/b");
    expect(request).toHaveBeenLastCalledWith("/frontier/evidence/topic-requests/tr_a%2Fb/second", "POST", {});
  });
  it("words a refusal with the registry's sentence for its code, and a failure with no code plainly", () => {
    expect(topicRequestErrorMessage(new WebApiError("limit", { status: 429, code: "evidence_topic_request_limit" }))).toContain("你今天申请和附议的选题已经到上限了");
    expect(topicRequestErrorMessage(new WebApiError("bad", { status: 400, code: "evidence_topic_request_invalid" }))).toContain("4 到 200 个字");
    expect(topicRequestErrorMessage(new Error("network"))).toBe("操作没有完成，请稍后重试。");
  });
});
