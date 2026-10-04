import { describe, expect, it } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { fieldMapBody, freezeBody, grantBody, sourceBody, uploadQuery } from "@/lib/vcrIntakeBodies";
import { readVcrIntake, type VcrIntakeSource } from "@/lib/vcrClient";
import { fixture } from "../__fixtures__/serverFixtures";
import { IMPORT_FORMATS, documentAccept, editorRows, entriesOf, importAccept, importProblem, importSummary, intakeErrorMessage, mapProblem, rowProblem, uploadProblem } from "./intakeState";
import { knownErrorCodeMessage } from "@evimed/domain";

/** The second source of the sealed page: one file, a map with problems. */
function source(change?: (raw: VcrIntakeSource) => void): VcrIntakeSource {
  const intake = readVcrIntake(fixture("intake/data-sealed.json").intake);
  const found = structuredClone(intake.sources[1]);
  change?.(found);
  return found;
}

describe("the editor's rows and the entries they become", () => {
  it("starts from every column of the newest version of each data file, and keeps what the map already says", () => {
    const first = readVcrIntake(fixture("intake/data-sealed.json").intake).sources[0];
    const rows = editorRows(first);
    expect(rows.map((row) => `${row.table}:${row.column}`)).toContain("cohort.csv:OS_MONTHS");
    expect(rows.find((row) => row.column === "OS_MONTHS")).toMatchObject({ role: "outcome_time", parameter: "OS", unit: "month" });
    expect(rows.find((row) => row.column === "ARM")).toMatchObject({ role: "arm", alias: "arm", treated: "TRT", control: "CTL" });
    // Round trip: what the server has, the editor sends back unchanged — nothing it does not show is lost.
    const again = entriesOf(rows);
    const saved = first.fieldMap.columns.filter((entry) => entry.role !== "other" || entry.identifier);
    expect(again.map((entry) => `${entry.table}:${entry.column}:${entry.role}`).sort()).toEqual(saved.map((entry) => `${entry.table}:${entry.column}:${entry.role}`).sort());
    expect(again.find((entry) => entry.column === "AGE")).toMatchObject({ role: "covariate", alias: "age", unit: "year", type: "integer", range: [18, 100] });
  });

  it("an old version of a file is not offered again", () => {
    const found = source((raw) => {
      raw.files = [{ ...raw.files[0], id: "sfl_old", latest: false }, { ...raw.files[0], id: "sfl_new", latest: true }];
    });
    expect(editorRows(found).filter((row) => row.column === "ARM")).toHaveLength(1);
  });

  it("suggests the person's key and marks a suspected identifier, and sends neither an untouched 其他 column nor a column of no meaning", () => {
    const found = source((raw) => {
      raw.fieldMap.columns = [];
      raw.files[0].columns = ["PATIENT_NO", "ARM", "DEAD", "PHONE"].map((name) => ({ name, type: "text", filled: 1, distinct: 2, identifying: name === "PHONE" }));
    });
    const rows = editorRows(found);
    expect(rows.find((row) => row.column === "PATIENT_NO")?.role).toBe("subject_key");
    expect(rows.find((row) => row.column === "PHONE")).toMatchObject({ role: "other", identifier: true });
    expect(entriesOf(rows).map((entry) => entry.column)).toEqual(["PATIENT_NO", "PHONE"]);
    expect(entriesOf(editorRows(source((raw) => { raw.fieldMap.columns = []; raw.files[0].columns = raw.files[0].columns.filter((column) => column.name !== "PATIENT_NO"); })))).toEqual([]);
  });

  it("says what is missing in a row's own words, and holds a map back until every table has its subject key", () => {
    const rows = editorRows(source((raw) => { raw.fieldMap.columns = []; raw.files[0].columns.forEach((column) => { column.identifying = false; }); }));
    const dead = rows.find((row) => row.column === "DEAD")!;
    expect(mapProblem(rows)).toBeNull();
    dead.role = "outcome_event";
    expect(rowProblem(dead)).toBe("填一个参数代码，例如 OS。");
    expect(mapProblem(rows)).toMatch(/“DEAD”/);
    dead.parameter = "OS";
    expect(mapProblem(rows)).toBeNull();
    const arm = rows.find((row) => row.column === "ARM")!;
    arm.role = "arm";
    arm.alias = "1 bad";
    expect(rowProblem(arm)).toMatch(/英文字母/);
    arm.alias = "";
    expect(rowProblem(arm)).toBeNull();
    rows.find((row) => row.column === "PATIENT_NO")!.role = "other";
    expect(mapProblem(rows)).toBe("“followup.csv”需要标出受试者编号那一列。");
    expect(mapProblem([])).toBe("至少标出受试者编号那一列。");
  });
});

