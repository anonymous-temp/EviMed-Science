/**
 * What an action says, in the reader's words (R19, audit C §2.5): the pure half of 行动 — every sentence of a row, the status chips,
 * the grouping under question groups, the order, the filters.
 *
 * **The code computes every number, the model wrote the language.** Nothing here computes a number the server did not send: the
 * counts are `k of n`, a rate is printed only from a reading the server marked `enough`, and a target is the chosen tier's row for
 * the pool, never a run's number (`expected.target`). A group that is a control group has no action; a project-level action has no
 * group and is a block of its own.
 */
import {
  GEO_ACTION_KIND_LABELS_ZH,
  GEO_ACTION_PROMISE_LABELS_ZH,
  GEO_ACTION_STATUS_LABELS_ZH,
  GEO_ARTICLE_CHANNEL_LABELS_ZH,
  GEO_GAP_CLASS_LABELS_ZH,
  geoMetricName,
  geoMetricUnit,
  pythonRound,
} from "@evimed/domain";
import type { GeoAction, GeoActionKind, GeoActionSource, GeoActionStatus, GeoActionsView, GeoArticle } from "@/lib/geoClient";
import { formatGeoValue } from "../GeoCellText";
import {
  engineName,
  GEO_ARTICLE_STALE_NOTE,
  GEO_ARTICLE_STATUS_WORDS,
  GEO_ARTICLE_UNRESOLVED_NOTE,
  GEO_LAYER_NAMES,
  GEO_PLACEMENT_LABEL_WORDS,
  GEO_SOURCE_LAYER_WORDS,
  layerName,
} from "../geoText";
import { sourceKindWord, yuan } from "../tabs/geoTabText";
import { clusterName, readingText } from "./clusterModel";

/* ------------------------------------------------------------------ status */

/** The five words of the page's status chips; every status of the server falls to one of them. */
export type ActionStage = "todo" | "ready" | "live" | "cited" | "skipped";

export const ACTION_STAGES: readonly ActionStage[] = Object.freeze(["todo", "ready", "live", "cited", "skipped"]);

export const ACTION_STAGE_LABELS: Readonly<Record<ActionStage, string>> = Object.freeze({
  todo: "待写",
  ready: "待发",
  live: "已发",
  cited: "被引",
  skipped: "已跳过",
});

/**
 * 待写 (nothing written or being written), 待发 (written, or placed and waiting to be published), 已发 (published; the one that was
 * never cited in eight weeks is 「陈旧」 and is still 已发), 被引 (an engine cited it, or it was verified), 已跳过 (a person's word).
 */
const STAGE_OF: Readonly<Record<GeoActionStatus, ActionStage>> = Object.freeze({
  proposed: "todo",
  writing: "todo",
  ready: "ready",
  placed: "ready",
  live: "live",
  stale: "live",
  cited: "cited",
  verified: "cited",
  skipped: "skipped",
});

export const stageOf = (status: GeoActionStatus): ActionStage => STAGE_OF[status] ?? "todo";

/** The status as a word: 「待写」「在写」「可发布」「已投放」「已发布」「已被引用」「已验证」「陈旧」「已跳过」. */
export const statusWord = (status: GeoActionStatus): string => (GEO_ACTION_STATUS_LABELS_ZH as Readonly<Record<string, string>>)[status] ?? "—";

/** The mark's shape for a status: hollow (nothing done), half (in progress), filled (published), ringed filled (cited), square (stale), dash (set aside). */
export type StatusShape = "hollow" | "half" | "filled" | "cited" | "stale" | "skipped";

const SHAPE_OF: Readonly<Record<GeoActionStatus, StatusShape>> = Object.freeze({
  proposed: "hollow",
  writing: "half",
  ready: "half",
  placed: "half",
  live: "filled",
  cited: "cited",
  verified: "cited",
  stale: "stale",
  skipped: "skipped",
});

export const statusShape = (status: GeoActionStatus): StatusShape => SHAPE_OF[status] ?? "hollow";

/* --------------------------------------------------------------- the words */

export const kindWord = (kind: GeoActionKind): string => GEO_ACTION_KIND_LABELS_ZH[kind] ?? "行动";

/** The gap class as a word (「只讲获益不讲安全」); null for a class the vocabulary does not name — a code is never printed. */
export function gapWord(gapClass: string | null | undefined): string | null {
  return gapClass ? (GEO_GAP_CLASS_LABELS_ZH as Readonly<Record<string, string>>)[gapClass] ?? null : null;
}

/** The first wrong statement an action is about, when it is about errors. */
export function firstErrorStatement(action: GeoAction): string | null {
  for (const entry of action.need.evidence) {
    if (entry.kind === "error" && entry.statement) return entry.statement;
  }
  return null;
}

