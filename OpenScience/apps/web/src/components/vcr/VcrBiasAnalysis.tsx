import type { ReactNode } from "react";
import type { VcrBiasAnalysisCard, VcrBiasConfounderCell, VcrValue } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { FactList, type Fact } from "@/components/ui/FactList";
import { BlockHeading } from "@/components/ui/Section";
import { VcrNumber } from "./VcrNumber";
import { NO_VALUE, intervalText, numberText } from "./vcrText";

type ShiftedRow = NonNullable<VcrBiasAnalysisCard["shiftedNull"]>["rows"][number] & { key: string };
type ConfounderRow = NonNullable<VcrBiasAnalysisCard["confounder"]>["rows"][number] & { key: string };

const SUBHEADING = "text-ui font-semibold text-text";
const CAPTION = "text-caption text-text-3";

function Block({ title, part, children }: { title: string; part: string; children: ReactNode }) {
  return (
    <div data-vcr-bias-part={part} className="flex flex-col gap-2">
      {title && <BlockHeading className={SUBHEADING}>{title}</BlockHeading>}
      {children}
    </div>
  );
}

/** A number the server sent, or the dash where the part did not have one. */
const numberOrDash = (value: VcrValue | null, label: string) => (value ? <VcrNumber value={value} label={label} /> : NO_VALUE);

/** The conclusion of a shifted-null row: the server's sentence, else the two words the flag stands for. */
const holdsWords = (row: ShiftedRow): string => row.sentence || (row.holds ? "仍不含无效线" : "已含无效线");

const shiftedColumns: Array<DataColumn<ShiftedRow>> = [
  { key: "bias", header: "假设的偏倚", rowHeader: true, cell: (row) => <span className="tabular-nums">{row.bias}</span> },
  { key: "adjusted", header: "校正后的估计", align: "right", isEmpty: (row) => row.adjusted == null, cell: (row) => numberOrDash(row.adjusted, `${row.bias}的偏倚下，校正后的估计`) },
  {
    key: "interval",
    header: "校正后的区间",
    align: "right",
    isEmpty: (row) => row.lower == null && row.upper == null,
    cell: (row) => (row.lower && row.upper
      ? <span className="tabular-nums"><VcrNumber value={row.lower} label={`${row.bias}的偏倚下，校正后区间的下端`} />{"–"}<VcrNumber value={row.upper} label={`${row.bias}的偏倚下，校正后区间的上端`} /></span>
      : NO_VALUE),
  },
  { key: "p", header: "单侧 P 值", align: "right", isEmpty: (row) => row.p == null, cell: (row) => numberOrDash(row.p, `${row.bias}的偏倚下，单侧 P 值`) },
  { key: "holds", header: "结论", cell: (row) => <span data-vcr-bias-holds={String(row.holds)} className="text-text">{holdsWords(row)}</span> },
];

/** A flipping confounder's side: the server's sentence (which already says when no such confounder can exist), or a dash. */
function cellText(cell: VcrBiasConfounderCell | null) {
  if (!cell) return <span className="text-text-3">{NO_VALUE}</span>;
  return <span data-vcr-bias-feasible={String(cell.feasible)} className={cell.feasible ? "text-text" : "text-text-3"}>{cell.sentence}</span>;
}

const confounderColumns: Array<DataColumn<ConfounderRow>> = [
  { key: "association", header: "与结局的关联", rowHeader: true, cell: (row) => (row.association ? <VcrNumber value={row.association} label="混杂因素与结局的关联" /> : NO_VALUE) },
  { key: "estimate", header: "翻转估计值", isEmpty: (row) => row.estimate == null, cell: (row) => cellText(row.estimate) },
  { key: "limit", header: "翻转区间", isEmpty: (row) => row.limit == null, cell: (row) => cellText(row.limit) },
];

function tippingRows(tipping: VcrBiasAnalysisCard["tipping"]): Fact[] {
  return [
    ...(tipping.limit ? [{ label: "使区间碰到无效线的偏倚", value: <VcrNumber value={tipping.limit} label="使区间碰到无效线的偏倚" /> }] : []),
    ...(tipping.estimate ? [{ label: "使估计值碰到无效线的偏倚", value: <VcrNumber value={tipping.estimate} label="使估计值碰到无效线的偏倚" /> }] : []),
  ];
}

