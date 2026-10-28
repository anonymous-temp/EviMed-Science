import { productRequest } from "./productClient";

/**
 * A stored connection reference. The service never returns its credentials; `label` is the non-secret name of where it points (host and
 * database name, `host/dbname`) when the service gives one, so two saved connections can be told apart.
 */
export interface ResearchDatabaseRef { id: string; createdAt: string; label?: string }
/** One readable table and its importable columns; `estimatedRows` is null until the database has measured it. */
export interface ResearchDatabaseTable { schema: string; table: string; estimatedRows: number | null; columns: Array<{ name: string; type: string }> }
export interface ResearchDatabaseSnapshot { sourceId: string; capturedAt: string; rowCount: number; columns?: number; truncated: boolean; oversizedValuesWithheld: boolean }
/** The most rows one import takes; a larger table is imported up to this many. */
export const RESEARCH_DATABASE_ROW_LIMIT = 20_000;
export const RESEARCH_DATABASE_COLUMN_LIMIT = 64;

export function researchDatabaseStatus(projectId: string) {
  return productRequest<{ available: boolean }>(`/research-databases/status?projectId=${encodeURIComponent(projectId)}`);
}
export function listResearchDatabases(projectId: string) {
  return productRequest<{ items: ResearchDatabaseRef[] }>(`/research-databases?projectId=${encodeURIComponent(projectId)}`);
}
export function saveResearchDatabase(input: { projectId: string; requestId: string; host: string; port: number; database: string; username: string; password: string }) {
  return productRequest<{ id: string }>("/research-databases", "POST", input);
}
export function listResearchDatabaseTables(id: string, projectId: string) {
  return productRequest<{ tables: ResearchDatabaseTable[]; truncated: boolean }>(`/research-databases/${encodeURIComponent(id)}/tables?projectId=${encodeURIComponent(projectId)}`);
}
/** `columns` empty or omitted imports every supported column of the table. */
export function snapshotResearchDatabase(id: string, input: { projectId: string; requestId: string; agendaId: string; schema: string; table: string; columns: string[] }) {
  return productRequest<ResearchDatabaseSnapshot>(`/research-databases/${encodeURIComponent(id)}/snapshot`, "POST", input);
}
export function removeResearchDatabase(id: string, projectId: string) {
  return productRequest<{ removed: boolean }>(`/research-databases/${encodeURIComponent(id)}`, "DELETE", { projectId });
}
