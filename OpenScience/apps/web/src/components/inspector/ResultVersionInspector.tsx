import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { inputClasses } from "@/components/ui/Input";
import { Disclosure } from "@/components/ui/Disclosure";
import { ReportReader } from "@/components/report/ReportReader";
import { TablePreview } from "./TablePreview";
import { ResultImpactPanel } from "./ResultImpactPanel";
import { ResultCorrectionPanel } from "./ResultCorrectionPanel";
import { DocumentExportActions } from "@/components/document/DocumentExportActions";
import { ResultLineagePanel } from "./ResultLineagePanel";
import { PublishAsEvidenceCard, isClinicalPackage } from "@/components/frontier/PublishAsEvidenceCard";
import { parseTableFile } from "@/lib/csv";
import { getWebProjectId } from "@/lib/apiClient";
import type { RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { parseFailureMessage } from "@/lib/errorText";
import { assignResultAnchors, cancelResultReplay, directlyRelatedResults, exportResult, getResultReplay, getResultVersion, listRelatedResultVersions, listResultVersions, readResultBytes, replayEnvironmentLabel, replayErrorText, replayNumbersLabel, replayResult, requestResultRevision,
  resultActionFailure, resultEnvironmentDifference, resultTextDifference, resultValueDifference, resultGapLabel, saveResultBlob, selectionResultAnchor, type ResultAnchor, type ResultReplay, type ResultVersion } from "@/lib/resultProvenance";

/** Immutable result selection lives in the existing history pane. */
export function ResultVersionInspector({ path, runId, initialVersionId, onLegacy }: {
  path: string; runId?: string; initialVersionId?: string; onLegacy?: () => void;
}) {
  const [items, setItems] = useState<ResultVersion[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(initialVersionId ?? "");
  const [version, setVersion] = useState<ResultVersion | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [readAttempt, setReadAttempt] = useState(0);
  const [compareAttempt, setCompareAttempt] = useState(0);
  const [reading, setReading] = useState(false);
  const [anchor, setAnchor] = useState<{ versionId: string; digest: string; selection: ResultAnchor } | null>(null);
  const [comparisonId, setComparisonId] = useState("");
  const [comparison, setComparison] = useState<{ prior: ResultVersion; text: string | null } | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [replay, setReplay] = useState<ResultReplay | null>(null);
  const [relatedCursor, setRelatedCursor] = useState<string | null>(null);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [relatedAttempt, setRelatedAttempt] = useState(0);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const viewGeneration = useRef(0);
  useEffect(() => {
    viewGeneration.current += 1;
    setAction(null); setLoadingRelated(false);
    return () => { viewGeneration.current += 1; };
  }, [path, runId, initialVersionId, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setItems(null); setError(null); setVersion(null); setBlob(null); setText(null); setAnchor(null); setComparison(null);
    void listResultVersions(path, runId).then((result) => {
      if (cancelled) return;
      setItems(result.items); setCursor(result.nextCursor);
      setSelectedId(initialVersionId ?? result.items[0]?.versionId ?? "");
    }).catch((caught) => { if (!cancelled) setError(parseFailureMessage(caught, "版本记录")); });
    return () => { cancelled = true; };
  }, [path, runId, initialVersionId, reload]);

  useEffect(() => {
    let cancelled = false;
    setVersion(null); setBlob(null); setText(null); setReadError(null); setAnchor(null);
    setComparison(null); setComparisonId(""); setActionError(null); setReplay(null); setReading(Boolean(selectedId));
    if (selectedId) void getResultVersion(selectedId).then(async (value) => {
      if (cancelled) return;
      if (value.versionId !== selectedId) throw new Error("返回的结果与所选版本不一致，请重试");
      if (value.path !== path || (runId && !initialVersionId && value.producer.runId !== runId)) throw new Error("此版本不属于当前文件");
      setVersion(value);
      const bytes = await readResultBytes(value);
      const contents = isText(value) ? await bytes.text() : null;
      if (!cancelled) { setBlob(bytes); setText(contents); }
    }).catch((caught) => { if (!cancelled) setReadError(parseFailureMessage(caught, "此版本")); })
      .finally(() => { if (!cancelled) setReading(false); });
    return () => { cancelled = true; };
  }, [selectedId, path, runId, initialVersionId, readAttempt]);

  useEffect(() => {
    if (!blob) { setObjectUrl(null); return; }
    const url = URL.createObjectURL(blob); setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  useEffect(() => { if (previewRef.current && !reading) assignResultAnchors(previewRef.current); }, [text, reading, selectedId]);

  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    setLoadingRelated(true); setRelatedError(null); setRelatedCursor(null);
    void listRelatedResultVersions(version.versionId).then(page => {
      if (cancelled) return;
      if (page.items.some(item => item.versionId !== version.versionId && !directlyRelatedResults(version, item))) throw new Error("关联版本关系无法确认，请重试");
      setItems(current => [...new Map([...(current ?? []), ...page.items].map(item => [item.versionId, item])).values()]);
      setRelatedCursor(page.nextCursor);
    }).catch(caught => { if (!cancelled) setRelatedError(parseFailureMessage(caught, "关联版本")); })
      .finally(() => { if (!cancelled) setLoadingRelated(false); });
    return () => { cancelled = true; };
  }, [version, relatedAttempt]);

  useEffect(() => {
    let cancelled = false;
    setComparison(null); setComparisonError(null); setComparing(Boolean(comparisonId && version));
    if (comparisonId && version) void getResultVersion(comparisonId).then(async (prior) => {
      if (prior.versionId !== comparisonId) throw new Error("返回的结果与比较版本不一致，请重试");
      if (prior.projectId !== version.projectId || !canCompareResults(version, prior)) throw new Error("不能比较没有关联的结果");
      const bytes = await readResultBytes(prior);
      const value = isText(prior) ? await bytes.text() : null;
      if (!cancelled) setComparison({ prior, text: value });
    }).catch((caught) => { if (!cancelled) setComparisonError(parseFailureMessage(caught, "比较版本")); })
      .finally(() => { if (!cancelled) setComparing(false); });
    return () => { cancelled = true; };
  }, [comparisonId, version, compareAttempt]);

  useEffect(() => {
    if (!replay || !["queued", "running", "pending"].includes(replay.state)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void getResultReplay(replay.id).then((next) => { if (!cancelled) setReplay(next); })
        .catch((caught) => { if (!cancelled) setActionError(parseFailureMessage(caught, "重算进度")); });
    }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [replay]);

  const choose = (id: string) => {
    const target = items?.find(item => item.versionId === id);
    if (target && target.path !== path) {
      if (!version || !directlyRelatedResults(version, target)) { setActionError("不能打开没有关联的结果"); return; }
      navigate(resultHref(target)); return;
    }
    setSelectedId(id); setAnchor(null);
  };
  const openSuccessor = async (id: string) => {
    const generation = viewGeneration.current;
    setActionError(null);
    try {
      const successor = await getResultVersion(id);
      if (generation !== viewGeneration.current) return;
      if (successor.versionId !== id) throw new Error("返回的结果与新版本不一致，请重试");
      if (successor.path === path) {
        setItems((current) => current?.some((item) => item.versionId === id) ? current : [successor, ...(current ?? [])]);
        choose(id);
      } else navigate(resultHref(successor));
    } catch (caught) { if (generation === viewGeneration.current) setActionError(parseFailureMessage(caught, "新结果")); }
  };
  useEffect(() => {
    const captureSelection = () => {
      if (!version || !previewRef.current || reading) return;
      assignResultAnchors(previewRef.current);
      const selection = selectionResultAnchor(previewRef.current, window.getSelection());
      if (selection) setAnchor({ versionId: version.versionId, digest: version.digest, selection });
    };
    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [version, reading]);
  const continueRevision = async () => {
    const generation = viewGeneration.current;
    if (!version || !anchor || anchor.versionId !== version.versionId || anchor.digest !== version.digest) return;
    const selected = { ...anchor.selection };
    setAction("revision"); setActionError(null);
    try {
      const sessionId = version.producer.sessionId && /^[A-Za-z0-9_-]{1,160}$/.test(version.producer.sessionId)
        ? version.producer.sessionId : crypto.randomUUID();
      const prepared = await requestResultRevision(version, selected, sessionId);
      if (generation !== viewGeneration.current) return;
      const targetSession = prepared.sessionId ?? sessionId;
      const intent: RuntimeUiIntent = {
        kind: version.producer.sessionId ? "open" : "create", projectId: getWebProjectId(), requestId: crypto.randomUUID(),
        sessionId: targetSession, draft: prepared.draft, resultRevision: { referenceId: prepared.referenceId },
      };
      navigate(version.producer.sessionId ? `/app/chat/${targetSession}` : "/app/chat", { state: { runtimeUiIntent: intent } });
    } catch (caught) { if (generation === viewGeneration.current) setActionError(parseFailureMessage(caught, "修改请求")); }
    finally { if (generation === viewGeneration.current) setAction(null); }
  };
  const act = async (name: "export" | "replay") => {
    const generation = viewGeneration.current;
    if (!version) return;
    setAction(name); setActionError(null);
    try {
      if (name === "export") {
        const exported = await exportResult(version);
        if (generation === viewGeneration.current) saveResultBlob(exported, `${path.split("/").pop()}.evimed.zip`);
      } else {
        const result = await replayResult(version);
        if (generation === viewGeneration.current) setReplay(result);
      }
    } catch (caught) { if (generation === viewGeneration.current) setActionError(resultActionFailure(caught, (error) => parseFailureMessage(error, name === "export" ? "导出" : "重算"))); }
    finally { if (generation === viewGeneration.current) setAction(null); }
  };
  const loadMore = async () => {
    const generation = viewGeneration.current;
    if (!cursor) return;
    setAction("more"); setActionError(null);
    try { const next = await listResultVersions(path, runId, cursor); if (generation !== viewGeneration.current) return; setItems((current) => [...(current ?? []), ...next.items]); setCursor(next.nextCursor); }
    catch (caught) { if (generation === viewGeneration.current) setActionError(parseFailureMessage(caught, "版本记录")); }
    finally { if (generation === viewGeneration.current) setAction(null); }
  };
  const loadMoreRelated = async () => {
    const generation = viewGeneration.current;
    if (!version || !relatedCursor) return;
    setLoadingRelated(true); setRelatedError(null);
    try {
      const page = await listRelatedResultVersions(version.versionId, relatedCursor);
      if (generation !== viewGeneration.current) return;
      if (page.items.some(item => item.versionId !== version.versionId && !directlyRelatedResults(version, item))) throw new Error("关联版本关系无法确认，请重试");
      setItems(current => [...new Map([...(current ?? []), ...page.items].map(item => [item.versionId, item])).values()]);
      setRelatedCursor(page.nextCursor);
    } catch (caught) { if (generation === viewGeneration.current) setRelatedError(parseFailureMessage(caught, "关联版本")); }
    finally { if (generation === viewGeneration.current) setLoadingRelated(false); }
  };

  const refreshReplay = async (cancel = false) => {
    if (!replay) return;
    const generation = viewGeneration.current;
    if (cancel) setAction("cancel");
    try {
      const result = await (cancel ? cancelResultReplay(replay.id) : getResultReplay(replay.id));
      if (generation === viewGeneration.current) setReplay(result);
    } catch (caught) {
      if (generation === viewGeneration.current) setActionError(parseFailureMessage(caught, cancel ? "取消重算" : "重算进度"));
    } finally { if (cancel && generation === viewGeneration.current) setAction(null); }
  };

  if (error) return <div role="alert" className="space-y-3 p-4 text-ui text-error"><p>{error}</p><Button variant="secondary" onClick={() => setReload((n) => n + 1)}>重试</Button></div>;
  if (!items) return <Loading text="正在读取版本记录" />;
  if (!items.length && !initialVersionId) return <div className="space-y-3 p-4 text-ui text-muted"><p>暂无保存的结果版本。</p>{onLegacy && <Button variant="text" onClick={onLegacy}>查看旧版记录</Button>}</div>;
  const filename = path.split("/").pop() ?? path;
  return <div className="space-y-4 p-4 text-ui text-text">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1">结果版本<select aria-label="结果版本" className={inputClasses({ className: "mt-2" })} value={selectedId} disabled={action !== null} onChange={(event) => choose(event.target.value)}>
        {initialVersionId && !items.some((item) => item.versionId === initialVersionId) && <option value={initialVersionId}>指定版本</option>}
        {items.filter(item => item.path === path || (version && directlyRelatedResults(version, item))).map((item) => <option key={item.versionId} value={item.versionId}>{item.path !== path ? `${item.supersedesVersionId === version?.versionId ? "后续结果" : "原始结果"} · ${item.path.split("/").pop()} · ` : ""}{new Date(item.capturedAt).toLocaleString("zh-CN")} · {item.digest.slice(0, 8)}</option>)}
      </select></label>
      {cursor && <Button variant="text" loading={action === "more"} onClick={() => void loadMore()}>更多版本</Button>}
      {version && <Button variant="text" loading={loadingRelated} onClick={() => setRelatedAttempt(value => value + 1)}>刷新关联版本</Button>}
      {relatedCursor && <Button variant="text" loading={loadingRelated} onClick={() => void loadMoreRelated()}>更多关联版本</Button>}
    </div>
    {relatedError && <p role="alert" className="text-error">{relatedError}</p>}
    {reading && <Loading text="正在读取所选版本" />}
    {readError && <div role="alert" className="space-y-2 text-error"><p>{readError}</p><Button variant="secondary" onClick={() => setReadAttempt((n) => n + 1)}>重试</Button></div>}
    {version && <>
      <p className="break-all text-caption text-muted">文件摘要：{version.digest}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!blob} onClick={() => blob && saveResultBlob(blob, filename)}>下载此版本</Button>
        <Button variant="secondary" disabled={version.reuseEligibility?.replay.status !== "available" || action !== null} loading={action === "replay"} onClick={() => void act("replay")}>重算此结果</Button>
        <Button variant="secondary" disabled={!version.reuseEligibility || version.reuseEligibility.export.status === "unavailable" || action !== null} loading={action === "export"} onClick={() => void act("export")}>导出研究包</Button>
        {isClinicalPackage(version) && <Button variant="secondary" disabled={action !== null} onClick={() => setPublishing(true)}>发布为证据卡</Button>}
        {version.producer.sessionId && <Button variant="text" onClick={() => navigate(`/app/chat/${version.producer.sessionId}`)}>来源对话</Button>}
      </div>
      {publishing && <PublishAsEvidenceCard version={version} onClose={() => setPublishing(false)} />}
      {(!version.reuseEligibility || version.reuseEligibility.replay.status !== "available") && <p className="text-caption text-muted">暂不能重算：{version.reuseEligibility?.replay.reasons.map(resultGapLabel).join("；") || "缺少可用的计算配方"}</p>}
      {version.reuseEligibility?.export.status !== "available" && <p className="text-caption text-muted">{version.reuseEligibility?.export.reasons.map(resultGapLabel).join("；") || "研究包可用性尚未确认"}</p>}
      {actionError && <p role="alert" className="text-error">{actionError}</p>}
      {replay && <div role="status" className="flex flex-wrap items-center gap-2"><span>{replayLabel(replay.state)}</span>{replay.error && <span className="text-error">{replayErrorText(replay.error)}</span>}{replay.resultVersionId && <Button variant="text" onClick={() => void openSuccessor(replay.resultVersionId!)}>打开新结果</Button>}{["queued", "running", "pending"].includes(replay.state) && <Button variant="text" loading={action === "cancel"} onClick={() => void refreshReplay(true)}>取消重算</Button>}{actionError && <Button variant="text" onClick={() => void refreshReplay()}>刷新进度</Button>}</div>}
      {replay?.comparison && <ReplayOutcome comparison={replay.comparison} />}
      <Disclosure summary="依据与核对意见" defaultOpen>
        {!version.findings.length && <p className="py-2 text-muted">此版本没有可读取的核对意见，尚未核实。</p>}
        <ul className="space-y-3 py-2">{version.findings.map((finding) => <li key={finding.id}><p className={finding.status === "verified" ? "text-verify-ok" : "text-verify-pending"}>{finding.status === "verified" ? "✓ " : "⚠ "}{finding.message}</p>{finding.sourceRefs?.map((source) => <SourceReference key={source.id} source={source} onOpen={(id) => navigate(`/app/runs/${version.producer.runId ?? version.producer.sessionId ?? "result"}/files/${(source.path ?? path).split("/").map(encodeURIComponent).join("/")}?version=${encodeURIComponent(id)}`)} />)}</li>)}</ul>
        {version.inputs.length > 0 && <ul className="space-y-2">{version.inputs.map((source) => <li key={`${source.id}:${source.versionId ?? source.digest}`}><SourceReference source={source} onOpen={(id) => navigate(`/app/runs/${version.producer.runId ?? version.producer.sessionId ?? "result"}/files/${(source.path ?? path).split("/").map(encodeURIComponent).join("/")}?version=${encodeURIComponent(id)}`)} /></li>)}</ul>}
        {version.coverage.gaps.length > 0 && <p className="py-2 text-verify-pending">记录不完整：{version.coverage.gaps.map(resultGapLabel).join("；")}</p>}
        {version.machineValues.length > 0 && <MachineValues version={version} />}
      </Disclosure>
      {text !== null && /\.(md|markdown|txt)$/i.test(version.path) && <DocumentExportActions source={{ versionId: version.versionId }} groupLabel="导出此版本" />}
      <ResultCorrectionPanel key={`correction:${version.versionId}`} versionId={version.versionId} onOpen={(id) => void openSuccessor(id)} />
      <ResultLineagePanel key={version.versionId} version={version} selectedText={anchor && anchor.versionId === version.versionId ? anchor.selection.selectedText : null}
        onOpen={({ versionId, path: target, runId: targetRun }) => navigate(`/app/runs/${encodeURIComponent(targetRun ?? version.producer.runId ?? version.producer.sessionId ?? "result")}/files/${target.split("/").map(encodeURIComponent).join("/")}?version=${encodeURIComponent(versionId)}`)} />
      {items.length > 1 && <label className="block">与历史版本比较<select aria-label="比较版本" value={comparisonId} className={inputClasses({ className: "mt-2" })} onChange={(event) => setComparisonId(event.target.value)}><option value="">选择比较版本</option>{items.filter((item) => item.versionId !== selectedId && canCompareResults(version, item)).map((item) => <option key={item.versionId} value={item.versionId}>{item.path !== path ? `${item.path.split("/").pop()} · ` : ""}{new Date(item.capturedAt).toLocaleString("zh-CN")} · {item.digest.slice(0, 8)}</option>)}</select></label>}
      <ResultImpactPanel key={version.versionId} projectId={version.projectId} versionId={version.versionId} digest={version.digest} />
      {comparing && <Loading text="正在比较版本" />}
      {comparisonError && <div role="alert" className="space-y-2 text-error"><p>{comparisonError}</p><Button variant="secondary" onClick={() => setCompareAttempt((n) => n + 1)}>重试比较</Button></div>}
      {comparison && <ResultComparison current={version} prior={comparison.prior} before={comparison.text} after={text} />}
      {anchor && anchor.versionId === version.versionId && <div className="space-y-2 rounded-card border border-border p-3"><blockquote className="max-h-32 overflow-auto whitespace-pre-wrap">“{anchor.selection.selectedText}”</blockquote><Button variant="secondary" loading={action === "revision"} disabled={action !== null} onClick={() => void continueRevision()}>在对话中修改所选内容</Button></div>}
      {!reading && !readError && blob && <div ref={previewRef}>
        {text !== null ? /\.md$/i.test(path) ? <ReportReader path={path} text={text} layout="pane" immutableVersion={version} /> : /\.(csv|tsv)$/i.test(path) ? <TablePreview table={parseTableFile(filename, text)} /> : <pre className="overflow-auto whitespace-pre-wrap rounded-card bg-surface p-3 text-ui">{text}</pre>
          : version.mimeType.startsWith("image/") && objectUrl ? <div className="space-y-2"><img src={objectUrl} alt={filename} className="max-w-full" /><Button variant="text" onClick={() => setAnchor({ versionId: version.versionId, digest: version.digest, selection: { kind: "figure", elementId: "figure-1", selectedText: filename } })}>选择此图修改</Button></div>
            : version.mimeType === "application/pdf" && objectUrl ? <iframe title="所选版本 PDF" src={objectUrl} className="h-96 w-full" /> : <p className="text-muted">此格式请下载所选版本后查看。</p>}
      </div>}
    </>}
  </div>;
}
/** What a finished recalculation found, with what it ran on: the numbers are never shown as a same-environment reproduction unless the record says so. */
function ReplayOutcome({ comparison }: { comparison: NonNullable<ResultReplay["comparison"]> }) {
  const numbers = replayNumbersLabel(comparison);
  const environment = replayEnvironmentLabel(comparison.environment);
  if (!numbers && !environment) return null;
  return <p role="status" className="text-caption text-muted">{numbers}{numbers && environment ? "；" : ""}{environment && <span className={comparison.environment?.status === "same" ? undefined : "text-verify-pending"}>{environment}</span>}</p>;
}
function Loading({ text }: { text: string }) { return <p role="status" className="flex items-center gap-2 p-3 text-muted"><Loader2 size={16} aria-hidden="true" className="animate-spin" />{text}</p>; }
function isText(version: ResultVersion) { return version.mimeType.startsWith("text/") || /\.(md|txt|json|csv|tsv|py|r|js|mjs)$/i.test(version.path); }
function canCompareResults(left: ResultVersion, right: ResultVersion) { return left.projectId === right.projectId && ((left.path === right.path && left.artifactId === right.artifactId) || directlyRelatedResults(left, right)); }
function resultHref(version: ResultVersion) { return `/app/runs/${encodeURIComponent(version.producer.runId ?? version.producer.sessionId ?? "result")}/files/${version.path.split("/").map(encodeURIComponent).join("/")}?version=${encodeURIComponent(version.versionId)}`; }
function replayLabel(state: string) { return ({ queued: "等待重算", pending: "等待重算", running: "正在重算", completed: "重算完成", succeeded: "重算完成", failed: "重算失败", cancelled: "重算已取消", canceled: "重算已取消", timed_out: "重算超时", ownership_unknown: "重算进程状态尚未确认", cleanup_uncertain: "重算停止状态尚未确认" } as Record<string, string>)[state] ?? "重算状态尚未确认"; }
function SourceReference({ source, onOpen }: { source: ResultVersion["inputs"][number]; onOpen: (id: string) => void }) {
  return <div className="break-all text-caption text-muted">{source.path ?? source.id} · {source.digest ? `摘要 ${source.digest.slice(0, 12)}` : "摘要未记录"} · {["available", "captured"].includes(source.availability) ? "原文可用" : "原文不可用或尚未确认"}{source.versionId && ["available", "captured"].includes(source.availability) && <Button size="sm" variant="text" onClick={() => onOpen(source.versionId!)}>查看原文版本</Button>}</div>;
}
function MachineValues({ version }: { version: ResultVersion }) { return <table className="w-full text-left text-ui"><caption className="py-2 text-left">计算值</caption><thead><tr><th>指标</th><th>数值</th><th>单位</th></tr></thead><tbody>{version.machineValues.map((value, index) => <tr key={value.name ?? value.key ?? index}><td>{value.name ?? value.key ?? "未注明"}</td><td className="font-mono">{JSON.stringify(value.value)}</td><td>{value.unit ?? "未注明"}</td></tr>)}</tbody></table>; }
export function ResultComparison({ current, prior, before, after }: { current: ResultVersion; prior: ResultVersion; before: string | null; after: string | null }) {
  const differences = before !== null && after !== null ? resultTextDifference(before, after) : null;
  const priorValues = new Map(prior.machineValues.map((value, index) => [value.name ?? value.key ?? String(index), value]));
  const currentValues = new Map(current.machineValues.map((value, index) => [value.name ?? value.key ?? String(index), value]));
  const valueKeys = new Set([...priorValues.keys(), ...currentValues.keys()]);
  const sourceChanges = current.inputs.filter((input) => !prior.inputs.some((old) => old.id === input.id && old.digest === input.digest));
  const removedSources = prior.inputs.filter((input) => !current.inputs.some((next) => next.id === input.id && next.digest === input.digest));
  const ranOn = resultEnvironmentDifference(current, prior);
  const environment = replayEnvironmentLabel(ranOn, "所比较的版本");
  return <section aria-label="版本差异" className="space-y-3 rounded-card border border-border p-3"><p>{current.digest === prior.digest ? "文件内容完全一致" : "文件内容有变化"}</p>
    {environment && <p className={ranOn?.status === "differs" ? "text-verify-pending" : "text-muted"}>{environment}</p>}
    {differences === null ? <p className="text-muted">无法比较此格式的文本内容。</p> : differences.length === 0 ? <p>文本一致。</p> : <ol className="max-h-64 overflow-auto font-mono text-caption">{differences.map((line, index) => <li key={index} className={line.kind === "added" ? "text-verify-ok" : "text-verify-pending"}>{line.kind === "added" ? "+" : "−"} {line.line} {line.text}</li>)}</ol>}
    <p>新增或改变来源 {sourceChanges.length}；移除或替换来源 {removedSources.length}</p>
    {[...sourceChanges, ...removedSources].map((input, index) => <p key={index} className="text-caption text-muted">{input.path ?? input.id} · {input.digest ?? "摘要未记录"}</p>)}
    {[...valueKeys].map((key) => { const value = currentValues.get(key); const old = priorValues.get(key); return <p key={key}>{key}：{old ? JSON.stringify(old.value) : "无旧值"} → {value ? JSON.stringify(value.value) : "无新值"} {value?.unit ?? old?.unit ?? ""} · {resultValueDifference(old, value)}</p>; })}
  </section>;
}
