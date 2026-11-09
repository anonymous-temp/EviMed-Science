import type { VcrPbpkInteractionCard } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { VcrSeriesLegend, VcrTrajectoryChart } from "./VcrCharts";
import { CardBlock, CardHeadline, CardNumber } from "./VcrDesignParts";
import { VcrPremises } from "./VcrPremises";
import { numberText } from "./vcrText";

type CurveRow = VcrPbpkInteractionCard["table"][number];

function curveColumns(card: VcrPbpkInteractionCard): Array<DataColumn<CurveRow>> {
  return [
    { key: "hour", header: `给药后（小时）`, rowHeader: true, cell: (row) => numberText(row.hour, row.hour < 10 && !Number.isInteger(row.hour) ? 2 : 0) },
    { key: "alone", header: `单用${card.victim}（ng/mL）`, align: "right", cell: (row) => <CardNumber value={row.alone} label={`单用${card.victim}的浓度`} /> },
    { key: "with", header: `${card.perpetrator}合用后（ng/mL）`, align: "right", cell: (row) => <CardNumber value={row.withPerpetrator} label={`合用后${card.victim}的浓度`} /> },
  ];
}

function PbpkCard({ card }: { card: VcrPbpkInteractionCard }) {
  return (
    <div data-vcr-pbpk={card.form} data-vcr-pbpk-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={card.citation ?? undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-pbpk-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.limited && <p data-vcr-pbpk-limited="" className="text-ui text-text">{card.limited}</p>}
          {card.lead && <p data-vcr-pbpk-lead="" className="text-ui text-text">{card.lead}</p>}
          <CardHeadline lines={card.headline} />

          {card.series.length > 0 && (
            <CardBlock title="血药浓度随时间的变化">
              <VcrSeriesLegend series={card.series} />
              <VcrTrajectoryChart series={card.series} xLabel="给药后（小时）" yLabel="ng/mL" />
              <p className="text-caption text-text">线是模型对一个典型健康成人的预测，没有个体差异的范围。</p>
            </CardBlock>
          )}

          {card.table.length > 0 && (
            <CardBlock title="各时间点的浓度">
              <DataTable label={`${card.title}：各时间点的浓度`} columns={curveColumns(card)} rows={card.table} rowKey={(row) => row.key} ground="surface" />
            </CardBlock>
          )}

          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/**
 * The drug-interaction exposure predictions a conversation computed (a drug given after a perpetrator of CYP3A4, on a published PBPK model), each a
 * card of its own: the ratios first, then the curves alone and after, and the premises that say whose values these are.
 */
export function VcrPbpkInteractions({ cards }: { cards: readonly VcrPbpkInteractionCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div data-vcr-pbpk-list="" className="flex flex-col gap-4">
      {cards.map((card) => <PbpkCard key={card.id} card={card} />)}
    </div>
  );
}
