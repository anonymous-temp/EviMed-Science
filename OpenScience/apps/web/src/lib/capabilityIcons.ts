import {
  BookOpenCheck,
  ClipboardCheck,
  Database,
  Dna,
  FileSearch,
  FlaskConical,
  Globe,
  Landmark,
  Layers,
  Lightbulb,
  ListChecks,
  Network,
  PenLine,
  Pill,
  Scale,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

/**
 * One line icon per capability, drawn in the muted ink (appendix D §10.4).
 * They replace the two-letter monograms (SA, CS, CE…), which carried no
 * information in a Chinese interface and sat in the brand colour beside the
 * primary button. An icon is recognition, never identity: the name is always
 * printed beside it.
 */
const ICONS: Record<string, LucideIcon> = {
  "clinical-evidence-synthesis": Stethoscope,
  "evidence-appraisal": ClipboardCheck,
  "meta-analysis": Layers,
  "adr-analysis": Pill,
  "off-label-analysis": BookOpenCheck,
  "comprehensive-drug-evaluation": Scale,
  "drug-selection": ListChecks,
  "dataset-research-scoping": Database,
  "research-topic-selection": Lightbulb,
  "mendelian-randomization": Dna,
  "bibliometric-analysis": Network,
  "peer-review": FileSearch,
  "manuscript-support": PenLine,
  "research-grant-development": Landmark,
  "geo-content": Globe,
};

export function capabilityIcon(id: string): LucideIcon {
  return ICONS[id] ?? FlaskConical;
}
