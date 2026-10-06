import { useId, useRef, useState } from "react";
import { fileVcrPrediction, type VcrDesign } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";

/** The measures of a design that are a probability of success, and the path the server reads them at. */
const PROBABILITY_MEASURES: ReadonlyArray<{ key: string; label: string; path: string }> = Object.freeze([
  { key: "power", label: "功效", path: "measure(power)" },
  { key: "assurance", label: "成功把握", path: "measure(assurance)" },
]);

/**
 * 登记预测: the lead files a trial scenario's prediction of a registered trial's primary endpoint. The page chooses a design and a
 * measure; **it types no number** — the server reads the estimate (or the success probability) from the engine's own result at the
 * named path, so a prediction can never be a figure somebody chose. Filed with a timestamp, scored when the trial reports, shown to
 * nobody before that.
 */
export function VcrFilePrediction({ studyId, designs }: { studyId: string; designs: readonly VcrDesign[] }) {
  const options = designs.filter((design) => !design.dominated && PROBABILITY_MEASURES.some((measure) => design.measures[measure.key]?.value != null));
  const [scenarioId, setScenarioId] = useState(options[0]?.id ?? "");
  const [measure, setMeasure] = useState("power");
  const [registryId, setRegistryId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const ids = { design: useId(), measure: useId(), registry: useId(), endpoint: useId() };
  if (options.length === 0) return null;
  const design = options.find((entry) => entry.id === scenarioId) ?? options[0];
  const available = PROBABILITY_MEASURES.filter((entry) => design.measures[entry.key]?.value != null);
  const chosen = available.find((entry) => entry.key === measure) ?? available[0];

  const file = () => {
    if (holding.current || !registryId.trim() || !endpoint.trim() || !chosen) return;
    holding.current = true;
    setBusy(true);
    void fileVcrPrediction(studyId, { scenarioId: design.id, registryId: registryId.trim(), endpoint: endpoint.trim(), resultPath: chosen.path })
      .then(() => toast.success("已登记预测。"))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法登记，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <Card title="登记预测">
      <div data-vcr-file-prediction="" className="flex flex-col gap-3">
        <p className="text-caption text-text-3">把这个方案对某项已注册试验主要终点的预测，连同时间一起登记；预测的数直接取自引擎的结果，这里不输入任何数字。试验结果出来之前不公开。</p>
        <Select id={ids.design} label="方案" value={design.id} onChange={(event) => setScenarioId(event.target.value)}>
          {options.map((entry) => <option key={entry.id} value={entry.id}>{`${entry.code} · ${entry.name}`}</option>)}
        </Select>
        <Select id={ids.measure} label="预测的指标" value={chosen?.key ?? ""} onChange={(event) => setMeasure(event.target.value)}>
          {available.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
        </Select>
        <Input id={ids.registry} label="试验登记号" value={registryId} placeholder="例如 NCT02296125" onChange={(event) => setRegistryId(event.target.value)} />
        <Input id={ids.endpoint} label="主要终点" value={endpoint} maxLength={120} onChange={(event) => setEndpoint(event.target.value)} />
        <div>
          <Button size="sm" variant="secondary" loading={busy} disabled={!registryId.trim() || !endpoint.trim()} onClick={file}>登记预测</Button>
        </div>
      </div>
    </Card>
  );
}
