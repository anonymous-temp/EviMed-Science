import { productRequest } from "./productClient";

/**
 * A stored connection reference. The service never returns its credentials; `label` is the non-secret name of where it points (host and
 * database name, `host/dbname`) when the service gives one, so two saved connections can be told apart.
 */
export interface ResearchDatabaseRef { id: string; createdAt: string; label?: string }
export interface ResearchDatabaseColumn { name: string; type: string }
/**
 * One readable table, as the listing describes it before anything is imported.
 *
 * `columns` are the columns an import reads (a supported type; the first `limits.columns` by position). What it leaves out is
 * counted here too: `omittedColumnCount` supported columns lie past the column limit, and `unsupportedColumnCount` columns are of a
 * type the import does not read (enum, jsonb, array, time, interval, ...), of which `unsupportedColumns` names the first fifty.
 * `estimatedRows` is null until the database has measured the table.
 */
export interface ResearchDatabaseTable {
  schema: string; table: string; estimatedRows: number | null;
  columns: ResearchDatabaseColumn[]; omittedColumnCount: number;
  unsupportedColumns: ResearchDatabaseColumn[]; unsupportedColumnCount: number;
}
/** What one import takes at most, as the deployment is configured: rows, columns, and the bytes of one cell (a larger cell is left out). */
export interface ResearchDatabaseLimits { rows: number; columns: number; cellBytes: number }
export interface ResearchDatabaseTables { tables: ResearchDatabaseTable[]; truncated: boolean; limits: ResearchDatabaseLimits }
/** Why a column is not in the imported file. */
export type ResearchDatabaseDroppedReason = "unsupported_type" | "over_column_limit";
export interface ResearchDatabaseDroppedColumn extends ResearchDatabaseColumn { reason: ResearchDatabaseDroppedReason }
/**
 * The result of one import. `partial` is true when the file is not the whole table as selected: the rows stopped (`truncated`, by
 * `stoppedBy`: the row limit, the byte limit or the read time), cells over the cell limit were left out (`withheldCells`), or columns
 * were not read (`droppedColumnCount`; `droppedColumns` names the first fifty). `totalRows` is the table's size when the rows stopped,
 * exact or, when `totalRowsExact` is false, the database's estimate; null when not even that is known. `version` is 1 for a table
 * imported for the first time and rises with each import of the same table, which takes the earlier one's place in the research.
 */
export interface ResearchDatabaseSnapshot {
  sourceId: string; capturedAt: string; title: string; rowCount: number; columns: number;
  truncated: boolean; oversizedValuesWithheld: boolean; partial: boolean;
  totalRows: number | null; totalRowsExact: boolean; stoppedBy: "rows" | "bytes" | "time" | null;
  withheldCells: number; droppedColumnCount: number; droppedColumns: ResearchDatabaseDroppedColumn[];
  sidecar: string; version: number;
}

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
  return productRequest<ResearchDatabaseTables>(`/research-databases/${encodeURIComponent(id)}/tables?projectId=${encodeURIComponent(projectId)}`);
}
/** `columns` empty or omitted imports every supported column of the table (up to the column limit). */
export function snapshotResearchDatabase(id: string, input: { projectId: string; requestId: string; agendaId: string; schema: string; table: string; columns: string[] }) {
  return productRequest<ResearchDatabaseSnapshot>(`/research-databases/${encodeURIComponent(id)}/snapshot`, "POST", input);
}
export function removeResearchDatabase(id: string, projectId: string) {
  return productRequest<{ removed: boolean }>(`/research-databases/${encodeURIComponent(id)}`, "DELETE", { projectId });
}
