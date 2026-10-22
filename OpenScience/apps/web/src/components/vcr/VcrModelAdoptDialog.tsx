import { useId, useRef, useState } from "react";
import { VCR_ENDPOINT_TYPE_LABELS_ZH } from "@evimed/domain";
import { adoptVcrModel, getVcrHome, getVcrModels, readVcrReferenceTrial, type VcrReferenceRecord, type VcrModelCard, type VcrModelBody } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { WebApiError } from "@/lib/apiClient";
import { Input, inputClasses, Textarea } from "@/components/ui/Input";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";

import { VcrLiteratureSource, type LiteratureSelection } from "./VcrLiteratureSource";

export function nextParameterVersion(version: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version);
  return match ? `${Number(match[1])}.${Number(match[2] ?? 0)}.${Number(match[3] ?? 0) + 1}` : null;
}
const ENDPOINTS = Object.freeze(Object.entries(VCR_ENDPOINT_TYPE_LABELS_ZH) as Array<[NonNullable<VcrModelBody["endpointType"]>, string]>);

/** Register or revise a literature model from existing preserved sources.
 * Parameter mappings are resolved by the server, certification is never granted
 * by this form, and incomplete registrations remain useful records.
 */
export function VcrModelAdoptDialog({ onClose, onSaved, initialModel, initialStudyId, submitLabel = "保存文献参数" }: { onClose: () => void; onSaved: (saved?: { id: string }) => void; initialModel?: VcrModelCard | null; initialStudyId?: string; submitLabel?: string }) {
  const [name, setName] = useState(initialModel?.name ?? "");
  const [version, setVersion] = useState(initialModel ? nextParameterVersion(initialModel.version ?? "") : "1.0.0");
  const [saveError, setSaveError] = useState("");
  const [endpoint, setEndpoint] = useState<NonNullable<VcrModelBody["endpointType"]> | "">(initialModel?.endpointType ?? "");
  const [sources, setSources] = useState((initialModel?.sourceRefs ?? []).join("\n"));
  const [studyId, setStudyId] = useState(initialStudyId ?? initialModel?.studyId ?? "");
  const [literature, setLiterature] = useState<LiteratureSelection | null>(null);
  const studies = useVcrLoad("model-intake:studies", getVcrHome);
  const studyFieldId = useId();
  const [registryId, setRegistryId] = useState(initialModel?.sourceRegistryId ?? "");
  const [record, setRecord] = useState<VcrReferenceRecord | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const endpointId = useId();
  const valid = name.trim() !== "" && name.trim().length <= 80 && version !== null;

  const save = () => {
    if (!valid || holding.current || reading) return;
    holding.current = true;
    setBusy(true); setSaveError("");
    void adoptVcrModel({
      name, version: version ?? undefined, ...(studyId ? { studyId } : {}), ...(initialModel && ["none", "low", "medium", "high"].includes(initialModel.risk) ? { risk: initialModel.risk as NonNullable<VcrModelBody["risk"]> } : {}), ...(endpoint ? { endpointType: endpoint } : {}),
      sources: [...sources.split("\n"), ...(literature ? [literature.title] : [])],
      ...((record?.available || initialModel || literature) ? { card: { ...initialModel?.revisionCard,
        ...(literature ? { literatureSource: literature.literatureSource, parameterBindings: literature.parameterBindings, executionProfile: literature.executionProfile } : {}),
        ...(record?.available ? { sourceRegistryId: record.registryId, sourceParameters: record.record?.values ?? [],
          knownLimits: initialModel?.limits?.length ? initialModel.limits : ["登记记录的参数不构成已验证的预测模型；尚缺模型方程、系数与可调用集成。"] } : {}),
      }, applicability: initialModel?.revisionApplicability } : {}),
    })
      .then(saved => { toast.success("已保存文献参数。"); onSaved(saved); onClose(); })
       .catch(async (error: unknown) => {
        if (error instanceof WebApiError && error.status === 409) {
          try {
            const library = await getVcrModels();
            const versions = library.models.filter(model => model.name === name.trim()).map(model => model.version ?? "").filter(value => /^\d+(?:\.\d+){0,2}$/.test(value)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
            const next = nextParameterVersion(versions.at(-1) ?? version ?? "1.0.0");
            setVersion(next); setSaveError(`已有更新的来源版本，当前输入已保留。${next ? `再次保存将使用版本 ${next}。` : "暂时无法自动安排新版本，请重新打开最新来源。"}`);
          } catch { setSaveError("已有同名来源版本，当前输入已保留。请刷新来源列表后重试。"); }
        } else setSaveError(webErrorMessage(error, { fallback: "文献参数暂时无法保存，请重试。" }));
      })
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <Section title={initialModel ? "补充文献参数并保存新版本" : "使用文献参数"} toolbar={<Button variant="text" disabled={busy || reading} onClick={onClose}>返回方法列表</Button>}>
      <form data-vcr-model-adopt="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}><fieldset disabled={busy || reading} className="flex min-w-0 flex-col gap-4">
        {studies.state.kind === "ready" && studies.state.data.studies.length > 0 && <div>
          <label htmlFor={studyFieldId} className="mb-2 block text-ui text-text">用于现有研究</label>
          <select id={studyFieldId} value={studyId} className={inputClasses()} onChange={event => { setStudyId(event.target.value); setLiterature(null); }}><option value="">仅登记模型库</option>{studies.state.data.studies.map(study => <option key={study.id} value={study.id}>{study.name}</option>)}</select>
        </div>}
        {studies.state.kind === "error" && <VcrTabError message={studies.state.message} onRetry={studies.reload} />}
        {studyId && studies.state.kind === "ready" && <VcrLiteratureSource key={studyId} studyId={studyId} projectId={studies.state.data.studies.find(study => study.id === studyId)?.projectId ?? ""} onChange={value => { setLiterature(value); if (value && !name.trim()) setName(value.title.slice(0, 80)); }} />}
        <Input label="试验登记来源编号（可选）" placeholder="NCT02296125" value={registryId} disabled={reading} onChange={event => { setRegistryId(event.target.value); setRecord(null); }} />
        <Button type="button" variant="secondary" disabled={!/^NCT\d{8}$/.test(registryId.trim()) || reading} loading={reading} onClick={() => {
          const requestedId = registryId.trim();
          setReading(true); setReadError("");
          void readVcrReferenceTrial("clinicaltrials.gov", requestedId).then(result => {
            setRecord({ ...result, registryId: requestedId });
            if (result.available) { if (!name.trim()) setName((result.record?.title ?? requestedId).slice(0, 80)); setSources(previous => [...previous.split("\n").filter(Boolean), requestedId].join("\n")); }
            else setReadError(`来源未读到：${result.reason ?? result.status}`);
          }).catch(error => setReadError(webErrorMessage(error, { fallback: "来源未读到，可保留登记后补充。" }))).finally(() => setReading(false));
        }}>读取来源参数</Button>
        {readError && <p role="status" className="text-caption text-text-2">{readError}</p>}
        {record?.available && <div className="space-y-2 text-caption text-text-2"><p>已读取登记资料；尚缺模型方程、系数和可调用集成，保存后作为待补全文献模型。</p><ul>{record.record?.values?.map((value, index) => <li key={index}>{value.parameter}：{value.value ?? "未知"} {value.unit || "单位未声明"} · {value.verification}</li>)}</ul></div>}
        <Input label="参数集名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        <p className="text-caption text-text-2">{version ? `保存为来源版本 ${version}，已有版本与历史结果保留。` : "当前来源版本无法自动递增，请重新选择最新来源。"}</p>
        <div>
          <label htmlFor={endpointId} className="mb-2 block text-ui text-text">终点</label>
          <select id={endpointId} value={endpoint} onChange={(event) => setEndpoint(event.target.value as typeof endpoint)} className={inputClasses()}>
            <option value="">未声明</option>
            {ENDPOINTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <Textarea label="来源试验（每行一项）" rows={4} value={sources} onChange={(event) => setSources(event.target.value)} />
        {saveError && <p role="alert" className="text-ui text-error">{saveError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!valid || busy || reading}>{submitLabel}</Button>
        </div>
      </fieldset></form>
    </Section>
  );
}
