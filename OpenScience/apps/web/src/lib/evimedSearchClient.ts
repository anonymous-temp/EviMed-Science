import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import { productRequest } from "@/lib/productClient";

export const EVIMED_SEARCH_CATEGORIES = [
  { value: "literature", label: "搜文献" },
  { value: "guidelines", label: "查指南" },
  { value: "drugs", label: "找药品" },
  { value: "trials", label: "临床试验" },
] as const;

export type EvimedSearchCategory = typeof EVIMED_SEARCH_CATEGORIES[number]["value"];

export interface EvimedSearchFilters {
  words?: string;
  articleType?: string[];
  keyWords?: string[];
  p?: string[];
  ic?: string[];
  jcrPartition?: string[];
  journalPartition?: string[];
  smallJcr?: number;
  bidJcr?: number;
  zdzs?: string[];
  keywords?: string[];
  sType?: string[];
  firstLevelDepartment?: string[];
  secondLevelDepartment?: string[];
  studyType?: string[];
  testPhase?: string[];
  recruitmentStatus?: string[];
  associatedArticles?: string[];
  clinicalSourceDb?: string;
  minSampleSize?: number;
  maxSampleSize?: number;
  language?: "zh" | "en" | "";
  startYear?: number;
  endYear?: number;
  source?: string;
  sort?: "comprehensive" | "relevance" | "newest" | "oldest" | "impact-high" | "impact-low";
}

export interface EvimedSearchItem {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  source: string;
  publishedAt: string;
  authors: string[];
  url: string | null;
  doi: string | null;
  detailRef: string | null;
  actionRef?: string | null;
  collected?: boolean | null;
  tags: string[];
}

export interface EvimedSearchResult {
  category: EvimedSearchCategory;
  query: string;
  page: number;
  pageSize: number;
  total: number;
  items: EvimedSearchItem[];
}

export interface EvimedSearchFacetOption {
  value: string;
  label: string;
  count?: number;
  parent?: string;
}

export interface EvimedSearchFacets {
  timeline: { year: number; count: number }[];
  groups: { key: keyof EvimedSearchFilters; label: string; options: EvimedSearchFacetOption[] }[];
  unavailable: string[];
}

export interface EvimedSearchDetail {
  id?: string;
  actionRef?: string | null;
  collected?: boolean | null;
  title: string;
  subtitle: string;
  source: string;
  url: string | null;
  doi: string | null;
  sections: { title: string; text: string }[];
  metadata: { label: string; value: string }[];
}

export function evimedSearchCategory(value: string | undefined): EvimedSearchCategory {
  return EVIMED_SEARCH_CATEGORIES.find((entry) => entry.value === value)?.value ?? "literature";
}

export function searchEvimed(category: EvimedSearchCategory, request: {
  query: string;
  page: number;
  pageSize: number;
  filters: EvimedSearchFilters;
}, signal?: AbortSignal): Promise<EvimedSearchResult> {
  return signal === undefined ? productRequest(`/evimed-search/${category}/search`, "POST", request)
    : productRequest(`/evimed-search/${category}/search`, "POST", request, { signal });
}

export function readEvimedSearchFacets(category: EvimedSearchCategory, request: {
  query: string;
  filters: EvimedSearchFilters;
}, signal?: AbortSignal): Promise<EvimedSearchFacets> {
  return signal === undefined ? productRequest(`/evimed-search/${category}/facets`, "POST", request)
    : productRequest(`/evimed-search/${category}/facets`, "POST", request, { signal });
}

export function readEvimedSearchDetail(category: EvimedSearchCategory, detailRef: string, signal?: AbortSignal): Promise<EvimedSearchDetail> {
  return signal === undefined ? productRequest(`/evimed-search/${category}/detail`, "POST", { detailRef })
    : productRequest(`/evimed-search/${category}/detail`, "POST", { detailRef }, { signal });
}

export interface EvimedFullTextStatus {
  status: number;
  url: string | null;
  canRequest: boolean;
  canDownload: boolean;
}

export interface EvimedFullTextOffer extends EvimedFullTextStatus {
  offerRef: string;
  filename: string;
  daily: number;
  permanent: number;
  unlimited: boolean;
  kind: "owned" | "unlimited" | "free" | "beans";
  amount: number;
}

export interface EvimedSearchFile { filename: string; contentType: string; base64: string }
export type EvimedCitationFormat = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type EvimedExportFormat = 1 | 2 | 3;

function searchAction<T>(category: EvimedSearchCategory, action: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return signal === undefined ? productRequest(`/evimed-search/${category}/${action}`, "POST", body)
    : productRequest(`/evimed-search/${category}/${action}`, "POST", body, { signal });
}

