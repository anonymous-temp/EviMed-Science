import { describe, expect, it } from "vitest";
import type { ResearchDatabaseSnapshot, ResearchDatabaseTable } from "./researchDatabaseClient";
import { importOutcome, tableImportNotes, tableLabel } from "./researchDatabaseWording";

const limits = { rows: 20_000, columns: 64, cellBytes: 32_768 };
const table = (patch: Partial<ResearchDatabaseTable> = {}): ResearchDatabaseTable => ({
  schema: "public", table: "cohort", estimatedRows: 1_200, columns: [{ name: "age", type: "integer" }], omittedColumnCount: 0, unsupportedColumns: [], unsupportedColumnCount: 0, ...patch,
});
const result = (patch: Partial<ResearchDatabaseSnapshot> = {}): ResearchDatabaseSnapshot => ({
  sourceId: "src_one", capturedAt: "2026-10-28T08:00:00.000Z", title: "public.cohort", rowCount: 1_200, columns: 3, truncated: false, oversizedValuesWithheld: false, partial: false,
  totalRows: 1_200, totalRowsExact: true, stoppedBy: null, withheldCells: 0, droppedColumnCount: 0, droppedColumns: [], sidecar: "knowledge-base/databases/x.import.json", version: 1, ...patch,
});

describe("what a table import will leave out, before it is pressed", () => {
  it("states the deployment's own limits and says nothing more about a table that fits", () => {
    const notes = tableImportNotes(table(), limits);
    expect(notes.limits).toBe("导入后存为知识库里的数据表，并加入本研究。单次最多导入 20,000 行、64 列；单个单元格超过 32 KB 的内容不会导入。");
    expect([notes.rows, notes.overLimit, notes.unsupported]).toEqual([null, null, null]);
  });

  it("follows a limit the operator moved, not a number written here", () => {
    expect(tableImportNotes(table(), { rows: 500, columns: 12, cellBytes: 1_048_576 }).limits).toContain("单次最多导入 500 行、12 列；单个单元格超过 1 MB");
  });

  it("says that only the first rows come over when the table is larger, and that they are not a sample", () => {
    const notes = tableImportNotes(table({ estimatedRows: 52_340 }), limits);
    expect(notes.rows).toBe("这张表约有 5.2万 行，只会导入表里靠前的 20,000 行（按存放顺序，不是随机抽样）。");
  });

  it("says the same when the size of the table is not known, without claiming that it is larger", () => {
    const notes = tableImportNotes(table({ estimatedRows: null }), limits);
    expect(notes.rows).toBe("这张表的行数还没有统计；超过 20,000 行时，只会导入表里靠前的 20,000 行（按存放顺序，不是随机抽样）。");
  });

  it("counts the columns past the column limit", () => {
    expect(tableImportNotes(table({ omittedColumnCount: 36 }), limits).overLimit).toBe("另有 36 列超出 64 列的上限，不会导入。");
  });

  it("names the columns of a type that is not read, with their type, inline when there are few", () => {
    const notes = tableImportNotes(table({ unsupportedColumns: [{ name: "notes", type: "jsonb" }, { name: "stay", type: "interval" }], unsupportedColumnCount: 2 }), limits);
    expect(notes.unsupported).toEqual({ summary: "2 列的类型暂不支持，不会导入", names: "notes（jsonb）、stay（interval）", fold: false });
  });

  it("folds a long list of unsupported columns and counts the ones the listing no longer names", () => {
    const many = Array.from({ length: 50 }, (_, index) => ({ name: `c${index}`, type: "jsonb" }));
    const notes = tableImportNotes(table({ unsupportedColumns: many, unsupportedColumnCount: 80 }), limits);
    expect(notes.unsupported?.summary).toBe("80 列的类型暂不支持，不会导入");
    expect(notes.unsupported?.fold).toBe(true);
    expect(notes.unsupported?.names).toMatch(/^c0（jsonb）、c1（jsonb）/);
    expect(notes.unsupported?.names).toMatch(/，以及另外 30 列$/);
  });

  it("writes a table outside the default schema with its schema", () => {
    expect(tableLabel({ schema: "public", table: "cohort" })).toBe("cohort");
    expect(tableLabel({ schema: "lab", table: "results" })).toBe("lab.results");
  });
});

