import type { VcrDoseCard, VcrDoseColumn, VcrValue } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";
import { CardBlock, CardHeadline, CardNumber } from "./VcrDesignParts";
import { VcrPremises } from "./VcrPremises";
import { NO_VALUE, numberText } from "./vcrText";

type DesignRow = NonNullable<VcrDoseCard["table"]>["rows"][number];
type DifferenceRow = NonNullable<VcrDoseCard["differences"]>["rows"][number];
type Scenario = NonNullable<VcrDoseCard["selection"]>["scenarios"][number];
type AllocationRow = { key: string; design: string; metric: string; values: Array<VcrValue | null> };

/** The design that was asked about comes first, whatever order the engine listed them in. */
const askedFirst = (rows: readonly DesignRow[]): DesignRow[] => [...rows.filter((row) => row.role === "asked"), ...rows.filter((row) => row.role !== "asked")];

/** The measures the cards compare, one column each; a measure no row has is not a column. */
function measureColumns<T extends { label: string; cells: Record<string, VcrValue | null> }>(columns: readonly VcrDoseColumn[]): Array<DataColumn<T>> {
  return columns.map((column): DataColumn<T> => ({
    key: column.key,
    header: column.label,
    align: "right",
    isEmpty: (row) => row.cells[column.key] == null,
    cell: (row) => <CardNumber value={row.cells[column.key]} label={`${row.label} ${column.label}`} />,
  }));
}

/** The designs side by side: one row each, the asked one first and named. */
function designColumns(table: NonNullable<VcrDoseCard["table"]>): Array<DataColumn<DesignRow>> {
  return [
    {
      key: "design",
      header: "设计",
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-text">{row.label}</span>
          {row.role === "asked" && table.rows.length > 1 && <span className="text-caption text-text-3">所问的设计</span>}
        </span>
      ),
    },
    ...measureColumns<DesignRow>(table.columns),
  ];
}

/** The doses as columns: the dose, the toxicity it truly carries, and a mark on the one that is the maximum tolerated dose. */
function allocationColumns(card: VcrDoseCard, count: number): Array<DataColumn<AllocationRow>> {
  return [
    { key: "design", header: "设计", rowHeader: true, cell: (row) => row.design },
    { key: "metric", header: "指标", cell: (row) => row.metric },
    ...Array.from({ length: count }, (_, index): DataColumn<AllocationRow> => {
      const entry = card.doses[index];
      return {
        key: `dose-${index + 1}`,
        header: (
          <span className="flex flex-col items-end gap-0.5">
            <span>{`第 ${entry?.dose ?? index + 1} 剂量`}</span>
            {entry && <span className="text-meta text-text-3">{`真实毒性 ${numberText(entry.toxicity)}%`}</span>}
            {entry?.mtd && <Tag tone="accent">最大耐受剂量</Tag>}
          </span>
        ),
        align: "right",
        cell: (row) => <CardNumber value={row.values[index]} label={`${row.design} ${row.metric} 第 ${index + 1} 剂量`} />,
      };
    }),
  ];
}

