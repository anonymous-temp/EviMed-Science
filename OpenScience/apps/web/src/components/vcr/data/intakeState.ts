import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import type { VcrFieldMapEntry, VcrFieldRole, VcrIntakeSource } from "@/lib/vcrClient";

/**
 * What the data-intake flow decides on the page rather than on the server:
 * the field-map editor's rows and the entries they become, the client-side
 * checks that spare a person an upload the plane would refuse, and the
 * sentences for the plane's refusals.
 *
 * The server checks all of it again — a map is validated as a whole before it is
 * confirmed and before a snapshot is frozen. Nothing here decides anything; it
 * saves a round trip and says why in the words of the form in front of the reader.
 */

/** Roles that name an outcome or a measurement and so need a parameter code. */
export const PARAMETER_ROLES: readonly VcrFieldRole[] = ["outcome_time", "outcome_event", "measurement"];
/** Roles that put a column into the subject table under a name of its own. */
export const ALIAS_ROLES: readonly VcrFieldRole[] = ["arm", "covariate"];
/** A name a column carries in the analysis tables — the row-rule grammar's column name. */
const ANALYSIS_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
/** Column names that usually are the person's key in the source. */
const KEY_NAME = /^(usubjid|subjid|subject_?id|patient_?id|patient_?no|pid|受试者编号|患者编号)$/i;

/** The keys of an entry the editor shows and rewrites itself. */
const SHOWN_KEYS = ["table", "column", "role", "parameter", "alias", "unit", "timeKind", "missingReason", "identifier", "outcome", "codes"] as const;

/** One column of one file, as the editor holds it. Words, not codes: `treated` is what a person types. */
export interface EditorRow {
  key: string;
  table: string;
  column: string;
  role: VcrFieldRole;
  parameter: string;
  alias: string;
  unit: string;
  timeKind: string;
  missingReason: string;
  identifier: boolean;
  /** A baseline or measurement column that is itself an outcome (a response, a change): sealed like the outcome pair. */
  outcome: boolean;
  treated: string;
  control: string;
  event: string;
  censored: string;
  /** Everything the entry carries that the editor does not show (concept, range, type, coding system…), kept as it was. */
  extra: Partial<VcrFieldMapEntry>;
  /** The profiler's own finding that the column identifies a person. */
  identifying: boolean;
}

const words = (value: string): string[] => value.split(/[,，、;；]/).map((word) => word.trim()).filter(Boolean).slice(0, 10);
const joined = (value: readonly string[] | undefined): string => (value ?? []).join("、");

/** The rows of a source's editor: every column of the newest version of each data file, with its saved answer when there is one. */
export function editorRows(source: VcrIntakeSource): EditorRow[] {
  const saved = new Map(source.fieldMap.columns.map((entry) => [`${entry.table ?? ""}\u0000${entry.column}`, entry]));
  const rows: EditorRow[] = [];
  let hasKey = source.fieldMap.columns.some((entry) => entry.role === "subject_key");
  for (const file of source.files) {
    if (file.role !== "data" || file.latest === false) continue;
    for (const column of file.columns) {
      const entry = saved.get(`${file.name}\u0000${column.name}`);
      const { role, parameter, alias, unit, timeKind, missingReason, identifier, outcome, codes } = entry ?? ({} as VcrFieldMapEntry);
      // What the editor does not show travels as it was (concept, range, type, coding system…).
      const extra: Record<string, unknown> = { ...entry };
      for (const key of SHOWN_KEYS) delete extra[key];
      let suggested: VcrFieldRole = "other";
      if (!entry && !hasKey && KEY_NAME.test(column.name)) { suggested = "subject_key"; hasKey = true; }
      rows.push({
        key: `${file.name}\u0000${column.name}`,
        table: file.name, column: column.name,
        role: (role as VcrFieldRole | undefined) ?? suggested,
        parameter: parameter ?? "",
        alias: alias ?? "",
        unit: unit ?? "",
        timeKind: timeKind ?? "",
        missingReason: missingReason ?? "",
        identifier: identifier === true || (!entry && column.identifying && suggested !== "subject_key"),
        outcome: outcome === true,
        treated: joined(codes?.treated), control: joined(codes?.control), event: joined(codes?.event), censored: joined(codes?.censored),
        extra: extra as Partial<VcrFieldMapEntry>,
        identifying: column.identifying,
      });
    }
  }
  return rows;
}

