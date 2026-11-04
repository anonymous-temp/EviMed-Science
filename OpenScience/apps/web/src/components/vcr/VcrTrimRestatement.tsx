import type { VcrTrimCard } from "@/lib/vcrClient";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { numberText } from "./vcrText";

type ArmRow = VcrTrimCard["arms"][number];
type CovariateRow = VcrTrimCard["covariates"][number];

/** A head count the engine did not state (a group of one to nine people) is a dash, never a zero. */
const count = (value: number | null) => (value === null ? "—" : numberText(value, 0));

const armColumns: Array<DataColumn<ArmRow>> = [
  { key: "arm", header: "组别", rowHeader: true, cell: (row) => row.arm },
  { key: "n", header: "人数", align: "right", cell: (row) => <span className="tabular-nums">{count(row.n)}</span> },
  { key: "kept", header: "留下", align: "right", cell: (row) => <span className="tabular-nums">{count(row.kept)}</span> },
  { key: "removed", header: "去掉", align: "right", cell: (row) => <span className="tabular-nums">{count(row.removed)}</span> },
  { key: "share", header: "去掉的比例", align: "right", cell: (row) => <span className="tabular-nums">{row.share}</span> },
];

const side = (header: string, pick: (row: CovariateRow) => string): DataColumn<CovariateRow> => ({
  key: header, header, align: "right", cell: (row) => <span className="tabular-nums">{pick(row)}</span>,
});

const covariateColumns: Array<DataColumn<CovariateRow>> = [
  { key: "covariate", header: "特征", rowHeader: true, cell: (row) => row.covariate },
  side("试验组·留下", (row) => row.treated.kept),
  side("试验组·去掉", (row) => row.treated.removed),
  side("对照组·留下", (row) => row.control.kept),
  side("对照组·去掉", (row) => row.control.removed),
];

/**
 * Who the estimate is about after a propensity trimming: the server's sentence first, then how many of each group were removed and what
 * the removed were like beside the kept. The trimmed population is the one the estimate is about, so a reader meets this before the
 * diagnostics. Nothing is drawn for a result that did not trim.
 */
export function VcrTrimRestatement({ trim }: { trim: VcrTrimCard | null | undefined }) {
  if (!trim) return null;
  return (
    <div data-vcr-trim="" className="flex flex-col gap-3">
      <p data-vcr-trim-sentence="" className="text-body text-text">{trim.sentence}</p>
      {trim.arms.length > 0 && (
        <DataTable label="按倾向评分去掉的人数" columns={armColumns} rows={trim.arms} rowKey={(row) => row.arm} rowAttrs={(row) => ({ "data-vcr-trim-arm": row.arm })} ground="surface" />
      )}
      {trim.covariates.length > 0 && (
        <div data-vcr-trim-covariates="" className="flex flex-col gap-2">
          <BlockHeading className="text-ui font-semibold text-text">被去掉的人与留下的人</BlockHeading>
          <DataTable label="被去掉的人与留下的人" columns={covariateColumns} rows={trim.covariates} rowKey={(row) => row.covariate} ground="surface" />
        </div>
      )}
      {trim.trimmed && <p data-vcr-trim-population="" className="text-caption text-text-3">估计针对的是留下的人</p>}
    </div>
  );
}
