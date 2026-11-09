import type { VcrStcCard } from "@/lib/vcrClient";
import { BlockHeading } from "@/components/ui/Section";
import { FactList, type Fact } from "@/components/ui/FactList";
import { VcrNumber } from "./VcrNumber";
import { intervalText } from "./vcrText";

/** The interval a value carries, with its own name, beside it; nothing for a value with none. */
const interval = (value: VcrStcCard["estimate"]) => {
  const text = intervalText(value.interval, value.precision);
  return text ? <span className="ml-2 text-caption font-normal text-text-3">{text}</span> : null;
};

/**
 * The simulated treatment comparison of a comparison: the question and the server's sentence first, then the indirect estimate with its
 * interval (and its ratio form beside it for a log-odds or log-risk scale), then the figures it is made of, each as the server counted it. The
 * conditional effect is set apart with its own note: it is what the usual regression gives, and it is not what is subtracted. Every number and
 * every word is the server's; nothing is drawn for a result that is not a simulated comparison.
 */
export function VcrStcComparison({ card }: { card: VcrStcCard | null | undefined }) {
  if (!card) return null;
  const rows: Fact[] = [
    { label: card.anchored ? "间接比较估计" : "两个结局水平之差", value: <span data-vcr-stc-estimate="" className="tabular-nums"><VcrNumber value={card.estimate} label={card.scale} className="font-semibold" />{interval(card.estimate)}</span> },
    ...(card.ratio && card.ratioLabel
      ? [{ label: card.ratioLabel, value: <span data-vcr-stc-ratio="" className="tabular-nums"><VcrNumber value={card.ratio} label={card.ratioLabel} />{interval(card.ratio)}</span> }]
      : []),
    ...card.rows.map((row) => ({
      label: row.label,
      value: (
        <span data-vcr-stc-row={row.key} className="tabular-nums">
          <VcrNumber value={row.value} label={row.label} />{interval(row.value)}
          {row.note && <span className="block text-caption font-normal text-text-3">{row.note}</span>}
        </span>
      ),
    })),
  ];
  return (
    <div data-vcr-stc="" className="flex flex-col gap-3">
      <BlockHeading className="text-ui font-semibold text-text">{card.question}</BlockHeading>
      <p data-vcr-stc-sentence="" className="text-body text-text">{card.sentence}</p>
      <FactList max={rows.length} rows={rows} />
      <p data-vcr-stc-scale="" className="text-caption text-text-3">{`估计所在的尺度：${card.scale}`}</p>
      {card.outside && <p data-vcr-stc-outside="" className="text-body text-text-2">{card.outside}</p>}
    </div>
  );
}
