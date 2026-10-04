import { describe, expect, it } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { fieldMapBody, freezeBody, grantBody, sourceBody, uploadQuery } from "@/lib/vcrIntakeBodies";
import { readVcrIntake, type VcrIntakeSource } from "@/lib/vcrClient";
import { fixture } from "../__fixtures__/serverFixtures";
import { editorRows, entriesOf, intakeErrorMessage, mapProblem, rowProblem, uploadProblem } from "./intakeState";

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
