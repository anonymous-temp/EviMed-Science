import { useId, useState } from "react";
import { Library } from "lucide-react";
import { applyVcrReferenceTrial, getVcrHome, readVcrReferenceTrial, searchVcrReferenceTrials, type VcrReferenceCandidate } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { inputClasses } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Drawer";
import { DataTable } from "@/components/ui/DataTable";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/cards/EmptyState";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";

/** Uses the same registry reads and evidence preservation as a research run. */
export function VcrReferenceSearch({ query, onApplied }: { query: string; onApplied: () => void }) {
  const { state, reload } = useVcrLoad(`vcr:reference-search:${query}`, () => searchVcrReferenceTrials(query));
  const [opened, setOpened] = useState<VcrReferenceCandidate | null>(null);
  return <Section title="检索登记试验">
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <>
      <DataTable label="登记试验检索结果" columns={[
        { key: "registryId", header: "登记号", cell: row => row.registryId },
        { key: "title", header: "试验", cell: row => row.title },
        { key: "registry", header: "来源", cell: row => row.registry },
      ]} rows={state.data.candidates} rowKey={row => `${row.registry}:${row.registryId}`} onRowOpen={setOpened} />
      {state.data.candidates.length === 0 && <EmptyState icon={Library} title={state.data.status === "ok" ? "没有找到登记试验" : "登记来源暂时无法查询"} action={<Button variant="secondary" onClick={reload}>重试</Button>} />}
      <ul aria-label="本次来源查询" className="space-y-1 text-caption text-text-2">{state.data.registries.map(row => <li key={row.registry}>{row.registry} · {row.status === "ok" ? `查询成功${row.total == null ? "" : `，${row.total} 项`}` : `未能查询：${row.reason ?? row.status}`}</li>)}</ul>
    </>}
    {opened && <ReferenceRecord candidate={opened} onClose={() => setOpened(null)} onApplied={onApplied} />}
  </Section>;
}

function ReferenceRecord({ candidate, onClose, onApplied }: { candidate: VcrReferenceCandidate; onClose: () => void; onApplied: () => void }) {
  const { state, reload } = useVcrLoad(`vcr:reference-record:${candidate.registry}:${candidate.registryId}`, () => readVcrReferenceTrial(candidate.registry, candidate.registryId));
  const studies = useVcrLoad("vcr:reference-studies", getVcrHome);
  const [studyId, setStudyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fieldId = useId();
  async function apply() {
    if (busy || !studyId) return;
    setBusy(true); setMessage("");
    try {
      const result = await applyVcrReferenceTrial(studyId, candidate.registry, candidate.registryId);
      setMessage(result.status === "ok" ? `已保存参考试验与来源，核对通过 ${result.counts?.verified ?? 0} 项取值。` : `未保存：${result.reason ?? result.status}`);
      if (result.status === "ok") onApplied();
    } catch (error) { setMessage(webErrorMessage(error, { fallback: "保存失败，请重试。" })); }
    finally { setBusy(false); }
  }
  return <Drawer title={candidate.registryId} onClose={onClose} widthClassName="max-w-lg">
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : !state.data.available ? <EmptyState icon={Library} title={`登记记录未读到：${state.data.reason ?? state.data.status}`} action={<Button onClick={reload}>重试</Button>} /> : <div className="space-y-4">
      <h2 className="text-ui font-semibold text-text">{state.data.record?.title ?? candidate.title}</h2>
      <dl className="text-ui text-text-2"><dt>计划入组</dt><dd>{state.data.record?.enrollment?.planned ?? "未登记"}</dd><dt>实际入组</dt><dd>{state.data.record?.enrollment?.actual ?? "未登记"}</dd></dl>
      <DataTable label="登记取值" columns={[
        { key: "parameter", header: "参数", cell: row => row.parameter },
        { key: "value", header: "取值", cell: row => row.value ?? "未知" },
        { key: "unit", header: "单位", cell: row => row.unit || "未声明" },
        { key: "verification", header: "原文核对", cell: row => row.verification },
      ]} rows={state.data.record?.values ?? []} rowKey={(row) => `${row.parameter}:${row.value}:${row.unit}`} />
      <details><summary className="text-ui text-link">登记原文</summary><pre className="whitespace-pre-wrap text-caption text-text-2">{state.data.record?.text ?? "未提供原文"}</pre></details>
      {studies.state.kind === "error" ? <VcrTabError message={studies.state.message} onRetry={studies.reload} /> : studies.state.kind === "ready" && <>
        <label htmlFor={fieldId} className="block text-ui text-text">用于现有研究</label>
        <select id={fieldId} className={inputClasses()} value={studyId} onChange={event => setStudyId(event.target.value)}><option value="">选择研究</option>{studies.state.data.studies.map(study => <option key={study.id} value={study.id}>{study.name}</option>)}</select>
        <Button disabled={!studyId || busy} loading={busy} onClick={() => { void apply(); }}>保存为研究参考试验</Button>
      </>}
      {message && <p role="status" className="text-ui text-text-2">{message}</p>}
    </div>}
  </Drawer>;
}
