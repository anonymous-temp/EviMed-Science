import { productRequest } from "./productClient";

/** A stored connection reference. The service never returns its credentials. */
export interface ResearchDatabaseRef { id: string; createdAt: string }
export interface ResearchDatabaseSnapshot { sourceId: string; capturedAt: string; rowCount: number; truncated: boolean; oversizedValuesWithheld: boolean }
export function listResearchDatabases(projectId: string) {
  return productRequest<{ items: ResearchDatabaseRef[] }>(`/research-databases?projectId=${encodeURIComponent(projectId)}`);
}
export function saveResearchDatabase(input: { projectId: string; requestId: string; host: string; port: number; database: string; username: string; password: string }) {
  return productRequest<{ id: string }>("/research-databases", "POST", input);
}
export function snapshotResearchDatabase(id: string, input: { projectId: string; requestId: string; agendaId: string; schema: string; table: string; columns: string[] }) {
  return productRequest<ResearchDatabaseSnapshot>(`/research-databases/${encodeURIComponent(id)}/snapshot`, "POST", input);
}
export function removeResearchDatabase(id: string, projectId: string) {
  return productRequest<{ removed: boolean }>(`/research-databases/${encodeURIComponent(id)}`, "DELETE", { projectId });
}
