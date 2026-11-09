import type { VcrEffectShrinkageCard } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { BlockHeading } from "@/components/ui/Section";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { intervalText } from "./vcrText";

type Row = VcrEffectShrinkageCard["rows"][number];

const SUBHEADING = "text-ui font-semibold text-text";

/**
 * One estimate against the trials of its kind. The value the person wrote comes first and is printed as it was written; the other is
 * beside it at the same weight, as a reading of the same estimate and not a correction of it. There is no arrow between them. An
 * estimate of exactly 0 has no direction to shrink, so it has only its sentence.
 */
function ShrinkageRow({ row, named }: { row: Row; named: boolean }) {
  const pair = !row.degenerate && row.stated && row.shrunken ? { stated: row.stated, shrunken: row.shrunken } : null;
  const interval = pair ? intervalText(pair.shrunken.interval, pair.shrunken.precision) : "";
  return (
    <div data-vcr-shrinkage-row={row.id} className="flex flex-col gap-2">
      {named && <BlockHeading className={SUBHEADING}>{row.id}</BlockHeading>}
      {pair && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <div data-vcr-shrinkage-stated="" className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption text-text-3">你写的值</dt>
            <dd className="text-ui text-text"><VcrNumber value={pair.stated} label="你写的值" /></dd>
          </div>
          <div data-vcr-shrinkage-shrunken="" className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption text-text-3">按 Cochrane 里这类试验的总体来看</dt>
            <dd className="flex flex-wrap items-baseline gap-x-2 text-ui text-text">
              <VcrNumber value={pair.shrunken} label="按 Cochrane 里这类试验的总体来看" />
              {interval && <span data-vcr-interval="" className="text-caption tabular-nums text-text-3">{interval}</span>}
            </dd>
          </div>
        </dl>
      )}
      <p data-vcr-shrinkage-sentence="" className="text-ui text-text">{row.sentence}</p>
    </div>
  );
}

function EffectShrinkageCard({ card }: { card: VcrEffectShrinkageCard }) {
  return (
    <div data-vcr-effect-shrinkage={card.id} className="min-w-0">
      <ChartCard title={card.title}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-evidence-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.rows.map((row) => <ShrinkageRow key={row.id} row={row} named={card.rows.length > 1} />)}
          {card.note && <p data-vcr-shrinkage-note="" className="text-caption text-text-3">{card.note}</p>}
          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/** The published effects a conversation set against the Cochrane trials of their kind: a comparison line, never a replacement of the value. */
export function VcrEffectShrinkage({ cards }: { cards: readonly VcrEffectShrinkageCard[] }) {
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => <EffectShrinkageCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
