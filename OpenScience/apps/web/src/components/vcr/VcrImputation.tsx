import type { VcrImputationCard } from "@/lib/vcrClient";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { VcrNumber } from "./VcrNumber";
import { NO_VALUE } from "./vcrText";

type Row = VcrImputationCard["rows"][number];
type CovariateRow = VcrImputationCard["covariates"][number];

/** The two words an agreement stands for. */
const AGREEMENT_WORDS = { same: "结论一致", different: "结论不一致" } as const;

const rowColumns: Array<DataColumn<Row>> = [
  { key: "estimate", header: "估计", rowHeader: true, cell: (row) => row.label },
  { key: "imputed", header: "补齐后（合并）", align: "right", cell: (row) => <VcrNumber value={row.imputed} label={`${row.label}，补齐后合并的结果`} /> },
  {
    key: "completeCase",
    header: "只用完整病例",
    align: "right",
    isEmpty: (row) => row.completeCase == null,
    cell: (row) => (row.completeCase ? <VcrNumber value={row.completeCase} label={`${row.label}，只用完整病例的结果`} /> : NO_VALUE),
  },
  {
    key: "agreement",
    header: "两者",
    isEmpty: (row) => row.agreement == null,
    cell: (row) => (row.agreement ? <Tag tone={row.agreement === "different" ? "warn" : "neutral"}>{AGREEMENT_WORDS[row.agreement]}</Tag> : null),
  },
];

const covariateColumns: Array<DataColumn<CovariateRow>> = [
  { key: "name", header: "特征", rowHeader: true, cell: (row) => row.name },
  { key: "missing", header: "缺失", align: "right", cell: (row) => <span className="tabular-nums">{row.missing}</span> },
  { key: "share", header: "占比", align: "right", cell: (row) => <span className="tabular-nums">{row.share}</span> },
  { key: "method", header: "补齐方法", cell: (row) => row.method },
];

/**
 * What filling in the missing covariate values did to the answer: the question and the server's sentence first, then the filled-in
 * (pooled) result beside the complete-case one, then who was dropped from the second and which features had gaps. The premise the
 * filling rests on is an ordinary sentence of the card, not a banner. Every number and every word is the server's; nothing is drawn
 * for a result that did not impute.
 */
export function VcrImputation({ card }: { card: VcrImputationCard | null | undefined }) {
  if (!card) return null;
  return (
    <div data-vcr-imputation="" className="flex flex-col gap-3">
      <BlockHeading className="text-ui font-semibold text-text">{card.question}</BlockHeading>
      <p data-vcr-imputation-sentence="" className="text-body text-text">{card.sentence}</p>
      {card.rows.length > 0 && (
        <DataTable
          label="补齐缺失值前后的结果"
          columns={rowColumns}
          rows={card.rows}
          rowKey={(row) => row.key}
          rowAttrs={(row) => ({ "data-vcr-imputation-row": row.key })}
          ground="surface"
        />
      )}
      {card.completeCase && <p data-vcr-imputation-complete-case="" className="text-body text-text">{card.completeCase.sentence}</p>}
      {card.covariates.length > 0 && (
        <DataTable
          label="有缺失的特征"
          columns={covariateColumns}
          rows={card.covariates}
          rowKey={(row) => row.name}
          rowAttrs={(row) => ({ "data-vcr-imputation-covariate": row.name })}
          ground="surface"
        />
      )}
      {card.assumption && <p data-vcr-imputation-assumption="" className="text-body text-text">{card.assumption}</p>}
      {card.few && <p data-vcr-imputation-few="" className="text-body text-text-2">{card.few}</p>}
      {card.stopped && <p data-vcr-imputation-stopped="" className="text-body text-text-2">{card.stopped}</p>}
      {card.budget && <p data-vcr-imputation-budget="" className="text-caption text-text-3">{card.budget}</p>}
      {card.note && <p data-vcr-imputation-note="" className="text-caption text-text-3">{card.note}</p>}
    </div>
  );
}