/**
 * What the action is for, in two parts: the verb of its kind with the gap's own word — 「补上缺口 · 只讲获益不讲安全」,
 * 「纠正讲错」 — and, as a second line, the first thing an answer must say or the wrong statement itself.
 */
export function whatLines(action: GeoAction): { title: string; detail: string | null } {
  const verb = kindWord(action.kind);
  if (action.kind === "correct_error") {
    return { title: verb, detail: firstErrorStatement(action) ?? action.need.judgment ?? action.reason };
  }
  if (action.kind === "fill_gap") {
    const gap = gapWord(action.need.gapClass);
    return { title: gap ? `${verb} · ${gap}` : verb, detail: action.need.expectedPoints[0]?.statement ?? action.need.judgment ?? action.reason };
  }
  if (action.kind === "win_cluster") {
    return { title: verb, detail: action.need.expectedPoints[0]?.statement ?? action.need.judgment ?? "让它进入被提及" };
  }
  return { title: verb, detail: action.need.judgment ?? "已经达到目标" };
}

/** The action as one phrase, for a name and a search: 「纠正讲错：把信尔美说成需要每天注射一次」. */
export function whatToDo(action: GeoAction): string {
  const { title, detail } = whatLines(action);
  return detail ? `${title}：${detail}` : title;
}

/** The second line of 「要做」 in a short form: what an answer must say, else the run's judgment. */
export function whatDetail(action: GeoAction): string | null {
  return whatLines(action).detail;
}

/** The article's kind and the engines it is written for: 「科普稿件」, 「针对 千问、元宝」. */
export function articleLine(action: GeoAction): { kind: string | null; engines: string | null; channel: string | null } {
  const layer = action.what.layer ? GEO_LAYER_NAMES[action.what.layer] ?? null : null;
  const engines = action.engines.length > 0 ? `针对 ${action.engines.map(engineName).join("、")}` : null;
  const channel = action.what.channel ? (GEO_ARTICLE_CHANNEL_LABELS_ZH as Readonly<Record<string, string>>)[action.what.channel] ?? null : null;
  return { kind: layer, engines, channel };
}

/* ---------------------------------------------------------------- articles */

/**
 * What the evidence chain says about an article, beside its kind: how many outlets it went to, the label a paid placement carries,
 * a cited conclusion since corrected, a reference that does not resolve. A notice is a word, never a stop.
 */
export function articleMeta(article: GeoArticle): string {
  return [
    layerName(article.layer) === "—" ? null : layerName(article.layer),
    article.title && article.question && article.question !== article.title ? article.question : null,
    article.placements > 0 ? `投放 ${article.placements} 家` : null,
    article.placementLabel ? GEO_PLACEMENT_LABEL_WORDS[article.placementLabel] ?? null : null,
    (article.staleReferences?.length ?? 0) > 0 ? GEO_ARTICLE_STALE_NOTE : null,
    article.referenceStatus === "unresolved" ? GEO_ARTICLE_UNRESOLVED_NOTE : null,
  ].filter(Boolean).join(" · ");
}

/** 「已发布 · 已被 AI 引用」. */
export function articleStatusLine(article: GeoArticle): string {
  const word = GEO_ARTICLE_STATUS_WORDS[article.status] ?? "—";
  return article.cited ? `${word} · 已被 AI 引用` : word;
}

/* ------------------------------------------------------------------ sources */

/** The conditions a source meets, as one phrase or null where nothing is known (an unchecked condition is never said). */
export function conditionsWord(conditions: GeoActionSource["conditions"] | null | undefined): { met: boolean; text: string } | null {
  const checks: Array<[string, boolean | null | undefined]> = [
    ["备案", conditions?.icp],
    ["新闻源", conditions?.newsIndexed],
    ["医疗", conditions?.medical],
  ];
  const failed = checks.filter(([, value]) => value === false).map(([name]) => name);
  const passed = checks.filter(([, value]) => value === true).map(([name]) => name);
  if (failed.length > 0) return { met: false, text: `${failed.join("、")}不满足` };
  if (passed.length === 3) return { met: true, text: "三项条件满足" };
  if (passed.length > 0) return { met: true, text: `${passed.join("、")}满足` };
  return null;
}

/** The source as a reader names it: its name, else its domain, else the own channel's platform. */
export function sourceName(source: GeoActionSource): string {
  if (source.name) return source.name;
  if (source.domain) return source.domain;
  if (source.channel) return (GEO_ARTICLE_CHANNEL_LABELS_ZH as Readonly<Record<string, string>>)[source.channel] ?? "自有渠道";
  return "—";
}

const ROUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  market: "媒介集市",
  own: "自有渠道，发布后贴链接",
  waiting_market: "等媒介集市接通",
  not_in_market: "媒介集市没有收录",
});

