/**
 * Shared display formatting. Page-local copies of these used to drift apart;
 * keep the single implementation here.
 */

/**
 * Byte size in base-1024 steps written KB / MB / GB / TB, one decimal below ten
 * units and none above: `512 B`, `1.5 MB`, `12 GB`. The one implementation —
 * three pages kept their own, and one of them said KiB where the others said KB
 * for the same number (2026-09-16 review, U14). Anything that is not a size
 * (null, NaN, negative) is the empty string, for the caller to leave blank.
 */
export function humanSize(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

/** Hour and minute of a timestamp, `14:05`; empty for a value that is not a time. */
export function formatClock(value: string | null | undefined): string {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** zh-CN locale date-time; pass Intl options to narrow the rendered fields. */
export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString("zh-CN", options);
}

/** Last path segment of a workspace folder, or "工作区" when unknown. */
export function baseName(path: string | null): string {
  if (!path) return "工作区";
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "工作区";
}

/**
 * An amount in yuan the way a researcher reads a bill: two decimals, and
 * 「不足 ¥0.01」 below a cent rather than eight decimals of a model call's
 * price (review B: 「实际费用 ¥0.00123456 CNY」). Empty for a value that is
 * not an amount.
 */
export function formatCny(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value > 0 && value < 0.01) return "不足 ¥0.01";
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A duration in at most two units (spec §14.4 rule 5): 45 秒, 2 分 30 秒,
 * 25 分钟, 1 小时 5 分, 3 天, 1 天 5 小时. The larger unit takes the smaller
 * one beside it and nothing below that, so seconds are shown only under an
 * hour and minutes only under a day; the value is rounded to the smaller unit
 * shown. A whole number of the larger unit is written alone — 分钟 when
 * minutes stand by themselves, 分 when seconds follow. Empty for a value that
 * is not a duration.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }
  const hours = Math.round(minutes / 60);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} 天 ${rest} 小时` : `${days} 天`;
}

/**
 * A value as a local calendar date. A bare `YYYY-MM-DD` is a calendar day, not
 * an instant — an autopilot episode is dated in its agenda's own zone — so it
 * is read as written rather than as UTC midnight, which the browser would move
 * to the day before west of Greenwich. `null` for a value that is not a date.
 */
function toDate(value: Date | number | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const calendar = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const date = calendar ? new Date(Number(calendar[1]), Number(calendar[2]) - 1, Number(calendar[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A date in one of the three written forms (spec §14.3):
 *
 *  - `prose` — in a sentence: 「2026年9月26日」
 *  - `iso` — a table, metadata, an export, a search cut-off: 「2026-09-26」
 *  - `short` — within this year, when the year adds nothing: 「9月26日」
 *
 * Never `Intl`'s zh-CN default, which is 「2026/9/26」. Empty for a value that
 * is not a date.
 */
export function formatDate(value: Date | number | string | null | undefined, style: "prose" | "iso" | "short" = "iso"): string {
  const date = toDate(value);
  if (!date) return "";
  const [y, m, d] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  if (style === "prose") return `${y}年${m}月${d}日`;
  if (style === "short") return `${m}月${d}日`;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * A day as a list dates it: 「9月22日」 within this year, 「2025-09-22」 before it
 * (spec §14.4; appendix E #28 — it used to write 「2025年9月22日」, the prose
 * form, in a list). Empty for a value that is not a date.
 */
export function formatDay(value: string | null | undefined, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "";
  return formatDate(date, date.getFullYear() === now.getFullYear() ? "short" : "iso");
}

/**
 * When an event happened, as a list says it (spec §14.4): 「刚刚」 under a
 * minute, 「N 分钟前」 under an hour, 「14:05」 earlier today, 「昨天 14:05」,
 * 「9月14日」 this year, 「2025-09-14」 before. A time in the future (a clock a
 * little ahead of the server's) reads as its clock or its date, never as
 * 「−3 分钟前」. Pair it with a `<time dateTime>` whose title is the absolute
 * time: a relative time is never a record's only time. Empty for a value that
 * is not a time.
 */
export function formatRelativeTime(value: Date | number | string | null | undefined, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "";
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 60_000 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `昨天 ${clock}`;
  return formatDay(formatDate(date, "iso"), now);
}

/** The minus sign a reader sees (U+2212); exports keep ASCII `-` (spec §14.2). */
const MINUS = "−";
/** Between a number and its unit, so the two never break apart (spec §5.5). */
const NBSP = " ";

/**
 * A number with thousands separators and a real minus sign (spec §14.2):
 * 「1,284」「12,345」「−3.2」. `digits` fixes the decimals (a column keeps one
 * count); without it the number keeps up to two. Years, PMIDs, DOIs, pages and
 * ids are not numbers to format — pass them through as text. Empty for a value
 * that is not a finite number.
 */
export function formatNumber(value: number | null | undefined, digits?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const text = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits ?? 0,
    maximumFractionDigits: digits ?? 2,
  });
  // A value that rounds to zero is not negative.
  return value < 0 && /[1-9]/.test(text) ? `${MINUS}${text}` : text;
}

/**
 * An approximate count in an overview (spec §14.2): 「1.2万」「3.4亿」 from ten
 * thousand up, with no space before 万 / 亿, one decimal at most; below that the
 * plain number. Never k, w or 千. An exact count — a sample size, a bill — uses
 * `formatNumber`. Empty for a value that is not a finite number.
 */
export function formatApproxCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  // Rounded to one decimal of 万 first, so 99,999,999 becomes 1亿 rather than
  // 「10,000万」.
  const wan = Math.round(value / 1e3) / 10;
  if (Math.abs(wan) >= 1e4) return `${formatNumber(Math.round(value / 1e7) / 10)}亿`;
  if (Math.abs(value) >= 1e4) return `${formatNumber(wan)}万`;
  return formatNumber(Math.round(value));
}

/**
 * A percentage, already in percent units (spec §14.2): 「12.3%」 — one decimal
 * by default, `%` tight against the number. Empty for a value that is not a
 * finite number.
 */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  const text = formatNumber(value, digits);
  return text ? `${text}%` : "";
}

/**
 * A value with its unit (spec §5.5, §14.5): 「5 mg」「1.3 MB」「37.5 ℃」, joined
 * by a no-break space so the two never land on different lines; tight for
 * 「%」 and 「°」. A dose, a lab value, a temperature. Empty for a value that is
 * not a number.
 */
export function formatDose(value: number | null | undefined, unit: string, digits?: number): string {
  const text = formatNumber(value, digits);
  if (!text) return "";
  return unit === "%" || unit === "°" ? `${text}${unit}` : `${text}${NBSP}${unit}`;
}

/**
 * A range (spec §14.1): 「5～10 mg」 — the full-width tilde, no spaces, the unit
 * written once, after the second value; 「10%～20%」 and 「1万～2万」 carry theirs
 * on both ends. A range with a negative end is written with 「至」:
 * 「−4.1 至 −0.9 mmHg」. Dates and preformatted text pass through:
 * 「2026-09-01～2026-09-26」. Empty when either end is missing.
 */
export function formatRange(
  low: number | string | null | undefined,
  high: number | string | null | undefined,
  options: { unit?: string; digits?: number } = {},
): string {
  const { unit, digits } = options;
  const text = (end: number | string | null | undefined) =>
    typeof end === "number" ? formatNumber(end, digits) : (end ?? "").trim();
  const [a, b] = [text(low), text(high)];
  if (!a || !b) return "";
  const negative = a.startsWith(MINUS) || b.startsWith(MINUS);
  const both = unit === "%" || unit === "万" || unit === "亿";
  const [left, right] = both ? [`${a}${unit}`, `${b}${unit}`] : [a, b];
  const range = negative ? `${left} 至 ${right}` : `${left}～${right}`;
  return unit && !both ? `${range}${NBSP}${unit}` : range;
}

/**
 * A P value (spec §15.4): 「P = 0.03」「P = 0.004」「P < 0.001」「P > 0.99」 —
 * two decimals from 0.01, three below it, and three whenever two would round
 * across 0.05 (「P = 0.046」, not 「P = 0.05」). Never 「P = 0.000」 or
 * 「P = 1.00」. The caller sets the 「P」 in italics. Empty for a value that is
 * not a probability.
 */
export function formatPValue(p: number | null | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return "";
  if (p < 0.001) return "P < 0.001";
  if (p > 0.99) return "P > 0.99";
  if (p < 0.01) return `P = ${p.toFixed(3)}`;
  const two = p.toFixed(2);
  const crosses = (p < 0.05) !== (Number(two) < 0.05);
  return `P = ${crosses ? p.toFixed(3) : two}`;
}

/**
 * An effect with its confidence interval (spec §15.4): 「HR 0.76（95% CI
 * 0.62～0.91）」; a negative end switches the interval to 「至」 and every minus
 * is U+2212 — 「MD −2.5 mmHg（95% CI −4.1 至 −0.9）」. Ratios take two decimals
 * by default. Empty when any of the three numbers is missing.
 */
export function formatConfidenceInterval(
  estimate: number | null | undefined,
  low: number | null | undefined,
  high: number | null | undefined,
  options: { measure?: string; unit?: string; digits?: number; level?: number } = {},
): string {
  const { measure, unit, digits = 2, level = 95 } = options;
  const point = formatNumber(estimate, digits);
  const interval = formatRange(low ?? null, high ?? null, { digits });
  if (!point || !interval) return "";
  const head = [measure, unit ? `${point}${NBSP}${unit}` : point].filter(Boolean).join(" ");
  return `${head}（${level}% CI ${interval}）`;
}
