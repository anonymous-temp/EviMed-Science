import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormDialog } from "@/components/ui/FormDialog";
import { Radio } from "@/components/ui/Radio";
import { productErrorMessage } from "@/lib/productClient";
import { setSourceProjects, type SourceRecord } from "@/lib/sourceClient";
import type { ProjectChoice, ProjectGroups } from "./useProjectGroups";

/** Said for a document that takes effect nowhere: a file kept in the account's storage and handed to no project yet. */
export const APPLIES_NOWHERE = "暂未用于任何项目";

/** What a document says of where it takes effect, in the words a project is read by. */
export interface AppliesToView {
  /** Every project, those made later too. */
  all: boolean;
  /** The projects that hold the file (always in force), then the others it was sent to, each by name. */
  names: string[];
  /** One line: 「所有项目」, the names, or {@link APPLIES_NOWHERE}. */
  text: string;
}

/**
 * Where a document takes effect, as a row and the reader say it. The holders come first and are named as the server names them; a
 * project the person sent it to is named by the label the project list gives it, and one that cannot be named any more (deleted,
 * archived) is left out rather than shown as an id. Null for a record that carries no answer — a row of any list but the whole library's.
 */
export function appliesView(source: SourceRecord, labels: ReadonlyMap<string, string>): AppliesToView | null {
  const applies = source.appliesTo;
  if (applies === undefined) return null;
  if (applies === "all") return { all: true, names: [], text: "所有项目" };
  const held = (source.holders ?? []).map((holder) => holder.id);
  const names = [
    ...(source.holders ?? []).map((holder) => labels.get(holder.id) ?? holder.name),
    ...applies.filter((id) => !held.includes(id)).flatMap((id) => (labels.has(id) ? [labels.get(id) as string] : [])),
  ];
  return { all: false, names, text: names.length > 0 ? names.join("、") : APPLIES_NOWHERE };
}

/**
 * The projects whose conversation can read every one of these documents: for each, the projects it takes effect in — a project that holds it
 * or is named in its choice, or any of the account's own projects where it says all — and what they have in common. The projects that hold
 * a document are listed under whatever kind they are (a 循证 GEO project's own file is read in that project's conversation).
 */
export function conversationProjects(sources: readonly SourceRecord[], groups: ProjectGroups): ProjectChoice[] {
  const everywhere = new Map<string, ProjectChoice>([...groups.own, ...groups.studies, ...groups.communication].map((choice) => [choice.id, choice]));
  const reading = sources.map((source): Map<string, ProjectChoice> => {
    const applies = source.appliesTo;
    if (applies === "all") return new Map(groups.own.map((choice) => [choice.id, choice]));
    const ids = applies ?? (source.holders ?? []).map((holder) => holder.id).concat(source.personal ? [] : [source.projectId]);
    return new Map(ids.flatMap((id) => (everywhere.has(id) ? [[id, everywhere.get(id) as ProjectChoice] as const] : [])));
  });
  const [first, ...rest] = reading;
  if (!first) return [];
  return [...first.values()].filter((choice) => rest.every((others) => others.has(choice.id)));
}

/**
 * 「生效项目」, the document's own place on the row and on its page: where it takes effect, said in words, which is also the press that
 * changes it. A quiet 「生效于」 before the words, and the words are the button — a document that is read everywhere says 「所有项目」, one
 * that is read in two projects names them.
 */
export function AppliesTo({ source, labels, disabled, onOpen }: {
  source: SourceRecord; labels: ReadonlyMap<string, string>; disabled?: boolean; onOpen: () => void;
}) {
  const view = appliesView(source, labels);
  if (!view) return null;
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <span className="shrink-0">生效于</span>
      <Button variant="text" size="sm" disabled={disabled} onClick={onOpen} aria-label={`“${source.display.title}”的生效项目：${view.text}，点击修改`} className="min-w-0 max-w-full px-1">
        <span className="truncate">{view.text}</span>
      </Button>
    </span>
  );
}

