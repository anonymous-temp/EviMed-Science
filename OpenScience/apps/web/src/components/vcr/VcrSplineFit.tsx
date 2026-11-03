import type { VcrSplineFitBlock, VcrValue } from "@/lib/vcrClient";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { NO_VALUE } from "./vcrText";

type CurveRow = VcrSplineFitBlock["curve"][number] & { key: string };
type SpecRow = VcrSplineFitBlock["specifications"][number] & { key: string };

const numberOrDash = (value: VcrValue | null, label: string) => (value ? <VcrNumber value={value} label={label} /> : NO_VALUE);

const curveColumns: Array<DataColumn<CurveRow>> = [
  { key: "time", header: "时间", rowHeader: true, cell: (row) => row.timeWords },
  { key: "survival", header: "生存率（95% 区间）", align: "right", isEmpty: (row) => row.survival == null, cell: (row) => numberOrDash(row.survival, `${row.timeWords}的生存率`) },
  {
    key: "beyond", header: "与数据的关系",
    cell: (row) => <span data-vcr-spline-beyond={String(row.beyondData)} className={row.beyondData ? "text-text" : "text-text-3"}>{row.beyondData ? `超出随访，是最长随访的 ${row.timesLongestFollowUp?.toFixed(2) ?? "?"} 倍（外推）` : "在随访之内"}</span>,
  },
];

const specColumns: Array<DataColumn<SpecRow>> = [
  { key: "knots", header: "内部结点数", rowHeader: true, cell: (row) => <span data-vcr-spline-selected={String(row.selected)}>{`${row.knots}${row.selected ? "（本次所选）" : ""}`}</span> },
  { key: "median", header: "生存中位时间", align: "right", isEmpty: (row) => !row.estimable || row.median == null, cell: (row) => numberOrDash(row.median, `${row.knots} 个结点的生存中位时间`) },
  { key: "survival", header: "最后一个时间点的生存率", align: "right", isEmpty: (row) => !row.estimable || row.survival == null, cell: (row) => numberOrDash(row.survival, `${row.knots} 个结点的最后一个时间点的生存率`) },
];

/**
 * A spline survival fit on the result page: the median and the restricted mean, the survival at each time with how far beyond the longest
 * follow-up it lies, what other numbers of knots give at the same times, and the premises. The numbers are the server's.
 */
export function VcrSplineFit({ block }: { block: VcrSplineFitBlock | null | undefined }) {
  if (!block) return null;
  return (
    <div data-vcr-spline-fit="" className="flex min-w-0 flex-col gap-4">
      <BlockHeading className="text-ui font-semibold text-text">{block.question}</BlockHeading>
      <DataTable label="样条拟合的生存率" columns={curveColumns} rows={block.curve.map((row, i) => ({ ...row, key: `t${i}` }))} rowKey={(row) => row.key} />
      {block.rmst && (
        <p className="text-ui text-text-2">
          {"到 "}{block.rmst.tauWords}{"的限制性平均生存时间（RMST）："}{block.rmst.value ? <VcrNumber value={block.rmst.value} label="限制性平均生存时间" /> : NO_VALUE}
        </p>
      )}
      {block.specifications.some((spec) => spec.estimable) && (
        <>
          <DataTable label="不同结点数的差别" columns={specColumns} rows={block.specifications.map((row, i) => ({ ...row, key: `s${i}` }))} rowKey={(row) => row.key} />
          {block.note && <p className="text-caption text-text-3">{block.note}</p>}
        </>
      )}
      <VcrPremises premises={block.premises} />
    </div>
  );
}
