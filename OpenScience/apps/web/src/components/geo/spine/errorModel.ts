/**
 * What a wrong statement is, said by the claim (R19, audit C §2.3 准确与安全 and A.4 D11).
 *
 * The platform stores an error once for each claim × engine, so a claim told by five engines is five rows; a reader asks "which
 * wrong things are said about us", not "how many rows". The list therefore groups by the claim — the grouping is the domain's
 * (`geoErrorsByClaim`, the function the server's own `byClaim` runs), run here over the rows the page has narrowed so a filter on
 * an engine groups what is left. Everything that names a number here is a count of rows or of claims.
 */
import { geoErrorsByClaim } from "@evimed/domain";
import type { GeoAction, GeoEngine, GeoErrorRow, GeoErrorStatus, GeoErrorType } from "@/lib/geoClient";
import { engineName, zh } from "../geoText";
import { CITED_ATTRIBUTE_WORDS } from "../tabs/geoTabText";
import { isSeverityLevel, type SeverityLevel } from "@/components/ui/SeverityBadge";
import { ERROR_SOURCE_WORDS, type ErrorSourceCounts } from "@/components/charts/ErrorSourceBar";

/** How a wrong sentence was traced to a page: the page the engine cited for it, no page it cited fits, or it cited nothing. */
export type ErrorTrace = "traced" | "unattributable" | "noRetrieval";

export const ERROR_TRACES: readonly ErrorTrace[] = Object.freeze(["traced", "unattributable", "noRetrieval"]);

/** The three, as the page says them (the chart's own words). */
export const ERROR_TRACE_WORDS: Readonly<Record<ErrorTrace, string>> = ERROR_SOURCE_WORDS;

/**
 * The trace of one error. The server writes `citedSource.basis`; a row written before the field has an attribute and a domain
 * only, and is read the way those were written: the attribute `none` was an engine citing nothing, a domain a page it named, and a
 * row with neither is a sentence no cited page was tied to.
 */
export function errorTrace(error: Pick<GeoErrorRow, "citedSource">): ErrorTrace {
  const cited = error.citedSource;
  const basis = cited?.basis ?? null;
  if (basis === "inline_marker") return "traced";
  if (basis === "no_retrieval") return "noRetrieval";
  if (basis === "not_attributable") return "unattributable";
  if (cited?.attribute === "none") return "noRetrieval";
  if (cited?.domain) return "traced";
  return "unattributable";
}

/** The errors counted by how they were traced: the figure of the composition bar. */
export function errorSourceCounts(errors: readonly Pick<GeoErrorRow, "citedSource">[]): ErrorSourceCounts {
  const counts: ErrorSourceCounts = { traced: 0, unattributable: 0, noRetrieval: 0 };
  for (const error of errors) counts[errorTrace(error)] += 1;
  return counts;
}

/* ------------------------------------------------------------------ filters */

/** The status chips of the list: the gravest open ones, everything not yet handled, what is being handled, and all. */
export type ErrorShow = "severe" | "open" | "acting" | "all";
export const ERROR_SHOWS: readonly ErrorShow[] = Object.freeze(["severe", "open", "acting", "all"]);

/** A live error that would reach a patient (S3 or S4). */
export const isSevereError = (error: Pick<GeoErrorRow, "status" | "severity">): boolean =>
  error.status !== "closed" && (error.severity === "S3" || error.severity === "S4");

const SHOW_MATCHES: Readonly<Record<ErrorShow, (error: GeoErrorRow) => boolean>> = {
  severe: isSevereError,
  open: (error) => error.status === "open",
  acting: (error) => error.status === "acting" || error.status === "awaiting_remeasure",
  all: () => true,
};

export interface ErrorFilter {
  show: ErrorShow;
  engine?: string | null;
  type?: GeoErrorType | null;
  trace?: ErrorTrace | null;
  /** The questions of one question group: only the errors told in answers to them. */
  questions?: ReadonlySet<string> | null;
  query?: string;
}

