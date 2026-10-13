import {
  BarChart3,
  BookOpenCheck,
  ClipboardCheck,
  Code2,
  Database,
  Dna,
  FileSearch,
  FileText,
  FlaskConical,
  Globe,
  Landmark,
  Layers,
  Lightbulb,
  ListChecks,
  Network,
  PenLine,
  Pill,
  Presentation,
  Scale,
  Stethoscope,
  Table2,
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

/** The general tools of the tools page, by their id in `@evimed/domain`'s `GENERAL_TOOLS`. */
const GENERAL_ICONS: Record<string, LucideIcon> = {
  documents: FileText,
  spreadsheets: Table2,
  slides: Presentation,
  "data-analysis": BarChart3,
  "web-research": Globe,
  code: Code2,
};

export function generalToolIcon(id: string): LucideIcon {
  return GENERAL_ICONS[id] ?? Lightbulb;
}
