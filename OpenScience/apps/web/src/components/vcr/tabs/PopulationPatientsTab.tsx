import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/Button";
import type { VcrTabProps } from "@/app/virtual-research/VcrStudyPage";
import { PopulationTab } from "./PopulationTab";
import { PatientsTab } from "./PatientsTab";

/** A cohort is a population; a virtual patient is one member with its provenance and trajectory. */
export function PopulationPatientsTab(props: VcrTabProps) {
  const [params, setParams] = useSearchParams();
  const individual = params.get("level") === "individual" || params.has("patient");
  return <>
    <nav aria-label="人群与患者" className="mb-4 flex flex-wrap items-center gap-2">
      {[{ value: "cohort", label: "队列总览" }, { value: "individual", label: "个体患者" }].map(item => <Button key={item.value} variant={individual === (item.value === "individual") ? "secondary" : "text"} aria-pressed={individual === (item.value === "individual")} onClick={() => setParams(previous => {
        const next = new URLSearchParams(previous);
        next.set("level", item.value);
        if (item.value === "cohort") next.delete("patient");
        return next;
      })}>{item.label}</Button>)}
      <span className="text-caption text-text-2">{individual ? "看个体特征、来源与轨迹" : "看人群分布与筛选过程"}</span>
    </nav>
    {individual ? <PatientsTab {...props} /> : <PopulationTab {...props} />}
  </>;
}
