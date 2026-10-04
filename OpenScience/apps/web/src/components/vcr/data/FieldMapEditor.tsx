import { useEffect, useMemo, useRef, useState } from "react";
import { confirmVcrFieldMap, proposeVcrFieldMap, type VcrIntake, type VcrIntakeSource } from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input, inputClasses } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import {
  ALIAS_ROLES, PARAMETER_ROLES, editorRows, entriesOf, intakeErrorMessage, mapProblem, rowProblem, type EditorRow,
} from "./intakeState";

/**
 * 字段映射: what each column of a source's files is for. The run may propose the
 * map (「AI 提议」); a person confirms it — and confirms exactly the version they
 * read, by its hash. Nothing is derived from a map nobody confirmed, and an edit
 * withdraws an earlier confirmation.
 *
 * The editor shows every column of the newest version of each data file, with the
 * role it has been given. A column left as 「其他」 is kept in the snapshot and is
 * never derived. The direct identifiers of a person are marked and never used as
 * data — the platform works on a per-study pseudonym.
 */
export function FieldMapEditor({ studyId, source, options, canManage, onChanged }: {
  studyId: string;
  source: VcrIntakeSource;
  options: VcrIntake["options"];
  canManage: boolean;
  onChanged: () => void;
}) {
  // The rows are rebuilt when the server's map changes (a proposal from the run,
  // or a reload after saving), not on every render: a person's edits are theirs
  // until they save or the map underneath them changes.
  const serverKey = `${source.fieldMap.hash ?? ""}|${source.files.map((file) => file.id).join(",")}`;
  const [rows, setRows] = useState<EditorRow[]>(() => editorRows(source));
  const shown = useRef(serverKey);
  useEffect(() => {
    if (shown.current === serverKey) return;
    shown.current = serverKey;
    setRows(editorRows(source));
  }, [serverKey, source]);
  const [busy, setBusy] = useState<"save" | "confirm" | null>(null);
  const [problems, setProblems] = useState<Array<{ message: string }>>([]);

  const change = (key: string, patch: Partial<EditorRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const blocked = useMemo(() => mapProblem(rows), [rows]);
  const state = source.fieldMap.state;
  const editable = canManage && source.readable;
  const confirmable = editable && state === "proposed" && source.fieldMap.issues.length === 0 && problems.length === 0;

  const save = () => {
    if (busy || blocked) return;
    setBusy("save");
    setProblems([]);
    proposeVcrFieldMap(studyId, source.id, entriesOf(rows))
      .then((answer) => {
        const found = [...answer.entryIssues.map((issue) => ({ message: issue.message })), ...answer.mapIssues.map((issue) => ({ message: issue.message }))];
        setProblems(found);
        if (found.length) toast.error("字段映射还有问题，已在下方列出。");
        else toast.success("字段映射已保存，请核对后确认。");
        onChanged();
      })
      .catch((error: unknown) => toast.error(intakeErrorMessage(error, "字段映射暂时无法保存，请稍后重试。")))
      .finally(() => setBusy(null));
  };

  const confirm = () => {
    if (busy || !source.fieldMap.hash) return;
    setBusy("confirm");
    confirmVcrFieldMap(studyId, source.id, source.fieldMap.hash)
      .then(() => { toast.success("字段映射已确认。"); onChanged(); })
      .catch((error: unknown) => toast.error(intakeErrorMessage(error, "字段映射暂时无法确认，请稍后重试。")))
      .finally(() => setBusy(null));
  };

  if (!rows.length) {
    return <p className="text-ui text-text-3">先上传数据文件，再在这里说明每一列是什么。</p>;
  }

  return (
    <div data-vcr-fieldmap={source.id} className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2 text-caption text-text-3">
        <Tag tone={state === "confirmed" ? "accent" : "neutral"}>{source.fieldMap.stateLabel || "尚未提出"}</Tag>
        {source.fieldMap.by && <span>{source.fieldMap.by}</span>}
        {state === "confirmed" && source.fieldMap.confirmedAt && <span>{`${source.fieldMap.confirmedByName ?? ""} 于 ${source.fieldMap.confirmedAt} 确认`.trim()}</span>}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-ui">
          <thead>
            <tr className="border-b border-border text-caption text-text-3">
              <th scope="col" className="py-2 pr-3 font-normal">列</th>
              <th scope="col" className="py-2 pr-3 font-normal">作用</th>
              <th scope="col" className="py-2 pr-3 font-normal">参数 / 分析表列名</th>
              <th scope="col" className="py-2 pr-3 font-normal">单位</th>
              <th scope="col" className="py-2 font-normal">更多</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-faint">
            {rows.map((row) => {
              const problem = rowProblem(row);
              const needsParameter = PARAMETER_ROLES.includes(row.role);
              const needsAlias = ALIAS_ROLES.includes(row.role);
              return (
                <tr key={row.key} data-vcr-fieldmap-row={row.column} className="align-top">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="text-text">{row.column}</span>
                    {source.files.filter((file) => file.role === "data" && file.latest !== false).length > 1 && <span className="block text-caption text-text-3">{row.table}</span>}
                    {row.identifying && <Tag tone="warn" className="mt-1">疑似标识</Tag>}
                  </th>
                  <td className="py-2 pr-3">
                    <select
                      aria-label={`${row.column} 的作用`}
                      value={row.role}
                      disabled={!editable}
                      onChange={(event) => change(row.key, { role: event.target.value as EditorRow["role"] })}
                      className={inputClasses({ size: "sm" })}
                    >
                      {options.roles.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    {needsParameter && (
                      <Input
                        aria-label={`${row.column} 的参数代码`} placeholder="参数代码，如 OS" value={row.parameter} disabled={!editable}
                        aria-invalid={problem !== null && !row.parameter.trim() ? true : undefined}
                        onChange={(event) => change(row.key, { parameter: event.target.value })}
                      />
                    )}
                    {needsAlias && (
                      <Input
                        aria-label={`${row.column} 在分析表里的列名`} placeholder={row.column} value={row.alias} disabled={!editable}
                        aria-invalid={problem !== null && !/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(row.alias.trim() || row.column) ? true : undefined}
                        onChange={(event) => change(row.key, { alias: event.target.value })}
                      />
                    )}
                    {/* Beside the field, not through its `error` slot: a field whose wrapper appears and vanishes is remounted, and takes the cursor with it. */}
                    {editable && problem && <p className="mt-1 text-caption text-text-3">{problem}</p>}
                    {row.role === "arm" && (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Input aria-label={`${row.column} 中的试验组取值`} placeholder="试验组取值，如 TRT" value={row.treated} disabled={!editable}
                          onChange={(event) => change(row.key, { treated: event.target.value })} />
                        <Input aria-label={`${row.column} 中的对照组取值`} placeholder="对照组取值，如 CTL" value={row.control} disabled={!editable}
                          onChange={(event) => change(row.key, { control: event.target.value })} />
                      </div>
                    )}
                    {row.role === "outcome_event" && (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <Input aria-label={`${row.column} 中表示发生事件的取值`} placeholder="事件取值，默认 1" value={row.event} disabled={!editable}
                          onChange={(event) => change(row.key, { event: event.target.value })} />
                        <Input aria-label={`${row.column} 中表示删失的取值`} placeholder="删失取值，默认 0" value={row.censored} disabled={!editable}
                          onChange={(event) => change(row.key, { censored: event.target.value })} />
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Input aria-label={`${row.column} 的单位`} value={row.unit} disabled={!editable} onChange={(event) => change(row.key, { unit: event.target.value })} />
                  </td>
                  <td className="py-2">
                    <Disclosure summary="时间与缺失" summaryClassName="text-caption">
                      <div className="flex min-w-40 flex-col gap-2">
                        <select
                          aria-label={`${row.column} 的时间种类`} value={row.timeKind} disabled={!editable}
                          onChange={(event) => change(row.key, { timeKind: event.target.value })} className={inputClasses({ size: "sm" })}
                        >
                          <option value="">不是日期</option>
                          {options.timeKinds.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        <select
                          aria-label={`${row.column} 空白的含义`} value={row.missingReason} disabled={!editable}
                          onChange={(event) => change(row.key, { missingReason: event.target.value })} className={inputClasses({ size: "sm" })}
                        >
                          <option value="">空白含义未说明</option>
                          {options.missingReasons.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        {(row.role === "covariate" || row.role === "measurement") && (
                          <label className="flex items-center gap-2 text-caption text-text-2">
                            <input type="checkbox" checked={row.outcome} disabled={!editable} onChange={(event) => change(row.key, { outcome: event.target.checked })} />
                            这一列本身就是结局（封存到分析计划冻结）
                          </label>
                        )}
                        <label className="flex items-center gap-2 text-caption text-text-2">
                          <input
                            type="checkbox" checked={row.identifier} disabled={!editable || row.role === "subject_key"}
                            onChange={(event) => change(row.key, { identifier: event.target.checked })}
                          />
                          直接标识（不进入分析）
                        </label>
                      </div>
                    </Disclosure>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(source.fieldMap.issues.length > 0 || problems.length > 0) && (
        <ul data-vcr-fieldmap-issues="" className="flex flex-col gap-1 text-ui text-error">
          {[...problems, ...source.fieldMap.issues].map((issue, index) => <li key={`${index}:${issue.message}`}>{issue.message}</li>)}
        </ul>
      )}
      {editable && blocked && <p className={cn("text-caption", "text-text-3")}>{blocked}</p>}

      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" loading={busy === "save"} disabled={busy !== null || blocked !== null} onClick={save}>保存并检查</Button>
          <Button loading={busy === "confirm"} disabled={busy !== null || !confirmable} onClick={confirm}>
            {state === "confirmed" ? "已确认" : "确认字段映射"}
          </Button>
        </div>
      )}
    </div>
  );
}
