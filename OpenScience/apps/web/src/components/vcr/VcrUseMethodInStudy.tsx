import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { createVcrStudy, getVcrHome, saveVcrMethodConfiguration } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { vcrMethodPath } from "@/lib/vcrMethodLocation";
import { methodHasOwnedReferences, stripMethodScopeRefs } from "@/lib/vcrMethodDisplay";
import { Note } from "@/components/ui/Note";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input, Select } from "@/components/ui/Input";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import type { VcrMethodRunnerProps } from "./VcrMethodRunner";

type MethodUseProps = { method: string; name: string; scenario: Record<string, unknown>; modelId?: string; valid: boolean; disabled: boolean; onUse?: VcrMethodRunnerProps["onUse"] };

export function VcrUseMethodInStudy(props: MethodUseProps) {
  const [open, setOpen] = useState(false);
  if (props.method === "population.quality") return null;
  return <Disclosure summary="用于研究" onToggle={setOpen}>{open && <MethodUseForm {...props} />}</Disclosure>;
}

/** Copy a configuration only when asked. A calculation container never changes purpose. */
function MethodUseForm({ method, name, scenario, modelId, valid, disabled, onUse }: MethodUseProps) {
  const navigate = useNavigate();
  const needsData = methodHasOwnedReferences(method, scenario);
  const studies = useVcrLoad("method-use:studies", getVcrHome);
  const [target, setTarget] = useState("");
  const [newName, setNewName] = useState("");
  const [createdDraft, setCreatedDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ studyId: string; version: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = async (create: boolean) => {
    if (busy || disabled || !valid || (create ? !newName.trim() : !target)) return;
    setBusy(true); setError("");
    try {
      let destination = create ? createdDraft : target;
      if (!destination && create) { const study = await createVcrStudy({ name: newName.trim(), purpose: "programme", draft: true }); destination = study.id; setCreatedDraft(study.id); }
      if (!destination) return;
      if (needsData) {
        navigate(vcrMethodPath(method, { studyId: destination, ...(modelId ? { modelId } : {}) }), { state: { methodScenario: stripMethodScopeRefs(scenario), methodDraftNotice: "数值参数已带入；请在当前研究选择授权输入，保存并运行后才会产生计算历史。" } });
        return;
      }
      const configuration = await saveVcrMethodConfiguration(destination, { method, name, scenario: structuredClone(scenario), ...(modelId ? { modelId } : {}) });
      if (!configuration.subjectId || !configuration.objectKind) {
        navigate(vcrMethodPath(method, { studyId: destination, ...(modelId ? { modelId } : {}) }), { state: { methodScenario: structuredClone(scenario), methodDraftNotice: "参数已作为未运行草稿带入当前研究；运行后才会产生计算历史。" } });
        return;
      }
      setSaved({ studyId: destination, version: configuration.version });
      onUse?.({ studyId: destination, subjectId: configuration.subjectId, scenario: structuredClone(scenario) });
    } catch (failure) { setError(webErrorMessage(failure, { fallback: "配置暂时无法复制，当前输入已保留。" })); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-3">
    {studies.state.kind === "error" ? <VcrTabError message={studies.state.message} onRetry={studies.reload} /> : <Select label="选择目标研究" disabled={busy || disabled || studies.state.kind === "loading"} value={target} onChange={event => setTarget(event.target.value)}><option value="">请选择目标研究</option>{studies.state.kind === "ready" && studies.state.data.studies.filter(study => study.purpose !== "calculation").map(study => <option key={study.id} value={study.id}>{study.name}</option>)}</Select>}
    <Note action={<Button variant="secondary" disabled={!target || !valid || disabled || busy} loading={busy} onClick={() => void copy(false)}>{needsData ? "在目标研究继续配置" : "将配置复制到研究"}</Button>}>将当前参数保存到所选研究，复制本身不会运行计算。{needsData ? "数值参数会保留，请在目标研究重新选择授权数据后保存配置。" : ""}</Note>
    <Input label="新研究名称" value={newName} disabled={disabled || busy} maxLength={80} onChange={event => { setNewName(event.target.value); setCreatedDraft(null); }} />
    <Button variant="secondary" disabled={!newName.trim() || !valid || disabled || busy} loading={busy} onClick={() => void copy(true)}>{needsData ? "新建研究草稿并继续配置" : "新建研究草稿并使用配置"}</Button>
    {saved && <p role="status" className="text-ui text-text-2">配置已保存{saved.version != null ? `为版本 ${saved.version}` : ""}。<Link className="ml-2 text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(saved.studyId)}`}>打开研究并补充研究问题</Link></p>}
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
  </div>;
}
