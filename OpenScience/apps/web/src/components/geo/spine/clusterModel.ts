/**
 * What a question group is, said in counts (R19, audit C §2.4 and class 5).
 *
 * The group is the spine of a 循证 GEO project: a person asks "what do the engines say about this group, what are we doing for it,
 * what came of it". About a dozen answers fall to a group in a round — under the platform's own floor of 30 — so everything said of
 * one group here is a **count**, `k of n`, and a percentage exists only where the server sent one (`state: "enough"`). The server
 * leaves the `rate` key out of a thin reading and the type says so; this module never computes one from `k` and `n`, so no layer
 * above it can print a rate the platform withheld.
 */
import { agendaLocalDate, DISPLAY_TIME_ZONE, GEO_MIN_CELL_SAMPLES } from "@evimed/domain";
import type { GeoClusterRow, GeoClusterView, GeoEngine, GeoGroupReading } from "@/lib/geoClient";
import type { EffectMarker, EffectPoint } from "@/components/charts/EffectStrip";
import { GEO_POOL_KINDS, groupName, monthDay } from "../geoText";

/** What one engine's answers to a group's questions did in the latest full round: facts counted, not a metric. */
export interface EngineTally {
  answered: number;
  mentioned: number;
  wrong: number;
}

/** `all` of the answers named us, `some` did, `none` did, or the engine was not asked (`unmeasured`). */
export type EngineStance = "all" | "some" | "none" | "unmeasured";

export function engineStance(tally: EngineTally | null | undefined): EngineStance {
  if (!tally || tally.answered <= 0) return "unmeasured";
  if (tally.mentioned >= tally.answered) return "all";
  return tally.mentioned > 0 ? "some" : "none";
}

/** One engine's tally of a group, `null` where it was not asked. */
export function tallyOf(group: Pick<GeoClusterRow, "byEngine"> | null | undefined, engine: GeoEngine): EngineTally | null {
  const row = group?.byEngine?.[engine];
  if (!row || typeof row.answered !== "number") return null;
  return { answered: row.answered, mentioned: row.mentioned ?? 0, wrong: row.wrong ?? 0 };
}

/** The group's tally over some engines (all of them by default): the sum of the engines' answers. */
export function groupTally(group: Pick<GeoClusterRow, "byEngine"> | null | undefined, engines?: readonly GeoEngine[]): EngineTally {
  const names = engines ?? Object.keys(group?.byEngine ?? {});
  return names.reduce<EngineTally>((sum, engine) => {
    const row = tallyOf(group, engine);
    return row ? { answered: sum.answered + row.answered, mentioned: sum.mentioned + row.mentioned, wrong: sum.wrong + row.wrong } : sum;
  }, { answered: 0, mentioned: 0, wrong: 0 });
}

/** A count as a reader says it: `3/12`. */
export const countText = (k: number, n: number): string => `${k.toLocaleString("zh-CN")}/${n.toLocaleString("zh-CN")}`;

/** The reading of a group, said once: the counts, the rate only where the server sent one, and the word for a thin sample. */
export interface ReadingText {
  state: "enough" | "thin" | "absent";
  /** `3/12`, or `—` where nothing was measured. */
  counts: string;
  /** `31%`; null for every reading under the floor. */
  rate: string | null;
  /** 「样本不足」 where the reading is thin; null otherwise. */
  sample: string | null;
}

export function readingText(reading: GeoGroupReading | null | undefined): ReadingText {
  if (!reading || reading.state === "absent" || reading.k === null || reading.n === null) return { state: "absent", counts: "—", rate: null, sample: null };
  const counts = countText(reading.k, reading.n);
  // `rate` is read only after the narrowing: a thin reading has no such key to read.
  if (reading.state === "enough") return { state: "enough", counts, rate: `${Math.round(reading.rate)}%`, sample: null };
  return { state: "thin", counts, rate: null, sample: "样本不足" };
}

/**
 * How often engines named the product in a group, as the page says it: the group's own mention reading where the platform computed
 * one, else the answers counted over the latest round (the facts the engine cells hold). The rate rides along only with a reading
 * the server sent as `enough`; counted answers carry no rate whatever their number.
 *
 * Given `engines`, the answer is the count over those engines alone (a filter narrows the sum, and the platform's reading — which is
 * over all of them — no longer applies).
 */
export function mentionText(group: Pick<GeoClusterRow, "mention" | "byEngine">, engines?: readonly GeoEngine[]): ReadingText {
  if (engines === undefined && group.mention && group.mention.state !== "absent") return readingText(group.mention);
  const tally = groupTally(group, engines);
  if (tally.answered <= 0) return { state: "absent", counts: "—", rate: null, sample: null };
  const thin = tally.answered < GEO_MIN_CELL_SAMPLES;
  return { state: thin ? "thin" : "enough", counts: countText(tally.mentioned, tally.answered), rate: null, sample: thin ? "样本不足" : null };
}

/** A group's name as a reader reads it (the method's internal number is stripped). */
export const clusterName = (group: Pick<GeoClusterRow, "name"> | { name: string | null | undefined }): string => groupName(group.name) || "未命名问题群";

/**
 * 存量 · 认知与选药: the pool's reader name and the stage the group belongs to. One vocabulary for the pools (the audit's class
 * 4.6): 存量 · 增量 · 泛增量 · 风险监测 — the second set of names (品牌明确类 …) is nowhere on a page, not even as a tooltip.
 */
export function clusterContext(group: Pick<GeoClusterRow, "pool" | "journeyStage">): string {
  return [group.pool ? GEO_POOL_KINDS[group.pool] : null, group.journeyStage].filter(Boolean).join(" · ");
}

