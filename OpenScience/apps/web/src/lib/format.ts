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
 * A duration in the words a list uses: 45 秒 / 12 分钟 / 1 小时 5 分. Empty for
 * a value that is not a duration.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}