/** Whether a row says anything at all: an untouched 「其他」 column is not sent. */
function isDefault(row: EditorRow): boolean {
  return row.role === "other" && !row.identifier && !row.unit && !row.timeKind && !row.missingReason && Object.keys(row.extra).length === 0;
}

/** The entries the routes take, from the editor's rows: only what the person said. */
export function entriesOf(rows: readonly EditorRow[]): VcrFieldMapEntry[] {
  return rows.filter((row) => !isDefault(row)).map((row) => {
    const entry: VcrFieldMapEntry = { ...row.extra, table: row.table, column: row.column, role: row.role };
    if (PARAMETER_ROLES.includes(row.role) && row.parameter.trim()) entry.parameter = row.parameter.trim();
    if (ALIAS_ROLES.includes(row.role) && row.alias.trim()) entry.alias = row.alias.trim();
    if (row.unit.trim()) entry.unit = row.unit.trim();
    if (row.timeKind) entry.timeKind = row.timeKind as VcrFieldMapEntry["timeKind"];
    if (row.missingReason) entry.missingReason = row.missingReason;
    if (row.identifier) entry.identifier = true;
    if (row.outcome && (row.role === "covariate" || row.role === "measurement")) entry.outcome = true;
    if (row.role === "arm" && (words(row.treated).length || words(row.control).length)) {
      entry.codes = { ...(words(row.treated).length ? { treated: words(row.treated) } : {}), ...(words(row.control).length ? { control: words(row.control) } : {}) };
    }
    if (row.role === "outcome_event" && (words(row.event).length || words(row.censored).length)) {
      entry.codes = { ...(words(row.event).length ? { event: words(row.event) } : {}), ...(words(row.censored).length ? { censored: words(row.censored) } : {}) };
    }
    return entry;
  });
}

/** What is missing in a row, in the words of its own fields — the server names the rest. */
export function rowProblem(row: EditorRow): string | null {
  if (PARAMETER_ROLES.includes(row.role) && !row.parameter.trim()) return "填一个参数代码，例如 OS。";
  if (ALIAS_ROLES.includes(row.role)) {
    const name = row.alias.trim() || row.column;
    if (!ANALYSIS_NAME.test(name)) return "分析表里的列名需要英文字母、数字或下划线，请填写。";
  }
  if (row.identifier && row.role !== "subject_key" && row.role !== "other") return "直接标识不能作为分析数据。";
  return null;
}

/** Whether the map, as the editor holds it, can be sent: a subject key wherever there is anything to derive. */
export function mapProblem(rows: readonly EditorRow[]): string | null {
  const entries = entriesOf(rows);
  if (!entries.length) return "至少标出受试者编号那一列。";
  const tables = [...new Set(entries.filter((entry) => entry.role !== "other" && entry.role !== "subject_key").map((entry) => entry.table))];
  for (const table of tables) {
    if (!entries.some((entry) => entry.table === table && entry.role === "subject_key")) return `“${table}”需要标出受试者编号那一列。`;
  }
  const first = rows.map((row) => ({ row, problem: rowProblem(row) })).find((item) => item.problem && !isDefault(item.row));
  return first ? `“${first.row.column}”：${first.problem}` : null;
}

/** The plane's own extension list for a role, mirrored so an upload is not sent to be refused. */
const EXTENSIONS: Record<"data" | "dictionary" | "document", readonly string[]> = {
  data: ["csv", "tsv", "json", "xlsx"], dictionary: ["csv", "tsv", "json", "xlsx"], document: ["txt", "md"],
};
/** The ceiling a dictionary or a document has beside the deployment's own. */
const ROLE_CAPS: Record<"dictionary" | "document", number> = { dictionary: 2 * 1024 * 1024, document: 1024 * 1024 };