/** Where a source stands for placement: the market's, the brand's own, or waiting for the market. */
export const routeWord = (route: GeoActionSource["route"]): string | null => (route ? ROUTE_WORDS[route] ?? null : null);

/**
 * Why a media source cannot be placed now, in words. The codes are the market's closed list; one the table does not know is not
 * printed (`blacklisted:<rule>` is named by its prefix).
 */
const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  media_unavailable: "这家媒体现在不接单",
  blacklisted: "在黑名单里",
  refuses_medical: "不接医疗稿",
  price_unknown: "还没有报价",
  price_above_auto_cap: "报价超过自动下单的上限",
  domain_unknown: "域名没有核实过",
  domain_unverified: "域名没有核实过",
  impostor: "是冒名站",
  icp_mismatch: "备案主体对不上",
  icp_unchecked: "备案还没核实",
  not_news_indexed: "不是新闻源",
  news_unchecked: "是否新闻源还没核实",
  not_medical: "不是医疗类媒体",
  medical_unchecked: "是否医疗类还没核实",
  domain_cap_reached: "同一个站已经投到上限",
  outlet_unknown_order: "有一单状态还没确认",
  not_in_catalogue: "媒介集市里没有这家媒体",
  avoided_by_plan: "投放计划里排除了它",
});

export function unavailableWords(codes: readonly string[]): string[] {
  const words = codes.map((code) => UNAVAILABLE_WORDS[code.split(":")[0]]).filter((word): word is string => Boolean(word));
  return [...new Set(words)];
}

/** What a source costs, or null where it has no price. */
export const priceWord = (source: GeoActionSource): string | null => (typeof source.price === "number" ? yuan(source.price) : null);

/** The layer and kind of a source, as two grey words. */
export function sourceKinds(source: GeoActionSource): string[] {
  const layer = source.layer ? GEO_SOURCE_LAYER_WORDS[source.layer] : null;
  return [sourceKindWord(source.kind), layer].filter((word): word is string => Boolean(word));
}

/** The source the row names: the person's swap, else what was placed, else the first of the ranked list. */
export function leadSource(action: GeoAction): GeoActionSource | null {
  return action.sources.find((source) => source.chosen !== "recommended") ?? action.sources[0] ?? null;
}

/* ----------------------------------------------------------------- expected */

/**
 * What the action is expected to do, in two lines of counts. The first is where the group stands; the second is the goal and the
 * promise. A rate appears only for a reading the server sent as `enough`; a thin one is `k/n` and 「样本不足」.
 *
 *  - at the pool's target: 「已达池目标 58%」, and what is still to do — the errors to close;
 *  - a reading: 「品牌提及率 3/12」 (thin) or 「基线 20% → 现在 31%」 (enough both times);
 *  - no reading: 「还没有测到」.
 */
export interface ExpectedText {
  /** Where it stands. */
  now: string;
  /** The goal and the promise (the pool's target for the chosen tier, how far the platform says the action can move it). */
  goal: string | null;
  /** The target alone: 「池目标 98%」, for the row that has little room. */
  target: string | null;
  /** The sample's word, when the reading is thin. */
  sample: string | null;
  /** The group is at its pool's target: the action's remaining work is what it closes. */
  reached: boolean;
}

export function expectedText(action: GeoAction): ExpectedText {
  const expected = action.expected;
  const metric = expected.primaryMetricId ? geoMetricName(expected.primaryMetricId) : null;
  const unit = geoMetricUnit(expected.primaryMetricId);
  const target = typeof expected.target === "number" ? formatGeoValue(expected.target, unit) : null;
  const promise = expected.promise ? (GEO_ACTION_PROMISE_LABELS_ZH as Readonly<Record<string, string>>)[expected.promise] ?? null : null;
  const closes = expected.closes.errors > 0 ? `关闭 ${expected.closes.errors} 条严重讲错` : null;
  const from = readingText(expected.from);
  const baseline = readingText(expected.baseline);
  const name = metric ?? "读数";
  if (expected.reached === true) {
    return {
      now: from.rate ? `${name} ${from.rate}，已达池目标${target ? ` ${target}` : ""}` : `${name} ${from.counts}，已达池目标${target ? ` ${target}` : ""}`,
      goal: closes ?? promise,
      target: closes,
      sample: null,
      reached: true,
    };
  }
  const goalParts = [target ? `池目标 ${target}` : null, promise].filter((part): part is string => Boolean(part));
  const goal = goalParts.length > 0 ? goalParts.join(" · ") : closes;
  const targetOnly = target ? `池目标 ${target}` : null;
  if (from.state === "absent") return { now: `${name} 还没有测到`, goal, target: targetOnly, sample: null, reached: false };
  if (from.state === "enough" && from.rate) {
    const start = baseline.state === "enough" && baseline.rate ? `基线 ${baseline.rate} → ` : baseline.state !== "absent" ? `基线 ${baseline.counts} → ` : "";
    return { now: `${name} ${start}现在 ${from.rate}`, goal, target: targetOnly, sample: null, reached: false };
  }
  return { now: `${name} ${from.counts}`, goal, target: targetOnly, sample: from.sample, reached: false };
}

