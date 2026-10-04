import { knownErrorCodeMessage } from "@evimed/domain";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import type { VcrFieldMapEntry, VcrFieldRole, VcrImportFormat, VcrImportResult, VcrIntakeSource } from "@/lib/vcrClient";

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
const SHOWN_KEYS = ["table", "column", "role", "parameter", "alias", "unit", "timeKind", "missingReason", "identifier", "outcome", "codes", "valueSource"] as const;

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
  /** Where the column's values come from (observed, extracted, calculated, imputed); empty is the file's own source. */
  valueSource: string;
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
      const { role, parameter, alias, unit, timeKind, missingReason, identifier, outcome, codes, valueSource } = entry ?? ({} as VcrFieldMapEntry);
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
        valueSource: valueSource ?? "",
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
  return row.role === "other" && !row.identifier && !row.unit && !row.timeKind && !row.missingReason && !row.valueSource && Object.keys(row.extra).length === 0;
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
    if (row.valueSource) entry.valueSource = row.valueSource as VcrFieldMapEntry["valueSource"];
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
const EXTENSIONS: Record<"data" | "dictionary", readonly string[]> = {
  data: ["csv", "tsv", "json", "xlsx"], dictionary: ["csv", "tsv", "json", "xlsx"],
};
/** A patient record is text anywhere, and PDF or Word where the deployment converts them to text itself. */
const DOCUMENT_TEXT_EXTENSIONS: readonly string[] = ["txt", "md"];
const DOCUMENT_CONVERTED_EXTENSIONS: readonly string[] = ["pdf", "docx"];
/** A picture of a record has no text to read: refused for that, never sent. */
const PICTURE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "heic", "heif"];
/** The ceiling a dictionary or a document's text has beside the deployment's own. */
const ROLE_CAPS: Record<"dictionary" | "document", number> = { dictionary: 2 * 1024 * 1024, document: 1024 * 1024 };

/** What a source's file chooser accepts for a patient record: what this deployment would take. */
export function documentAccept(documents: VcrIntakeSource["upload"]["documents"] | null): string {
  return [...DOCUMENT_TEXT_EXTENSIONS, ...(documents?.converter ? DOCUMENT_CONVERTED_EXTENSIONS : [])].map((extension) => `.${extension}`).join(",");
}

/** A sentence when a file would be refused, `null` when it would not. */
export function uploadProblem(
  file: { name: string; size: number }, role: "data" | "dictionary" | "document", maxBytes: number | null,
  documents: VcrIntakeSource["upload"]["documents"] | null = null,
): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!extension) return "文件名需要带扩展名，例如 cohort.csv。";
  if (role === "document" && PICTURE_EXTENSIONS.includes(extension)) {
    // The server's own sentence for the same refusal, so the page and the plane never say two things.
    return knownErrorCodeMessage("vcr_document_needs_text");
  }
  // The plane's own sentences for what it refuses by name (`VCR_UNSUPPORTED_FORMAT_HINTS`), word for word: a test holds them equal.
  if (extension === "parquet") return "Parquet 文件目前不能直接接入：请在导出时改为 CSV，或用 Excel、Python 转成 CSV 后上传。";
  if (extension === "xls") return "旧版 .xls 不能接入：请另存为 .xlsx 或 CSV 后上传。";
  if (extension === "zip") return "请先解压，再逐个上传数据文件。";
  if (role === "document" && extension === "doc") return "旧版 .doc 不能直接转换：请另存为 .docx、可复制文字的 PDF 或 .txt 后上传。";
  if (role === "document") {
    const converted = DOCUMENT_CONVERTED_EXTENSIONS.includes(extension);
    const allowed = [...DOCUMENT_TEXT_EXTENSIONS, ...(documents?.converter ? DOCUMENT_CONVERTED_EXTENSIONS : [])];
    if (!allowed.includes(extension)) {
      return converted ? "本部署暂不转换 PDF 和 Word，请先另存为 .txt 后上传。" : `这一类文件支持：${allowed.join("、")}。`;
    }
    if (file.size === 0) return "文件是空的。";
    const cap = Math.min(maxBytes ?? Number.POSITIVE_INFINITY, converted ? documents?.maxBytes ?? Number.POSITIVE_INFINITY : ROLE_CAPS.document);
    if (Number.isFinite(cap) && file.size > cap) return `文件超过 ${Math.round(cap / 1024 / 1024)} MB 的上限。`;
    return null;
  }
  if (!EXTENSIONS[role].includes(extension)) return `这一类文件支持：${EXTENSIONS[role].join("、")}。`;
  if (file.size === 0) return "文件是空的。";
  const cap = role === "data" ? maxBytes : Math.min(maxBytes ?? Number.POSITIVE_INFINITY, ROLE_CAPS[role]);
  if (cap !== null && Number.isFinite(cap) && file.size > cap) return `文件超过 ${Math.round(cap / 1024 / 1024)} MB 的上限。`;
  return null;
}

