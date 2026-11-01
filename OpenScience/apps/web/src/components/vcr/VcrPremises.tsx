import { PenLine } from "lucide-react";
import { VCR_PREMISES_DECISIVE_MAX, VCR_PREMISE_SOURCE_LABELS_ZH } from "@evimed/domain";
import type { VcrPremise } from "@/lib/vcrClient";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tag, type TagTone } from "@/components/ui/Tag";
import { DRAFT_PREFIX } from "./vcrActionWords";

/**
 * 「这个结论的前提」 — the one block a result page opens with its assumptions (remediation plan 5.2), the same on the trial, the
 * population and the comparator.
 *
 * The server hands over every premise of the result with its value, where it came from (文献 / 假设 / 默认 / 你给的数据) and whether
 * the conclusion turns on it; this shows the decisive ones, at most five, and folds every other into one disclosure. There is no
 * banner and no general caveat: a row is a premise because a number stands behind it, and it carries the one way to change it — the
 * draft into the conversation's own composer, prefilled with the premise's name (`premiseDraft`), which the researcher completes
 * and sends. Pressing it sends nothing.
 *
 * A default is the quiet fact the block is for (a dropout of 0 nobody wrote), so 默认 is the one source drawn in the attention tone.
 */
export const premiseDraft = (premise: Pick<VcrPremise, "label" | "value">): string => `改“${premise.label}”（现在是 ${premise.value}）为：`;

const TONES: Record<VcrPremise["source"], TagTone> = { literature: "neutral", assumed: "neutral", default: "warn", given: "neutral" };

function PremiseRow({ premise, onChange }: { premise: VcrPremise; onChange: ((premise: VcrPremise) => void) | null }) {
  return (
    <li data-vcr-premise={premise.key} data-vcr-premise-source={premise.source} className="grid grid-cols-[minmax(7rem,12rem)_1fr_auto_auto] items-center gap-x-3 gap-y-1 border-b border-faint py-2 last:border-b-0 max-sm:grid-cols-[1fr_auto]">
      <span className="text-caption text-text-3 max-sm:col-span-2">{premise.label}</span>
      <span className="min-w-0 text-ui text-text max-sm:col-start-1">{premise.value}</span>
      <Tag tone={TONES[premise.source]}>{VCR_PREMISE_SOURCE_LABELS_ZH[premise.source]}</Tag>
      {onChange
        ? (
          <Button size="sm" variant="text" actionKind="draft" data-vcr-premise-change={premise.key} onClick={() => onChange(premise)} aria-label={`${DRAFT_PREFIX}调整：${premise.label}`}>
            <PenLine size={16} aria-hidden="true" />{`${DRAFT_PREFIX}调整`}
          </Button>
        )
        : <span />}
    </li>
  );
}

export function VcrPremises({ premises, onChange = null }: {
  premises: readonly VcrPremise[] | undefined;
  /** Puts the premise's draft in the conversation's composer; absent where the reader may not change it. */
  onChange?: ((premise: VcrPremise) => void) | null;
}) {
  const all = premises ?? [];
  if (all.length === 0) return null;
  const decisive = all.filter((premise) => premise.decisive).slice(0, VCR_PREMISES_DECISIVE_MAX);
  const open = new Set(decisive.map((premise) => premise.key));
  const rest = all.filter((premise) => !open.has(premise.key));
  return (
    <section data-vcr-premises="" aria-labelledby="vcr-premises-title" className="flex flex-col gap-1">
      <h3 id="vcr-premises-title" className="text-ui font-semibold text-text">这个结论的前提</h3>
      {decisive.length > 0 && <ul data-vcr-premises-open="">{decisive.map((premise) => <PremiseRow key={premise.key} premise={premise} onChange={onChange} />)}</ul>}
      {rest.length > 0 && (
        <Disclosure summary={decisive.length > 0 ? `其余 ${rest.length} 条前提` : `全部 ${rest.length} 条前提`} defaultOpen={decisive.length === 0}>
          <ul data-vcr-premises-rest="">{rest.map((premise) => <PremiseRow key={premise.key} premise={premise} onChange={onChange} />)}</ul>
        </Disclosure>
      )}
    </section>
  );
}