/** The errors a narrowing leaves. */
export function filterErrors(errors: readonly GeoErrorRow[], filter: ErrorFilter): GeoErrorRow[] {
  const needle = (filter.query ?? "").trim().toLowerCase();
  return errors.filter((error) => {
    if (!SHOW_MATCHES[filter.show](error)) return false;
    if (filter.engine && error.engine !== filter.engine) return false;
    if (filter.type && error.errorType !== filter.type) return false;
    if (filter.trace && errorTrace(error) !== filter.trace) return false;
    if (filter.questions && !(error.questionId && filter.questions.has(error.questionId))) return false;
    if (needle && !`${error.statement} ${error.evidenceQuote ?? ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/* -------------------------------------------------------------------- claims */

/** The key a claim is grouped and addressed by: its fingerprint, else the claim it contradicts, else the row itself (`geoErrorsByClaim`'s). */
export const claimKeyOf = (error: Pick<GeoErrorRow, "fingerprint" | "claimId" | "id">): string => error.fingerprint || error.claimId || error.id;

/** One wrong claim, with the engines that tell it and the rows behind it. */
export interface ClaimRow {
  /** The claim's fingerprint (the row's address: `?error=`). */
  key: string;
  statement: string;
  claimId: string | null;
  engines: GeoEngine[];
  /** Rows: engine × claim. */
  count: number;
  severity: SeverityLevel | null;
  /** The most open of its rows. */
  status: GeoErrorStatus;
  urgent: boolean;
  /** The answer the claim was first seen in (the most severe live row's). */
  snapshotId: string | null;
  /** The label's own words the claim contradicts, when the claim is a card's. */
  evidenceQuote: string | null;
  /** The rows, gravest first, live before closed. */
  rows: GeoErrorRow[];
  /** The distinct ways the rows were traced, in `ERROR_TRACES` order. */
  traces: ErrorTrace[];
}

const SEVERITY_ORDER: readonly SeverityLevel[] = ["S0", "S1", "S2", "S3", "S4"];
const severityRank = (severity: string | null | undefined): number => (isSeverityLevel(severity) ? SEVERITY_ORDER.indexOf(severity) : -1);
const STATUS_ORDER: readonly GeoErrorStatus[] = ["open", "acting", "awaiting_remeasure", "closed"];
const statusRank = (status: string): number => {
  const at = STATUS_ORDER.indexOf(status as GeoErrorStatus);
  return at < 0 ? 0 : at;
};

/**
 * The errors grouped by the claim they contradict, live claims before closed ones and the gravest first. A claim lists only the
 * rows it was given: narrow the errors first and its engines are the engines that are left.
 */
export function claimRows(errors: readonly GeoErrorRow[]): ClaimRow[] {
  const byId = new Map(errors.map((error) => [error.id, error]));
  const grouped = geoErrorsByClaim(errors as unknown as Array<Record<string, unknown>>);
  const rows = grouped.map((entry): ClaimRow => {
    const members = (entry.errorIds as string[]).map((id) => byId.get(id)).filter((error): error is GeoErrorRow => Boolean(error))
      .sort((left, right) => (Number(left.status === "closed") - Number(right.status === "closed")) || (severityRank(right.severity) - severityRank(left.severity)));
    const lead = members[0];
    const severity = isSeverityLevel(entry.severity as string | null) ? (entry.severity as SeverityLevel) : null;
    const traces = ERROR_TRACES.filter((trace) => members.some((member) => errorTrace(member) === trace));
    return {
      key: entry.fingerprint as string,
      statement: (entry.statement as string | null) ?? lead?.statement ?? "",
      claimId: (entry.claimId as string | null) ?? null,
      engines: entry.engines as GeoEngine[],
      count: entry.count as number,
      severity,
      status: entry.status as GeoErrorStatus,
      urgent: entry.urgent === true,
      snapshotId: (entry.snapshotId as string | null) ?? null,
      evidenceQuote: members.find((member) => member.evidenceQuote)?.evidenceQuote ?? null,
      rows: members,
      traces,
    };
  });
  return rows.sort((left, right) => (Number(left.status === "closed") - Number(right.status === "closed"))
    || (severityRank(right.severity) - severityRank(left.severity))
    || (statusRank(left.status) - statusRank(right.status))
    || right.count - left.count);
}

/** The claims of one engine alone: the 按引擎 view's section, each claim counted over that engine's rows only. */
export function claimRowsOfEngine(errors: readonly GeoErrorRow[], engine: string): ClaimRow[] {
  return claimRows(errors.filter((error) => error.engine === engine));
}

/** The engines that tell any of these errors, the most first (ties by the order they appear). */
export function enginesOf(errors: readonly GeoErrorRow[]): GeoEngine[] {
  const counts = new Map<GeoEngine, number>();
  for (const error of errors) counts.set(error.engine, (counts.get(error.engine) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([engine]) => engine);
}

/** How the claim's rows were traced, as the row says it: the first page an engine named, how many more, or that none was tied. */
export interface TraceSummary {
  /** The first traced page's site, with the word for what kind of site it is. */
  lead: { domain: string; attribute: string | null } | null;
  /** More traced sites beyond the lead. */
  more: number;
  /** Rows that were not tied to a cited page, and rows whose answer cited nothing. */
  unattributable: number;
  noRetrieval: number;
}

export function traceSummary(claim: Pick<ClaimRow, "rows">): TraceSummary {
  const sites: Array<{ domain: string; attribute: string | null }> = [];
  const seen = new Set<string>();
  let unattributable = 0;
  let noRetrieval = 0;
  for (const row of claim.rows) {
    const trace = errorTrace(row);
    if (trace === "unattributable") unattributable += 1;
    else if (trace === "noRetrieval") noRetrieval += 1;
    else if (row.citedSource?.domain && !seen.has(row.citedSource.domain)) {
      seen.add(row.citedSource.domain);
      sites.push({ domain: row.citedSource.domain, attribute: row.citedSource.attribute ?? null });
    }
  }
  return { lead: sites[0] ?? null, more: Math.max(0, sites.length - 1), unattributable, noRetrieval };
}

/** The trace as one phrase of a row: the first page an engine named (and how many more), else the one fact that there is none. */
export function traceLine(claim: Pick<ClaimRow, "rows">): string | null {
  const trace = traceSummary(claim);
  if (trace.lead) {
    const kind = trace.lead.attribute ? CITED_ATTRIBUTE_WORDS[trace.lead.attribute] ?? null : null;
    return `出处 ${trace.lead.domain}${kind ? `（${kind}）` : ""}${trace.more > 0 ? ` 等 ${trace.more + 1} 处` : ""}`;
  }
  if (trace.unattributable > 0) return "出处没有对应到某一页";
  if (trace.noRetrieval > 0) return "回答没有引用来源";
  return null;
}

/* ------------------------------------------------------------- corrections */

/** The brief a person's 「写纠错稿」 hands to the project's conversation, unsent: who said what, and what the label says instead. */
export function correctionBrief(claim: Pick<ClaimRow, "engines" | "statement" | "evidenceQuote">, product: string): string {
  const engines = claim.engines.map(engineName).join("、");
  return zh`${engines}在回答里说“${claim.statement}”，和${product}的说明书不一致${claim.evidenceQuote ? `（说明书：${claim.evidenceQuote}）` : ""}。写一篇纠错稿，把正确的说法讲清楚。`;
}

/**
 * The actions that correct this claim: those that name any of its rows as an error they close. (A `fill_gap` action of a group
 * already at its target becomes a `correct_error` one, so the kind is not asked: the rows an action names are.) A claim with
 * none has no correction under way — the row's 「写纠错稿」 is how one starts.
 */
export function correctionsOf(claim: Pick<ClaimRow, "rows">, actions: readonly GeoAction[]): GeoAction[] {
  const ids = new Set(claim.rows.map((row) => row.id));
  return actions.filter((action) => action.need.errorIds.some((id) => ids.has(id)));
}
