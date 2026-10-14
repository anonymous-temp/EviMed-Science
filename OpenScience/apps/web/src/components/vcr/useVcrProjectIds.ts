import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVcrHome } from "@/lib/vcrClient";
import { RUNS_CHANGED_EVENT } from "@/lib/runPresentation";

const NONE: ReadonlySet<string> = new Set();
const NO_STUDIES: ReadonlyMap<string, string> = new Map();

/**
 * The control-plane projects the project list must not show as the account's own:
 * `studies` are 虚拟临床研究 studies (they get the people icon), `drafts` are studies
 * nobody has spoken in yet (they are not in the list at all), and `studyOf` says which
 * study a project is — the id the study's own address needs.
 */
export interface VcrProjectSets {
  studies: ReadonlySet<string>;
  drafts: ReadonlySet<string>;
  /** A study project's id → the study's id. */
  studyOf: ReadonlyMap<string, string>;
}

/** Drafts this browser has just made: the answer to 「新建研究」 is known before the list is re-read, and a draft must not flash in the sidebar between the two. */
const hinted = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** Said when a study's name, status or existence changed, wherever it was seen: the sidebar's list of studies is read again. */
export const VCR_STUDIES_CHANGED_EVENT = "evimed:vcr-studies-changed";

export function announceVcrStudiesChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VCR_STUDIES_CHANGED_EVENT));
}

/** Say that a project was just made as a draft study, so the sidebar leaves it out at once (and knows which study it is). */
export function hintVcrDraftProject(projectId: string, studyId: string | null = null): void {
  if (!projectId || hinted.has(projectId)) return;
  hinted.set(projectId, studyId);
  for (const listener of listeners) listener();
}

/** How soon two reads of the list may follow one another: the list is every study's presenter, and an event storm is not a reason to ask for it each time. */
const READ_GAP_MS = 3_000;
/** While a draft is in sight the list is asked again at this pace… */
const DRAFT_WATCH_MS = 6_000;
/** …for this long: a study nobody speaks in is not watched for ever. */
const DRAFT_WATCH_LIMIT_MS = 5 * 60_000;

/**
 * Which of the account's control-plane projects are 虚拟临床研究 studies, so the
 * project list can give them the people icon (plan §9.1: 「最近」 里它和其他项目
 * 放在一起，图标换成人形) — and which are drafts, so it can leave those out (R10:
 * a study nobody has spoken in is not a project of the account's, and an hour
 * with nothing said in it deletes it).
 *
 * Read when the module is offered (`enabled`), when the account's project list changes (`projectsKey` — a study is created as an
 * ordinary project first, so a new one arrives the same way any other project does), **and again when something says it
 * changed**: a study that was named in its conversation (`VCR_STUDIES_CHANGED_EVENT`), a ledger that moved (`RUNS_CHANGED_EVENT`),
 * and — every few seconds, while it lasts — a draft the reader is in or has just made, because the first sentence said in it is what
 * turns it into a study and nothing else tells the sidebar. Until 2026-10-14 the list was read once per project list, so a study named
 * in its conversation appeared only after a reload. A list that cannot be read costs the icons, never the list.
 */
export function useVcrProjects(enabled: boolean, projectsKey: string, currentId?: string): VcrProjectSets {
  const [sets, setSets] = useState<VcrProjectSets>({ studies: NONE, drafts: NONE, studyOf: NO_STUDIES });
  // A hint arrives from outside React: the render it asks for is the one that reads `hinted` again.
  const [, rerender] = useState(0);
  const bump = useCallback(() => rerender((value) => value + 1), []);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, [bump]);

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const read = useCallback(() => {
    void getVcrHome()
      .then((home) => {
        if (!live.current) return;
        const studyOf = new Map(home.studies.map((study) => [study.projectId, study.id] as const));
        const studies = new Set(studyOf.keys());
        const drafts = new Set(home.draftProjectIds);
        // What the list now says is the truth: a hint it has caught up with (the project is a study or a draft there) is forgotten.
        const hints = hinted.size;
        for (const projectId of studies) hinted.delete(projectId);
        for (const projectId of drafts) hinted.delete(projectId);
        setSets((previous) => (same(previous, { studies, drafts, studyOf }) ? previous : { studies, drafts, studyOf }));
        if (hinted.size !== hints) bump();
      })
      .catch(() => { /* the folders stay folders */ });
  }, [bump]);

  useEffect(() => {
    if (!enabled) {
      setSets({ studies: NONE, drafts: NONE, studyOf: NO_STUDIES });
      return undefined;
    }
    read();
    return undefined;
  }, [enabled, projectsKey, read]);

  // Something said a study changed: ask again, but not more than once in a few seconds.
  useEffect(() => {
    if (!enabled) return undefined;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; last = Date.now(); read(); }, Math.max(0, READ_GAP_MS - (Date.now() - last)));
    };
    window.addEventListener(VCR_STUDIES_CHANGED_EVENT, soon);
    window.addEventListener(RUNS_CHANGED_EVENT, soon);
    return () => {
      window.removeEventListener(VCR_STUDIES_CHANGED_EVENT, soon);
      window.removeEventListener(RUNS_CHANGED_EVENT, soon);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, read]);

  // A draft in sight — the one this browser just made, or the project the reader is in — is asked about until it is not one.
  const watching = enabled && (hinted.size > 0 || (currentId !== undefined && sets.drafts.has(currentId)));
  useEffect(() => {
    if (!watching) return undefined;
    const since = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - since > DRAFT_WATCH_LIMIT_MS) { clearInterval(timer); return; }
      if (document.visibilityState === "visible") read();
    }, DRAFT_WATCH_MS);
    return () => clearInterval(timer);
  }, [watching, read]);

  return useMemo(() => {
    if (!enabled || !hinted.size) return sets;
    const studyOf = new Map(sets.studyOf);
    for (const [projectId, studyId] of hinted) if (studyId && !studyOf.has(projectId)) studyOf.set(projectId, studyId);
    return { studies: sets.studies, drafts: new Set([...sets.drafts, ...hinted.keys()]), studyOf };
    // `hinted` is read when a hint arrives (`rerender`): the memo is keyed by the sets, which `bump` does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sets, hinted.size]);
}

function same(a: VcrProjectSets, b: VcrProjectSets): boolean {
  return a.studies.size === b.studies.size && a.drafts.size === b.drafts.size
    && [...b.studies].every((id) => a.studies.has(id)) && [...b.drafts].every((id) => a.drafts.has(id))
    && [...b.studyOf].every(([projectId, studyId]) => a.studyOf.get(projectId) === studyId);
}

/** The studies' projects alone, for the callers that draw only the icon. */
export function useVcrProjectIds(enabled: boolean, projectsKey: string): ReadonlySet<string> {
  return useVcrProjects(enabled, projectsKey).studies;
}