describe("what the page refuses before the plane has to", () => {
  it("names the extension, the emptiness and the size", () => {
    const max = 50 * 1024 * 1024;
    expect(uploadProblem({ name: "a.csv", size: 10 }, "data", max)).toBeNull();
    expect(uploadProblem({ name: "a.XLSX", size: 10 }, "data", max)).toBeNull();
    expect(uploadProblem({ name: "a.parquet", size: 10 }, "data", max)).toMatch(/Parquet/);
    expect(uploadProblem({ name: "a.xls", size: 10 }, "data", max)).toMatch(/xlsx/);
    expect(uploadProblem({ name: "a.zip", size: 10 }, "data", max)).toMatch(/解压/);
    expect(uploadProblem({ name: "a.pdf", size: 10 }, "data", max)).toMatch(/支持/);
    expect(uploadProblem({ name: "a", size: 10 }, "data", max)).toMatch(/扩展名/);
    expect(uploadProblem({ name: "a.csv", size: 0 }, "data", max)).toBe("文件是空的。");
    expect(uploadProblem({ name: "a.csv", size: max + 1 }, "data", max)).toMatch(/50 MB/);
    expect(uploadProblem({ name: "dictionary.csv", size: 3 * 1024 * 1024 }, "dictionary", max)).toMatch(/2 MB/);
    expect(uploadProblem({ name: "a.csv", size: 999_999_999 }, "data", null)).toBeNull();
  });

  it("holds a patient record to what the deployment would take: text, PDF and Word where they are converted, never a picture", () => {
    const max = 50 * 1024 * 1024;
    const converted = { formats: ["txt", "md", "pdf", "docx"], maxBytes: 25 * 1024 * 1024, maxText: "25 MB", converter: true };
    const textOnly = { formats: ["txt", "md"], maxBytes: null, maxText: null, converter: false };
    expect(documentAccept(null)).toBe(".txt,.md");
    expect(documentAccept(textOnly)).toBe(".txt,.md");
    expect(documentAccept(converted)).toBe(".txt,.md,.pdf,.docx");
    expect(uploadProblem({ name: "a.txt", size: 10 }, "document", max, converted)).toBeNull();
    expect(uploadProblem({ name: "a.PDF", size: 20 * 1024 * 1024 }, "document", max, converted)).toBeNull();
    expect(uploadProblem({ name: "a.docx", size: 26 * 1024 * 1024 }, "document", max, converted)).toMatch(/25 MB/);
    // The text of a record keeps its own, smaller ceiling.
    expect(uploadProblem({ name: "a.txt", size: 2 * 1024 * 1024 }, "document", max, converted)).toMatch(/1 MB/);
    expect(uploadProblem({ name: "a.pdf", size: 10 }, "document", max, textOnly)).toMatch(/暂不转换 PDF 和 Word/);
    expect(uploadProblem({ name: "a.pdf", size: 10 }, "document", max)).toMatch(/暂不转换 PDF 和 Word/);
    expect(uploadProblem({ name: "a.pdf", size: 0 }, "document", max, converted)).toBe("文件是空的。");
    for (const name of ["x.png", "x.JPG", "x.jpeg", "x.tiff", "x.heic"]) {
      expect(uploadProblem({ name, size: 10 }, "document", max, converted)).toBe(knownErrorCodeMessage("vcr_document_needs_text"));
    }
    expect(uploadProblem({ name: "x.doc", size: 10 }, "document", max, converted)).toMatch(/另存为 \.docx/);
    expect(uploadProblem({ name: "x.csv", size: 10 }, "document", max, converted)).toMatch(/txt、md、pdf、docx/);
    // Another role is unchanged: a PDF is not a data file, and a picture of one is not a document's problem.
    expect(uploadProblem({ name: "a.pdf", size: 10 }, "data", max, converted)).toMatch(/支持/);
  });

  it("says a scan, a damaged file and a missing converter in the registry's words, and the plane's format refusal for both kinds of file", () => {
    for (const code of ["vcr_document_needs_text", "vcr_document_unreadable", "vcr_document_too_long", "vcr_document_converter_unavailable", "vcr_intake_timeout", "vcr_intake_failed"]) {
      const sentence = intakeErrorMessage(new WebApiError("x", { status: 422, code }), "f");
      expect(sentence).toBe(knownErrorCodeMessage(code));
      expect(sentence).not.toBe("f");
    }
    expect(intakeErrorMessage(new WebApiError("x", { status: 422, code: "vcr_document_needs_text" }), "f")).toMatch(/请提供文字版/);
    expect(intakeErrorMessage(new WebApiError("x", { status: 415, code: "vcr_data_format_unsupported" }), "f")).toMatch(/CSV.*PDF/);
  });

  it("says the plane's refusals as sentences, and a code it does not know the way the rest of the page does", () => {
    expect(intakeErrorMessage(new WebApiError("x", { status: 409, code: "vcr_field_map_unconfirmed" }), "f")).toBe("请先确认字段映射，再冻结快照。");
    expect(intakeErrorMessage(new WebApiError("x", { status: 403, code: "vcr_grant_owner_only" }), "f")).toMatch(/只有登记这个数据源的账号/);
    expect(intakeErrorMessage(new Error("boom"), "暂时无法保存。")).toBe("暂时无法保存。");
  });
});

