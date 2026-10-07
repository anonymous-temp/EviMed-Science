import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceRecord } from "@/lib/sourceClient";
import { listAllSources } from "@/lib/sourceList";
import { productErrorMessage } from "@/lib/productClient";
import { Button } from "@/components/ui/Button";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";

/** A document's file name, as the knowledge base page shows it. */
const nameOf = (source: SourceRecord) => (source.payload.paths[0] ?? source.id).split("/").at(-1) ?? source.id;

/**
 * The project's usable documents, to be associated with one question. Nothing is
 * uploaded or registered here: these are documents already in the knowledge
 * base, and choosing them only says which question they are for.
 */
export function MaterialPicker({ projectId, taken, busy, onChoose, onCancel }: {
  projectId: string; taken: string[]; busy: boolean; onChoose: (sourceIds: string[]) => void; onCancel: () => void;
}) {
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const live = useRef(true);
  const load = useCallback(() => {
    setError(null);
    listAllSources(projectId, { state: "ready" }).then(
      records => { if (live.current) setSources(records); },
      caught => { if (live.current) setError(`知识库暂不可用：${productErrorMessage(caught)}`); });
  }, [projectId]);
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, [load]);
  const choices = (sources ?? []).filter(source => !taken.includes(source.id));
  return <div className="space-y-4">
    {error && <LoadError message={error} onRetry={load} />}
    {!error && sources === null && <FilesSkeleton />}
    {sources !== null && choices.length === 0 && <p className="text-ui text-text-3">知识库里没有可以再添加的资料。</p>}
    {choices.length > 0 && <ul aria-label="知识库资料" className="max-h-72 space-y-1 overflow-y-auto">{choices.map(source => <li key={source.id}>
      <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-ui text-text hover:bg-surface-2">
        <input type="checkbox" checked={chosen.includes(source.id)} onChange={event => setChosen(event.target.checked ? [...chosen, source.id] : chosen.filter(id => id !== source.id))} />
        <span className="min-w-0 truncate">{nameOf(source)}</span>
      </label>
    </li>)}</ul>}
    <div className="flex justify-end gap-2 border-t border-border pt-4">
      <Button variant="secondary" disabled={busy} onClick={onCancel}>取消</Button>
      <Button loading={busy} disabled={chosen.length === 0} onClick={() => onChoose(chosen)}>添加到这个任务</Button>
    </div>
  </div>;
}