/** The standards a source may be imported from, with what each is uploaded as. The server lists which of them this deployment converts. */
export const IMPORT_FORMATS: ReadonlyArray<{ value: VcrImportFormat; label: string; hint: string }> = [
  { value: "fhir", label: "FHIR", hint: "FHIR R4 的 NDJSON 批量导出、Bundle（JSON），或把它们打成 .zip。" },
  { value: "omop", label: "OMOP CDM", hint: "OMOP CDM 5.3 / 5.4 的 CSV 表，打包成一个 .zip。" },
  { value: "adam", label: "CDISC ADaM", hint: "ADSL、ADTTE、ADAE 的 SAS 传输文件（.xpt，V5），可单个上传，也可打成 .zip。" },
];

/** What a source's file chooser accepts for an import of this standard: what the deployment says it is uploaded as. */
export function importAccept(format: VcrImportFormat, imports: VcrIntakeSource["upload"]["imports"] | null): string {
  return (imports?.formats.find((entry) => entry.value === format)?.extensions ?? []).map((extension) => `.${extension}`).join(",");
}

/** A sentence when an import file would be refused, `null` when it would not. */
export function importProblem(
  file: { name: string; size: number }, format: VcrImportFormat, imports: VcrIntakeSource["upload"]["imports"] | null,
): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!extension) return "文件名需要带扩展名，例如 export.zip。";
  const allowed = imports?.formats.find((entry) => entry.value === format)?.extensions ?? [];
  if (!allowed.includes(extension)) return `这一种格式支持：${allowed.join("、") || "（本部署暂未开通）"}。`;
  if (file.size === 0) return "文件是空的。";
  if (imports?.maxBytes != null && file.size > imports.maxBytes) return `文件超过 ${Math.round(imports.maxBytes / 1024 / 1024)} MB 的上限。`;
  return null;
}

