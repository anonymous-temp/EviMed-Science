import type { VcrBorrowingCard, VcrValue } from "@/lib/vcrClient";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { VcrNumber } from "./VcrNumber";
import { NO_VALUE } from "./vcrText";

type PosteriorRow = VcrBorrowingCard["posterior"][number];
type ConflictRow = NonNullable<VcrBorrowingCard["conflict"]>["rows"][number] & { key: string };
type OcRow = NonNullable<VcrBorrowingCard["operatingCharacteristics"]>["rows"][number] & { key: string };

const SUBHEADING = "text-ui font-semibold text-text";

/** A number the server sent, or the dash where the part did not have one. */
const numberOrDash = (value: VcrValue | null, label: string) => (value ? <VcrNumber value={value} label={label} /> : NO_VALUE);

const posteriorColumns: Array<DataColumn<PosteriorRow>> = [
  { key: "label", header: "借用方式", rowHeader: true, cell: (row) => <span data-vcr-borrowing-row={row.which}>{row.label}</span> },
  { key: "mean", header: "对照组后验均值", align: "right", isEmpty: (row) => row.mean == null, cell: (row) => numberOrDash(row.mean, `${row.label}的对照组后验均值`) },
  {
    key: "interval", header: "95% 区间", align: "right", isEmpty: (row) => row.lower == null || row.upper == null,
    cell: (row) => (row.lower && row.upper
      ? <span className="tabular-nums"><VcrNumber value={row.lower} label={`${row.label}的区间下端`} />{"–"}<VcrNumber value={row.upper} label={`${row.label}的区间上端`} /></span>
      : NO_VALUE),
  },
  { key: "better", header: "试验组更好的概率", align: "right", isEmpty: (row) => row.probabilityBetter == null, cell: (row) => numberOrDash(row.probabilityBetter, `${row.label}下，试验组更好的概率`) },
  { key: "weight", header: "借用程度", align: "right", isEmpty: (row) => row.weight == null, cell: (row) => numberOrDash(row.weight, `${row.label}的借用程度`) },
];

const conflictColumns: Array<DataColumn<ConflictRow>> = [
  { key: "difference", header: "当前对照组与历史相比", rowHeader: true, cell: (row) => row.differenceWords },
  { key: "weight", header: "借用程度", align: "right", isEmpty: (row) => row.weight == null, cell: (row) => numberOrDash(row.weight, `${row.differenceWords}时的借用程度`) },
];

const ocColumns: Array<DataColumn<OcRow>> = [
  { key: "drift", header: "对照组真实水平", rowHeader: true, cell: (row) => row.driftWords },
  { key: "t1none", header: "I 类错误（不借用）", align: "right", isEmpty: (row) => row.none.typeOneError == null, cell: (row) => numberOrDash(row.none.typeOneError, `${row.driftWords}，不借用的 I 类错误`) },
  { key: "t1", header: "I 类错误（借用）", align: "right", isEmpty: (row) => row.chosen.typeOneError == null, cell: (row) => numberOrDash(row.chosen.typeOneError, `${row.driftWords}，借用的 I 类错误`) },
  { key: "pownone", header: "功效（不借用）", align: "right", isEmpty: (row) => row.none.power == null, cell: (row) => numberOrDash(row.none.power, `${row.driftWords}，不借用的功效`) },
  { key: "pow", header: "功效（借用）", align: "right", isEmpty: (row) => row.chosen.power == null, cell: (row) => numberOrDash(row.chosen.power, `${row.driftWords}，借用的功效`) },
  { key: "weight", header: "平均借用程度", align: "right", isEmpty: (row) => row.chosen.weight == null, cell: (row) => numberOrDash(row.chosen.weight, `${row.driftWords}，平均借用程度`) },
];

/**
 * An external control arm borrowed into the control: the question of its prior, the control arm's posterior beside no and full borrowing,
 * the table that turns a conflict into a level of borrowing, and the type I error and power as the true control value drifts. The numbers
 * are the server's; this places them. The premises of the conclusion are the comparison's own block, not repeated here.
 */
export function VcrBorrowing({ card }: { card: VcrBorrowingCard | null | undefined }) {
  if (!card) return null;
  return (
    <div data-vcr-borrowing={card.kind} className="flex min-w-0 flex-col gap-4">
      <BlockHeading className={SUBHEADING}>{card.question}</BlockHeading>
      {card.posterior.length > 0 && (
        <DataTable label="借用外部对照后，对照组的估计和结论" columns={posteriorColumns} rows={card.posterior} rowKey={(row) => row.which} />
      )}
      {card.conflict && (
        <div data-vcr-borrowing-part="conflict" className="flex flex-col gap-2">
          <BlockHeading className={SUBHEADING}>{`数据与历史冲突时，借多少（${card.conflict.patients ?? "?"} 例当前对照，差异到 ${card.conflict.delta} 就不借）`}</BlockHeading>
          <DataTable label="冲突与借用程度" columns={conflictColumns} rows={card.conflict.rows.map((row, i) => ({ ...row, key: `c${i}` }))} rowKey={(row) => row.key} />
          {card.conflict.note && <p className="text-caption text-text-3">{card.conflict.note}</p>}
        </div>
      )}
      {card.operatingCharacteristics && (
        <div data-vcr-borrowing-part="operating" className="flex flex-col gap-2">
          <BlockHeading className={SUBHEADING}>{`对照组的真实水平偏离历史时（对照 ${card.operatingCharacteristics.nControl ?? "?"} 例、试验 ${card.operatingCharacteristics.nTreatment ?? "?"} 例）`}</BlockHeading>
          <DataTable label="偏离历史时的 I 类错误和功效" columns={ocColumns} rows={card.operatingCharacteristics.rows.map((row, i) => ({ ...row, key: `o${i}` }))} rowKey={(row) => row.key} />
          {card.operatingCharacteristics.note && <p className="text-caption text-text-3">{card.operatingCharacteristics.note}</p>}
        </div>
      )}
    </div>
  );
}
