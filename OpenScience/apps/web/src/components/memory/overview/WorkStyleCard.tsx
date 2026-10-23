import type { WorkStyle } from "./memoryOverviewModel";

/** The three categories of a way of working, in the order they are told, with the fill each is drawn in: blue, then the two greys of the data palette. */
const PARTS = [
  { key: "methods", label: "方法", fill: "bg-accent" },
  { key: "standards", label: "标准与偏好", fill: "bg-text-graphic" },
  { key: "background", label: "背景", fill: "bg-border-control" },
] as const;

/**
 * 工作方式卡: how a person works, in three named categories and nothing else — 方法, 标准与偏好, 背景 — as one stacked bar and the words under
 * it. It is the face of the sharing half of the capsule: the overview shows the card of what the account could hand over, and the page a
 * share arrives on shows the card of what the sender hands over, in the same grammar, so a person who receives a pack sees at once how
 * the other works (build spec A5; the Apple privacy label the 2026-10-12 research cites: say what is in it, in plain words).
 *
 * A category with nothing in it is left out of the bar and of the words, and the bar is not drawn at all for a card that holds nothing.
 * No origin, no confidence and no count of use is in it: a category and how many things it holds.
 */
export function WorkStyleCard({ style, label }: { style: WorkStyle; label: string }) {
  const held = PARTS.filter((part) => style[part.key] > 0);
  const words = held.map((part) => `${part.label} ${style[part.key]}`).join(" · ");
  return (
    <div data-work-style="" data-total={style.total}>
      <div role="img" aria-label={`${label}：${words || "还没有内容"}`} className="flex h-2 w-full overflow-hidden rounded-full bg-surface-2" data-forced-colors="preserve">
        {held.map((part) => <span key={part.key} className={part.fill} style={{ width: `${(style[part.key] / style.total) * 100}%` }} />)}
      </div>
      <ul aria-label={label} className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-2">
        {held.map((part) => (
          <li key={part.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${part.fill}`} />
            <span>{part.label}</span>
            <span className="tabular-nums text-text-3">{style[part.key]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
