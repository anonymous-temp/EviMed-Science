import { Link } from "react-router";
import type { VcrReconstructionResult } from "@/lib/vcrClient";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { Note } from "@/components/ui/Note";
import { FactList } from "@/components/ui/FactList";

export function reconstructionProblem(scenario: Record<string, unknown>, selected: string | null, available: boolean | null, choices: VcrReconstructionResult[]): string | null {
  if (available === false) return "历史所用重建结果已无法复用。原结果保留，请明确重新选择重建版本，或采用领域允许的锚定汇总比较。";
  if (!selected && scenario.anchored !== true) return "非锚定生存比较需要选择本研究已有的文献曲线重建结果。";
  if (selected && !choices.some(choice => choice.resultId === selected) && available !== true) return "请选择本研究可读取的重建结果。";
  if (selected && (scenario.aggregateEstimate != null || scenario.aggregateSe != null)) return "重建结果和汇总效应参数只能选择一种比较依据，请清除其中一项。";
  return null;
}
export function VcrReconstructionInput({ studyId, scenario, selected, available, choices, onChange, onRefresh, disabled }: { studyId: string; scenario: Record<string, unknown>; selected: string | null; available: boolean | null; choices: VcrReconstructionResult[]; onChange: (id: string | null) => void; onRefresh: () => void; disabled: boolean }) {
  const current = choices.find(choice => choice.resultId === selected);
  const origin = current?.source?.origin;
  const source = typeof origin === "string" ? origin : origin && typeof origin === "object" ? ["title", "label", "doi", "url"].map(key => (origin as Record<string, unknown>)[key]).find(value => typeof value === "string") : null;
  return <div className="flex flex-col gap-3">
    <Select label="文献曲线重建结果" disabled={disabled} value={available === false ? "historical-unavailable" : selected ?? ""} onChange={event => onChange(event.target.value || null)}><option value="">{scenario.anchored === true ? "不使用重建结果，采用汇总比较" : "选择本研究已有重建结果"}</option>{available === false && <option value="historical-unavailable" disabled>历史重建结果不可复用，请重新选择</option>}{selected && !current && available === true && <option value={selected}>本次历史所用重建结果</option>}{choices.map(choice => <option key={choice.resultId} value={choice.resultId}>Kaplan–Meier 重建 v{choice.version}{choice.createdAt ? ` · ${choice.createdAt}` : ""}</option>)}</Select>
    <Button size="sm" variant="text" disabled={disabled} onClick={onRefresh}>刷新重建结果</Button>
    {current && <FactList rows={[{ label: "数据性质", value: "文献曲线重建，不能当作真实患者观测" }, { label: "来源时间单位", value: current.timeUnit ?? "尚未注明，请在证据流程核对" }, ...(typeof source === "string" ? [{ label: "曲线来源", value: source }] : [])]} />}
    {!choices.length && <Note action={<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(studyId)}/data`}>从文献曲线取得重建结果</Link>}>尚无可选择的已保存重建结果。{scenario.anchored === true ? "已有汇总效应和标准误时可继续锚定比较。" : "请先在研究证据流程完成曲线来源与重建。"}</Note>}
  </div>;
}
