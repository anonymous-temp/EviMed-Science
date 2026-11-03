import type { VcrBayesianCard, VcrSimonDesign, VcrValue } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { Tag } from "@/components/ui/Tag";
import { CardBlock, CardHeadline, CardNumber } from "./VcrDesignParts";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { NO_VALUE, numberText } from "./vcrText";

type Look = VcrBayesianCard["looks"][number];
type OperatingRow = NonNullable<VcrBayesianCard["operating"]>["rows"][number];
type StopRow = NonNullable<VcrBayesianCard["operating"]>["stops"][number];
type ThresholdRow = NonNullable<VcrBayesianCard["calibration"]>["rows"][number];
type SimonRow = { key: string; name: string; design: VcrSimonDesign };

const lookName = (look: number) => `第 ${look} 次`;
const sizeText = (size: number | null) => (size == null ? NO_VALUE : `${numberText(size, 0)} 人`);

const lookColumns: Array<DataColumn<Look>> = [
  { key: "look", header: "分析", rowHeader: true, cell: (row) => lookName(row.look) },
  { key: "size", header: "累计人数", align: "right", cell: (row) => sizeText(row.size) },
  { key: "rule", header: "这次分析怎么办", cell: (row) => row.rule || NO_VALUE },
];

/** Under the null row the success probability is the type I error, under the alternative it is the power: the cell says which. */
const successRole = (role: string): string => (role === "null" ? "I 类错误" : role === "alternative" ? "功效" : "");

const operatingColumns: Array<DataColumn<OperatingRow>> = [
  { key: "scenario", header: "真实情况", rowHeader: true, cell: (row) => row.label },
  {
    key: "success",
    header: "判成功的概率",
    align: "right",
    isEmpty: (row) => row.cells.success == null,
    cell: (row) => (
      <span className="inline-flex items-baseline gap-1.5">
        <CardNumber value={row.cells.success} label={`${row.label} 判成功的概率`} />
        {successRole(row.role) && <span className="text-caption text-text-3">{successRole(row.role)}</span>}
      </span>
    ),
  },
  ...([
    ["expected", "期望样本量"],
    ["futility", "中途因无效停止的概率"],
    ["efficacy", "中途提前宣布成功的概率"],
  ] as const).map(([key, header]): DataColumn<OperatingRow> => ({
    key,
    header,
    align: "right",
    isEmpty: (row) => row.cells[key] == null,
    cell: (row) => <CardNumber value={row.cells[key]} label={`${row.label} ${header}`} />,
  })),
];

const stopColumns: Array<DataColumn<StopRow>> = [
  { key: "look", header: "分析", rowHeader: true, cell: (row) => lookName(row.look) },
  { key: "size", header: "累计人数", align: "right", cell: (row) => sizeText(row.size) },
  { key: "nullFutility", header: "无效应时因无效停止的概率", align: "right", cell: (row) => <CardNumber value={row.nullFutility} label={`${lookName(row.look)}分析 无效应时因无效停止的概率`} /> },
  { key: "alternativeFutility", header: "有效应时因无效停止的概率", align: "right", cell: (row) => <CardNumber value={row.alternativeFutility} label={`${lookName(row.look)}分析 有效应时因无效停止的概率`} /> },
];

const simonColumns: Array<DataColumn<SimonRow>> = [
  { key: "name", header: "Simon 设计", rowHeader: true, cell: (row) => row.name },
  { key: "rule", header: "规则", cell: (row) => row.design.rule },
  ...([
    ["typeOneError", "I 类错误"],
    ["power", "功效"],
    ["expectedNull", "无效应时的期望样本量"],
    ["expectedAlt", "有效应时的期望样本量"],
  ] as const).map(([key, header]): DataColumn<SimonRow> => ({
    key,
    header,
    align: "right",
    cell: (row) => <CardNumber value={row.design[key]} label={`${row.name} ${header}`} />,
  })),
];

const thresholdColumns: Array<DataColumn<ThresholdRow>> = [
  { key: "label", header: "阈值", rowHeader: true, cell: (row) => row.label },
  { key: "threshold", header: "成功阈值（后验概率）", align: "right", cell: (row) => <CardNumber value={row.threshold} label={`${row.label} 成功阈值`} /> },
  { key: "typeOneError", header: "I 类错误", align: "right", cell: (row) => <CardNumber value={row.typeOneError} label={`${row.label} I 类错误`} /> },
  { key: "power", header: "功效", align: "right", cell: (row) => <CardNumber value={row.power} label={`${row.label} 功效`} /> },
];

