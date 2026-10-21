import { vcrStudyNameError } from "@/lib/vcrStudyName";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { fetchWebMe, webErrorMessage, WebApiError } from "@/lib/apiClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { createVcrStudy, patchVcrStudy, startVcrStudy, type VcrStartAnswer, type VcrStudy } from "@/lib/vcrClient";
import { clearStudyBrief, emptyStudyBrief, readStudyBrief, STUDY_BRIEF_EXAMPLES, savedStudyBriefKey, studyBriefKey, studyBriefName, studyBriefText, VCR_BRIEF_LIMIT, writeStudyBrief, type StudyBriefDraft, type StudyBriefFields } from "@/lib/vcrStudyBrief";
import { vcrChatPath } from "@/lib/studyLocation";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Note } from "@/components/ui/Note";
import { VcrTabSkeleton } from "./VcrStates";
import { announceVcrStudiesChanged } from "./useVcrProjectIds";

type Remote = NonNullable<StudyBriefDraft["remote"]>;
/** A short brief is edited here; conversation and its composer remain in the native pane after Start. */
export function VcrStudyBrief({ study, onStarted, onDataRequested }: { study?: VcrStudy; onDataRequested?: (remote: Remote, isCurrent: () => boolean) => Promise<boolean | void> | boolean | void; onStarted: (remote: Remote, answer: VcrStartAnswer, isCurrent: () => boolean) => Promise<boolean | void> | boolean | void }) {
  const initial = (): StudyBriefDraft => ({ fields: { ...emptyStudyBrief(), question: study?.question ?? "", name: study?.name === "未命名研究" ? "" : study?.name ?? "" }, ...(study ? { remote: { id: study.id, projectId: study.projectId } } : {}) });
  const [draft, setDraft] = useState<StudyBriefDraft>(initial);
  const [key, setKey] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState("");
  const [identityVersion, setIdentityVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [storageIssue, setStorageIssue] = useState(false);
  const held = useRef(false);
  const scope = useRef({ mounted: false, key: null as string | null, generation: 0 });
  useEffect(() => {
    let live = true;
    const owner = scope.current;
    const generation = ++owner.generation;
    scope.current.mounted = true; scope.current.key = null;
    setKey(null); setIdentityError("");
    void fetchWebMe().then(me => {
      if (!live || !scope.current.mounted || scope.current.generation !== generation) return;
      if (!me?.user?.id) { setIdentityError("请重新确认登录后继续编辑研究。"); return; }
      const scoped = studyBriefKey(me.user.id, me.tenant?.id ?? me.user.tenantId ?? me.user.id, study?.id);
      scope.current.key = scoped;
      setDraft(readStudyBrief(scoped) ?? initial());
      setKey(scoped);
    }).catch(error => { if (live) setIdentityError(webErrorMessage(error, { fallback: "账户暂时无法读取，请重试。" })); });
    return () => { live = false; owner.mounted = false; owner.key = null; owner.generation += 1; held.current = false; };
    // The addressed study and account read define the scope; polling its result must not replace unsent local text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study?.id, identityVersion]);
  const keep = (next: StudyBriefDraft) => {
    if (!key || !scope.current.mounted || scope.current.key !== key) return;
    const saved = writeStudyBrief(key, next);
    const studyKey = next.remote ? savedStudyBriefKey(key, next.remote.id) : key;
    const savedInStudy = studyKey === key || writeStudyBrief(studyKey, next);
    setStorageIssue(!saved || !savedInStudy); setDraft(next);
  };
  const change = (field: keyof StudyBriefFields, value: string) => { keep({ ...draft, fields: { ...draft.fields, [field]: value } }); setMessage(""); };
  const brief = studyBriefText(draft.fields, draft.attachments);
  const action = draft.action ?? (draft.request?.payload.action === "auto" ? "auto" : "definition");
  const canWrite = !study || study.abilities.includes("write");
  const canRun = !study || study.abilities.includes("run");
  const nameError = vcrStudyNameError(draft.fields.name);
  const valid = !nameError && !!draft.fields.question.trim() && brief.length <= VCR_BRIEF_LIMIT;
  const uncertain = draft.request?.state === "confirming";
  const accepted = draft.request?.state === "accepted";
  const blocked = Boolean(draft.recovery);
  const moved = Boolean(study && draft.remote && study.id !== draft.remote.id);
  const disabled = busy || uncertain || accepted || moved || !canWrite;
  const perform = async (kind: "save" | "upload" | "start" | "recover" | "data") => {
    if (!key || scope.current.key !== key || !scope.current.mounted || held.current || moved) return;
    if (kind !== "recover" && (blocked || draft.missingRemote)) return;
    if (!canWrite || (kind === "start" && !canRun)) return;
    // Preserve receipt replay and opening an accepted run; validate only new mutations.
    if (nameError && !(kind === "start" && (uncertain || accepted))) return;
    if (kind !== "upload" && kind !== "recover" && kind !== "data" && !valid && !uncertain && !accepted) return;
    const originKey = key, generation = ++scope.current.generation;
    const isCurrent = () => scope.current.mounted && scope.current.key === originKey && scope.current.generation === generation;
    held.current = true; setBusy(true); setMessage("");
    let current = draft;
    let phase: "picker" | "save" | "create" | "upload" | "start" | "handoff" = "save";
    let awaitingReceipt = false;
    // A late result belongs only to its originating storage record. Preserve newer editable text and never replace another binding.
    const persist = (next: StudyBriefDraft) => {
      current = next;
      const targets = [originKey, ...(next.remote && savedStudyBriefKey(originKey, next.remote.id) !== originKey ? [savedStudyBriefKey(originKey, next.remote.id)] : [])];
      for (const target of targets) {
        let stored = next;
        if (!isCurrent()) {
          const latest = readStudyBrief(target);
          if (latest?.remote && next.remote && latest.remote.id !== next.remote.id) continue;
          if (latest?.request && next.request && latest.request.payload.requestId !== next.request.payload.requestId) continue;
          if (latest) stored = { ...next, fields: latest.fields, action: latest.action ?? next.action,
            attachments: latest.attachments?.map(file => next.attachments?.some(done => done.name === file.name && done.state === "uploaded") ? { ...file, state: "uploaded" as const } : file) ?? next.attachments };
        }
        const saved = writeStudyBrief(target, stored);
        if (isCurrent() && target === originKey) { setDraft(stored); setStorageIssue(!saved); }
      }
    };
    const save = async (): Promise<Remote | null> => {
      if (!isCurrent()) return null;
      const text = studyBriefText(current.fields, current.attachments);
      if (text.length > VCR_BRIEF_LIMIT || (!current.fields.question.trim() && !current.attachments?.length && kind !== "data")) throw new Error("brief_invalid");
      let remote = current.remote;
      phase = remote ? "save" : "create";
      if (!remote) {
        const created = await createVcrStudy({ draft: true, name: studyBriefName(current.fields), question: text });
        remote = { id: created.id, projectId: created.projectId };
        persist({ ...current, remote });
        if (!isCurrent()) return null;
        announceVcrStudiesChanged();
      } else {
        await patchVcrStudy(remote.id, { ...(study?.abilities.includes("manage_study") === false ? {} : { name: studyBriefName(current.fields) }), question: text });
        if (!isCurrent()) return null;
      }
      return remote;
    };
    try {
      if (accepted && current.remote && current.request?.answer && kind === "start") {
        phase = "handoff";
        const landed = await onStarted(current.remote, current.request.answer, isCurrent);
        if (!study && landed !== false && readStudyBrief(originKey)?.request?.payload.requestId === current.request.payload.requestId) clearStudyBrief(originKey);
        return;
      }
      if (kind === "recover") {
        current = { ...current, remote: undefined, request: undefined, recovery: undefined, missingRemote: undefined,
          attachments: current.attachments?.map(file => ({ ...file, state: "selected" })),
          ...(current.request || current.recovery ? { priorSubmission: { studyId: current.remote?.id ?? current.recovery?.studyId, request: current.request, recovery: current.recovery } } : {}) };
        persist(current);
      }
      phase = "picker";
      const files = kind === "upload" ? await pickFiles(".pdf,.docx,.doc,.txt,.md,.html,.epub") : [];
      if (!isCurrent() || (kind === "upload" && !files.length)) return;
      if (kind === "upload" && files.some(file => /\.(csv|tsv|xlsx?|parquet|sav|sas7bdat|rds|dta|jsonl)$/i.test(file.name))) {
        persist({ ...current, dataIntent: true, attachments: [...(current.attachments ?? []), ...files.map(file => ({ name: file.name, state: "selected" as const }))] });
        setMessage("所选研究数据尚未上传。请保存草稿并通过研究数据接入登记数据源后选择文件。"); return;
      }
      if (kind === "upload") current = { ...current, attachments: [...(current.attachments ?? []), ...files.map(file => ({ name: file.name, state: "selected" as const }))] };
      if (studyBriefText(current.fields, current.attachments).length > VCR_BRIEF_LIMIT) { persist(current); setMessage("所选文件名和简述合计超过 2,000 字。请缩短简述或减少本次材料，输入仍已保留。"); return; }
      persist(current);
      const remote = uncertain && current.remote ? current.remote : await save();
      if (!isCurrent() || !remote) return;
      current = { ...current, remote };
      if (kind === "data") {
        persist({ ...current, dataIntent: true });
        if (!isCurrent() || !onDataRequested) return;
        phase = "handoff";
        const landed = await onDataRequested(remote, isCurrent);
        if (landed !== false && savedStudyBriefKey(originKey, remote.id) !== originKey && readStudyBrief(originKey)?.remote?.id === remote.id) clearStudyBrief(originKey);
        return;
      }
      if (kind === "save" || kind === "recover") { setMessage("研究草稿已保存，尚未开始研究。"); return; }
      if (kind === "upload") {
        phase = "upload";
        const offset = (current.attachments ?? []).length - files.length;
        for (let index = 0; index < files.length; index += 1) {
          if (!isCurrent()) return;
          const uploaded = await uploadFilesToWorkspace([files[index]], "knowledge-base", "base", remote.projectId).catch(error => {
            persist({ ...current, attachments: current.attachments?.map((file, position) => position === offset + index ? { ...file, state: "failed" as const } : file) });
            throw error;
          });
          if (!uploaded.length) throw new Error("upload_unavailable");
          persist({ ...current, attachments: current.attachments?.map((file, position) => position === offset + index ? { ...file, state: "uploaded" as const } : file) });
          if (!isCurrent()) return;
        }
        phase = "save";
        await patchVcrStudy(remote.id, { question: studyBriefText(current.fields, current.attachments) });
        if (!isCurrent()) return;
        setMessage(current.fields.question.trim() ? "材料已加入研究，尚未开始。" : "材料已加入草稿。请补充想研究什么，再开始研究。"); return;
      }
      const payload = uncertain && current.request ? current.request.payload : { brief: studyBriefText(current.fields, current.attachments), ...(!study || study.abilities.includes("manage_study") ? { name: studyBriefName(current.fields) } : {}), requestId: crypto.randomUUID(), action };
      persist({ ...current, request: { payload, state: "confirming" } });
      if (!isCurrent()) return;
      phase = "start"; awaitingReceipt = true;
      const answer = await startVcrStudy(remote.id, payload);
      awaitingReceipt = answer.state === "confirming";
      persist({ ...current, request: { payload, state: answer.state === "accepted" || answer.state === "awaiting_input" ? "accepted" : answer.state, ...(answer.state === "accepted" || answer.state === "awaiting_input" ? { answer } : {}) } });
      if (!isCurrent()) return;
      if (answer.state === "confirming") { setMessage("正在核实是否已提交。可再次核实同一请求，避免重复开始。"); return; }
      if (answer.state === "rejected") { setMessage("这次研究未能开始。保留的简述可以修改后重新开始。"); return; }
      announceVcrStudiesChanged(); phase = "handoff";
      const landed = await onStarted(remote, answer, isCurrent);
      if (!study && landed !== false && readStudyBrief(originKey)?.request?.payload.requestId === payload.requestId) clearStudyBrief(originKey);
    } catch (error) {
      const missing = error instanceof WebApiError && error.status === 404 && (phase === "save" || phase === "start") && current.remote;
      if (missing) persist({ ...current, missingRemote: true, ...(current.request ? { recovery: { state: current.request.state === "rejected" ? "unknown" : current.request.state, studyId: current.remote?.id } } : {}) });
      else if (error instanceof WebApiError && error.status >= 400 && error.status < 500 && error.code !== "agent_run_dispatch_conflict" && phase !== "handoff") persist({ ...current, request: undefined });
      if (!isCurrent()) return;
      setMessage(missing ? "原研究已无法读取。简述仍已保留，可明确另存为新草稿；不会重新提交原请求。" : webErrorMessage(error, {
        fallback: awaitingReceipt ? "提交状态尚未确认，可核实同一请求。简述已保留。" : "暂时未能完成操作，简述已保留，请重试。",
        codes: {
          vcr_conversation_busy: "研究对话正在进行中或有内容排队。请等它结束后再开始，简述已保留。",
          vcr_conversation_unavailable: "研究对话暂时无法打开，请稍后重试，简述已保留。",
          vcr_study_paused: "研究已暂停，请先在研究菜单中继续研究。",
          vcr_calculation_research_required: "此处是独立计算，请将参数用于新研究或已有研究后再开始。",
          agent_run_dispatch_conflict: "这次提交记录与简述不一致。请打开研究对话核对已提交内容。",
        },
      }));
    } finally { if (isCurrent()) { held.current = false; setBusy(false); } }
  };
  if (!key) return identityError ? <Note tone="warn" action={<Button variant="secondary" onClick={() => setIdentityVersion(value => value + 1)}>重试</Button>}>{identityError}</Note> : <VcrTabSkeleton rows={2} />;
  return <section aria-label="研究简述" className="mx-auto flex w-full max-w-read flex-col gap-4">
    <Textarea label="研究问题" value={draft.fields.question} disabled={disabled} rows={3} maxLength={VCR_BRIEF_LIMIT} onChange={event => change("question", event.target.value)} placeholder="想研究什么？已有想法或材料都可以先说。" />
    <div className="flex flex-wrap gap-2" aria-label="可编辑研究示例">{STUDY_BRIEF_EXAMPLES.map(example => <Button key={example.label} variant="text" size="sm" disabled={disabled} onClick={() => { keep({ ...draft, fields: { ...example.fields }, dataIntent: example.data === true }); setMessage(""); }}>{example.label}</Button>)}</div>
    <Disclosure summary="补充人群、终点和已有材料（可选）">
      <div className="grid gap-3 md:grid-cols-2">
        {([["population", "目标人群"], ["intervention", "干预与对照"], ["endpoint", "主要终点"], ["materials", "已有材料"], ["output", "希望得到"]] as const).map(([field, label]) => <Input key={field} label={label} value={draft.fields[field]} disabled={disabled} onChange={event => change(field, event.target.value)} />)}
        <Input label="研究名称" value={draft.fields.name} placeholder={studyBriefName(draft.fields)} disabled={disabled} aria-invalid={!!nameError} onChange={event => change("name", event.target.value)} />
      </div>
    </Disclosure>
    {nameError && <p role="alert" className="text-ui text-error">{nameError}</p>}
    <Note action={null}>{action === "auto" ? "开始后先梳理研究定义，再推进所需的七步研究流程；资料不足时会在研究对话里询问。" : "开始后先梳理研究定义，补问缺少的关键信息；后续步骤由你按需要发起。"}</Note>
    <div className="flex flex-wrap items-end gap-2">
      <Select label="本次开始" value={action} disabled={disabled} onChange={event => keep({ ...draft, action: event.target.value === "auto" ? "auto" : "definition" })}><option value="definition">先明确研究定义</option><option value="auto">推进完整研究流程</option></Select>
      <Button variant={draft.dataIntent ? "secondary" : "primary"} disabled={busy || moved || blocked || draft.missingRemote || (!accepted && (!canWrite || !canRun || (!valid && !uncertain)))} loading={busy} onClick={() => { void perform("start"); }}>{accepted ? "打开研究对话" : uncertain ? "核实提交" : "开始研究"}</Button>
      <Button variant="secondary" disabled={!valid || disabled || blocked || draft.missingRemote} onClick={() => { void perform("save"); }}>保存草稿</Button>
      <Button variant="text" disabled={!!nameError || disabled || blocked || draft.missingRemote || draft.dataIntent} onClick={() => { void perform("upload"); }}>添加参考材料</Button>
      {onDataRequested && <Button variant={draft.dataIntent ? "primary" : "secondary"} disabled={!!nameError || busy || moved || !canWrite || blocked || draft.missingRemote || brief.length > VCR_BRIEF_LIMIT} onClick={() => { void perform("data"); }}>保存草稿并接入研究数据</Button>}
      {draft.remote && <Link to={vcrChatPath(draft.remote.id)} className="rounded text-ui text-link hover:underline">打开研究</Link>}
    </div>
    <Note action={null}>参考材料可添加公开文献、方案等文件；患者记录和研究数据请通过研究数据接入添加。</Note>
    {moved && draft.remote && <Note action={<Link to={vcrChatPath(draft.remote.id)} className="rounded text-ui text-link hover:underline">打开新草稿</Link>}>简述已另存为新的研究草稿，请打开新草稿继续编辑。</Note>}
    {blocked && <Note tone="warn" action={null}>本地提交记录不完整，尚不能确认是否已开始。简述可继续编辑；请先打开原研究核对，或明确另存新草稿。</Note>}
    {(draft.missingRemote || blocked) && <Button variant="secondary" disabled={!!nameError || busy || !canWrite || brief.length > VCR_BRIEF_LIMIT || (!draft.fields.question.trim() && !draft.attachments?.length)} onClick={() => { void perform("recover"); }}>另存为新草稿</Button>}
    {!draft.remote && draft.recovery?.studyId && <Link to={vcrChatPath(draft.recovery.studyId)} className="rounded text-ui text-link hover:underline">打开原研究</Link>}
    {draft.priorSubmission && <Note action={draft.priorSubmission.studyId ? <Link to={vcrChatPath(draft.priorSubmission.studyId)} className="rounded text-ui text-link hover:underline">核对原研究</Link> : null}>原提交记录已保留；另存草稿不会重发原请求。开始新的研究前请先核对原提交状态。</Note>}
    {!!draft.attachments?.length && <ul aria-label="研究材料" className="text-caption text-text-2">{draft.attachments.map((file, index) => <li key={`${index}:${file.name}`}>{file.name} · {file.state === "uploaded" ? "已上传" : file.state === "failed" ? "上传未完成，请重新添加" : "待上传"}</li>)}</ul>}
    {brief.length > VCR_BRIEF_LIMIT && <Note tone="warn" action={null}>简述合计超过 2,000 字，请缩短部分内容后再保存或开始。当前输入仍为你保留。</Note>}
    {storageIssue && <Note tone="warn" action={null}>浏览器未能保存输入，请先保存研究草稿再离开此页。</Note>}
    {message && <div role="status"><Note tone="warn" action={null}>{message}</Note></div>}
  </section>;
}