/**
 * The dialog behind 「生效项目」: 「所有项目」 (the projects made later too) or a checklist of the account's own projects. The projects that
 * hold the file are checked and cannot be unchecked — a file does not leave the project it is in. 保存 is `PUT /api/library/:id`; a
 * refusal is said in the dialog in the registry's words, and the dialog stays so the choice is not lost.
 */
export function AppliesToDialog({ source, projects, labels, onClose, onSaved }: {
  source: SourceRecord;
  /** The projects a document can be sent to (`ProjectGroups.applicable`). */
  projects: readonly ProjectChoice[];
  labels: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: (change: { sourceId: string; libraryProjects: "all" | string[]; appliesTo: "all" | string[] }) => void;
}) {
  const holders = source.holders ?? [];
  const held = new Set(holders.map((holder) => holder.id));
  const choosable = new Set(projects.map((project) => project.id));
  const initialAll = source.libraryProjects === "all";
  const initialPicked = new Set(Array.isArray(source.libraryProjects) ? source.libraryProjects.filter((id) => choosable.has(id) && !held.has(id)) : []);
  // Projects the record lists that this dialog does not offer (one put away since): they stay on it. The dialog changes what it shows
  // and nothing else, and the server does not ask again about a project the record already has.
  const unlisted = Array.isArray(source.libraryProjects) ? source.libraryProjects.filter((id) => !choosable.has(id) && !held.has(id)) : [];
  const [all, setAll] = useState(initialAll);
  const [picked, setPicked] = useState<ReadonlySet<string>>(initialPicked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = all !== initialAll || (!all && (picked.size !== initialPicked.size || [...picked].some((id) => !initialPicked.has(id))));
  const toggle = (id: string, on: boolean) => setPicked((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });
  const save = async (markSaved: () => void) => {
    setBusy(true); setError(null);
    try {
      const entry = await setSourceProjects(source.id, all ? "all" : [...picked, ...unlisted]);
      markSaved();
      onSaved({ sourceId: source.id, libraryProjects: entry.libraryProjects, appliesTo: entry.appliesTo });
    } catch (failure) { setError(productErrorMessage(failure)); setBusy(false); }
  };
  const others = projects.filter((project) => !held.has(project.id));
  return (
    <FormDialog title="生效项目" busy={busy} dirty={dirty} onClose={onClose}>
      {(requestClose, markSaved) => (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (dirty && !busy) void save(markSaved); }}>
          <p className="text-ui text-text">“{source.display.title}”在哪些项目的对话里可以被读到、引用。</p>
          <fieldset className="space-y-1" disabled={busy}>
            <legend className="sr-only">生效项目</legend>
            <Radio name="applies-to" checked={all} onChange={() => setAll(true)} label="所有项目" hint="包括以后新建的项目。" />
            <Radio name="applies-to" checked={!all} onChange={() => setAll(false)} label="选择项目" />
            {!all && (
              <div role="group" aria-label="选择项目" className="ml-6 space-y-0.5 border-l border-border pl-3">
                {holders.map((holder) => (
                  <Checkbox key={holder.id} checked disabled label={<span>{labels.get(holder.id) ?? holder.name}<span className="ml-2 text-caption text-text-3">所在项目，不能取消</span></span>} />
                ))}
                {others.map((project) => (
                  <Checkbox key={project.id} checked={picked.has(project.id)} onChange={(event) => toggle(project.id, event.target.checked)} label={project.label} />
                ))}
                {holders.length === 0 && others.length === 0 && <p className="py-2 text-ui text-text">还没有可以选择的项目。</p>}
              </div>
            )}
          </fieldset>
          {error && <div role="alert" className="text-ui text-danger">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={requestClose}>取消</Button>
            <Button type="submit" loading={busy} disabled={!dirty}>保存</Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}
