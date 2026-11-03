import type { VcrWinRatioCard } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { CardBlock, CardHeadline, CardNumber } from "./VcrDesignParts";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { intervalLevelText, numberText, rangeText } from "./vcrText";

type LevelRow = NonNullable<VcrWinRatioCard["table"]>["rows"][number];

/** The levels as rows, each cell a number or a dash: wins and losses are shares of all pairs, and the last column is what is still tied. */
function levelColumns(table: NonNullable<VcrWinRatioCard["table"]>): Array<DataColumn<LevelRow>> {
  return [
    { key: "level", header: "比较的层次", rowHeader: true, cell: (row) => row.label },
    ...table.columns.map((column): DataColumn<LevelRow> => ({
      key: column.key,
      header: column.label,
      align: "right",
      isEmpty: (row) => row.cells[column.key] == null,
      cell: (row) => <CardNumber value={row.cells[column.key]} label={`${row.label} ${column.label}`} />,
    })),
  ];
}

/** How many people per arm, for how much power; the power at that size is a simulation, and is said so. */
function SizeLead({ card }: { card: VcrWinRatioCard }) {
  const size = card.size;
  if (!size) return null;
  const perArmLine = card.headline.find((line) => line.key === "required_per_arm");
  return (
    <p data-vcr-winratio-size="" className="text-ui text-text">
      <span>每组 </span>
      <VcrNumber value={perArmLine?.value} label="每组所需患者数" className="font-semibold">{`${numberText(size.perArm, 0)} 人`}</VcrNumber>
      <span>{`，共 ${numberText(size.total, 0)} 人${size.powerWanted == null ? "" : `；要有 ${numberText(size.powerWanted)}% 的把握判出有效`}。`}</span>
      {size.verified && <span>这个人数下的功效是模拟得到的，不是用公式算出的，所以带模拟误差。</span>}
    </p>
  );
}

/** The ratio's own range, worded apart from its simulation error: the range is what one trial of this size shows, the error is the simulation's. */
function RatioRange({ card }: { card: VcrWinRatioCard }) {
  const interval = card.headline.find((line) => line.key === "win_ratio")?.value.interval;
  if (!interval || interval.kind !== "prediction") return null;
  const range = rangeText(interval.low, interval.high, card.headline.find((line) => line.key === "win_ratio")?.value.precision);
  if (!range) return null;
  return (
    <p data-vcr-winratio-range="" className="text-caption text-text">
      {`换一次同样大小的试验，胜率比大致落在 ${range} 之间（${intervalLevelText(interval.level)}预测区间）；数字后面的“±”是模拟本身的误差，不是这个范围。`}
    </p>
  );
}

function WinRatioCard({ card }: { card: VcrWinRatioCard }) {
  const lines = card.size ? card.headline.filter((line) => line.key !== "required_per_arm") : card.headline;
  const { treat, control } = card.arms;
  return (
    <div data-vcr-winratio={card.form} data-vcr-winratio-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={card.trials != null ? `模拟 ${numberText(card.trials, 0)} 次` : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-winratio-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.limited && <p data-vcr-winratio-limited="" className="text-ui text-text">{card.limited}</p>}
          {!card.size && treat != null && control != null && (
            <p data-vcr-winratio-arms="" className="text-ui text-text">{`试验组 ${numberText(treat, 0)} 人，对照组 ${numberText(control, 0)} 人。`}</p>
          )}
          <SizeLead card={card} />
          <div className="flex flex-col gap-2">
            <CardHeadline lines={lines} />
            <RatioRange card={card} />
          </div>

          {card.table && (
            <CardBlock title="各层分出胜负的情况">
              <DataTable
                label={`${card.title}：各层分出胜负的情况`}
                columns={levelColumns(card.table)}
                rows={card.table.rows}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ "data-vcr-winratio-level": row.key })}
                footnote="占比都是占全部对数的比例；每一层只比较上一层没分出胜负的对。"
                ground="surface"
              />
            </CardBlock>
          )}

          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/**
 * The win-ratio results a conversation computed (a composite of death, the number of events and a score, compared pair by pair), each
 * a card of its own: never one of the page's lettered designs, and never a pick. Tables only; every number is a simulation and carries
 * its error.
 */
export function VcrWinRatioDesigns({ designs }: { designs: readonly VcrWinRatioCard[] }) {
  if (designs.length === 0) return null;
  return (
    <>
      {designs.map((card) => <WinRatioCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
