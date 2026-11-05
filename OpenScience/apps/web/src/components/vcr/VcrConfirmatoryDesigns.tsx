import type { ReactNode } from "react";
import type { VcrConfirmatoryCard, VcrConfirmatoryLook } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { NO_VALUE, numberText } from "./vcrText";

type EffectRow = NonNullable<VcrConfirmatoryCard["table"]>["rows"][number] & { key: string };

const SUBHEADING = "text-ui font-semibold text-text";
const NOT_APPLICABLE = <span className="text-text-3">{NO_VALUE}</span>;

/** Whether the card counts people or events: the unit a look's size is in is the one its own columns and headline are in. */
const countsEvents = (card: VcrConfirmatoryCard): boolean =>
  card.unit === "events" || Boolean(card.table?.columns.some((column) => column.key.includes("events")) || card.headline.some((line) => line.key.includes("events")));

/** The per-effect table: one row per assumed true effect, one column per measure, grouped under who it belongs to. */
function effectColumns(table: NonNullable<VcrConfirmatoryCard["table"]>): Array<DataColumn<EffectRow>> {
  return [
    {
      key: "effect",
      header: "假设的真实效应",
      rowHeader: true,
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-text">{row.label}</span>
          {row.effect && <span className="text-caption text-text-3">{row.effect}</span>}
          {row.iterations != null && <span data-vcr-confirmatory-iterations="" className="text-meta text-text-3">{`模拟 ${numberText(row.iterations, 0)} 次`}</span>}
        </span>
      ),
    },
    ...table.columns.map((column): DataColumn<EffectRow> => {
      const header = column.group ? `${column.group} · ${column.label}` : column.label;
      return {
        key: column.key,
        header,
        align: "right",
        // A measure no row has is not a column of this table.
        isEmpty: (row) => row.cells[column.key] == null,
        cell: (row) => {
          const value = row.cells[column.key];
          return value ? <VcrNumber value={value} label={`${row.label} ${header}`} /> : NOT_APPLICABLE;
        },
      };
    }),
  ];
}

const percentOf = (rate: number | null): string => (rate === null ? NO_VALUE : `${numberText(Math.round(rate * 1000) / 10)}%`);

/** The look boundaries of a group-sequential design: when each analysis happens, where it stops the trial, and how likely it is to. */
function lookColumns(events: boolean): Array<DataColumn<VcrConfirmatoryLook>> {
  const stop = (key: "efficacyStop" | "futilityStop" | "nullFutilityStop", header: string): DataColumn<VcrConfirmatoryLook> => ({
    key,
    header,
    align: "right",
    isEmpty: (look) => look[key] == null,
    cell: (look) => (look[key] ? <VcrNumber value={look[key]} label={`第 ${look.look} 次分析 ${header}`} /> : NOT_APPLICABLE),
  });
  return [
    { key: "look", header: "分析", rowHeader: true, cell: (look) => `第 ${look.look} 次` },
    { key: "informationRate", header: "信息比例", align: "right", cell: (look) => percentOf(look.informationRate) },
    { key: "size", header: events ? "事件数" : "样本量", align: "right", cell: (look) => numberText(look.size, 0) },
    { key: "efficacyBound", header: "达标界值（z 值）", align: "right", cell: (look) => numberText(look.efficacyBound, 2) },
    { key: "futilityBound", header: "无效界值（z 值）", align: "right", cell: (look) => numberText(look.futilityBound, 2) },
    stop("efficacyStop", "达标停止的概率（计划的效应）"),
    stop("futilityStop", "无效停止的概率（计划的效应）"),
    stop("nullFutilityStop", "无效停止的概率（无效应）"),
  ];
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <BlockHeading className={SUBHEADING}>{title}</BlockHeading>
      {children}
    </div>
  );
}

function ConfirmatoryCard({ card }: { card: VcrConfirmatoryCard }) {
  const rows: EffectRow[] = (card.table?.rows ?? []).map((row, index) => ({ ...row, key: `${index}:${row.role}` }));
  return (
    <div data-vcr-confirmatory={card.design} data-vcr-confirmatory-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={card.endpoint ? <Tag>{card.endpoint}</Tag> : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-confirmatory-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.limited && <p data-vcr-confirmatory-limited="" className="text-ui text-text">{card.limited}</p>}

          {card.headline.length > 0 && (
            <dl data-vcr-confirmatory-headline="" className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {card.headline.map((line) => (
                <div key={line.key} data-vcr-confirmatory-measure={line.key} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-caption text-text-3">{line.label}</dt>
                  <dd className="text-ui text-text"><VcrNumber value={line.value} label={line.label} /></dd>
                </div>
              ))}
            </dl>
          )}

          {card.table && rows.length > 0 && (
            <Block title="各假设效应下的结果">
              <DataTable
                label={`${card.title}：各假设效应下的结果`}
                columns={effectColumns(card.table)}
                rows={rows}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ "data-vcr-effect": row.role })}
                ground="surface"
              />
            </Block>
          )}

          {card.looks.length > 0 && (
            <Block title="各次分析的界值与停止概率">
              <DataTable
                label={`${card.title}：各次分析的界值与停止概率`}
                columns={lookColumns(countsEvents(card))}
                rows={card.looks}
                rowKey={(look) => String(look.look)}
                rowAttrs={(look) => ({ "data-vcr-look": String(look.look) })}
                ground="surface"
              />
            </Block>
          )}

          {card.baselines.length > 0 && (
            <ul data-vcr-confirmatory-baselines="" className="flex flex-col gap-1">
              {card.baselines.map((line) => (
                <li key={line.key} className="text-caption text-text-3">
                  <span>{line.label}：</span>
                  <span className="tabular-nums text-text-2">{line.text}</span>
                </li>
              ))}
            </ul>
          )}

          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/** The confirmatory designs a conversation wrote, each a card of its own: never one of the page's lettered designs, and never a pick. */
export function VcrConfirmatoryDesigns({ designs }: { designs: readonly VcrConfirmatoryCard[] }) {
  if (designs.length === 0) return null;
  return (
    <>
      {designs.map((card) => <ConfirmatoryCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