/** The converter's closed words for what it skipped, in the reader's language; a word it does not know is shown as it is. */
const IMPORT_REASONS: Record<string, string> = {
  unsupported_resource_type: "本版本不读这类资源",
  not_fhir_resources: "没有一行是 FHIR 资源",
  not_a_fhir_file: "不是 FHIR 文件",
  not_json: "不是 JSON",
  bundle_too_large: "Bundle 太大，请改用 NDJSON",
  all_rows_skipped: "没有一行能导入",
  no_patient_reference: "没有指向患者的引用",
  no_id: "没有编号",
  duplicate_patient_id: "患者编号重复",
  medication_not_coded: "药物没有编码（按引用或其他形式给出）",
  too_many_rows: "行数超过上限",
  table_too_large: "超过文件大小上限",
  too_many_columns: "列数超过上限",
  not_kept: "没有保存",
  unsupported_table: "本版本不读这张表",
  empty_table: "表里没有数据",
  text_encoding: "不是 UTF-8 文本",
  not_an_omop_table: "不是 OMOP CDM 的表",
  missing_person_id: "没有受试者编号",
  duplicate_person_id: "受试者编号重复",
  duplicate_death_row: "同一个人有多条死亡记录",
  death_date_unreadable: "死亡日期读不出来",
  unsupported_dataset: "本版本只读 ADSL、ADTTE、ADAE",
  not_an_xpt_file: "不是 SAS 传输文件（.xpt）",
  not_xpt: "不是 SAS 传输文件",
  xpt_version_unsupported: "不是 V5 版的 SAS 传输文件",
  corrupt: "文件已损坏",
  rows_not_placed: "没有放进任何参数表",
  paramcd_not_usable: "参数代码不合规范",
  paramcd_case_collision: "参数代码只差大小写",
  duplicate_table: "同名的表已经生成过",
  no_usable_parameter: "没有可用的参数代码",
};
/** The converter's notices: a count of something worth knowing about the data, never a value of a patient. */
const IMPORT_NOTICES: Record<string, string> = {
  lines_not_resources: "行不是 FHIR 资源，已略过",
  mixed_units: "个检查项目在不同行里用了不同单位（数值未做换算，请按单位列区分）",
  records_after_death: "位患者在死亡日期之后仍有记录",
  death_before_first_record: "位患者的死亡日期早于第一条记录，随访时间留空",
  death_date_unknown: "位患者标为已故但没有死亡日期，随访时间留空",
  zero_follow_up: "位患者的随访时间为 0 天",
  no_dated_record: "位患者没有带日期的记录，年龄与随访时间留空",
  age_by_year_difference: "位患者的出生日期不完整，年龄按出生年份相减",
  patient_not_in_file: "位患者出现在记录里，但文件中没有他们的患者信息",
  partial_date: "个日期只有年或年月，按原样保留",
  date_unreadable: "个日期读不出来，已留空",
  observation_without_value: "条观察没有取值，只保留了项目和日期",
  archive_metadata_ignored: "个压缩包附带的系统文件，已忽略",
  death_table_empty: "张死亡表是空的：没有记录不等于都还活着，随访按观察期结束截尾",
  death_table_absent: "份导出里没有死亡表：随访按观察期结束截尾",
  person_table_absent: "份导出里没有人员表：只导入了按受试者编号关联的记录",
  person_not_in_person_table: "个受试者编号出现在记录里，但人员表里没有",
  follow_up_from_records: "位受试者没有观察期，起点和终点取自他们第一条和最后一条有日期的记录",
  concept_table_absent: "份导出里没有词表（CONCEPT）：概念编号没有名称可查",
  concept_ids_not_in_vocabulary: "个概念编号不在这份导出的词表里",
  concept_table_unreadable: "张词表读不出来，概念编号没有名称可查",
  cdm_source_unreadable: "张 CDM 版本表读不出来",
  cdm_version_undeclared: "份导出没有声明 CDM 版本",
  cdm_version_not_tested: "份导出的 CDM 版本不是 5.3 或 5.4，按 5.3 / 5.4 的列读取",
  death_before_index: "位受试者的死亡日期早于起点，随访时间留空",
  follow_up_before_index: "位受试者的观察期终点早于起点，随访时间留空",
  number_unreadable: "个数值读不出来，已留空",
  special_missing_values: "个取值是 SAS 的特殊缺失（.A 到 .Z），按空白处理",
  dtype_populated: "份数据集带有 DTYPE：其中有申办方推导或插补出的记录，取值列的来源标为“插补”",
  duplicate_subject_rows: "位受试者在 ADSL 里出现了不止一行",
  duplicate_subject_parameter_rows: "位受试者在同一个参数里不止一行",
  cnsr_not_binary: "行的删失标志不是 0 或 1",
};

/** The word for a skipped reason or a notice code. */
function importWord(table: Record<string, string>, code: string): string {
  if (code.startsWith("missing_required_column:")) return `缺少必需的列 ${code.slice("missing_required_column:".length)}`;
  return table[code] ?? (code.startsWith("value_not_carried:") ? `类型为 ${code.slice("value_not_carried:".length)} 的取值本版本不读，已留空` : code);
}

/** What an import read, took and left, as sentences a data manager can read: no patient value is in them. */
export function importSummary(result: VcrImportResult): { tables: string[]; skipped: string[]; notices: string[] } {
  const tables = result.tables.map((table) => (table.stored
    ? `${table.name}：${table.rows} 行，${table.columns} 列`
    : `${table.name}：没有保存（${importWord(IMPORT_REASONS, table.reason ?? "not_kept")}）`));
  const skipped = [
    ...result.coverage.inputs.filter((input) => input.status === "skipped" || Object.keys(input.skipped).length > 0).map((input) => {
      const detail = Object.entries(input.skipped).map(([reason, n]) => `${importWord(IMPORT_REASONS, reason)} ${n}`).join("；");
      return `${input.kind}：读到 ${input.records ?? "—"} 条，导入 ${input.imported} 条${input.reason ? `（${importWord(IMPORT_REASONS, input.reason)}）` : ""}${detail ? `；${detail}` : ""}`;
    }),
    ...result.coverage.skippedTables.map((entry) => `${entry.table}：没有生成（${importWord(IMPORT_REASONS, entry.reason)}）`),
  ];
  const notices = result.coverage.notices.map((notice) => `${notice.count} ${importWord(IMPORT_NOTICES, notice.code)}`);
  return { tables, skipped, notices };
}

/** The plane's refusals, in words a data manager can act on. */
const INTAKE_CODES: Record<string, string> = {
  vcr_data_plane_not_configured: "本部署未接入数据平面，暂不能接入患者级数据。",
  vcr_data_file_too_large: "文件超过了大小上限。",
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
