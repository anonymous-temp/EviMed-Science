import { useId, useState } from "react";
import { Library } from "lucide-react";
import { applyVcrReferenceTrial, getVcrHome, readVcrReferenceTrial, searchVcrReferenceTrials, type VcrReferenceCandidate } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Input, inputClasses } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Drawer";
import { DataTable } from "@/components/ui/DataTable";
import { Section } from "@/components/ui/Section";
import { Note } from "@/components/ui/Note";
import { EmptyState } from "@/components/cards/EmptyState";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";

function registryFailure(reason: string | null | undefined): string {
  if (/timeout/i.test(reason ?? "")) return "查询超时，可重试";
  if (/rate.?limit|quota/i.test(reason ?? "")) return "请求较多，请稍后重试";
  if (/not.?configured|unavailable|unsupported/i.test(reason ?? "")) return "来源暂未接入";
  return "暂时未能查询，可重试";
}

/** Uses the same registry reads and evidence preservation as a research run. */
export function VcrReferenceSearch({ query, onApplied, studyId }: { query: string; onApplied: () => void; studyId?: string }) {
  const { state, reload } = useVcrLoad(`vcr:reference-search:${query}`, () => searchVcrReferenceTrials(query));
  const [opened, setOpened] = useState<VcrReferenceCandidate | null>(null);
  const resultsId = useId();
  return <Section title="检索登记试验">
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <>
      <div role="status"><Note result={["本次显示 ", { n: state.data.candidates.length, onOpen: () => document.getElementById(resultsId)?.scrollIntoView({ block: "nearest" }), label: "查看本次检索结果" }, " 项；各来源检索命中数见下方。"]} /></div>
      <div id={resultsId}>
      <DataTable label="登记试验检索结果" columns={[
        { key: "registryId", header: "登记号", cell: row => row.registryId },
        { key: "title", header: "试验", cell: row => row.title },
        { key: "registry", header: "来源", cell: row => row.registry },
      ]} rows={state.data.candidates} rowKey={row => `${row.registry}:${row.registryId}`} onRowOpen={setOpened} />
      </div>
      {state.data.candidates.length === 0 && <EmptyState icon={Library} title={state.data.status === "ok" ? "没有找到登记试验" : "登记来源暂时无法查询"} action={<Button variant="secondary" onClick={reload}>重试</Button>} />}
      <ul aria-label="本次来源查询" className="space-y-1 text-caption text-text-2">{state.data.registries.map(row => <li key={row.registry}>{row.registry} · {row.status === "ok" ? `查询成功${row.total == null ? "" : `，检索命中 ${row.total} 项`}` : registryFailure(row.reason ?? row.status)}</li>)}</ul>
    </>}
    {opened && <ReferenceRecord key={`${opened.registry}:${opened.registryId}`} studyId={studyId} candidate={opened} onClose={() => setOpened(null)} onApplied={onApplied} />}
  </Section>;
}

function ReferenceRecord({ candidate, onClose, onApplied, studyId: fixedStudyId }: { candidate: VcrReferenceCandidate; onClose: () => void; onApplied: () => void; studyId?: string }) {
  const { state, reload } = useVcrLoad(`vcr:reference-record:${candidate.registry}:${candidate.registryId}`, () => readVcrReferenceTrial(candidate.registry, candidate.registryId));
  const studies = useVcrLoad(`vcr:reference-studies:${fixedStudyId ?? "choose"}`, () => fixedStudyId ? Promise.resolve(null) : getVcrHome());
  const [studyId, setStudyId] = useState(fixedStudyId ?? "");
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fieldId = useId();
  async function apply() {
    if (busy || !studyId) return;
    setBusy(true); setMessage("");
    try {
      const result = await applyVcrReferenceTrial(studyId, candidate.registry, candidate.registryId);
      setMessage(result.status === "ok" ? "已保存到研究参考试验。登记信息可作为研究来源，个体入排匹配需在研究的匹配步骤中进行。" : "本次未能保存参考试验，请核对来源后重试。");
      if (result.status === "ok") { setApplied(true); onApplied(); }
    } catch (error) { setMessage(webErrorMessage(error, { fallback: "保存失败，请重试。" })); }
    finally { setBusy(false); }
  }
  return <Drawer title={candidate.registryId} onClose={onClose} widthClassName="max-w-lg">
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : !state.data.available ? <EmptyState icon={Library} title="登记记录暂时无法读取" action={<Button onClick={reload}>重试</Button>} /> : <div className="space-y-4">
      <h2 className="text-ui font-semibold text-text">{state.data.record?.title ?? candidate.title}</h2>
      <dl className="text-ui text-text-2"><dt>计划入组</dt><dd>{state.data.record?.enrollment?.planned ?? "未登记"}</dd><dt>实际入组</dt><dd>{state.data.record?.enrollment?.actual ?? "未登记"}</dd></dl>
      <DataTable label="登记取值" columns={[
        { key: "parameter", header: "参数", cell: row => row.parameter },
        { key: "value", header: "取值", cell: row => row.value ?? "未知" },
        { key: "unit", header: "单位", cell: row => row.unit || "未声明" },
        { key: "verification", header: "原文核对", cell: row => row.verification === "verified" ? "原文一致" : "待核对" },
      ]} rows={state.data.record?.values ?? []} rowKey={(row) => `${row.parameter}:${row.value}:${row.unit}`} />
      <details><summary className="text-ui text-link">登记原文</summary><pre className="whitespace-pre-wrap text-caption text-text-2">{state.data.record?.text ?? "未提供原文"}</pre></details>
      {fixedStudyId ? <Button disabled={busy || applied} loading={busy} onClick={() => { void apply(); }}>{applied ? "已用于本研究" : "用于本研究"}</Button> : studies.state.kind === "error" ? <VcrTabError message={studies.state.message} onRetry={studies.reload} /> : studies.state.kind === "ready" && studies.state.data && <>
        <label htmlFor={fieldId} className="block text-ui text-text">用于现有研究</label>
        <select id={fieldId} className={inputClasses()} value={studyId} onChange={event => setStudyId(event.target.value)}><option value="">选择研究</option>{studies.state.data.studies.map(study => <option key={study.id} value={study.id}>{study.name}</option>)}</select>
        <Button disabled={!studyId || busy || applied} loading={busy} onClick={() => { void apply(); }}>保存为研究参考试验</Button>
      </>}
      {message && <p role="status" className="text-ui text-text-2">{message}</p>}
    </div>}
  </Drawer>;
}

/** One search form shared by global discovery and the study evidence workspace. */
export function VcrReferenceWorkspace({ studyId, onApplied = () => undefined }: { studyId?: string; onApplied?: () => void }) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  return <section aria-label="参考试验检索" className="flex flex-col gap-3">
    <form onSubmit={event => { event.preventDefault(); if (query.trim()) setAsked(query.trim()); }} className="flex flex-wrap items-end gap-2">
      <Input label="检索参考试验" value={query} placeholder="疾病、干预或登记号" onChange={event => setQuery(event.target.value)} />
      <Button type="submit" variant="secondary" disabled={!query.trim()}>检索</Button>
    </form>
    {asked && <VcrReferenceSearch key={`${studyId ?? "global"}:${asked}`} query={asked} studyId={studyId} onApplied={onApplied} />}
  </section>;
}
