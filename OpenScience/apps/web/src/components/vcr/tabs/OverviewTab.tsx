import { Link } from "react-router";
import { CircleDashed, Download, History, Sparkles } from "lucide-react";
import type { VcrAttention, VcrStudy } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { StatBand } from "@/components/ui/StatTile";
import { ChartCard } from "@/components/ui/ChartCard";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrTradeoffScatter } from "../VcrDiagrams";
import { ReviewChip, SeriesLegend } from "../VcrMarks";
import { VcrStat, VcrStatNote, VcrWordStat } from "../VcrNumber";
import { VcrHeadline, VcrSection } from "../vcrTabKit";
import { numberText } from "../vcrText";
import { vcrTabPath } from "../vcrTabs";

/**
 * 总览: the one sentence the study came to, the numbers it rests on, how the
 * designs compare, and the three things a reader has to look at.
 *
 * The number band is the page's centre of gravity and every tile in it obeys
 * the module's rule: the value, the source it came from, its named interval,
 * and — where the platform set it rather than a person — the 「AI 设定」 tag,
 * which is a label on a live value and never a gate (plan §10). A route that
 * cannot be estimated is a tile too, with its word where its number would be,
 * because a blank tile reads as an oversight.
 */
export function OverviewTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const { headline, metrics, counts, designs, attention, changes, deliverables } = study.overview;
  const columns = metrics.length >= 6 ? 6 : metrics.length >= 5 ? 5 : 4;
  return (
    <div className="flex flex-col gap-6">
      {headline && <VcrHeadline>{headline}</VcrHeadline>}

      {metrics.length > 0 && (
        <StatBand label="关键数字" columns={columns}>
          {metrics.map((metric) => (
            metric.value.value === null && metric.value.text
              ? (
                <VcrWordStat
                  key={metric.key}
                  label={metric.label}
                  word={metric.value.text}
                  source={metric.value.source}
                  note={metric.note}
                />
              )
              : (
                <VcrStat
                  key={metric.key}
                  label={metric.label}
                  value={metric.value}
                  lead={metric.lead}
                  note={<VcrStatNote value={metric.value} basis={metric.note} />}
                />
              )
          ))}
        </StatBand>
      )}

      <VcrCountsBand counts={counts} />

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        {designs.length > 0 && (
          <ChartCard
            title="方案的成功把握与周期、成本"
            legend={(
              <>
                <SeriesLegend label="本方案" source="predicted" ours />
                <SeriesLegend label="其他方案" source="predicted" tone={1} />
                <span className="inline-flex items-center gap-1.5 text-caption text-text-3">
                  <span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-tag border border-dashed border-border-control" />
                  被占优
                </span>
              </>
            )}
            footnote="气泡面积为成本；被占优的方案不给数。"
          >
            <VcrTradeoffScatter
              designs={designs}
              xKey="duration_months"
              yKey="assurance"
              sizeKey="cost"
              xLabel="末例入组中位（月）"
              yLabel="成功把握"
              sizeLabel="气泡面积 = 成本"
              formatY={(value) => `${numberText(value * (value <= 1 ? 100 : 1), 0)}%`}
            />
          </ChartCard>
        )}

        <AttentionCard items={attention} studyId={studyId} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <VcrSection title="最近的变化">
          {changes.length === 0
            ? <p className="py-6 text-ui text-text-3">还没有变化记录。</p>
            : (
              <ol className="divide-y divide-faint">
                {changes.map((change) => (
                  <li key={change.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                    <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{change.at}</span>
                    <span className="min-w-0 flex-1 text-ui text-text">
                      {change.text}
                      {change.by && <span className="ml-1.5 text-caption text-text-3">{change.by}</span>}
                    </span>
                    {change.state === "stale"
                      ? <Tag>已过期</Tag>
                      : <ReviewChip state={change.state ?? null} />}
                  </li>
                ))}
              </ol>
            )}
        </VcrSection>

        <VcrSection title="交付物">
          {deliverables.length === 0
            ? <p className="py-6 text-ui text-text-3">还没有交付物。</p>
            : (
              <ul className="divide-y divide-faint">
                {deliverables.map((item) => (
                  <li key={item.id} className="relative flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-ui text-text">
                        {/* The package opens in the reader on this page
                            (`?package=`), which is one address rather than a
                            route of its own; the file itself is one click
                            further, inside it. */}
                        <Link
                          to={`${vcrTabPath(studyId, "overview")}?package=${encodeURIComponent(item.id)}`}
                          className="min-w-0 truncate after:absolute after:inset-0 after:rounded after:content-['']"
                        >
                          {item.title}
                        </Link>
                        {item.draft && <Tag>草稿</Tag>}
                      </p>
                      {item.meta && <p className="truncate text-caption tabular-nums text-text-3">{item.meta}</p>}
                    </div>
                    <Download size={16} aria-hidden="true" className="shrink-0 text-text-3" />
                  </li>
                ))}
              </ul>
            )}
        </VcrSection>
      </div>
    </div>
  );
}

const TONE_ICON = {
  attention: Sparkles,
  stale: History,
  neutral: CircleDashed,
} as const;

/**
 * 需要关注: what the reader has to look at, and nothing else. Three lines is
 * the whole of it — a study that lists twelve has stopped pointing at
 * anything.
 */
function AttentionCard({ items, studyId }: { items: readonly VcrAttention[]; studyId: string }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-section font-semibold text-text">需要关注</h2>
        <span className="text-caption tabular-nums text-text-3">{items.length}</span>
      </header>
      {items.length === 0
        ? <p className="py-6 text-ui text-text-3">现在没有需要你处理的事。</p>
        : (
          <ol className="mt-2 divide-y divide-faint">
            {items.map((item, index) => {
              const Icon = TONE_ICON[item.tone ?? "neutral"];
              return (
                <li key={`${item.kind}-${index}`} className="py-3">
                  <div className="flex items-start gap-2">
                    <Icon
                      size={16}
                      aria-hidden="true"
                      className={cn("mt-0.5 shrink-0", item.tone === "attention" ? "text-warn" : "text-text-3")}
                    />
                    <p className="min-w-0 flex-1 text-ui text-text">{item.text}</p>
                    {item.action && (
                      <Link
                        to={vcrTabPath(studyId, item.action.tab ?? item.tab ?? "overview")}
                        className="shrink-0 text-caption text-link hover:underline"
                      >
                        {item.action.label}
                      </Link>
                    )}
                  </div>
                  {item.items && item.items.length > 0 && (
                    <ul className="ml-6 mt-2 flex flex-wrap gap-1.5">
                      {item.items.map((name) => <li key={name}><Tag>{name}</Tag></li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
    </section>
  );
}