/** What the design saves against Simon's, in one plain sentence: a negative saving is more patients, and is said so. */
function SavingSentence({ saving }: { saving: VcrValue }) {
  if (saving.value == null) return null;
  const amount: VcrValue = { ...saving, value: Math.abs(saving.value), interval: null };
  return (
    <p data-vcr-bayes-saving="" className="text-ui text-text">
      {saving.value === 0
        ? "无效应时，这个设计的期望样本量和 Simon 最优设计相同。"
        : <>无效应时，这个设计的期望样本量比 Simon 最优设计{saving.value > 0 ? "少" : "多"} <VcrNumber value={amount} label="与 Simon 最优设计的期望样本量之差" />。</>}
    </p>
  );
}

function PhaseTwoBody({ card }: { card: VcrBayesianCard }) {
  const simonRows: SimonRow[] = [
    ...(card.simon?.optimal ? [{ key: "optimal", name: "最优设计", design: card.simon.optimal }] : []),
    ...(card.simon?.minimax ? [{ key: "minimax", name: "最小最大设计", design: card.simon.minimax }] : []),
  ];
  const operating = card.operating;
  return (
    <>
      <CardHeadline lines={card.headline} />
      {card.found && <p data-vcr-bayes-found="" className="text-ui text-text">{`得到的设计：${card.found}`}</p>}
      {!card.reachedPower && <p data-vcr-bayes-unreached="" className="text-ui text-text">这个设计的功效没有达到要求的水平。</p>}

      {card.looks.length > 0 && (
        <CardBlock title="各次分析的规则">
          <DataTable label={`${card.title}：各次分析的规则`} columns={lookColumns} rows={card.looks} rowKey={(row) => String(row.look)} rowAttrs={(row) => ({ "data-vcr-bayes-look": String(row.look) })} ground="surface" />
        </CardBlock>
      )}

      {operating && operating.rows.length > 0 && (
        <CardBlock title="无效应与有效应时的运行特征">
          <DataTable label={`${card.title}：无效应与有效应时的运行特征`} columns={operatingColumns} rows={operating.rows} rowKey={(row) => row.role || row.label} rowAttrs={(row) => ({ "data-vcr-bayes-scenario": row.role })} ground="surface" />
        </CardBlock>
      )}

      {operating && operating.stops.length > 0 && (
        <CardBlock title="每次分析因无效而停止的概率">
          <DataTable label={`${card.title}：每次分析因无效而停止的概率`} columns={stopColumns} rows={operating.stops} rowKey={(row) => String(row.look)} rowAttrs={(row) => ({ "data-vcr-bayes-stop": String(row.look) })} ground="surface" />
        </CardBlock>
      )}

      {simonRows.length > 0 && (
        <CardBlock title="与 Simon 两阶段设计相比">
          {card.simon?.saving && <SavingSentence saving={card.simon.saving} />}
          <DataTable label={`${card.title}：与 Simon 两阶段设计相比`} columns={simonColumns} rows={simonRows} rowKey={(row) => row.key} rowAttrs={(row) => ({ "data-vcr-bayes-simon": row.key })} ground="surface" />
        </CardBlock>
      )}
    </>
  );
}

function CalibrationBody({ card }: { card: VcrBayesianCard }) {
  const calibration = card.calibration;
  return (
    <>
      <CardHeadline lines={card.headline} />
      {calibration && (
        <CardBlock title="不同阈值下的 I 类错误与功效">
          <DataTable
            label={`${card.title}：不同阈值下的 I 类错误与功效`}
            columns={thresholdColumns}
            rows={calibration.rows}
            rowKey={(row) => row.kind || row.label}
            rowAttrs={(row) => ({ "data-vcr-bayes-threshold": row.kind })}
            footnote={calibration.note || undefined}
            ground="surface"
          />
        </CardBlock>
      )}
    </>
  );
}

function BayesianCard({ card }: { card: VcrBayesianCard }) {
  const endpoint = card.calibration?.endpoint;
  return (
    <div data-vcr-bayes={card.form} data-vcr-bayes-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={endpoint ? <Tag>{endpoint}</Tag> : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-bayes-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.limited && <p data-vcr-bayes-limited="" className="text-ui text-text">{card.limited}</p>}
          {card.form === "calibration" ? <CalibrationBody card={card} /> : <PhaseTwoBody card={card} />}
          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/**
 * The Bayesian designs without MCMC a conversation computed (the optimal phase II design, predictive-probability monitoring, the
 * calibration of a success threshold), each a card of its own. Every number on them is exact: none is shown with a simulation error.
 */
export function VcrBayesianDesigns({ designs }: { designs: readonly VcrBayesianCard[] }) {
  if (designs.length === 0) return null;
  return (
    <>
      {designs.map((card) => <BayesianCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
