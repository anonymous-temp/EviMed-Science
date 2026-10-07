import { FileText, X } from "lucide-react";
import type { AgendaRecord, ResearchState } from "@/lib/autopilotClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { LoadError } from "@/components/cards/LoadError";
import { ClampedText } from "./ClampedText";
import { FOUND_PREFIX, MATERIAL_STATE, needsMaterial, unresolvedText } from "./taskPresentation";

/**
 * What the researcher reads about the question itself: what was found, what is
 * still unresolved, and the material they added for it. The server projects it
 * from the same progress the next decision reads, so this is not a second
 * account of the research. What is asked of the researcher is said once, in the
 * header, by the planner's own words; the button here is the way to give it.
 */
export function ResearchProgress({ agenda, state, error, busy, lastRun, onAdd, onPick, onRemove, onRetry }: {
  agenda: AgendaRecord; state: ResearchState | null; error: string | null; busy: boolean;
  /** How the last run came out (`lastRunLine`): said above the card, so the first thing read is whether the question moved. */
  lastRun?: string;
  onAdd: () => void; onPick: () => void; onRemove: (sourceId: string) => void; onRetry: () => void;
}) {
  if (error) return <LoadError message={error} onRetry={onRetry} />;
  if (!state) return null;
  const waiting = needsMaterial(agenda);
  const section = (label: string, items: string[]) => items.length > 0 && <section aria-label={label} className="space-y-1">
    <h3 className="text-caption font-medium text-text-3">{label}</h3>
    <ul className="space-y-1 text-ui text-text">{items.map(item => <li key={item} className="leading-relaxed"><ClampedText text={item} lines={3} /></li>)}</ul>
  </section>;
  return <div className="max-w-body space-y-2">
    {lastRun && <p className="text-caption text-text-3">{lastRun}{waiting && " · 需要你补充"}</p>}
    <Card title="研究进展">
    <div className="space-y-4">
      {section("已发现", state.found.map(item => `${FOUND_PREFIX[item.check]}${item.statement}`))}
      {section("尚未解决", state.unresolved.map(unresolvedText))}
      <section aria-label="补充材料" className="space-y-2">
        <h3 className="text-caption font-medium text-text-3">补充材料</h3>
        {state.materials.length > 0 && <ul className="space-y-1">{state.materials.map(item => <li key={item.sourceId} className="flex items-center gap-2 text-ui text-text">
          <FileText size={16} className="shrink-0 text-text-3" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          {MATERIAL_STATE[item.state] && <span className="shrink-0 text-caption text-text-3">{MATERIAL_STATE[item.state]}</span>}
          <IconButton icon={X} label={`移除 ${item.name}`} size="sm" disabled={busy} onClick={() => onRemove(item.sourceId)} />
        </li>)}</ul>}
        <div className="flex flex-wrap gap-1">
          <Button variant={waiting ? "secondary" : "text"} size="sm" disabled={busy} onClick={onAdd}>{waiting ? "补充材料并继续" : "添加材料"}</Button>
          <Button variant="text" size="sm" disabled={busy} onClick={onPick}>从知识库选择</Button>
        </div>
      </section>
    </div>
    </Card>
  </div>;
}
