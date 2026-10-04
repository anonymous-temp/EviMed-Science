import type { DATA_CHECK_OUTCOMES, SemanticFactSummary } from "./dataSemanticsView";
import { productRequest } from "./productClient";

/** One dataset in a project's list: what it is made of, who vouches for how much of it, and how its last check ended. */
export interface DatasetMeaningListing {
  datasetId: string;
  title: string | null;
  tables: Array<{ table: string; path: string; sha256: string; rows: number }>;
  summary: { facts: number; researcherConfirmed: number; dictionaryStated: number; modelInferred: number; contested: number; tables: number; variables: number; transformations: number };
  lastCheck: { checkedAt: string; attention: number; information: number; notChecked: number; clean: number } | null;
  updatedAt: string;
  revision: number;
}

export interface DatasetCheckFinding {
  outcome: keyof typeof DATA_CHECK_OUTCOMES;
  family: string;
  severity: "attention" | "information";
  subject: Record<string, string>;
  count?: number;
  rows?: number[];
  message?: string;
  detail?: Record<string, unknown>;
}

/** The asset as the control plane stores it (`@evimed/domain` `dataSemantics`): meaning as facts, each with its basis. */
export interface DatasetMeaningAsset {
  datasetId: string;
  title: string | null;
  facts: Record<string, SemanticFactSummary>;
  tables: Array<{ name: string; facts: Record<string, SemanticFactSummary>; variables: Array<{ name: string; facts: Record<string, SemanticFactSummary> }> }>;
  joins: Array<{ id: string; left: { table: string; columns: string[] }; right: { table: string; columns: string[] }; facts: Record<string, SemanticFactSummary> }>;
  bindings: Array<{ table: string; path: string; sha256: string; rows: number; boundAt: string }>;
  transformations: Array<{ name: string; kind: string; version: number }>;
  lastCheck: null | {
    checkedAt: string;
    findings: DatasetCheckFinding[];
    notChecked: Array<{ family: string; reason: string; subject: Record<string, string> }>;
    clean: Array<{ family: string; subject: Record<string, string> }>;
    summary: { attention: number; information: number; notChecked: number; clean: number };
  };
}
export interface DatasetMeaning { asset: DatasetMeaningAsset; revision: number; interpretation: string; summary: DatasetMeaningListing["summary"] }

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/data-semantics`;

export function listDatasetMeanings(projectId: string) {
  return productRequest<{ items: DatasetMeaningListing[] }>(base(projectId));
}
export function getDatasetMeaning(projectId: string, datasetId: string) {
  return productRequest<DatasetMeaning>(`${base(projectId)}/${encodeURIComponent(datasetId)}`);
}
/** The researcher confirms facts exactly as they are shown; a correction is said in the conversation. */
export function confirmDatasetMeaning(projectId: string, datasetId: string, targets: string[]) {
  return productRequest<{ revision: number; summary: DatasetMeaningListing["summary"] }>(`${base(projectId)}/${encodeURIComponent(datasetId)}/confirm`, "POST", { targets });
}
