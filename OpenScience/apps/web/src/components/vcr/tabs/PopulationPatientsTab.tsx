import { useSearchParams } from "react-router";
import type { VcrTabProps } from "@/app/virtual-research/VcrStudyPage";
import { PopulationTab } from "./PopulationTab";
import { PatientsTab } from "./PatientsTab";

/** A cohort is a population; a virtual patient is one member with its provenance and trajectory. */
export function PopulationPatientsTab(props: VcrTabProps) {
  const [params] = useSearchParams();
  const individual = params.get("level") === "individual" || params.has("patient");
  return individual ? <PatientsTab {...props} /> : <PopulationTab {...props} />;
}
