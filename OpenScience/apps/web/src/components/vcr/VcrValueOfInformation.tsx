import type { VcrValueOfInformationCard } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { CardBlock, CardHeadline, CardNumber } from "./VcrDesignParts";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { numberText } from "./vcrText";

type InputRow = VcrValueOfInformationCard["inputs"][number];
type OptionRow = VcrValueOfInformationCard["options"][number];
type StudyRow = VcrValueOfInformationCard["studies"][number];
type ThresholdRow = VcrValueOfInformationCard["thresholds"][number];

const share = (value: number | null): string => (value === null ? "—" : `${numberText(value, value >= 10 ? 0 : 1)}%`);

const inputColumns: Array<DataColumn<InputRow>> = [
  { key: "input", header: "输入", rowHeader: true, cell: (row) => row.label },
  { key: "evppi", header: "弄清它的价值（EVPPI）", align: "right", cell: (row) => <CardNumber value={row.evppi} label={`${row.label} 的 EVPPI`} /> },
  { key: "share", header: "占完全信息价值的比例", align: "right", cell: (row) => share(row.share) },
];

const optionColumns: Array<DataColumn<OptionRow>> = [
  { key: "option", header: "选项", rowHeader: true, cell: (row) => (row.chosen ? `${row.label}（现在期望收益最大）` : row.label) },
  { key: "expected", header: "期望收益", align: "right", cell: (row) => <CardNumber value={row.expected} label={`${row.label} 的期望收益`} /> },
];

const studyColumns: Array<DataColumn<StudyRow>> = [
  { key: "study", header: "研究", rowHeader: true, cell: (row) => `${row.label}（观察：${row.observes}）` },
  { key: "evsi", header: "做它的价值（EVSI）", align: "right", cell: (row) => <CardNumber value={row.evsi} label={`${row.label} 的 EVSI`} /> },
  { key: "share", header: "占完全信息价值的比例", align: "right", cell: (row) => share(row.share) },
  { key: "ceiling", header: "把它观察的输入完全弄清的价值", align: "right", isEmpty: (row) => row.ceiling == null, cell: (row) => <CardNumber value={row.ceiling} label={`${row.label} 的上限`} /> },
];

/** An input with no distribution: where the best option changes, never a probability. */
function Threshold({ row }: { row: ThresholdRow }) {
  const { stated, decisions } = row;
  return (
    <div data-vcr-voi-threshold={row.key} className="flex flex-col gap-1">
      <p className="text-ui text-text">
        {`${row.label}只有三个取值，没有概率分布：乐观 ${stated.optimistic ?? "—"} 时选“${decisions.optimistic}”，基线 ${stated.base ?? "—"} 时选“${decisions.base}”，悲观 ${stated.pessimistic ?? "—"} 时选“${decisions.pessimistic}”。`}
      </p>
      {row.flips.length === 0
        ? <p className="text-caption text-text-3">在这三个值之间，最优选择不变。</p>
        : row.flips.map((flip, index) => (
          <p key={index} className="text-ui text-text">
            <span>{`${row.label}的取值在 `}</span>
            <VcrNumber value={flip.value} label={`${row.label}的转折点`} className="font-semibold" />
            <span>{` 附近时，最优选择会在“${flip.from}”和“${flip.to}”之间改变。`}</span>
          </p>
        ))}
    </div>
  );
}

function VoiCard({ card }: { card: VcrValueOfInformationCard }) {
  return (
    <div data-vcr-voi={card.form} data-vcr-voi-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={card.draws != null ? `抽样 ${numberText(card.draws, 0)} 次` : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-voi-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.limited && <p data-vcr-voi-limited="" className="text-ui text-text">{card.limited}</p>}
          {card.lead && <p data-vcr-voi-lead="" className="text-ui text-text">{card.lead}</p>}
          <CardHeadline lines={card.headline} />

          <CardBlock title="各个输入值多少">
            <DataTable
              label={`${card.title}：各个输入的信息价值`}
              columns={inputColumns}
              rows={card.inputs}
              rowKey={(row) => row.key}
              rowAttrs={(row) => ({ "data-vcr-voi-input": row.key })}
              footnote="按价值从大到小排；价值与份额都是模拟估计，份额可能因估计误差略超过 100%。没有概率分布的输入不在这张表里。"
              ground="surface"
            />
          </CardBlock>

          {card.thresholds.length > 0 && (
            <CardBlock title="没有概率分布的输入：什么时候会改变选择">
              {card.thresholds.map((row) => <Threshold key={row.key} row={row} />)}
            </CardBlock>
          )}

          {card.studies.length > 0 && (
            <CardBlock title="一项研究值多少">
              <DataTable
                label={`${card.title}：研究的信息价值`}
                columns={studyColumns}
                rows={card.studies}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ "data-vcr-voi-study": row.key })}
                footnote="研究的价值不会超过把它观察的那个输入完全弄清的价值；这里没有假设研究的成本。"
                ground="surface"
              />
            </CardBlock>
          )}

          <CardBlock title="现在各选项的期望收益">
            <DataTable
              label={`${card.title}：各选项的期望收益`}
              columns={optionColumns}
              rows={card.options}
              rowKey={(row) => row.key}
              rowAttrs={(row) => ({ "data-vcr-voi-option": row.key })}
              ground="surface"
            />
          </CardBlock>

          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/**
 * The value-of-information results a conversation computed (which unknown input is worth learning before the decision), each a card of its
 * own: tables only, every number a simulation with its error, and no recommendation beyond naming the top row.
 */
export function VcrValueOfInformation({ cards }: { cards: readonly VcrValueOfInformationCard[] }) {
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => <VoiCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
