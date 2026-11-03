import type { VcrTargetTrialCard } from "@/lib/vcrClient";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { VcrNumber } from "./VcrNumber";
import { NO_VALUE } from "./vcrText";

type Estimand = VcrTargetTrialCard["estimands"][number];

const columns: Array<DataColumn<Estimand>> = [
  {
    key: "estimand",
    header: "估计目标",
    rowHeader: true,
    cell: (row) => (
      <>
        <span>{row.label}</span>
        {row.meaning && <span className="block text-caption font-normal text-text-3">{row.meaning}</span>}
      </>
    ),
  },
  {
    key: "riskTreated",
    header: "试验组风险",
    align: "right",
    cell: (row) => (row.riskTreated ? <VcrNumber value={row.riskTreated} label={`${row.label}，试验组风险`} /> : NO_VALUE),
  },
  {
    key: "riskControl",
    header: "对照组风险",
    align: "right",
    cell: (row) => (row.riskControl ? <VcrNumber value={row.riskControl} label={`${row.label}，对照组风险`} /> : NO_VALUE),
  },
  {
    key: "riskDifference",
    header: "风险差",
    align: "right",
    cell: (row) => <VcrNumber value={row.riskDifference} label={`${row.label}，风险差`} className="font-semibold" />,
  },
  {
    key: "riskRatio",
    header: "风险比",
    align: "right",
    cell: (row) => (row.riskRatio ? <VcrNumber value={row.riskRatio} label={`${row.label}，风险比`} /> : NO_VALUE),
  },
];

/**
 * The target-trial emulation of a comparison: the question and the server's sentence first, then one table of the effects of each
 * estimand (the risk difference is the headline column), the sentence that says which estimand and which horizon each row answers, the
 * checks the server made, the naive number set apart and muted, and how the weights and the interval were made. Every number and every
 * word is the server's; nothing is drawn for a result that is not an emulation.
 */
export function VcrTargetTrial({ card }: { card: VcrTargetTrialCard | null | undefined }) {
  if (!card) return null;
  return (
    <div data-vcr-target-trial="" className="flex flex-col gap-3">
      <BlockHeading className="text-ui font-semibold text-text">{card.question}</BlockHeading>
      <p data-vcr-target-trial-sentence="" className="text-body text-text">{card.sentence}</p>
      <DataTable
        label="效应的估计"
        columns={columns}
        rows={card.estimands}
        rowKey={(row) => row.kind}
        rowAttrs={(row) => ({ "data-vcr-target-trial-estimand": row.kind })}
        ground="surface"
      />
      {card.estimands.map((row) => row.answers && (
        <p key={row.kind} data-vcr-target-trial-answers={row.kind} className="text-caption text-text-3">{row.answers}</p>
      ))}
      {card.checks.length > 0 && (
        <ul data-vcr-target-trial-checks="" className="flex flex-col gap-1 text-body text-text-2">
          {card.checks.map((check, index) => <li key={index}>{check}</li>)}
        </ul>
      )}
      {card.naive && card.naiveSentence && (
        <p data-vcr-target-trial-naive="" className="text-caption text-text-3">
          {card.naiveSentence}
          {" "}
          <VcrNumber value={card.naive} label="只按是否用过药分组的朴素风险差" className="text-text-3" />
        </p>
      )}
      {card.weights && <p data-vcr-target-trial-weights="" className="text-caption text-text-3">{card.weights}</p>}
      {card.bootstrap && <p data-vcr-target-trial-bootstrap="" className="text-caption text-text-3">{card.bootstrap}</p>}
    </div>
  );
}