/** The stage a group stands in the journey: its number where the run wrote one, else the free-text stage. */
export interface StageKey {
  /** The sort key: the number, or past every numbered stage. */
  no: number | null;
  /** The stage as a reader names it. */
  name: string;
}

export function stageOf(group: Pick<GeoClusterRow, "journeyStageNo" | "journeyStage">): StageKey {
  const name = group.journeyStage?.trim() || "未标阶段";
  return { no: typeof group.journeyStageNo === "number" ? group.journeyStageNo : null, name };
}

/**
 * The groups under their journey stages, in the journey's order. A stage is its number where groups carry one (the name of the
 * first group's stage text stands for it); groups without a number are grouped by the text, after the numbered ones, in the order
 * they come — except a group whose stage text is the name of a numbered stage, which stands in that stage: the run numbered some
 * of the groups of a stage and wrote the words alone on the rest, and one stage is not two cards. A group with no stage at all is
 * in 「未标阶段」, last.
 */
export function groupsByStage<T extends Pick<GeoClusterRow, "journeyStageNo" | "journeyStage">>(groups: readonly T[]): Array<{ key: string; name: string; no: number | null; groups: T[] }> {
  const numbered = new Map<string, number>();
  for (const group of groups) {
    const stage = stageOf(group);
    if (stage.no !== null && !numbered.has(stage.name)) numbered.set(stage.name, stage.no);
  }
  const stages = new Map<string, { key: string; name: string; no: number | null; groups: T[] }>();
  for (const group of groups) {
    const stage = stageOf(group);
    const no = stage.no ?? numbered.get(stage.name) ?? null;
    const key = no !== null ? `no:${no}` : `name:${stage.name}`;
    const found = stages.get(key);
    if (found) found.groups.push(group);
    else stages.set(key, { key, name: stage.name, no, groups: [group] });
  }
  const unnamed = "未标阶段";
  return [...stages.values()].sort((left, right) => {
    if (left.no !== null && right.no !== null) return left.no - right.no;
    if (left.no !== null) return -1;
    if (right.no !== null) return 1;
    if (left.name === unnamed) return 1;
    if (right.name === unnamed) return -1;
    return 0;
  });
}

/** The group a question is in, from the questions read: what turns an error's `questionId` into a cluster to link to. */
export function questionGroupIndex(groups: ReadonlyArray<{ id: string; name: string; isControl?: boolean; questions?: ReadonlyArray<{ id: string }> | null }> | null | undefined): Map<string, { id: string; name: string; isControl: boolean }> {
  const index = new Map<string, { id: string; name: string; isControl: boolean }>();
  for (const group of groups ?? []) {
    for (const question of group.questions ?? []) index.set(question.id, { id: group.id, name: group.name, isControl: group.isControl === true });
  }
  return index;
}

/** The latest answer of one engine to one question of a cluster's view, when there is one. */
export function answerOf(question: GeoClusterView["questions"][number], engine: GeoEngine): GeoClusterView["questions"][number]["answers"][number] | null {
  return question.answers.find((answer) => answer.engine === engine) ?? null;
}

/** What an engine's answer did for us: named us, misstated us, did not name us, or is not there. */
export type AnswerStance = "wrong" | "named" | "silent" | "unmeasured";

export function answerStance(answer: GeoClusterView["questions"][number]["answers"][number] | null | undefined): AnswerStance {
  if (!answer) return "unmeasured";
  if (answer.wrongOurs === true) return "wrong";
  if (answer.mentionsOurs === true) return "named";
  if (answer.mentionsOurs === false) return "silent";
  return "unmeasured";
}

/* ------------------------------------------------------------------ effect */

/** One group's series of the pool's headline metric as the chart's points: a round's day, answers that named us, answers. */
export function effectPoints(series: ReadonlyArray<{ date: string | null; k: number | null; n: number | null }> | null | undefined): EffectPoint[] {
  return (series ?? []).map((point) => ({ label: monthDay(point.date) ?? "", k: point.k, n: point.n }));
}

const EVENT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  article: "稿件写成",
  published: "稿件发布",
  cited: "首次被引用",
  error_seen: "讲错出现",
});

/**
 * What happened to a group, placed on the rounds it fell between: each kind's first event, on the first round measured on or after
 * its day (the series' days are days in the module's zone, an event an instant — compared as the day it fell on there, never as
 * it stands). Two events on one round share its mark.
 */
export function effectMarkers(
  dates: ReadonlyArray<string | null>,
  events: GeoClusterView["effect"]["events"] | null | undefined,
): EffectMarker[] {
  const days = dates.map((date) => (date ? date.slice(0, 10) : null));
  if (days.every((day) => day === null)) return [];
  const byIndex = new Map<number, string[]>();
  const seen = new Set<string>();
  const sorted = [...(events ?? [])].filter((event) => event && event.at && !Number.isNaN(Date.parse(event.at)))
    .sort((left, right) => Date.parse(left.at as string) - Date.parse(right.at as string));
  for (const event of sorted) {
    const word = EVENT_WORDS[event.kind];
    if (!word || seen.has(event.kind)) continue;
    seen.add(event.kind);
    const day = agendaLocalDate(DISPLAY_TIME_ZONE, event.at as string);
    let at = days.findIndex((candidate) => candidate !== null && candidate >= day);
    if (at < 0) at = days.length - 1;
    byIndex.set(at, [...(byIndex.get(at) ?? []), word]);
  }
  return [...byIndex.entries()].sort((left, right) => left[0] - right[0]).map(([index, words]) => ({ index, label: words.join("·") }));
}