describe("what an import came to", () => {
  it("keeps the one-line confirmation for a table that came over whole", () => {
    const outcome = importOutcome(result(), "cohort");
    expect(outcome).toEqual({ text: "已导入 cohort：1,200 行 × 3 列，已加入本研究。", partial: false, notes: [] });
  });

  it("says plainly that only part of the table came over, how many rows of how many, and what else was left out", () => {
    const outcome = importOutcome(result({
      rowCount: 20_000, truncated: true, partial: true, totalRows: 52_340, totalRowsExact: true, stoppedBy: "rows", withheldCells: 3, droppedColumnCount: 2,
      droppedColumns: [{ name: "notes", type: "jsonb", reason: "unsupported_type" }, { name: "stay", type: "interval", reason: "unsupported_type" }],
    }), "cohort");
    expect(outcome.partial).toBe(true);
    expect(outcome.text).toBe("已导入 cohort，只导入了一部分：前 20,000 行（共 52,340 行） × 3 列；3 个单元格过大未导入；2 列类型不支持未导入。已加入本研究。");
    expect(outcome.notes).toContain("取的是表里靠前的行（按存放顺序，不是随机抽样），不能代表整张表。");
    expect(outcome.notes).toContain("未导入的列：notes、stay。");
  });

  it("marks a total that is only the database's estimate as approximate, and leaves out a total nobody knows", () => {
    const cut = { rowCount: 20_000, truncated: true, partial: true, stoppedBy: "rows" as const };
    expect(importOutcome(result({ ...cut, totalRows: 52_340, totalRowsExact: false }), "cohort").text).toContain("前 20,000 行（共约 52,340 行）");
    const unknown = importOutcome(result({ ...cut, totalRows: null, totalRowsExact: false }), "cohort").text;
    expect(unknown).toContain("前 20,000 行 × 3 列");
    expect(unknown).not.toContain("共");
  });

  it("says why the rows stopped when it was not the row limit", () => {
    const cut = { rowCount: 9_000, truncated: true, partial: true, totalRows: 52_340, totalRowsExact: true };
    expect(importOutcome(result({ ...cut, stoppedBy: "bytes" }), "cohort").notes).toContain("数据量超过单次导入的上限，读到这里就停了。");
    expect(importOutcome(result({ ...cut, stoppedBy: "time" }), "cohort").notes).toContain("读取用时超过了上限，读到这里就停了。");
    expect(importOutcome(result({ ...cut, stoppedBy: "rows" }), "cohort").notes.join("")).not.toContain("就停了");
  });

  it("is partial for columns alone, and tells the two reasons apart", () => {
    const outcome = importOutcome(result({
      partial: true, droppedColumnCount: 3,
      droppedColumns: [{ name: "notes", type: "jsonb", reason: "unsupported_type" }, { name: "w1", type: "integer", reason: "over_column_limit" }, { name: "w2", type: "integer", reason: "over_column_limit" }],
    }), "cohort");
    expect(outcome.partial).toBe(true);
    expect(outcome.text).toBe("已导入 cohort，只导入了一部分：1,200 行 × 3 列；1 列类型不支持未导入；2 列超出列数上限未导入。已加入本研究。");
    expect(outcome.notes).toEqual(["未导入的列：notes、w1、w2。"]);
  });

  it("counts a dropped column the result no longer names, and shortens a long list of names", () => {
    const named = Array.from({ length: 50 }, (_, index) => ({ name: `c${index}`, type: "jsonb", reason: "unsupported_type" as const }));
    const outcome = importOutcome(result({ partial: true, droppedColumnCount: 60, droppedColumns: named }), "cohort");
    expect(outcome.text).toContain("50 列类型不支持未导入；另有 10 列未导入");
    expect(outcome.notes).toEqual(["未导入的列：c0、c1、c2、c3、c4、c5 等 60 列。"]);
  });

  it("says that a re-import is a new version that replaced the earlier one in the research, whole or not", () => {
    expect(importOutcome(result({ version: 3 }), "cohort").notes).toEqual(["这是 cohort 的第 3 版，本研究里已改用这一版。"]);
    expect(importOutcome(result({ version: 1 }), "cohort").notes).toEqual([]);
    expect(importOutcome(result({ version: 2, truncated: true, partial: true, rowCount: 20_000, totalRows: 30_000 }), "cohort").notes.at(-1)).toBe("这是 cohort 的第 2 版，本研究里已改用这一版。");
  });

  it("reads a result without the newer fields as a whole import instead of failing", () => {
    const old = { sourceId: "s", capturedAt: "", rowCount: 1, truncated: false, oversizedValuesWithheld: false } as unknown as ResearchDatabaseSnapshot;
    expect(importOutcome(old, "cohort")).toEqual({ text: "已导入 cohort：1 行，已加入本研究。", partial: false, notes: [] });
  });
});
