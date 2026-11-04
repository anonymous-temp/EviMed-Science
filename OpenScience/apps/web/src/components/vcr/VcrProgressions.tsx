import type { VcrProgressionCard } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";
import { VcrSeriesLegend, VcrTrajectoryChart } from "./VcrCharts";
import { CardBlock, CardNumber } from "./VcrDesignParts";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { numberText } from "./vcrText";

type VisitRow = VcrProgressionCard["table"]["rows"][number];

function visitColumns(timeUnit: string): Array<DataColumn<VisitRow>> {
  return [
    { key: "visit", header: timeUnit ? `时间（${timeUnit}）` : "时间", rowHeader: true, cell: (row) => numberText(row.visit, 0) },
    { key: "control", header: "对照组均值（标准差）", align: "right", cell: (row) => <span><CardNumber value={row.control.mean} label="对照组均值" />{" ("}<CardNumber value={row.control.sd} label="对照组标准差" />{")"}</span> },
    { key: "treated", header: "治疗组均值（标准差）", align: "right", cell: (row) => <span><CardNumber value={row.treated.mean} label="治疗组均值" />{" ("}<CardNumber value={row.treated.sd} label="治疗组标准差" />{")"}</span> },
    { key: "gap", header: "治疗减对照", align: "right", cell: (row) => <CardNumber value={row.gap} label="治疗减对照" /> },
  ];
}

function ProgressionCard({ card }: { card: VcrProgressionCard }) {
  return (
    <div data-vcr-progression="" data-vcr-progression-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={card.trials != null ? `模拟 ${numberText(card.trials, 0)} 次` : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-progression-question="" className="text-caption text-text-3">{card.question}</p>}
          <p data-vcr-progression-label="" className="flex flex-wrap items-center gap-2 text-ui text-text">
            <Tag>{card.label}</Tag>
            {card.reason && <span className="text-caption text-text-3">{card.reason}</span>}
          </p>
          {card.limited && <p data-vcr-progression-limited="" className="text-ui text-text">{card.limited}</p>}

          <div data-vcr-progression-power="" className="flex flex-col gap-1">
            <p className="text-caption text-text-3">{card.powerName}</p>
            <p className="text-ui text-text"><span className="font-semibold"><CardNumber value={card.power} label={card.powerName} /></span>
              {card.approximation && <span className="text-text">{"；同一个检验用公式算出的是 "}<VcrNumber value={card.approximation} label="用公式算出的功效" />{"，模拟应当和它一致。"}</span>}</p>
            {card.expected && <p className="text-caption text-text-3">{`${card.expected.words}：`}<CardNumber value={card.expected.value} label={card.expected.words} /></p>}
          </div>

          <CardBlock title="平均病程">
            <VcrSeriesLegend series={card.series} />
            <VcrTrajectoryChart series={card.series} xLabel={card.timeUnit ? `时间（${card.timeUnit}）` : "时间"} />
            <p className="text-caption text-text">线是各组的平均，带是 95% 的人落在的范围（均值 ± 1.96 个标准差）。</p>
          </CardBlock>

          <CardBlock title="每次随访的平均数与散布">
            <DataTable label={`${card.title}：每次随访`} columns={visitColumns(card.timeUnit)} rows={card.table.rows} rowKey={(row) => row.key} ground="surface" />
          </CardBlock>

          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/**
 * The disease-progression simulations a conversation computed, each a card of its own: the average course of each arm with the spread around it,
 * the power of the stated analysis, and where each number came from. Population level, and says so before anything else.
 */
export function VcrProgressions({ cards }: { cards: readonly VcrProgressionCard[] }) {
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => <ProgressionCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
