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
  Microscope,
  Network,
  PenLine,
  Pill,
  Scale,
  Sigma,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

/**
 * One line icon per capability, drawn in the muted ink (appendix D §10.4).
 * They replace the two-letter monograms (SA, CS, CE…), which carried no
 * information in a Chinese interface and sat in the brand colour beside the
 * primary button. An icon is recognition, never identity: the name is always
 * printed beside it.
 *
 * A hand-written table of the catalogue's capabilities: `capabilityIcons.test.ts` holds it to the listed ones, so a workflow
 * added to 科研工具 without a mark of its own — drawn as the fallback beaker — or an entry for one that is gone is red.
 */
export const CAPABILITY_ICONS: Readonly<Record<string, LucideIcon>> = {
  "clinical-evidence-synthesis": Stethoscope,
  "evidence-appraisal": ClipboardCheck,
  "meta-analysis": Layers,
  "adr-analysis": Pill,
  "off-label-analysis": BookOpenCheck,
  "comprehensive-drug-evaluation": Scale,
  "drug-selection": ListChecks,
  "dataset-research-scoping": Database,
  "gene-expression-analysis": Microscope,
  "statistical-analysis": Sigma,
  "research-topic-selection": Lightbulb,
  "mendelian-randomization": Dna,
  "bibliometric-analysis": Network,
  "peer-review": FileSearch,
  "manuscript-support": PenLine,
  "research-grant-development": Landmark,
  "geo-content": Globe,
};

export function capabilityIcon(id: string): LucideIcon {
  return CAPABILITY_ICONS[id] ?? FlaskConical;
}
