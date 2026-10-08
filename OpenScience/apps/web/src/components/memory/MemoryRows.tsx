import type { ReactNode } from "react";
import { ListRow } from "@/components/ui/ListRow";

/**
 * One row of the memory page, whichever tab and whichever store it comes from
 * (2026-10-07 plan §3.2 item 4): the sentence, a quiet line under it when there
 * is one, what it is for at the end, and a chevron — because every row opens
 * the drawer, and a row that looks like it opens something must open it.
 *
 * Nothing else is on a row: no 「推断」, no hover icons, no menu. 编辑, 忘记 and
 * the rest are in the drawer the row opens, where the researcher can see what
 * they are acting on.
 */
export function MemoryListRow({ title, summary, end, onOpen, highlighted = false, muted = false }: {
  title: string;
  /** A quiet line under the title: a method's one sentence. */
  summary?: string;
  /** What the row is for, at its end: the research tool a practice is used in. */
  end?: ReactNode;
  onOpen: () => void;
  /** Named by an inbox notice: marked, and scrolled into view by its page. */
  highlighted?: boolean;
  muted?: boolean;
}) {
  return (
    <ListRow
      className={highlighted ? "bg-accent-soft" : undefined}
      muted={muted}
      title={<span className="line-clamp-2 max-w-measure">{title}</span>}
      meta={summary ? <span className="line-clamp-2 max-w-measure">{summary}</span> : undefined}
      onOpen={onOpen}
      trailing={end}
    />
  );
}

/** A group's small header over its own list: 「所有研究都会用」, 「偏好」. The groups are spaced by their container. */
export function GroupHeader({ children }: { children: ReactNode }) {
  // Under the page's title directly: the tabs are not headings, so a group's header is the next level down from it.
  return <h2 className="px-2 pb-1 text-caption text-text-3">{children}</h2>;
}