/* ------------------------------------------------------------------- page */

/** One block of the list: a group and its actions, or the project's own (no group). */
export interface ActionBlock {
  /** The group's id; `null` is the block of actions that belong to the project as a whole. */
  groupId: string | null;
  name: string;
  actions: GeoAction[];
}

/**
 * The actions under their question groups, in the order of the run's own ranking: the server hands them ranked (a skipped one
 * last, then the run's rank, then the group's weight), so a group stands where its first action does and its other actions follow
 * it. A group that has only skipped actions therefore comes last, as a skipped action does.
 */
export function actionBlocks(actions: readonly GeoAction[]): ActionBlock[] {
  const blocks = new Map<string, ActionBlock>();
  for (const action of actions) {
    const key = action.group?.id ?? "";
    const block = blocks.get(key) ?? { groupId: action.group?.id ?? null, name: action.group ? clusterName(action.group) : "全项目", actions: [] };
    block.actions.push(action);
    blocks.set(key, block);
  }
  return [...blocks.values()];
}

/** The status chips' counts: how many actions fall to each stage. */
export function stageCounts(actions: readonly GeoAction[]): Record<ActionStage, number> {
  const counts: Record<ActionStage, number> = { todo: 0, ready: 0, live: 0, cited: 0, skipped: 0 };
  for (const action of actions) counts[stageOf(action.status)] += 1;
  return counts;
}

export interface ActionFilter {
  stage: ActionStage | "all";
  kind: GeoActionKind | null;
  /** A question group's id; `-` is the project-level block. */
  cluster: string | null;
  query: string;
}

/** The text a search reads in an action: the group, what to do, the article and the sources it names, the questions asked. */
function haystack(action: GeoAction): string {
  return [
    action.group ? clusterName(action.group) : "全项目",
    whatToDo(action),
    whatDetail(action) ?? "",
    action.what.title ?? "",
    ...action.sources.map(sourceName),
    ...action.questions.map((question) => question.text),
  ].join(" ").toLowerCase();
}

export function filterActions(actions: readonly GeoAction[], filter: ActionFilter): GeoAction[] {
  const needle = filter.query.trim().toLowerCase();
  return actions.filter((action) => {
    if (filter.stage !== "all" && stageOf(action.status) !== filter.stage) return false;
    if (filter.kind && action.kind !== filter.kind) return false;
    if (filter.cluster && (action.group?.id ?? "-") !== filter.cluster) return false;
    return !needle || haystack(action).includes(needle);
  });
}

/* ---------------------------------------------------------------- headline */

/**
 * The page's lead sentence as parts, so a number in it opens what it counts. It is `geoActionSentence` of the domain written as
 * parts — the one rule, drawn with links — and `actionModel.test.ts` holds the two to the same words.
 */
export type HeadlinePart = string | { n: number | string; target: "acted" | "waiting" | "effect" };

export function headlineParts(headline: GeoActionsView["headline"]): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  const arm = headline.arm;
  const band = arm?.noiseBand != null ? `（波动 ±${pythonRound(arm.noiseBand, 1)}）` : "";
  if (headline.actedGroups > 0 && arm) {
    const size = arm.netEffect != null ? pythonRound(Math.abs(arm.netEffect), 1) : null;
    if (!arm.comparable || arm.netEffect == null) parts.push("还不能和对照群比较：测量范围不同或样本不足");
    else if (arm.verdict === "up") parts.push("已行动的问句群比对照多涨 ", { n: size as number, target: "effect" }, ` 个点${band}`);
    else if (arm.verdict === "down") parts.push("已行动的问句群比对照少 ", { n: size as number, target: "effect" }, ` 个点${band}`);
    else parts.push(`已行动的问句群与对照相比没有超出波动${band}`);
  } else if (headline.actedGroups > 0) {
    parts.push({ n: headline.actedGroups, target: "acted" }, " 个问句群已经行动，还没有可比较的对照结果");
  }
  if (headline.gapGroupsNotActedOn > 0) {
    if (parts.length > 0) parts.push("；");
    parts.push("另有 ", { n: headline.gapGroupsNotActedOn, target: "waiting" }, " 个群的缺口还没有行动");
  }
  return parts;
}

/** The parts as the sentence the domain writes (the test's meeting point). */
export const headlineText = (parts: readonly HeadlinePart[]): string => parts.map((part) => (typeof part === "string" ? part : String(part.n))).join("");