function FindingBody({ card }: { card: VcrDoseCard }) {
  const rows = askedFirst(card.table?.rows ?? []);
  const doseCount = Math.max(card.doses.length, ...card.perDose.map((row) => Math.max(row.select.length, row.patients.length)));
  // The asked design first, as in the table above; the others keep the engine's order.
  const perDose = [...card.perDose.filter((row) => row.kind === card.design), ...card.perDose.filter((row) => row.kind !== card.design)];
  const allocation: AllocationRow[] = perDose.flatMap((row) => [
    { key: `${row.kind}:select`, design: row.label, metric: "选中的概率", values: row.select },
    { key: `${row.kind}:patients`, design: row.label, metric: "患者数（平均）", values: row.patients },
  ]);
  const differenceColumns: Array<DataColumn<DifferenceRow>> = card.differences
    ? [{ key: "against", header: "对比", rowHeader: true, cell: (row) => row.label }, ...measureColumns<DifferenceRow>(card.differences.columns)]
    : [];
  return (
    <>
      <CardHeadline lines={card.headline} caption={card.askedLabel ? `${card.askedLabel} 的主要结果` : undefined} />

      {card.table && rows.length > 0 && (
        <CardBlock title="各种设计的结果">
          <DataTable
            label={`${card.title}：各种设计的结果`}
            columns={designColumns(card.table)}
            rows={rows}
            rowKey={(row) => `${row.kind}:${row.role}`}
            rowAttrs={(row) => ({ "data-vcr-dose-design": row.kind })}
            ground="surface"
          />
        </CardBlock>
      )}

      {card.differences && (
        <CardBlock title="设计之间的差">
          <DataTable
            label={`${card.title}：设计之间的差`}
            columns={differenceColumns}
            rows={card.differences.rows}
            rowKey={(row) => row.kind}
            rowAttrs={(row) => ({ "data-vcr-dose-difference": row.kind })}
            footnote={card.differences.note}
            ground="surface"
          />
        </CardBlock>
      )}

      {allocation.length > 0 && doseCount > 0 && (
        <CardBlock title="各剂量被选中的概率与给药的患者数">
          <DataTable
            label={`${card.title}：各剂量被选中的概率与给药的患者数`}
            columns={allocationColumns(card, doseCount)}
            rows={allocation}
            rowKey={(row) => row.key}
            rowAttrs={(row) => ({ "data-vcr-dose-allocation": row.key })}
            ground="surface"
          />
        </CardBlock>
      )}
    </>
  );
}

function SelectionBody({ card }: { card: VcrDoseCard }) {
  const selection = card.selection;
  const doseCount = selection ? Math.max(selection.doses, ...selection.scenarios.map((row) => row.select.length)) : 0;
  const columns: Array<DataColumn<Scenario>> = [
    { key: "scenario", header: "情形", rowHeader: true, cell: (row) => row.label },
    { key: "rates", header: "各剂量的真实缓解率", cell: (row) => (row.rates.length > 0 ? row.rates.map((rate) => `${numberText(rate)}%`).join(" / ") : NO_VALUE) },
    { key: "right", header: "选对的剂量", cell: (row) => (row.rightDose == null ? NO_VALUE : `第 ${numberText(row.rightDose, 0)} 剂量`) },
    ...Array.from({ length: doseCount }, (_, index): DataColumn<Scenario> => ({
      key: `select-${index + 1}`,
      header: `选中第 ${index + 1} 剂量的概率`,
      align: "right",
      cell: (row) => <CardNumber value={row.select[index]} label={`${row.label} 选中第 ${index + 1} 剂量的概率`} />,
    })),
    { key: "correct", header: "选对的概率", align: "right", cell: (row) => <CardNumber value={row.correct} label={`${row.label} 选对的概率`} /> },
  ];
  return (
    <>
      <CardHeadline lines={card.headline} />
      {selection && selection.scenarios.length > 0 && (
        <CardBlock title="各情形下的选择结果">
          <DataTable
            label={`${card.title}：各情形下的选择结果`}
            columns={columns}
            rows={selection.scenarios}
            rowKey={(row) => row.label}
            rowAttrs={(row) => ({ "data-vcr-dose-scenario": row.label })}
            footnote={selection.note}
            ground="surface"
          />
        </CardBlock>
      )}
    </>
  );
}

function DoseCard({ card }: { card: VcrDoseCard }) {
  return (
    <div data-vcr-dose={card.form} data-vcr-dose-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={card.trials != null ? `每种设计模拟 ${numberText(card.trials, 0)} 次` : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-dose-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.limited && <p data-vcr-dose-limited="" className="text-ui text-text">{card.limited}</p>}
          {card.form === "dose_selection" ? <SelectionBody card={card} /> : <FindingBody card={card} />}
          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/**
 * The dose-finding results a conversation computed (3+3, BOIN, Keyboard and CRM on one toxicity curve, or the exact choice among
 * randomised doses), each a card of its own: never one of the page's lettered designs, and never a pick.
 */
export function VcrDoseDesigns({ designs }: { designs: readonly VcrDoseCard[] }) {
  if (designs.length === 0) return null;
  return (
    <>
      {designs.map((card) => <DoseCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
