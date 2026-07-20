/**
 * Shared display formatting. Page-local copies of these used to drift apart;
 * keep the single implementation here.
 */

/** Byte size as `n B` / `n KB` / `n.n MB`. */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** zh-CN locale date-time; pass Intl options to narrow the rendered fields. */
export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString("zh-CN", options);
}