describe("the bodies are exactly the routes' allow-lists", () => {
  it("leaves out what was not said, and never sends a key the route does not list", () => {
    expect(sourceBody({ name: " 合作方 ", ownerParty: " ", allowedUses: [] })).toEqual({ name: "合作方" });
    expect(Object.keys(sourceBody({ name: "x", ownerParty: "y", allowedUses: ["vcr"], visibleWindow: { start: "2020-01-01" }, retention: { until: "2030-01-01" }, valueSource: "observed" })).sort())
      .toEqual(["allowedUses", "name", "ownerParty", "retention", "valueSource", "visibleWindow"]);
    expect(fieldMapBody([{ column: " A ", role: "arm", alias: "", unit: null, identifier: false, codes: {} }])).toEqual({ columns: [{ column: "A", role: "arm" }] });
    expect(freezeBody()).toEqual({});
    expect(freezeBody({ fileIds: ["sfl_1"], asOf: "2026-01-01T00:00:00Z" })).toEqual({ fileIds: ["sfl_1"], asOf: "2026-01-01T00:00:00Z" });
    expect(grantBody({ grantee: " a ", fields: [], purposes: ["vcr"] })).toEqual({ grantee: "a", purposes: ["vcr"] });
    expect(uploadQuery({ name: "队列.csv" })).toBe("name=%E9%98%9F%E5%88%97.csv");
    expect(uploadQuery({ name: "d.csv", role: "dictionary", sheet: "病例" })).toBe("name=d.csv&role=dictionary&sheet=%E7%97%85%E4%BE%8B");
  });
});

