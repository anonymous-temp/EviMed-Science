import type { VcrPrognosticModelCard } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { CardBlock, CardHeadline, CardNumber } from "./VcrDesignParts";
import { VcrPremises } from "./VcrPremises";
import { numberText } from "./vcrText";

type SavingRow = NonNullable<VcrPrognosticModelCard["savings"]>["rows"][number];

/** The sample-size saving under each discount, at the correlation measured out of fold and at the lower end of its interval. */
function savingColumns(): Array<DataColumn<SavingRow>> {
  return [
    { key: "lambda", header: "相关系数打几折", rowHeader: true, cell: (row) => numberText(row.lambda, 2) },
    { key: "gamma", header: "对照组标准差放大几倍", align: "right", cell: (row) => numberText(row.gamma, 2) },
    { key: "estimate", header: "按留出折上估计的相关，可节省", align: "right", isEmpty: (row) => row.estimate == null, cell: (row) => <CardNumber value={row.estimate?.saving} label="按估计的相关可节省的样本量" /> },
    { key: "lower", header: "按相关的置信下限，可节省", align: "right", isEmpty: (row) => row.lower == null, cell: (row) => <CardNumber value={row.lower?.saving} label="按相关下限可节省的样本量" /> },
  ];
}

function PrognosticCard({ card }: { card: VcrPrognosticModelCard }) {
  if (card.form === "refused") {
    return (
      <div data-vcr-prognostic={card.form} data-vcr-prognostic-result={card.id} className="min-w-0">
        <ChartCard title={card.title}>
          <p data-vcr-prognostic-refusal="" className="text-ui text-text">{card.refusal}</p>
        </ChartCard>
      </div>
    );
  }
  const trained = card.trainedOn;
  return (
    <div data-vcr-prognostic={card.form} data-vcr-prognostic-result={card.id} className="min-w-0">
      <ChartCard title={card.title} meta={trained?.folds != null ? `${numberText(trained.folds, 0)} 折交叉拟合` : undefined}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-prognostic-question="" className="text-caption text-text-3">{card.question}</p>}
          {card.label && <p data-vcr-prognostic-label="" className="text-ui font-semibold text-text">{card.label}</p>}
          {card.limited && <p data-vcr-prognostic-limited="" className="text-ui text-text">{card.limited}</p>}
          <CardHeadline lines={card.headline} caption="下面的数字都是留出折上的：每个人的预测来自没见过他的模型。" />
          {card.correlationNote && <p data-vcr-prognostic-correlation="" className="text-caption text-text-3">{`相关系数：${card.correlationNote}。`}</p>}

          {card.savings && (
            <CardBlock title="用它做协变量调整，样本量能省多少">
              <DataTable
                label={`${card.title}：样本量节省`}
                columns={savingColumns()}
                rows={card.savings.rows}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ "data-vcr-prognostic-discount": row.key })}
                footnote="节省的是所需总人数的比例，用的是协变量调整的样本量公式；相关系数打折，是因为它在新人群里常常比在训练人群里低。"
                ground="surface"
              />
            </CardBlock>
          )}

          {card.comparison && (
            <CardBlock title="随机森林作对照">
              <p data-vcr-prognostic-forest="" className="text-ui text-text">
                {`${card.comparison.label}：`}<CardNumber value={card.comparison.value} label={card.comparison.label} />
                {"，比回归多出 "}<CardNumber value={card.comparison.difference} label="随机森林比回归多出的区分度" />
                {"。保存和应用的是回归方程，森林只用来看有没有被漏掉的非线性。"}
              </p>
            </CardBlock>
          )}

          {card.terms.length > 0 && (
            <CardBlock title="方程里各项的作用">
              <DataTable
                label={`${card.title}：方程各项`}
                columns={[
                  { key: "term", header: "预测因子", rowHeader: true, cell: (row) => `${row.label}${row.unit ? `（${row.unit}）` : ""}` },
                  { key: "effect", header: card.effectWords ?? "作用", align: "right", cell: (row) => <CardNumber value={row.effect} label={row.label} /> },
                ]}
                rows={card.terms}
                rowKey={(row) => row.label}
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
 * The prognostic models a conversation trained on the person's own table, each a card of its own: the out-of-fold discrimination and calibration, the
 * correlation, the table of sample-size savings under the discounts, the equation. Never called validated, and never a pick.
 */
export function VcrPrognosticModels({ cards }: { cards: readonly VcrPrognosticModelCard[] }) {
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => <PrognosticCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
