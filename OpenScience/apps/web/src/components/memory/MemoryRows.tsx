import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import type { WebPendingMemory } from "@/lib/apiClient";
import { List, ListRow } from "@/components/ui/ListRow";

/**
 * One row of the memory page, whichever tab and whichever store it comes from
 * (2026-10-07 plan §3.2 item 4): the sentence, a quiet line under it when there
 * is one, what it is for at the end, and a chevron — because every row opens
 * the drawer, and a row that looks like it opens something must open it.
 *
 * Nothing else is on a row: no mark of where it came from, no hover icons, no menu. 编辑, 忘记 and
 * the rest are in the drawer the row opens, where the researcher can see what
 * they are acting on.
 */
export function MemoryListRow({ title, summary, end, onOpen, highlighted = false }: {
  title: string;
  /** A quiet line under the title: a method's one sentence. */
  summary?: string;
  /** What the row is for, at its end: the research tool a practice is used in. */
  end?: ReactNode;
  onOpen: () => void;
  /** Named by an inbox notice: marked, and scrolled into view by its page. */
  highlighted?: boolean;
}) {
  return (
    <ListRow
      className={highlighted ? "bg-accent-soft" : undefined}
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

/**
 * One group of the memory page: its small header and, under it, its body in one block — whatever the body is (a list of rows, a
 * table, the months of the works, one quiet line). The walk reads a section by its tag and its first two kinds of child
 * (DESIGN.md 「页面结构」 rule 1), so a group written as header-and-list in one place and header-and-line in another counted as two
 * kinds of section on one tab; every group is this one shape.
 */
export function GroupSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <GroupHeader>{title}</GroupHeader>
      <div>{children}</div>
    </section>
  );
}

/**
 * What 「记住这一条」 asked and the memory has not written yet: the words, marked 「正在记住」, at the head of the list. A row of
 * its own kind, because there is nothing to open yet; when the memory is slow it says so instead of spinning for ever, and when the page has stopped waiting it says the memory is not finished.
 */
type ResolveForget = (id: string, action: "confirm" | "dismiss", choices: number[]) => Promise<unknown>;

export function PendingMemoryRows({ items, slow, stalled = false, onResolved, onResolve }: { onResolve?: ResolveForget; onResolved?: () => void; items: readonly WebPendingMemory[]; slow: boolean; /** The page has stopped reading: it says the memory is not finished and can be looked at later. */ stalled?: boolean }) {
  return (
    <List label="待处理的记忆">
      {items.map((item) => item.state === "confirmation" ? <ForgetConfirmationRow key={item.id} item={item} onResolved={onResolved} onResolve={onResolve} /> : (
        <ListRow
          key={item.id}
          chevron={false}
          title={<span className="line-clamp-2 max-w-measure">{item.text}</span>}
          trailing={<span role="status" className="text-caption text-text-3">{stalled ? "还没写完，可以稍后再看" : slow ? "还在记，比平时慢一些" : "正在记住"}</span>}
        />
      ))}
    </List>
  );
}

/**
 * Component: ForgetConfirmationRow; owner: H; rules: DS21, AT48/49.
 * Anatomy: original request, explicit choices, confirm/dismiss actions and inline failure.
 * Variants: available candidates or an unresolved reference with no candidates.
 * States: idle, selected, saving, failed with selection retained, resolved.
 * Hit area: shared Checkbox and Button controls.
 * Keyboard: native checkbox and button activation, no automatic selection.
 * Long content: full wrapping candidate text, no clipped destructive choice.
 * Theme: existing text and error tokens; no new surfaces.
 * Responsive: wrapping actions and full-width text within the existing list.
 * Verification: MemoryRows.forget.test.tsx; desktop/mobile Chromium and keyboard activation checked; screen reader check pending.
 */
function ForgetConfirmationRow({ item, onResolved, onResolve }: { item: WebPendingMemory; onResolved?: () => void; onResolve?: ResolveForget }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const saving = useRef(false);
  const submit = async (action: "confirm" | "dismiss") => {
    if (!onResolve || saving.current || action === "confirm" && !selected.length) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      await onResolve(item.id, action, selected);
      setResolved(true); onResolved?.();
    } catch {
      setError("没有完成。可以重试，或在记忆列表中找到内容后选择“忘记”。");
    } finally { saving.current = false; setBusy(false); }
  };
  if (resolved) return <ListRow title="已处理" chevron={false} />;
  return <ListRow chevron={false} title={<span className="break-words">{item.text}</span>} meta={
    <div className="space-y-2">
      <p>请确认要忘记的内容。确认前，这些记忆仍会保留。</p>
      {item.choices?.length ? item.choices.map(choice => <Checkbox key={choice.index} label={<span className="break-words">{choice.text}</span>}
        checked={selected.includes(choice.index)} disabled={busy} onChange={event => setSelected(previous => event.target.checked
          ? [...previous, choice.index] : previous.filter(index => index !== choice.index))} />)
        : <p>暂时无法确定是哪一条。请在对话中说明具体内容，或在记忆列表中找到后选择“忘记”。</p>}
      <div className="flex flex-wrap gap-2">
        {!!item.choices?.length && <Button size="sm" loading={busy} disabled={!onResolve || !selected.length} onClick={() => void submit("confirm")}>忘记选中的内容</Button>}
        <Button size="sm" variant="text" disabled={busy || !onResolve} onClick={() => void submit("dismiss")}>保留记忆，关闭此项</Button>
      </div>
      {error && <p role="alert" className="text-error">{error}</p>}
    </div>
  } />;
}
