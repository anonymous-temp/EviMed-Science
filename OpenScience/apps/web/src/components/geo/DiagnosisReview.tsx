import { geoClaimApplicability, geoClaimAssessmentIdentity, geoClaimForStatement, geoStatementAssessmentIdentity } from "@evimed/domain";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { getGeoDiagnosisReview, getGeoProject, stageGeoPlanContext, submitGeoDiagnosisFeedback, type GeoAnswer, type GeoProject, type GeoStatementFact, type GeoAction, type GeoDiagnosisReview } from "@/lib/geoClient";
import { geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { safeWebHref } from "@/lib/readPages";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { FactList } from "@/components/ui/FactList";
import { Section } from "@/components/ui/Section";
import { Note } from "@/components/ui/Note";
import { useGeoLoad } from "./geoProjectData";
import { useOpenGeoConversation } from "./useOpenGeoConversation";
import { ensureGeoConversationSession } from "./geoConversationSession";
import { ErrorCorrections } from "./spine/ErrorDrawer";
import { claimRows, correctionSentence } from "./spine/errorModel";
import { answerPath } from "./tabs/geoTabText";
import { useGeoPath } from "./useGeoPath";

const verdictWords: Record<string, string> = { wrong: "讲错", correct: "讲对", unverifiable: "尚无法判定" };
const statusWords: Record<string, string> = { queued: "等待复核", running: "正在复核", succeeded: "复核完成", failed: "复核暂未完成" };

/** Full review remains alongside the original answer. Feedback never hides or resolves an error. */
export function DiagnosisReview({ geoId, data, project, actions, onAssessmentChanged }: { geoId: string; data: GeoAnswer; project: GeoProject; actions: readonly GeoAction[]; onAssessmentChanged?: () => void }) {
  const review = useGeoLoad(`judgment-review:${geoId}:${data.snapshot.id}`, () => getGeoDiagnosisReview(geoId, data.snapshot.id));
  const reloadReview = review.reload;
  const open = useOpenGeoConversation();
  const path = useGeoPath();
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [older, setOlder] = useState<{ snapshotId: string; version: string | null; history: GeoDiagnosisReview["history"]; feedback: GeoDiagnosisReview["feedback"]; historyPage?: GeoDiagnosisReview["historyPage"]; feedbackPage?: GeoDiagnosisReview["feedbackPage"]; feedbackCursors?: string[] } | null>(null);
  const [readingOlder, setReadingOlder] = useState(false);
  // A work action being handed to the conversation, and the request key a retry of the same selection keeps.
  const [handing, setHanding] = useState(false);
  const handoffKey = useRef<{ signature: string; key: string } | null>(null);
  const ready = review.state.kind === "ready" ? review.state.data : null;
  const location = useLocation();
  const requestedVersion = new URLSearchParams(location.search).get("assessmentVersion");
  const [focused, setFocused] = useState<{snapshotId:string; version:string; entry:GeoDiagnosisReview["history"][number] | null; state:"loading"|"ready"|"missing"|"error"} | null>(null);
  useEffect(() => {
    if (!ready || !requestedVersion || !/^[a-f0-9]{64}$/.test(requestedVersion)) { setFocused(null); return; }
    let live = true;
    const snapshotId=data.snapshot.id, version=requestedVersion;
    setFocused({snapshotId,version,entry:null,state:"loading"});
    void (async () => {
      let page=ready;
      const seen=new Set<number>();
      while (live) {
        const entry=page.history.find(row=>row.version===version);
        if (entry) {setFocused({snapshotId,version,entry,state:"ready"});return;}
        const cursor=page.historyPage?.nextBefore;
        if (cursor==null || seen.has(cursor)) {setFocused({snapshotId,version,entry:null,state:"missing"});return;}
        seen.add(cursor);
        page=await getGeoDiagnosisReview(geoId,snapshotId,{historyBefore:cursor});
        if (page.assessmentVersion!==ready.assessmentVersion) {if(live)setFocused({snapshotId,version,entry:null,state:"error"});return;}
      }
    })().catch(()=>{if(live)setFocused({snapshotId,version,entry:null,state:"error"});});
    return ()=>{live=false;};
  },[ready,requestedVersion,geoId,data.snapshot.id]);
  const observed = useRef<{ snapshotId: string; version: string | null } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const previous = observed.current;
    observed.current = { snapshotId: data.snapshot.id, version: ready.assessmentVersion };
    if (previous?.snapshotId === data.snapshot.id && previous.version !== ready.assessmentVersion) onAssessmentChanged?.();
  }, [ready, data.snapshot.id, onAssessmentChanged]);
  const pending = ready?.feedback.some(row => row.status === "queued" || row.status === "running") || older?.snapshotId === data.snapshot.id && older.version === ready?.assessmentVersion && older.feedback.some(row => row.status === "queued" || row.status === "running");
  const pollCursor = useRef(0);
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const timer = window.setInterval(() => {
      reloadReview();
      const cursors = older?.snapshotId === data.snapshot.id && older.version === ready?.assessmentVersion
        && older.feedback.some(row => row.status === "queued" || row.status === "running") ? older.feedbackCursors ?? [] : [];
      const batch = Array.from({ length: Math.min(3, cursors.length) }, (_, index) => cursors[(pollCursor.current + index) % cursors.length]);
      pollCursor.current += batch.length;
      void Promise.allSettled(batch.map(feedbackBefore => getGeoDiagnosisReview(geoId, data.snapshot.id, { feedbackBefore }))).then(results => {
        if (!live) return;
        for (const result of results) {
          if (result.status === "rejected") { setError("较早反馈的处理状态暂时无法更新，请稍后重试。"); continue; }
          const page = result.value;
          if (page.assessmentVersion !== ready?.assessmentVersion) { reloadReview(); continue; }
          setOlder(previous => previous?.snapshotId === data.snapshot.id && previous.version === page.assessmentVersion
            ? { ...previous, feedback: [...new Map([...previous.feedback, ...page.feedback].map(row => [row.id, row])).values()] } : previous);
        }
      });
    }, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [pending, reloadReview, older, geoId, data.snapshot.id, ready?.assessmentVersion]);
  if (review.state.kind === "error") return <Note action={<Button variant="secondary" size="sm" onClick={reloadReview}>重试</Button>}>无法读取复核记录。</Note>;
  if (!ready) return <Note action={null}>正在读取逐句核查与复核记录。</Note>;
  const canEdit = !project.access?.abilities || project.access.abilities.includes("edit");
  const canRun = !project.access?.abilities || project.access.abilities.includes("run");
  // Opening the conversation and staging its context take both (the module's descriptor asks for run and edit).
  const canConverse = canRun && canEdit;
  const retained = older?.snapshotId === data.snapshot.id && older?.version === ready.assessmentVersion ? older : null;
  const history = [...new Map([...ready.history, ...(retained?.history ?? [])].map(row => [row.version, row])).values()];
  const feedbackRows = [...new Map([...ready.feedback, ...(retained?.feedback ?? [])].map(row => [row.id, row])).values()];
  const historyPage = retained?.historyPage ?? ready.historyPage;
  const feedbackPage = retained?.feedbackPage ?? ready.feedbackPage;
  const earlier = async (kind: "history" | "feedback") => {
    const cursor = kind === "history" ? historyPage?.nextBefore : feedbackPage?.nextBefore;
    if (cursor == null) return;
    setReadingOlder(true); setError(null);
    try {
      const page = await getGeoDiagnosisReview(geoId, data.snapshot.id, kind === "history" ? { historyBefore: Number(cursor) } : { feedbackBefore: String(cursor) });
      if (page.assessmentVersion !== ready.assessmentVersion) { reloadReview(); setError("判定已经更新，请刷新后查看历史记录。"); return; }
      setOlder({ snapshotId: data.snapshot.id, version: ready.assessmentVersion,
        history: kind === "history" ? [...(retained?.history ?? []), ...page.history] : retained?.history ?? [],
        feedback: kind === "feedback" ? [...(retained?.feedback ?? []), ...page.feedback] : retained?.feedback ?? [],
        feedbackCursors: kind === "feedback" ? [...new Set([...(retained?.feedbackCursors ?? []), String(cursor)])] : retained?.feedbackCursors,
        historyPage: kind === "history" ? page.historyPage : retained?.historyPage,
        feedbackPage: kind === "feedback" ? page.feedbackPage : retained?.feedbackPage });
    } catch (cause) { setError(webErrorMessage(cause, { fallback: "无法读取更早记录，请重试。" })); }
    finally { setReadingOlder(false); }
  };
  const original = ready.original?.statements ?? ready.history.at(-1)?.assessment?.statements ?? ready.current?.statements ?? data.facts?.statements ?? [];
  const statements = [...new Map([...original, ...history.flatMap(row => row.assessment?.statements ?? []), ...feedbackRows.map(row => row.original), ...(ready.current?.statements ?? [])].map(row => [geoStatementAssessmentIdentity(row), row])).values()];
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const send = async (statement: GeoStatementFact) => {
    if (!ready.assessmentVersion || !note.trim()) return;
    setBusy(true); setError(null);
    try {
      await submitGeoDiagnosisFeedback(geoId, { snapshotId: data.snapshot.id, statement: statement.text, claimId: statement.claimId, statementIdentity: geoStatementAssessmentIdentity(statement),
        assessmentVersion: ready.assessmentVersion, note, requestKey, selectionRef: project.selection?.reference ?? null });
      setEditing(null); setNote(""); setRequestKey(crypto.randomUUID()); reloadReview();
    } catch (cause) {
      setError(webErrorMessage(cause, { fallback: "无法提交反馈，请刷新判定后重试。" }));
      reloadReview();
    } finally { setBusy(false); }
  };
  /**
   * 「更新项目结论或文章」/「创建出处或问题群处置任务」: the errors this statement is, the actions already correcting them and the
   * analysis range are staged as the conversation's context (`stageGeoPlanContext`, as 方案 does), and the composer holds only the
   * person's sentence — never the records' identities, which the person would otherwise send as their own words. An error outside the
   * staged range is left to the conversation's own reads rather than refusing the hand-off.
   */
  const act = async (statement: GeoStatementFact, action: "conclusion" | "treatment") => {
    if (handing) return;
    const rows = data.errors.filter(row => geoClaimAssessmentIdentity(row) === geoClaimAssessmentIdentity(statement));
    const claim = claimRows(rows)[0] ?? { engines: [data.snapshot.engine], statement: statement.text, evidenceQuote: statement.evidence, rows };
    const linked = actions.filter(item => item.need.errorIds.some(id => rows.some(row => row.id === id)));
    setHanding(true); setError(null);
    try {
      const current = await getGeoProject(geoId);
      const params = new URLSearchParams(location.search);
      const sessionId = await ensureGeoConversationSession(geoId, project.projectId,
        geoSessionIdFromChatPath(location.pathname) || params.get("session") || current.sessionId || project.sessionId);
      const selectionRef = project.selection?.reference ?? null;
      const focus = { sessionId, mode: "strategy" as const, ...(selectionRef ? { selectionRef } : {}),
        ...(linked.length ? { actionKeys: linked.map(item => item.key) } : {}) };
      const stage = async (input: typeof focus & { errorIds?: string[] }) => {
        const signature = JSON.stringify(input);
        const requestKey = handoffKey.current?.signature === signature ? handoffKey.current.key : crypto.randomUUID();
        handoffKey.current = { signature, key: requestKey };
        return stageGeoPlanContext(geoId, { ...input, requestKey });
      };
      const errorIds = rows.map(row => row.id);
      const context = await (errorIds.length ? stage({ ...focus, errorIds }) : stage(focus)).catch((cause: unknown) => {
        if (errorIds.length && cause instanceof WebApiError && cause.code === "geo_plan_focus_invalid") return stage(focus);
        throw cause;
      });
      if (await open({ projectId: project.projectId, geoId, sessionId: context.sessionId, geoPlanContext: { referenceId: context.referenceId } }, correctionSentence(claim, product, action))) handoffKey.current = null;
    } catch (cause) {
      setError(webErrorMessage(cause, { fallback: "对话暂时无法打开，请稍后重试。" }));
    } finally { setHanding(false); }
  };
  return <Section title="逐句诊断与反馈" level="section">
    <div id="geo-judgment-history" className="flex flex-col gap-6">
      {focused?.snapshotId===data.snapshot.id && focused.version===requestedVersion && <section aria-label="所选历史判定" className="flex flex-col gap-2">
        <p className="text-ui">所选历史判定</p>
        {focused.state==="loading" ? <p>正在读取这条表达的判定。</p> : focused.state==="missing" ? <p>未找到这次判定，原始回答仍可查阅。</p> : focused.state==="error" ? <Note action={<Button variant="secondary" size="sm" onClick={reloadReview}>重试读取判定</Button>}>这次判定暂时无法读取。</Note> : <>
          {(focused.entry?.assessment.statements ?? []).map((statement,index)=><p key={index}>{statement.text} · {verdictWords[statement.verdict]}</p>)}
          {((focused.entry?.assessment as {judgeExtract?:{recommendationExpressions?:{items?:Array<{quote:string;conditionQuote?:string|null}>}}})?.judgeExtract?.recommendationExpressions?.items ?? []).map((item,index)=><p key={index}>{item.quote} · 条件：{item.conditionQuote ?? "未陈述"}</p>)}
        </>}
      </section>}
      {statements.map(statement => {
        const prior = original.find(row => geoStatementAssessmentIdentity(row) === geoStatementAssessmentIdentity(statement));
        const current = (ready.current?.statements ?? []).find(row => geoStatementAssessmentIdentity(row) === geoStatementAssessmentIdentity(statement));
        const claimDetail = geoClaimForStatement(ready.claimDetails ?? [], statement) as NonNullable<GeoDiagnosisReview["claimDetails"]>[number] | null;
        const applicable = geoClaimApplicability(statement) ?? (claimDetail ? geoClaimApplicability(claimDetail) : null);
        const feedback = feedbackRows.filter(row => geoStatementAssessmentIdentity(row.original) === geoStatementAssessmentIdentity(statement));
        const statementKey = geoStatementAssessmentIdentity(statement);
        return <section key={statementKey} className="flex flex-col gap-3 border-b border-border pb-4">
          {/* The answer's own words, at the answer's size; then the record of the sentence as the one key / value list (no rule inside
            * the statement's block, whose rule is under it). Loose paragraphs here were six sentences standing alone on the fixture walk. */}
          <p data-prose="" className="text-body text-text">“{statement.text}”</p>
          <FactList ruled={false} rows={[
            { label: "判定", value: `原判定：${prior ? verdictWords[prior.verdict] : "较早判定未载入"} · 当前判定：${current ? verdictWords[current.verdict] : "本次复核未覆盖此句"}` },
            { label: "适用条件", value: applicable ? [applicable.population, ...Object.entries(applicable.elements ?? {}).map(([key, value]) => `${key}：${String(value)}`)].filter(Boolean).join("；") || "尚未记录" : "尚未记录" },
            ...(claimDetail ? [
              { label: "依据", value: safeWebHref(claimDetail.sourceRef) ? <a className="text-link" href={safeWebHref(claimDetail.sourceRef)!} target="_blank" rel="noreferrer">{claimDetail.sourceLabel || "查看引用来源"}</a> : claimDetail.sourceLabel || "原始证据" },
              { label: "正确说法", value: claimDetail.statement },
            ] : []),
            { label: "依据原文", value: <span data-prose="">{current?.evidence ?? prior?.evidence ?? "尚无可核对的引文"}</span> },
          ]} />
          {canEdit && canRun && ready.assessmentVersion && current && <Button variant="secondary" size="sm" onClick={() => { setEditing(statementKey); setNote(""); setRequestKey(crypto.randomUUID()); }}>反馈并复核判定</Button>}
          {editing === statementKey && <div className="flex flex-col gap-2">
            <Textarea label="反馈理由与适用条件" value={note} maxLength={4000} onChange={event => setNote(event.target.value)} />
            <div className="flex gap-2"><Button size="sm" loading={busy} disabled={!note.trim()} onClick={() => void send(statement)}>提交复核</Button><Button variant="text" size="sm" onClick={() => setEditing(null)}>取消</Button></div>
          </div>}
          {canConverse && <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={handing} onClick={() => void act(statement, "conclusion")}>更新项目结论或文章</Button><Button variant="secondary" size="sm" disabled={handing} onClick={() => void act(statement, "treatment")}>创建出处或问题群处置任务</Button></div>}
          <ErrorCorrections inline geoId={geoId} project={project} corrections={actions.filter(action => action.need.errorIds.some(id => data.errors.some(row => row.id === id && geoClaimAssessmentIdentity(row) === geoClaimAssessmentIdentity(statement))))} canRun={canConverse} onAsk={() => void act(statement, "conclusion")} />
          {history.length > 1 && <div className="text-caption text-text-3">{history.slice().reverse().map((entry) => { const item = (entry.assessment?.statements ?? []).find(row => geoStatementAssessmentIdentity(row) === geoStatementAssessmentIdentity(statement)); return <p key={entry.version}>{entry.assessment.judgedAt ? `${new Date(entry.assessment.judgedAt).toLocaleString("zh-CN")} ` : "历史"}判定：{item ? verdictWords[item.verdict] : "未覆盖此句"}</p>; })}</div>}
          {feedback.map(row => <div key={row.id} className="text-ui text-text-2"><p>反馈：{row.note}</p><p>{statusWords[row.status] ?? "复核状态未知"} · 提交时原判定：{verdictWords[row.original.verdict]}</p>{row.result && <p>复核结果：{verdictWords[row.result.statements.find(item => geoStatementAssessmentIdentity(item) === geoStatementAssessmentIdentity(row.original))?.verdict ?? "unverifiable"]}</p>}</div>)}
        </section>;
      })}
      {feedbackPage?.more && <Button variant="secondary" size="sm" loading={readingOlder} onClick={() => void earlier("feedback")}>读取更早反馈（已读取 {feedbackRows.length}/{feedbackPage.total}）</Button>}
      {historyPage?.more && <Button variant="secondary" size="sm" loading={readingOlder} onClick={() => void earlier("history")}>读取更早判定（已读取 {history.length}/{historyPage.total}）</Button>}
      {error && <Note action={<Button variant="secondary" size="sm" onClick={reloadReview}>刷新判定</Button>}>{error}</Note>}
      {data.errors.filter(row => row.firstSnapshotId && row.firstSnapshotId !== data.snapshot.id).map(row => <Link key={row.id} to={path(answerPath(geoId, row.firstSnapshotId!))} className="text-link">相近错误的原始回答：{row.statement}</Link>)}
    </div>
  </Section>;
}