describe("a source held in a standard format", () => {
  const imports = {
    available: true, maxBytes: 25 * 1024 * 1024, maxText: "25 MB",
    formats: [{ value: "fhir" as const, extensions: ["ndjson", "json", "zip"] }, { value: "omop" as const, extensions: ["zip"] }, { value: "adam" as const, extensions: ["xpt", "zip"] }],
  };

  it("says what each standard is uploaded as, and refuses on the page what the plane would refuse", () => {
    expect(IMPORT_FORMATS.map((entry) => entry.value)).toEqual(["fhir", "omop", "adam"]);
    expect(importAccept("fhir", imports)).toBe(".ndjson,.json,.zip");
    expect(importAccept("adam", imports)).toBe(".xpt,.zip");
    expect(importAccept("omop", null)).toBe("");
    expect(importProblem({ name: "export.zip", size: 10 }, "omop", imports)).toBeNull();
    expect(importProblem({ name: "adsl.xpt", size: 10 }, "adam", imports)).toBeNull();
    expect(importProblem({ name: "person.csv", size: 10 }, "omop", imports)).toBe("这一种格式支持：zip。");
    expect(importProblem({ name: "adsl.xpt", size: 10 }, "fhir", imports)).toBe("这一种格式支持：ndjson、json、zip。");
    expect(importProblem({ name: "noextension", size: 10 }, "fhir", imports)).toMatch(/扩展名/);
    expect(importProblem({ name: "export.zip", size: 0 }, "fhir", imports)).toBe("文件是空的。");
    expect(importProblem({ name: "export.zip", size: 26 * 1024 * 1024 }, "fhir", imports)).toBe("文件超过 25 MB 的上限。");
    expect(importProblem({ name: "export.zip", size: 10 }, "fhir", null)).toMatch(/本部署暂未开通/);
  });

  it("says the registry's words for each way an import is refused", () => {
    for (const code of ["vcr_import_not_this_format", "vcr_import_nothing_to_import", "vcr_import_unreadable", "vcr_import_version_unsupported", "vcr_import_converter_unavailable"]) {
      const sentence = intakeErrorMessage(new WebApiError("x", { status: 422, code }), "f");
      expect(sentence).toBe(knownErrorCodeMessage(code));
      expect(sentence).not.toBe("f");
    }
  });

  it("reads what an import took and left as sentences, a word it does not know as it is, and never a value", () => {
    const summary = importSummary({
      format: "fhir", standard: { name: "HL7 FHIR" }, fieldMap: { hash: "h", entries: 3, trimmed: 0, columnSourcesDeclared: true },
      tables: [{ name: "fhir_patient", file: "fhir_patient.csv", rows: 11, columns: 11, stored: true }, { name: "fhir_observation", file: "fhir_observation.csv", rows: 4188, columns: 16, stored: false, reason: "too_many_rows" }],
      coverage: {
        inputs: [
          { kind: "Patient", records: 12, imported: 11, status: "imported", reason: null, skipped: { duplicate_patient_id: 1 } },
          { kind: "Device", records: 39, imported: 0, status: "skipped", reason: "unsupported_resource_type", skipped: {} },
          { kind: "Condition", records: 5, imported: 5, status: "imported", reason: null, skipped: {} },
        ],
        skippedTables: [{ table: "fhir_encounter", reason: "something_new" }],
        notices: [{ code: "mixed_units", count: 2 }, { code: "value_not_carried:Range", count: 3 }, { code: "brand_new", count: 1 }],
      },
    });
    expect(summary.tables).toEqual(["fhir_patient：11 行，11 列", "fhir_observation：没有保存（行数超过上限）"]);
    expect(summary.skipped).toEqual([
      "Patient：读到 12 条，导入 11 条；患者编号重复 1",
      "Device：读到 39 条，导入 0 条（本版本不读这类资源）",
      "fhir_encounter：没有生成（something_new）",
    ]);
    expect(summary.notices[0]).toMatch(/^2 个检查项目在不同行里用了不同单位/);
    expect(summary.notices[1]).toBe("3 类型为 Range 的取值本版本不读，已留空");
    expect(summary.notices[2]).toBe("1 brand_new");
  });

  it("says OMOP's own words: a table folded into another, a table that lacks a column, an empty death table", () => {
    const summary = importSummary({
      format: "omop", standard: { name: "OMOP CDM" }, fieldMap: { hash: "h", entries: 3, trimmed: 0, columnSourcesDeclared: true },
      tables: [{ name: "omop_person", file: "omop_person.csv", rows: 150, columns: 10, stored: true }],
      coverage: {
        inputs: [
          { kind: "death", records: 0, imported: 0, status: "skipped", reason: "empty_table", skipped: {} },
          { kind: "measurement", records: 9, imported: 0, status: "skipped", reason: "missing_required_column:measurement_date", skipped: {} },
          { kind: "procedure_occurrence", records: 1807, imported: 0, status: "skipped", reason: "unsupported_table", skipped: {} },
        ],
        skippedTables: [], notices: [{ code: "death_table_empty", count: 1 }, { code: "concept_ids_not_in_vocabulary", count: 10 }],
      },
    });
    expect(summary.skipped).toEqual([
      "death：读到 0 条，导入 0 条（表里没有数据）",
      "measurement：读到 9 条，导入 0 条（缺少必需的列 measurement_date）",
      "procedure_occurrence：读到 1807 条，导入 0 条（本版本不读这张表）",
    ]);
    expect(summary.notices).toEqual(["1 张死亡表是空的：没有记录不等于都还活着，随访按观察期结束截尾", "10 个概念编号不在这份导出的词表里"]);
  });

  it("keeps each column's value source through the editor, so a person's edit does not lose what the import said", () => {
    const held = (columns: VcrIntakeSource["fieldMap"]["columns"]) => {
      const found = structuredClone(readVcrIntake(fixture("intake/data-sealed.json").intake).sources[0]);
      found.fieldMap.columns = columns;
      return found;
    };
    const rows = editorRows(held([{ table: "cohort.csv", column: "PATIENT_NO", role: "subject_key", valueSource: "observed" }, { table: "cohort.csv", column: "AGE", role: "covariate", alias: "AGE", valueSource: "calculated", concept: "Age" }]));
    expect(rows.find((row) => row.column === "AGE")).toMatchObject({ valueSource: "calculated" });
    const entries = entriesOf(rows);
    expect(entries.find((entry) => entry.column === "AGE")).toMatchObject({ valueSource: "calculated", concept: "Age" });
    expect(entries.find((entry) => entry.column === "PATIENT_NO")).toMatchObject({ valueSource: "observed" });
    // The route's body carries it too: it is one of the keys a field-map entry may have.
    expect(fieldMapBody(entries).columns).toContainEqual(expect.objectContaining({ column: "AGE", valueSource: "calculated" }));
    // A column that says only where it came from is still said, and a column that says nothing is not sent.
    const only = editorRows(held([{ table: "cohort.csv", column: "SEX", role: "other", valueSource: "imputed" }]));
    expect(entriesOf(only).find((entry) => entry.column === "SEX")).toMatchObject({ role: "other", valueSource: "imputed" });
  });
});
