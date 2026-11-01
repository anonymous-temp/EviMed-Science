import type { EvimedSearchCategory } from "./evimedSearchClient";
import { productRequest } from "./productClient";

export interface EvimedSearchTopic {
  id: string;
  query: string;
  description: string;
  /** Counts cover the collected recent-progress feed, not all records in a search database. */
  basis?: {
    eventCount: number;
    sourceCount: number;
    latestAt: string;
    sources: {
      id: string;
      title: string;
      url: string;
      source: string;
      publishedAt: string | null;
      timelineAt: string;
      dateBasis: "published" | "observed" | "updated";
    }[];
  };
}

/** The plugin's source label describes the feed, not popularity or evidence quality. */
export interface EvimedSearchTopics {
  schemaVersion: 1;
  category: EvimedSearchCategory;
  topics: EvimedSearchTopic[];
  count: number;
  total: number;
  updatedAt: string | null;
  revision: string;
  source: { kind: "curated" | "provider"; label: string; isExample: boolean };
  recommendation?: {
    algorithm: "recent-medical-topics-v1";
    windowDays: 30;
    generatedAt: string;
    dataThrough: string | null;
    stale: boolean;
    corpusVersion: string;
  };
}

export function readEvimedSearchTopics(projectId: string, category: EvimedSearchCategory, signal: AbortSignal): Promise<EvimedSearchTopics> {
  const query = new URLSearchParams({ category, limit: "3" });
  return productRequest(`/projects/${encodeURIComponent(projectId)}/evimed-search/topics?${query}`, "GET", undefined, { signal });
}
