/** A date as an evidence page prints it, in the reader's own locale; a value that is not a date is shown as written. */
export const evidenceDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/** The same moment as a day alone: what a reader's line says (「更新于 2026/10/7」); the clock is for the folded record. */
export const evidenceDay = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
};
