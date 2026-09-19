/**
 * The personal library, as the capsule's 「资料」 section reads it.
 *
 * The kb stream serves it (`GET /api/library`, `POST
 * /api/library/:sourceId/publish-to-capsule`); this is the reader, built to the
 * agreed shape. A deployment whose control plane does not serve the library
 * answers 404, which the section says plainly instead of failing.
 */
import { WebApiError } from "./apiClient";
import { productRequest } from "./productClient";

/** One source in the library (the agreed shape). */
export interface LibraryItem {
  sourceId: string;
  title: string;
  authors?: string[];
  doi?: string;
  kind: string;
  addedAt: string;
  /** The projects the source belongs to. */
  projects: string[];
  pageCount?: number;
  status: string;
}

/** What reading one source put into the capsule, as the publish route reports it. */
export interface LibraryPublishResult {
  facts?: number;
  methods?: number;
  [key: string]: unknown;
}

/** The library, or null when this deployment does not serve one. */
export async function fetchLibrary(): Promise<LibraryItem[] | null> {
  try {
    const data = await productRequest<LibraryItem[] | { items: LibraryItem[] }>("/library");
    return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  } catch (error) {
    if (error instanceof WebApiError && error.status === 404) return null;
    throw error;
  }
}

/** Put what EviMed learned from one source into the capsule: facts with their source, methods as drafts. */
export function publishToCapsule(sourceId: string) {
  return productRequest<LibraryPublishResult>(`/library/${encodeURIComponent(sourceId)}/publish-to-capsule`, "POST", {});
}

/** A source's kind, in the reader's words (the server's SOURCE_TYPES). */
export const LIBRARY_KIND_LABELS: Record<string, string> = {
  "published-paper": "已发表论文",
  "preprint-manuscript": "手稿或预印本",
  "review-guideline": "综述或指南",
  "book-chapter": "书籍章节",
  "conference-material": "会议材料",
  "grant-proposal": "标书或课题申请",
  "research-protocol": "研究方案或 SOP",
  "peer-review": "审稿意见",
  "medical-case": "医案",
  "patient-record": "病例或病历",
  "cohort-data": "队列数据",
  "statistical-output": "统计输出",
  "lecture-slides": "讲课 PPT",
  "audio-recording": "录音",
  "video-recording": "视频",
  "course-bundle": "课程包",
  "note-memo": "笔记或备忘",
  "message-export": "邮件或聊天导出",
  "administrative-record": "行政或财务资料",
  "certificate-scan": "证书或扫描件",
  "image-figure": "图片或图表",
  other: "其他资料",
};

/** Where a source is in its reading, in the reader's words. */
export const LIBRARY_STATUS_LABELS: Record<string, string> = {
  queued: "等待分析",
  parsing: "正在解析",
  complete: "已读完",
  ready: "已读完",
  needs_attention: "需要你看一下",
  failed: "分析失败",
  missing: "原始资料已移除",
  canceled: "已取消",
};
