import { useId, useRef, useState } from "react";
import { VCR_ENDPOINT_TYPE_LABELS_ZH } from "@evimed/domain";
import { adoptVcrModel, getVcrHome, readVcrReferenceTrial, type VcrReferenceRecord, type VcrModelCard, type VcrModelBody, type VcrModelRisk } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Input, inputClasses, Textarea } from "@/components/ui/Input";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { modelRiskLabel } from "./vcrText";

const RISKS: readonly VcrModelRisk[] = Object.freeze(["low", "medium", "high"]);
const ENDPOINTS = Object.freeze(Object.entries(VCR_ENDPOINT_TYPE_LABELS_ZH) as Array<[NonNullable<VcrModelBody["endpointType"]>, string]>);

/**
 * 引入文献模型: take a prediction model a published trial fitted into the
 * library both studies draw on.
 *
 * Hidden knowledge:
 *  - **The tier is not asked.** An adopted model is a literature-tier model, and
 *    the server says so; the page has no field that could name a higher one. A
 *    model earns 「数据」 or 「已验证」 by evidence the library holds, not by being
 *    typed in (plan §8.2).
 *  - **The population is written from the trials named here.** There is no
 *    「适用人群」 field: a model that claims a population nobody fitted it on is the
 *    failure the ceiling exists to prevent, so the server writes the population
 *    from the sources and the page only lists them, one trial a line.
 *  - One request at a time; a second click while one is in flight does nothing.
 */
export function VcrModelAdoptDialog({ onClose, onSaved, initialModel }: { onClose: () => void; onSaved: () => void; initialModel?: VcrModelCard | null }) {
  const [name, setName] = useState(initialModel?.name ?? "");
  const [version, setVersion] = useState("");
  const [risk, setRisk] = useState<VcrModelRisk | "">(initialModel && ["none", "low", "medium", "high"].includes(initialModel.risk) ? initialModel.risk : "");
  const [endpoint, setEndpoint] = useState<NonNullable<VcrModelBody["endpointType"]> | "">(initialModel?.endpointType ?? "");
  const [sources, setSources] = useState((initialModel?.sourceRefs ?? []).join("\n"));
  const [studyId, setStudyId] = useState("");
  const studies = useVcrLoad("model-intake:studies", getVcrHome);
  const studyFieldId = useId();
  const [registryId, setRegistryId] = useState(initialModel?.sourceRegistryId ?? "");
  const [record, setRecord] = useState<VcrReferenceRecord | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const riskId = useId();
  const endpointId = useId();
  const valid = name.trim() !== "" && name.trim().length <= 80 && (!initialModel || (version.trim() !== "" && version.trim() !== initialModel.version));

  const save = () => {
    if (!valid || holding.current || reading) return;
    holding.current = true;
    setBusy(true);
    void adoptVcrModel({
      name, version, ...(studyId ? { studyId } : {}), ...(risk ? { risk: risk as NonNullable<VcrModelBody["risk"]> } : {}), ...(endpoint ? { endpointType: endpoint } : {}),
      sources: sources.split("\n"),
      ...((record?.available || initialModel) ? { card: { ...initialModel?.revisionCard,
        ...(record?.available ? { sourceRegistryId: record.registryId, sourceParameters: record.record?.values ?? [],
          knownLimits: initialModel?.limits?.length ? initialModel.limits : ["登记记录的参数不构成已验证的预测模型；尚缺模型方程、系数与可调用集成。"] } : {}),
      }, applicability: initialModel?.revisionApplicability } : {}),
    })
      .then(() => { toast.success("已引入模型库。"); onSaved(); onClose(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这个模型暂时无法引入，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <Drawer title={initialModel ? "登记模型新版本" : "引入文献模型"} onClose={onClose} widthClassName="max-w-md">
      <form data-vcr-model-adopt="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Input label="登记来源编号" placeholder="NCT02296125" value={registryId} disabled={reading} onChange={event => { setRegistryId(event.target.value); setRecord(null); }} />
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
        <Input label="模型名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        <Input label="版本" placeholder={initialModel?.version ? `当前 ${initialModel.version}，填写新版本` : "1.0.0"} value={version} onChange={(event) => setVersion(event.target.value)} autoComplete="off" />
        <div>
          <label htmlFor={riskId} className="mb-2 block text-ui text-text">模型风险</label>
          <select id={riskId} value={risk} onChange={(event) => setRisk(event.target.value as VcrModelRisk)} className={inputClasses()}>
            <option value="">未评估</option>
            {(initialModel?.risk === "none" ? ["none" as const, ...RISKS] : RISKS).map((each) => <option key={each} value={each}>{modelRiskLabel(each)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={endpointId} className="mb-2 block text-ui text-text">终点</label>
          <select id={endpointId} value={endpoint} onChange={(event) => setEndpoint(event.target.value as typeof endpoint)} className={inputClasses()}>
            <option value="">未声明</option>
            {ENDPOINTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {studies.state.kind === "ready" && studies.state.data.studies.length > 0 && <div>
          <label htmlFor={studyFieldId} className="mb-2 block text-ui text-text">用于现有研究</label>
          <select id={studyFieldId} value={studyId} className={inputClasses()} onChange={event => setStudyId(event.target.value)}><option value="">仅登记模型库</option>{studies.state.data.studies.map(study => <option key={study.id} value={study.id}>{study.name}</option>)}</select>
        </div>}
        {studies.state.kind === "error" && <VcrTabError message={studies.state.message} onRetry={studies.reload} />}
        <Textarea label="来源试验（每行一项）" rows={4} value={sources} onChange={(event) => setSources(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!valid || busy || reading}>引入</Button>
        </div>
      </form>
    </Drawer>
  );
}
