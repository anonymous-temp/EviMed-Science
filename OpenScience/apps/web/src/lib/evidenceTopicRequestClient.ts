import { webErrorMessage } from "./apiClient";
import { productRequest } from "./productClient";

/** One open topic request as the signed-in reader sees it: how many accounts asked for it, never which. */
export interface TopicRequest {
  id: string;
  title: string;
  /** The published zone the request names, when it names one. */
  zoneId: string | null;
  zoneTitle: string | null;
  requesters: number;
  createdAt: string;
}
export interface TopicRequestList {
  items: TopicRequest[];
  /** The ids of the listed requests this account has already voted for. */
  seconded: string[];
  /** How many new votes (filing or seconding) the account has left today. */
  remainingToday: number;
}
export interface TopicRequestFiled {
  request: TopicRequest;
  /** False when the same words were already on the list: filing them again is a vote for that request. */
  filed: boolean;
  seconded: boolean;
  alreadySeconded: boolean;
}

const BASE = "/frontier/evidence/topic-requests";

/** The open requests, most requested first, and which of them this account has voted for. */
export const listTopicRequests = () => productRequest<TopicRequestList>(BASE);
/** File a request, or second the one with the same words. */
export const fileTopicRequest = (title: string, zoneId?: string | null) =>
  productRequest<TopicRequestFiled>(BASE, "POST", { title: title.trim(), ...(zoneId ? { zoneId } : {}) });
/** Second a request on the list. */
export const secondTopicRequest = (id: string) =>
  productRequest<TopicRequestFiled>(`${BASE}/${encodeURIComponent(id)}/second`, "POST", {});

/** What a refused request says; the registry's own sentences cover the daily limit and an invalid title or zone. */
export function topicRequestErrorMessage(error: unknown): string {
  return webErrorMessage(error, { fallback: "操作没有完成，请稍后重试。" });
}