/** A sentence when a file would be refused, `null` when it would not. */
export function uploadProblem(file: { name: string; size: number }, role: "data" | "dictionary" | "document", maxBytes: number | null): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!extension) return "文件名需要带扩展名，例如 cohort.csv。";
  if (extension === "parquet") return "Parquet 文件暂时不能接入：请在导出时改为 CSV 后上传。";
  if (extension === "xls") return "旧版 .xls 不能接入：请另存为 .xlsx 或 CSV 后上传。";
  if (!EXTENSIONS[role].includes(extension)) return `这一类文件支持：${EXTENSIONS[role].join("、")}。`;
  if (file.size === 0) return "文件是空的。";
  const cap = role === "data" ? maxBytes : Math.min(maxBytes ?? Number.POSITIVE_INFINITY, ROLE_CAPS[role]);
  if (cap !== null && Number.isFinite(cap) && file.size > cap) return `文件超过 ${Math.round(cap / 1024 / 1024)} MB 的上限。`;
  return null;
}

/** The plane's refusals, in words a data manager can act on. */
const INTAKE_CODES: Record<string, string> = {
  vcr_data_plane_not_configured: "本部署未接入数据平面，暂不能接入患者级数据。",
  vcr_data_file_too_large: "文件超过了大小上限。",
  vcr_data_format_unsupported: "这种文件格式暂不支持：请用 CSV、TSV、JSON 或 Excel（.xlsx）。",
  vcr_data_file_unreadable: "这个文件读不出来：请确认它是带表头的表格，列名没有重复。",
  vcr_data_file_name_invalid: "文件名需要带扩展名，例如 cohort.csv，最长 200 个字符。",
  vcr_source_file_not_found: "找不到这个文件，它可能已被删除。",
  vcr_source_file_frozen: "已有快照使用了这个文件，不能删除。",
  vcr_source_file_changed: "存储的文件与上传时不一致，请重新上传。",
  vcr_field_map_invalid: "字段映射还有问题，请按提示修改后再确认。",
  vcr_field_map_changed: "字段映射在你查看之后又改过了，请重新查看后再确认。",
  vcr_field_map_unconfirmed: "请先确认字段映射，再冻结快照。",
  vcr_snapshot_no_tables: "这个快照还没有分析表，请先派生。",
  vcr_snapshot_withheld: "这个快照的表因封存或授权范围而没有交给引擎。",
  vcr_snapshot_not_found: "找不到这个数据快照。",
  vcr_source_not_found: "找不到这个数据源。",
  vcr_analysis_table_invalid: "分析表不合格，已列出每一处问题；修改字段映射后再冻结。",
  vcr_grant_invalid: "授权对象需要是本研究的成员，或写成“角色：某角色”“本研究成员”。",
  vcr_grant_owner_only: "只有登记这个数据源的账号可以授权别人读取它。",
  vcr_grant_not_found: "找不到这条授权。",
  vcr_snapshot_profile_timeout: "剖析花的时间太长，已停止。请拆小文件后再试。",
  vcr_snapshot_profile_failed: "数据剖析没有完成，请稍后重试。",
  vcr_snapshot_profile_too_large: "剖析结果太大，请减少列数后再试。",
  vcr_payload_invalid: "填写的内容不符合要求，请检查后再提交。",
  vcr_forbidden: "你在本研究中没有数据接入的权限。",
};

/**
 * The sentence for a refused intake action. The plane's own sentence comes first:
 * the shared dictionary answers an unregistered `vcr_*` code with 「稍后再试」,
 * which is advice that cannot work for a map that is not confirmed or a file that
 * is not a table. Once the registry (`errorCodes.mjs`) carries these codes with
 * these sentences this table is redundant and goes.
 */
export function intakeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof WebApiError && error.code && Object.hasOwn(INTAKE_CODES, error.code)) return INTAKE_CODES[error.code];
  return webErrorMessage(error, { fallback });
}
