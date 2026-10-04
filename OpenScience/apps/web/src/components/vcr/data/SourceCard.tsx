import { useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import {
  createVcrGrant, freezeVcrSnapshot, importVcrSource, removeVcrFile, revokeVcrGrant, uploadVcrFile,
  type VcrImportFormat, type VcrImportResult, type VcrIntake, type VcrIntakeFile, type VcrIntakeGrant, type VcrIntakeSnapshot, type VcrIntakeSource,
} from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Input, inputClasses } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import { FieldMapEditor } from "./FieldMapEditor";
import { IMPORT_FORMATS, documentAccept, importAccept, importProblem, importSummary, intakeErrorMessage, uploadProblem } from "./intakeState";

/** One step of a source's way from a file to an engine input: a number, a name and what it holds. */
function Step({ number, title, meta, children }: { number: number; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section data-vcr-intake-step={number} className="border-t border-faint pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-ui font-medium text-text">
        <span className="tabular-nums text-text-3">{number}</span>
        {title}
        {meta && <span className="text-caption font-normal text-text-3">{meta}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A file row: what it is, how big, when — and 删除 only while nothing has frozen it. */
function FileRow({ file, frozen, canManage, busy, onRemove }: { file: VcrIntakeFile; frozen: boolean; canManage: boolean; busy: boolean; onRemove: () => void }) {
  const detail = [
    file.roleLabel,
    file.rows != null ? `${file.rows} 行` : null,
    file.columnCount != null && file.role === "data" ? `${file.columnCount} 列` : null,
    file.entries != null ? `${file.entries} 个变量` : null,
    file.size, file.at,
    file.subjectKey ? `受试者 ${file.subjectKey}` : null, file.visibleAt ? `可见于 ${file.visibleAt.slice(0, 10)}` : null,
    file.sheetUsed ? `工作表“${file.sheetUsed}”` : null,
    // A table a FHIR, OMOP or ADaM import produced.
    file.importFormat ? `来自 ${IMPORT_FORMATS.find((entry) => entry.value === file.importFormat)?.label ?? file.importFormat} 导入` : null,
    // A record converted from PDF or Word: what it was, and what part of it had no text to read.
    file.sourceFormat ? `来自 ${file.sourceFormat === "docx" ? "Word" : file.sourceFormat.toUpperCase()}${file.pages ? `，${file.pages} 页` : ""}${file.blankPages ? `，其中 ${file.blankPages} 页没有文字` : ""}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li data-vcr-file={file.id} className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="block truncate text-ui text-text">{file.name}</span>
        <span className="block truncate text-caption text-text-3">{detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {file.latest === false && <Tag title="同名文件有更新的版本，快照取最新的一份">旧版本</Tag>}
        {frozen && <Tag>已入快照</Tag>}
        {canManage && !frozen && <IconButton icon={Trash2} size="sm" label={`删除 ${file.name}`} disabled={busy} onClick={onRemove} />}
      </span>
    </li>
  );
}

/** What an import read, took and left: sentences and counts, never a value of a patient. */
function ImportReport({ result }: { result: VcrImportResult }) {
  const summary = importSummary(result);
  return (
    <div data-vcr-import-report="" className="rounded-card border border-border bg-surface-1 p-3">
      <p className="text-ui font-medium text-text">{`已按 ${IMPORT_FORMATS.find((entry) => entry.value === result.format)?.label ?? result.format} 导入 ${result.tables.filter((table) => table.stored).length} 张表，并提出了字段映射。`}</p>
      <ul className="mt-1 flex flex-col gap-0.5 text-caption text-text-2">{summary.tables.map((line) => <li key={line}>{line}</li>)}</ul>
      {summary.skipped.length > 0 && (
        <>
          <p className="mt-2 text-caption font-medium text-text">没有导入的部分</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-caption text-text-3">{summary.skipped.map((line) => <li key={line}>{line}</li>)}</ul>
        </>
      )}
      {summary.notices.length > 0 && <ul className="mt-2 flex flex-col gap-0.5 text-caption text-text-3">{summary.notices.map((line) => <li key={line}>{line}</li>)}</ul>}
      <p className="mt-2 text-caption text-text-3">
        {result.fieldMap.columnSourcesDeclared
          ? "每一列都标明了值的来源：源系统记录的是“观察”，由导入计算出来的（年龄、随访时间）是“计算”。"
          : "这个数据源整体标为非真实个体数据，各列不单独声明来源。"}
        {result.fieldMap.trimmed > 0 ? ` 映射条目已达上限，${result.fieldMap.trimmed} 个只说明来源的列没有写入。` : ""}
        请在下面的字段映射里核对后确认。
      </p>
    </div>
  );
}

/** The upload control: pick a file, say what it is, send it. Refuses on the page what the plane would refuse. */
function UploadForm({ studyId, source, onChanged }: { studyId: string; source: VcrIntakeSource; onChanged: () => void }) {
  const [role, setRole] = useState<"data" | "dictionary" | "document" | "import">("data");
  const [format, setFormat] = useState<VcrImportFormat>("fhir");
  const [subject, setSubject] = useState("");
  const [visibleAt, setVisibleAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [report, setReport] = useState<VcrImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const holding = useRef(false);
  const imports = source.upload.imports;
  const importable = imports.available ? IMPORT_FORMATS.filter((entry) => imports.formats.some((offered) => offered.value === entry.value)) : [];

  const send = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || holding.current) return;
    if (role === "import") {
      const refusal = importProblem({ name: file.name, size: file.size }, format, imports);
      setProblem(refusal);
      if (refusal) return;
      holding.current = true;
      setBusy(true);
      setReport(null);
      importVcrSource(studyId, source.id, file, { name: file.name, format })
        .then((answer) => { setReport(answer); toast.success("已导入，请核对字段映射。"); onChanged(); })
        .catch((error: unknown) => { const message = intakeErrorMessage(error, "文件暂时无法导入，请稍后重试。"); setProblem(message); toast.error(message); })
        .finally(() => { holding.current = false; setBusy(false); if (input.current) input.current.value = ""; });
      return;
    }
    const kind = role;
    const refusal = uploadProblem({ name: file.name, size: file.size }, kind, source.upload.maxBytes, source.upload.documents)
      ?? (kind === "document" && !subject.trim() ? "患者文档要写明它属于哪位受试者（源数据里的编号）。" : null);
    setProblem(refusal);
    if (refusal) return;
    holding.current = true;
    setBusy(true);
    uploadVcrFile(studyId, source.id, file, {
      name: file.name, role: kind, ...(kind === "document" ? { subject: subject.trim(), ...(visibleAt ? { visibleAt } : {}) } : {}),
    })
      .then((answer) => { toast.success(answer.created ? `已上传 ${file.name}。` : `${file.name} 已在这个数据源里。`); onChanged(); })
      .catch((error: unknown) => { const message = intakeErrorMessage(error, "文件暂时无法上传，请稍后重试。"); setProblem(message); toast.error(message); })
      .finally(() => { holding.current = false; setBusy(false); if (input.current) input.current.value = ""; });
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="文件类型" value={role} onChange={(event) => { setRole(event.target.value as typeof role); setProblem(null); }} className={inputClasses({ size: "sm", className: "w-auto" })}>
          <option value="data">数据文件</option>
          <option value="dictionary">数据字典</option>
          <option value="document">患者文档</option>
          {importable.length > 0 && <option value="import">标准格式导入</option>}
        </select>
        {role === "import" && (
          <select aria-label="标准格式" value={format} onChange={(event) => { setFormat(event.target.value as VcrImportFormat); setProblem(null); }} className={inputClasses({ size: "sm", className: "w-auto" })}>
            {importable.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        )}
        <input
          ref={input} type="file" aria-label="选择要上传的文件" disabled={busy}
          accept={role === "document" ? documentAccept(source.upload.documents)
            : role === "import" ? importAccept(format, imports) || undefined
              : source.upload.formats.map((entry) => `.${entry}`).join(",") || undefined}
          onChange={(event) => send(event.target.files)} className="text-ui text-text-2"
        />
        {busy && <span className="text-caption text-text-3">{role === "import" ? "正在转换" : "正在上传"}</span>}
      </div>
      {role === "document" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="文档所属受试者编号" placeholder="源数据里的受试者编号" value={subject} onChange={(event) => setSubject(event.target.value)} autoComplete="off" />
          <Input aria-label="文档对平台可见的日期" type="date" value={visibleAt} onChange={(event) => setVisibleAt(event.target.value)} />
        </div>
      )}
      <p className="text-caption text-text-3">
        {role === "document"
          ? source.upload.documents.converter
            ? "病历文件（.txt、.md、PDF、.docx）只用于匹配：PDF 和 Word 在平台内转成文字，不会发给外部服务；扫描件和图片没有文字，请提供文字版。平台按研究派生的假名编号存放，模型只在判断入选条件时按份读取。"
            : "病历文本（.txt、.md）只用于匹配：平台按研究派生的假名编号存放，模型只在判断入选条件时按份读取。"
          : role === "import"
            ? `${IMPORT_FORMATS.find((entry) => entry.value === format)?.hint ?? ""}在平台内转成数据表，不会发给外部服务；每张表、每一列的含义和值的来源（观察或计算）会写进字段映射和数据字典，没有导入的部分会一一列出。${imports.maxText ? `单个文件不超过 ${imports.maxText}。` : ""}`
            : `支持 ${(source.upload.formats.length ? source.upload.formats : ["csv", "tsv", "json", "xlsx"]).join("、")}${source.upload.maxText ? `，单个文件不超过 ${source.upload.maxText}` : ""}。Excel 取第一张有数据的工作表；文件按内容存放，不进入对话的工作区。`}
      </p>
      {problem && <p role="alert" className="text-ui text-error">{problem}</p>}
      {report && <ImportReport result={report} />}
    </div>
  );
}

/** 授权: who may read this source's rows, which columns, in which window. Only the source's own account grants. */
function GrantsSection({ studyId, source, options, onChanged }: { studyId: string; source: VcrIntakeSource; options: VcrIntake["options"]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"account" | "role" | "study">("role");
  const [account, setAccount] = useState("");
  const [role, setRole] = useState("data_manager");
  const [fields, setFields] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const holding = useRef(false);

  const run = (label: string, work: () => Promise<unknown>, done: string, failed: string) => {
    if (holding.current) return;
    holding.current = true;
    setBusy(label);
    work()
      .then(() => { toast.success(done); onChanged(); })
      .catch((error: unknown) => toast.error(intakeErrorMessage(error, failed)))
      .finally(() => { holding.current = false; setBusy(null); });
  };

  const grantee = kind === "role" ? `role:${role}` : kind === "study" ? `study:${studyId}` : account.trim();
  const valid = grantee !== "" && (kind !== "account" || account.trim() !== "");
  const windowOf = (grant: VcrIntakeGrant) => grant.window ?? "不限时间";

  return (
    <div className="flex flex-col gap-3">
      {source.grants.length === 0 && <p className="text-ui text-text-3">还没有授权：除了登记它的账号，没有人能读取这个数据源的行。</p>}
      {source.grants.length > 0 && (
        <ul className="divide-y divide-faint">
          {source.grants.map((grant) => (
            <li key={grant.id} data-vcr-grant={grant.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
              <span className="min-w-0">
                <span className="block truncate text-ui text-text">{grant.granteeLabel}</span>
                <span className="block truncate text-caption text-text-3">
                  {[grant.fields.length ? `${grant.fieldMode === "deny" ? "不含" : "仅"} ${grant.fields.join("、")}` : "所有列", windowOf(grant), grant.purposes.join("、")].filter(Boolean).join(" · ")}
                </span>
              </span>
              {grant.revoked
                ? <Tag>{grant.revokedAt ? `已于 ${grant.revokedAt} 撤销` : "已撤销"}</Tag>
                : source.canGrant && <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === `revoke:${grant.id}`}
                  onClick={() => run(`revoke:${grant.id}`, () => revokeVcrGrant(studyId, grant.id), "已撤销授权。", "授权暂时无法撤销，请稍后重试。")}>撤销</Button>}
            </li>
          ))}
        </ul>
      )}
      {source.canGrant ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            run("grant", () => createVcrGrant(studyId, source.id, {
              grantee, ...(kind === "role" ? { role } : {}), ...(fields.trim() ? { fields: fields.split(/[,，、\s]+/).filter(Boolean) } : {}),
              ...(start ? { windowStart: start } : {}), ...(end ? { windowEnd: end } : {}), purposes: source.allowedUses.length ? source.allowedUses : ["vcr"],
            }), "已授权。", "授权暂时无法创建，请稍后重试。");
          }}
        >
          <div>
            <label htmlFor={`${source.id}-grantee-kind`} className="mb-2 block text-ui font-medium text-text">授权给</label>
            <select id={`${source.id}-grantee-kind`} value={kind} onChange={(event) => setKind(event.target.value as "account" | "role" | "study")} className={inputClasses()}>
              <option value="role">某个角色</option>
              <option value="account">某个成员账号</option>
              <option value="study">本研究的全部成员</option>
            </select>
          </div>
          {kind === "role" && (
            <div>
              <label htmlFor={`${source.id}-grantee-role`} className="mb-2 block text-ui font-medium text-text">角色</label>
              <select id={`${source.id}-grantee-role`} value={role} onChange={(event) => setRole(event.target.value)} className={inputClasses()}>
                {options.memberRoles.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          )}
          {kind === "account" && <Input label="成员账号 ID" value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="off" />}
          <Input label="限定的列（留空为所有列）" value={fields} onChange={(event) => setFields(event.target.value)} placeholder="AGE、SEX、ARM" />
          <Input label="可读起始日期" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
          <Input label="可读截止日期" type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
          <div className="flex items-end justify-end sm:col-span-2">
            <Button type="submit" loading={busy === "grant"} disabled={!valid || busy !== null}>授权</Button>
          </div>
        </form>
      ) : (
        <p className="text-caption text-text-3">只有登记这个数据源的账号可以授权别人读取它。</p>
      )}
    </div>
  );
}

/** A snapshot with the tables derived from it, and what is sealed in it. */
function SnapshotRow({ snapshot }: { snapshot: VcrIntakeSnapshot }) {
  return (
    <li data-vcr-snapshot={snapshot.id} className="py-2">
      <p className="flex flex-wrap items-baseline gap-x-2 text-ui text-text">
        <span className="font-medium">{snapshot.label}</span>
        <span className="text-caption tabular-nums text-text-3">{[snapshot.at, snapshot.rows != null ? `${snapshot.rows} 行` : null, snapshot.findings ? `${snapshot.findings} 条质量提示` : null].filter(Boolean).join(" · ")}</span>
        {snapshot.sealedFields.length > 0 && <Tag tone={snapshot.sealed ? "warn" : "neutral"}>{snapshot.sealed ? "结局封存中" : "封存已解除"}</Tag>}
      </p>
      {snapshot.quality.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption">
          {snapshot.quality.map((check) => (
            <li key={check.label} className={check.passed ? "text-text-3" : "text-warn-strong"}>{`${check.label} ${check.value}`}</li>
          ))}
        </ul>
      )}
      {snapshot.sealed && <p className="mt-1 text-caption text-text-3">{`封存的列：${snapshot.sealedFields.join("、")}。分析计划冻结之前，引擎与 AI 都读不到它们。`}</p>}
      {snapshot.tables.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-3">
          {snapshot.tables.map((table) => (
            <li key={table.shape}>{`${table.label} ${table.rows ?? "—"} 行`}{table.outcomeBearing ? " · 含结局" : ""}</li>
          ))}
        </ul>
      ) : <p className="mt-1 text-caption text-text-3">这个快照还没有分析表：字段映射需要标出受试者编号，并至少有一类基线、结局或测量列。</p>}
    </li>
  );
}

/**
 * One data source, from its files to its grants. The steps are the plan's
 * (§8.1): the files and what each is, what the columns mean, the frozen
 * snapshot with its three analysis tables, and who may read the rows. What a
 * viewer without a grant sees is the source's name and state and nothing of its
 * columns.
 */
export function SourceCard({ studyId, source, snapshots, options, canManage, onChanged }: {
  studyId: string;
  source: VcrIntakeSource;
  snapshots: VcrIntakeSnapshot[];
  options: VcrIntake["options"];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const holding = useRef(false);
  const mine = snapshots.filter((snapshot) => snapshot.sourceId === source.id);
  const frozenNames = new Set(mine.flatMap((snapshot) => snapshot.files));
  const dataFiles = source.files.filter((file) => file.role === "data");
  const editable = canManage && source.readable;

  const run = (label: string, work: () => Promise<unknown>, done: string, failed: string) => {
    if (holding.current) return;
    holding.current = true;
    setBusy(label);
    work()
      .then(() => { toast.success(done); onChanged(); })
      .catch((error: unknown) => toast.error(intakeErrorMessage(error, failed)))
      .finally(() => { holding.current = false; setBusy(null); });
  };

  const freeze = () => run("freeze", async () => {
    const answer = await freezeVcrSnapshot(studyId, source.id);
    const refused = answer.tables?.refused ?? [];
    if (refused.length) toast.error(refused.flatMap((table) => table.issues.filter((issue) => issue.blocking).map((issue) => issue.message)).slice(0, 2).join(" ") || "有分析表不合格，已列出问题。");
    return answer;
  }, "已冻结快照，并派生分析表。", "快照暂时无法冻结，请稍后重试。");

  return (
    <Card
      header={(
        <div data-vcr-source={source.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-section font-semibold text-text">{source.name}</h2>
          <Tag>{source.statusLabel}</Tag>
          <Tag title="这个数据源里的值是什么来源：真实观察、文本抽取、计算或插补">{source.valueSourceLabel}</Tag>
          {source.ownerParty && <span className="text-caption text-text-3">{source.ownerParty}</span>}
        </div>
      )}
    >
      <p className="mb-4 text-caption text-text-3">
        {[source.allowedUses.length ? `允许用途：${source.allowedUses.join("、")}` : null, source.window ? `可见时间 ${source.window}` : null, source.retention].filter(Boolean).join(" · ")}
      </p>

      {!source.readable && (
        <p data-vcr-source-hidden="" className="text-ui text-text-3">你还没有读取这个数据源的授权：这里只显示它的名称和状态，不显示列名和取值。需要请联系登记它的账号。</p>
      )}

      {source.readable && (
        <div className="flex flex-col gap-4">
          <Step number={1} title="文件" meta={dataFiles.length ? `${dataFiles.length} 个数据文件` : undefined}>
            {source.files.length === 0 && <p className="text-ui text-text-3">还没有文件。</p>}
            {source.files.length > 0 && (
              <ul className="divide-y divide-faint">
                {source.files.map((file) => (
                  <FileRow
                    key={file.id} file={file} canManage={canManage} busy={busy !== null}
                    frozen={file.role === "data" && file.latest !== false && frozenNames.has(file.name)}
                    onRemove={() => run(`remove:${file.id}`, () => removeVcrFile(studyId, file.id), "已删除。", "文件暂时无法删除，请稍后重试。")}
                  />
                ))}
              </ul>
            )}
            {editable && source.status !== "withdrawn" && <UploadForm studyId={studyId} source={source} onChanged={onChanged} />}
          </Step>

          <Step number={2} title="字段映射" meta={source.fieldMap.stateLabel}>
            <FieldMapEditor studyId={studyId} source={source} options={options} canManage={canManage} onChanged={onChanged} />
          </Step>

          <Step number={3} title="快照与分析表" meta={mine.length ? `${mine.length} 个快照` : undefined}>
            {mine.length > 0 && <ul className="divide-y divide-faint">{mine.map((snapshot) => <SnapshotRow key={snapshot.id} snapshot={snapshot} />)}</ul>}
            {editable && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <p className="text-caption text-text-3">
                  {source.fieldMap.state === "confirmed" ? "冻结后这一版数据不再改动；更正的数据是新的快照。" : "字段映射确认后才能冻结。"}
                </p>
                <Button variant={mine.length ? "secondary" : "primary"} loading={busy === "freeze"} disabled={busy !== null || source.fieldMap.state !== "confirmed"} onClick={freeze}>
                  {mine.length ? "冻结新版本" : "冻结快照"}
                </Button>
              </div>
            )}
          </Step>

          <Step number={4} title="授权" meta={source.grants.filter((grant) => !grant.revoked).length ? `${source.grants.filter((grant) => !grant.revoked).length} 条有效` : undefined}>
            <GrantsSection studyId={studyId} source={source} options={options} onChanged={onChanged} />
          </Step>
        </div>
      )}
    </Card>
  );
}
