import { geoCoverageDifference } from "@evimed/domain";
import type { GeoSourceHistoryPoint } from "@/lib/geoClient";
import { coverageNotice, readingChange } from "../geoOverviewModel";
import { monthDay } from "../geoText";

/** One round of a source's history, as a column. */
export interface HistoryColumn {
  roundId: string;
  /** 「9月21日」. */
  label: string;
  cited: number;
  wrongOurs: number;
  /** What the round measured differs from the round before it: the two sides of this column are not compared. */
  breakBefore: boolean;
}

export interface SourceHistoryModel {
  columns: HistoryColumn[];
  /** Whether any column starts a different coverage (the table draws a rule there). */
  broken: boolean;
  /** The latest round against the one before: a comparison where they were measured over the same thing, otherwise the plain statement that they are not compared. */
  sentence: string | null;
}

/** 「持平」「多 2 个」「少 1 个」: a change of a count. */
function countWord(delta: number, flat: boolean): string {
  if (flat) return "持平";
  return `${delta > 0 ? "多" : "少"} ${Math.abs(Math.round(delta))} 个`;
}

/**
 * A source's counts across the last few rounds (R14 N-11), laid out to be read as a small table of rounds — and compared only
 * where the rounds were measured over the same thing (N-4). Citation counts can be compared using the sampling coverage; the
 * source-history response has no per-round judgment policy, so the observed wrong counts remain separate readings without a delta.
 * Null where there is no trend to show: fewer than two rounds, or a site no round cited.
 */
export function sourceHistoryModel(history: ReadonlyArray<GeoSourceHistoryPoint> | null | undefined): SourceHistoryModel | null {
  const rounds = (Array.isArray(history) ? history : []).filter((point) => point && point.roundId);
  if (rounds.length < 2 || rounds.every((point) => point.cited === 0 && point.wrongOurs === 0)) return null;
  const columns = rounds.map((point, index): HistoryColumn => ({
    roundId: point.roundId,
    label: monthDay(point.sampleDate) ?? "—",
    cited: point.cited,
    wrongOurs: point.wrongOurs,
    breakBefore: index > 0 && !geoCoverageDifference(rounds[index - 1].coverage, point.coverage).comparable,
  }));
  const cited = readingChange(rounds.map((point) => ({ date: point.sampleDate ?? undefined, value: point.cited, coverage: point.coverage })));
  const notice = coverageNotice(cited);
  const previous = monthDay(cited.from);
  const citationChange = notice ?? (cited.delta !== null
    ? `较上一轮${previous ? `（${previous}）` : ""}：被引用${countWord(cited.delta, cited.flat)}` : null);
  const sentence = [citationChange, "本视图未提供各轮的判定口径，讲错回答不比较变化"].filter(Boolean).join("。") + "。";
  return { columns, broken: columns.some((column) => column.breakBefore), sentence };
}