export const setEvimedSearchCollection = (category: EvimedSearchCategory, actionRef: string, collected: boolean, signal?: AbortSignal) =>
  searchAction<{ collected: boolean }>(category, "collection", { actionRef, collected }, signal);
export const readEvimedSearchCitations = (category: EvimedSearchCategory, actionRefs: string[], format: EvimedCitationFormat, signal?: AbortSignal) =>
  searchAction<{ quotes: { label: string; text: string }[] }>(category, "citations", { actionRefs, format }, signal);
export const exportEvimedSearchRecords = (category: EvimedSearchCategory, actionRefs: string[], format: EvimedExportFormat, signal?: AbortSignal) =>
  searchAction<EvimedSearchFile>(category, "export", { actionRefs, format }, signal);
export const readEvimedFullTextStatus = (category: EvimedSearchCategory, actionRef: string, signal?: AbortSignal) =>
  searchAction<EvimedFullTextStatus>(category, "fulltext-status", { actionRef }, signal);
export const requestEvimedFullText = (category: EvimedSearchCategory, actionRef: string, signal?: AbortSignal) =>
  searchAction<EvimedFullTextStatus>(category, "fulltext-request", { actionRef }, signal);
export const readEvimedFullTextOffer = (category: EvimedSearchCategory, actionRef: string, signal?: AbortSignal) =>
  searchAction<EvimedFullTextOffer>(category, "fulltext-offer", { actionRef }, signal);

/** The public file fetch carries no EviMed credential and precedes allowance consumption. */
export async function downloadEvimedFullText(category: EvimedSearchCategory, offer: EvimedFullTextOffer, signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  const unavailable = () => new WebApiError("The original file is unavailable.", { status: 409, code: "evimed_search_download_unavailable" });
  const tooLarge = () => new WebApiError("The original file exceeds the download size limit.", { status: 413, code: "evimed_search_download_too_large" });
  signal?.throwIfAborted();
  if (!offer.url || !offer.offerRef) throw unavailable();
  const url = new URL(offer.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw unavailable();
  const controller = new AbortController();
  const abortDownload = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortDownload, { once: true });
  const timeout = setTimeout(() => controller.abort(new WebApiError("The original file download timed out.", { status: 504, code: "evimed_search_timeout" })), 120_000);
  let blob: Blob;
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    if (!response.ok || !response.body) throw unavailable();
    const limit = 50 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body.cancel();
      throw tooLarge();
    }
    const reader = response.body.getReader();
    const chunks: ArrayBuffer[] = []; let length = 0;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) throw tooLarge();
        chunks.push(new Uint8Array(value).buffer);
      }
    } finally { await reader.cancel().catch(() => {}); }
    controller.signal.throwIfAborted();
    blob = new Blob(chunks, { type: "application/pdf" });
    if (!blob.size || !/^%PDF-\d\.\d\b/.test((await blob.slice(0, 1024).text()).trimStart())) throw unavailable();
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortDownload);
  }
  signal?.throwIfAborted();
  const approval = await searchAction<{ approved: boolean }>(category, "fulltext-confirm", { offerRef: offer.offerRef }, signal);
  if (approval.approved !== true) throw unavailable();
  signal?.throwIfAborted();
  return { blob, filename: offer.filename };
}

/** Links are source material, never script, credentials or HTML supplied by an upstream service. */
export function evimedSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export interface EvimedSearchFailure { message: string; action: "login" | "search" | "retry" }

export function evimedSearchFailure(error: unknown): EvimedSearchFailure {
  const message = webErrorMessage(error, { fallback: "暂时无法读取检索结果，请重试。", codes: {
    evimed_search_download_cost_changed: "下载权益已变化，请确认新的消耗后重试。",
    evimed_search_download_confirmation_pending: "下载结果尚未确认，请稍后刷新原文状态；已获取后可直接下载。",
    evimed_search_profile_required: "请先在 EviMed 账号中完善身份信息，再下载原文。",
    evimed_search_balance_insufficient: "下载次数或灵豆余额不足，请在 EviMed 账号中补充权益。",
    evimed_search_download_unavailable: "原文暂不可下载，请稍后刷新状态。",
    evimed_search_download_too_large: "原文文件超过 50 MB，请在来源网站下载。",
    evimed_search_action_unavailable: "此内容暂不支持该操作。",
  } });
  if (error instanceof WebApiError) {
    if (["evimed_search_login_required", "evimed_search_credential_expired"].includes(error.code ?? "") || error.status === 401) {
      return { message, action: "login" };
    }
    if (error.code === "evimed_search_reference_invalid") {
      return { message, action: "search" };
    }
  }
  return { message, action: "retry" };
}
