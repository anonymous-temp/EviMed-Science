import { useId, useRef, useState } from "react";
import { VCR_ENDPOINT_TYPE_LABELS_ZH } from "@evimed/domain";
import { adoptVcrModel, type VcrModelBody, type VcrModelRisk } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Input, inputClasses, Textarea } from "@/components/ui/Input";
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
export function VcrModelAdoptDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [risk, setRisk] = useState<VcrModelRisk>("low");
  const [endpoint, setEndpoint] = useState<NonNullable<VcrModelBody["endpointType"]> | "">("");
  const [sources, setSources] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const riskId = useId();
  const endpointId = useId();
  const valid = name.trim() !== "" && name.trim().length <= 80;

  const save = () => {
    if (!valid || holding.current) return;
    holding.current = true;
    setBusy(true);
    void adoptVcrModel({
      name, version, risk, ...(endpoint ? { endpointType: endpoint } : {}),
      sources: sources.split("\n"),
    })
      .then(() => { toast.success("已引入模型库。"); onSaved(); onClose(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这个模型暂时无法引入，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <Drawer title="引入文献模型" onClose={onClose} widthClassName="max-w-md">
      <form data-vcr-model-adopt="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <Input label="模型名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        <Input label="版本" placeholder="1.0.0" value={version} onChange={(event) => setVersion(event.target.value)} autoComplete="off" />
        <div>
          <label htmlFor={riskId} className="mb-2 block text-ui font-medium text-text">模型风险</label>
          <select id={riskId} value={risk} onChange={(event) => setRisk(event.target.value as VcrModelRisk)} className={inputClasses()}>
            {RISKS.map((each) => <option key={each} value={each}>{modelRiskLabel(each)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={endpointId} className="mb-2 block text-ui font-medium text-text">终点</label>
          <select id={endpointId} value={endpoint} onChange={(event) => setEndpoint(event.target.value as typeof endpoint)} className={inputClasses()}>
            <option value="">不限</option>
            {ENDPOINTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <Textarea label="来源试验（每行一项）" rows={4} value={sources} onChange={(event) => setSources(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!valid || busy}>引入</Button>
        </div>
      </form>
    </Drawer>
  );
}