/** The bias that comes out of the simulation alone, with the median beside its range. */
function systematicText(systematic: NonNullable<VcrBiasAnalysisCard["probabilistic"]>["systematic"]) {
  const { lower, upper, median } = systematic;
  if (!lower || !upper) return null;
  return (
    <span className="tabular-nums">
      <VcrNumber value={lower} label="只含偏倚的区间的下端" />{"–"}<VcrNumber value={upper} label="只含偏倚的区间的上端" />
      {median && <span className="text-text-3">{"（中位数 "}<VcrNumber value={median} label="只含偏倚的区间的中位数" />{"）"}</span>}
    </span>
  );
}

function probabilisticRows(part: NonNullable<VcrBiasAnalysisCard["probabilistic"]>): Fact[] {
  const range = intervalText(part.adjusted.interval, part.adjusted.precision);
  const systematic = systematicText(part.systematic);
  return [
    ...(part.stated ? [{ label: "设定的偏倚", value: part.stated }] : []),
    {
      label: "校正后的估计",
      value: (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <VcrNumber value={part.adjusted} label="校正后的估计" />
          {range && <span data-vcr-bias-adjusted-range="" className="text-caption tabular-nums text-text-3">{range}</span>}
        </span>
      ),
    },
    { label: "校正后效应仍在原方向的概率", value: <VcrNumber value={part.persists} label="校正后效应仍在原方向的概率" /> },
    ...(systematic ? [{ label: "只含偏倚的区间", value: systematic }] : []),
    ...(part.draws != null ? [{ label: "模拟次数", value: <span className="tabular-nums">{numberText(part.draws, 0)}</span> }] : []),
  ];
}

/**
 * How much unmeasured bias the conclusion survives, as one card of the comparison: the tipping bias first (it needs no parameter and is
 * always there), then only the parts the call asked for, each opening with its own question. The numbers are the server's; this places
 * them. Every bias on the card is one that exaggerates the effect, and the caption at the foot says which way that pushes.
 */
export function VcrBiasAnalysis({ card }: { card: VcrBiasAnalysisCard | null | undefined }) {
  if (!card) return null;
  const { tipping, shiftedNull, confounder, probabilistic } = card;
  const facts = tippingRows(tipping);
  const shifted: ShiftedRow[] = (shiftedNull?.rows ?? []).map((row, index) => ({ ...row, key: `${index}:${row.bias}` }));
  const confounders: ConfounderRow[] = (confounder?.rows ?? []).map((row, index) => ({ ...row, key: `${index}` }));
  return (
    <div data-vcr-bias-analysis="" className="min-w-0">
      <ChartCard title={card.question}>
        <div className="flex flex-col gap-4">
          {card.estimate && <p data-vcr-bias-estimate="" className="text-ui text-text">{`被分析的估计：${card.estimate}`}</p>}

          <div data-vcr-bias-part="tipping" className="flex flex-col gap-2">
            <p data-vcr-bias-tipping="" className="text-ui text-text">{tipping.sentence}</p>
            {facts.length > 0 && <FactList rows={facts} layout="stacked" />}
          </div>

          {shiftedNull && shifted.length > 0 && (
            <Block title={shiftedNull.question} part="shifted-null">
              <DataTable
                label={`${card.question}：${shiftedNull.question}`}
                columns={shiftedColumns}
                rows={shifted}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ "data-vcr-bias-shifted": row.bias })}
                ground="surface"
              />
              {shiftedNull.note && <p className={CAPTION}>{shiftedNull.note}</p>}
            </Block>
          )}

          {confounder && confounders.length > 0 && (
            <Block title={confounder.question} part="confounder">
              <DataTable
                label={`${card.question}：${confounder.question}`}
                columns={confounderColumns}
                rows={confounders}
                rowKey={(row) => row.key}
                ground="surface"
              />
              {confounder.note && <p className={CAPTION}>{confounder.note}</p>}
            </Block>
          )}

          {probabilistic && (
            <Block title={probabilistic.question} part="probabilistic">
              <FactList rows={probabilisticRows(probabilistic)} layout="stacked" />
              {probabilistic.interrupted && <p data-vcr-bias-interrupted="" className="text-ui text-warn-strong">{probabilistic.interrupted}</p>}
              {probabilistic.note && <p className={CAPTION}>{probabilistic.note}</p>}
            </Block>
          )}

          {card.direction && <p data-vcr-bias-direction="" className={CAPTION}>{card.direction}</p>}
        </div>
      </ChartCard>
    </div>
  );
}
