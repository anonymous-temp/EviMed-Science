import { beforeEach, describe, expect, it, vi } from "vitest";
import { listResearchDatabases, listResearchDatabaseTables, removeResearchDatabase, researchDatabaseStatus, saveResearchDatabase, snapshotResearchDatabase, type ResearchDatabaseSnapshot, type ResearchDatabaseTables } from "./researchDatabaseClient";

const request = vi.hoisted(() => vi.fn());
vi.mock("./productClient", () => ({ productRequest: request }));

describe("research database client", () => {
  beforeEach(() => { request.mockReset(); });

  it("asks for the status, the saved connections and the tables of one project with encoded identifiers", async () => {
    request.mockResolvedValue({});
    await researchDatabaseStatus("project/one");
    expect(request).toHaveBeenLastCalledWith("/research-databases/status?projectId=project%2Fone");
    await listResearchDatabases("project/one");
    expect(request).toHaveBeenLastCalledWith("/research-databases?projectId=project%2Fone");
    await listResearchDatabaseTables("conn/one", "project/one");
    expect(request).toHaveBeenLastCalledWith("/research-databases/conn%2Fone/tables?projectId=project%2Fone");
  });

  it("posts a connection and an import with their request ids, and removes a connection with the project in the body", async () => {
    request.mockResolvedValue({});
    const connection = { projectId: "p1", requestId: "r1", host: "db.example.org", port: 5432, database: "research", username: "reader", password: "secret-for-test" };
    await saveResearchDatabase(connection);
    expect(request).toHaveBeenLastCalledWith("/research-databases", "POST", connection);
    const input = { projectId: "p1", requestId: "r2", agendaId: "a1", schema: "public", table: "cohort", columns: ["age"] };
    await snapshotResearchDatabase("conn/one", input);
    expect(request).toHaveBeenLastCalledWith("/research-databases/conn%2Fone/snapshot", "POST", input);
    await removeResearchDatabase("conn/one", "p1");
    expect(request).toHaveBeenLastCalledWith("/research-databases/conn%2Fone", "DELETE", { projectId: "p1" });
  });

  it("hands the listing's unsupported and omitted columns and its limits to the caller whole", async () => {
    const listing: ResearchDatabaseTables = {
      truncated: false,
      limits: { rows: 20_000, columns: 64, cellBytes: 32_768 },
      tables: [{
        schema: "public", table: "cohort", estimatedRows: 52_340, columns: [{ name: "age", type: "integer" }], omittedColumnCount: 3,
        unsupportedColumns: [{ name: "notes", type: "jsonb" }], unsupportedColumnCount: 2,
      }],
    };
    request.mockResolvedValue(listing);
    expect(await listResearchDatabaseTables("conn-one", "p1")).toBe(listing);
  });

  it("hands the import's account of what it left out to the caller whole", async () => {
    const result: ResearchDatabaseSnapshot = {
      sourceId: "src_one", capturedAt: "2026-10-28T08:00:00.000Z", title: "public.cohort（前 20,000 行，共 52,340 行）", rowCount: 20_000, columns: 3,
      truncated: true, oversizedValuesWithheld: true, partial: true, totalRows: 52_340, totalRowsExact: true, stoppedBy: "rows",
      withheldCells: 3, droppedColumnCount: 2, droppedColumns: [{ name: "notes", type: "jsonb", reason: "unsupported_type" }, { name: "extra", type: "integer", reason: "over_column_limit" }],
      sidecar: "knowledge-base/databases/public.cohort-1a2b3c4d.import.json", version: 2,
    };
    request.mockResolvedValue(result);
    expect(await snapshotResearchDatabase("conn-one", { projectId: "p1", requestId: "r1", agendaId: "a1", schema: "public", table: "cohort", columns: [] })).toBe(result);
  });
});
