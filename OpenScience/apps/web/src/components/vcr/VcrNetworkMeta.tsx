import type { ReactNode } from "react";
import type { VcrNetworkMetaCard } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, InlineBar, type DataColumn } from "@/components/ui/DataTable";
import { BlockHeading } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { VcrNumber } from "./VcrNumber";
import { VcrPremises } from "./VcrPremises";
import { NO_VALUE, intervalText, numberText, valueText } from "./vcrText";

type RankRow = VcrNetworkMetaCard["ranking"][number] & { key: string };
type LeagueRow = NonNullable<VcrNetworkMetaCard["league"]>["rows"][number] & { key: string };

const SUBHEADING = "text-ui font-semibold text-text";
const NOT_APPLICABLE = <span className="text-text-3">{NO_VALUE}</span>;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <BlockHeading className={SUBHEADING}>{title}</BlockHeading>
      {children}
    </div>
  );
}

const rankColumns: Array<DataColumn<RankRow>> = [
  { key: "rank", header: "排名", width: "w-16", cell: (row) => <span className="tabular-nums text-text-3">{row.rank}</span> },
  {
    key: "treatment",
    header: "治疗",
    rowHeader: true,
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-text">{row.treatment}</span>
        {row.isReference && <Tag>对照</Tag>}
      </span>
    ),
  },
  { key: "studies", header: "研究数", align: "right", isEmpty: (row) => row.studies == null, cell: (row) => (row.studies == null ? NO_VALUE : numberText(row.studies, 0)) },
  {
    key: "score",
    header: "排序得分",
    align: "right",
    isEmpty: (row) => row.score == null,
    cell: (row) => {
      const score = row.score;
      if (!score) return NOT_APPLICABLE;
      return (
        <span className="flex items-center justify-end gap-3">
          <span className="block w-24">
            <InlineBar value={score.value} max={100} tone="rival" label={`${row.treatment} 排序得分 ${valueText(score)}${score.unit ?? ""}`} />
          </span>
          <VcrNumber value={score} label={`${row.treatment}的排序得分`} />
        </span>
      );
    },
  },
];

/**
 * The league table: a column per treatment, each cell the effect of the row's treatment against the column's with its interval under it
 * and the number of studies that compared the two directly. A cell whose interval clears the null line is set apart by its ground and
 * its weight, and says so to a reader who does not see colour. The diagonal is a dash: no treatment is compared with itself.
 */
function leagueColumns(treatments: readonly string[]): Array<DataColumn<LeagueRow>> {
  return [
    { key: "treatment", header: "治疗", rowHeader: true, cell: (row) => <span className="text-text">{row.treatment}</span> },
    ...treatments.map((column, columnIndex): DataColumn<LeagueRow> => ({
      key: `against-${columnIndex}`,
      header: column,
      align: "right",
      cell: (row) => {
        const cell = row.cells[columnIndex] ?? null;
        if (column === row.treatment) return <span data-vcr-league-self="" className="text-text-3">{NO_VALUE}</span>;
        if (!cell) return <span data-vcr-league-missing="" className="text-text-3">{NO_VALUE}</span>;
        const interval = intervalText(cell.value.interval, cell.value.precision);
        return (
          <span
            data-vcr-league-cell=""
            data-vcr-league-excludes={String(cell.excludesNull)}
            className={cn("inline-flex flex-col items-end rounded px-2 py-1", cell.excludesNull && "bg-accent-soft")}
          >
            <VcrNumber value={cell.value} label={`${row.treatment}比${column}`} className={cn("tabular-nums", cell.excludesNull ? "font-semibold" : "font-normal")} />
            {interval && <span className="text-meta font-normal text-text-3">{interval}</span>}
            {cell.directStudies != null && <span className="text-meta font-normal text-text-3">{`直接证据 ${numberText(cell.directStudies, 0)} 项`}</span>}
            {cell.excludesNull && <span className="sr-only">区间不含无效线</span>}
          </span>
        );
      },
    })),
  ];
}

function NetworkMetaCard({ card }: { card: VcrNetworkMetaCard }) {
  const ranking: RankRow[] = card.ranking.map((row) => ({ ...row, key: row.treatment }));
  const league = card.league;
  const leagueRows: LeagueRow[] = (league?.rows ?? []).map((row) => ({ ...row, key: row.treatment }));
  const marksNull = leagueRows.some((row) => row.cells.some((cell) => cell?.excludesNull));
  return (
    <div data-vcr-network-meta={card.id} className="min-w-0">
      <ChartCard title={card.title}>
        <div className="flex flex-col gap-4">
          {card.question && <p data-vcr-evidence-question="" className="text-caption text-text-3">{card.question}</p>}

          <Block title="治疗排名">
            <DataTable
              label={`${card.title}：治疗排名`}
              columns={rankColumns}
              rows={ranking}
              rowKey={(row) => row.key}
              rowAttrs={(row) => ({ "data-vcr-rank": String(row.rank), "data-vcr-treatment": row.treatment })}
              minWidth="min-w-0"
              ground="surface"
            />
            {card.scoreNote && <p data-vcr-network-score-note="" className="text-caption text-text-3">{card.scoreNote}</p>}
          </Block>

          {league && leagueRows.length > 0 && (
            <Block title="两两比较">
              <p data-vcr-league-meaning="" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-3">
                {league.meaning && <span>{league.meaning}</span>}
                {marksNull && (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" data-forced-colors="preserve" className="inline-block h-2.5 w-4 rounded-tag bg-accent-soft" />
                    区间不含无效线
                  </span>
                )}
              </p>
              <DataTable
                label={`${card.title}：两两比较`}
                columns={leagueColumns(league.treatments)}
                rows={leagueRows}
                rowKey={(row) => row.key}
                rowAttrs={(row) => ({ "data-vcr-league-row": row.treatment })}
                ground="surface"
              />
            </Block>
          )}

          {(card.consistency || card.heterogeneity) && (
            <div className="flex flex-col gap-1">
              {card.consistency && <p data-vcr-network-consistency="" className="text-ui text-text">{card.consistency}</p>}
              {card.heterogeneity && <p data-vcr-network-heterogeneity="" className="text-ui text-text">{card.heterogeneity}</p>}
            </div>
          )}

          <VcrPremises premises={card.premises} onChange={null} />
        </div>
      </ChartCard>
    </div>
  );
}

/** The network meta-analyses a conversation computed, each a card of its own: who ranks where, every pair, and whether the evidence agrees. */
export function VcrNetworkMeta({ cards }: { cards: readonly VcrNetworkMetaCard[] }) {
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((card) => <NetworkMetaCard key={`${card.id}@${card.version}`} card={card} />)}
    </>
  );
}
