import { useCallback, useEffect, useState } from "react";
import { getVcrHome } from "@/lib/vcrClient";

const NONE: ReadonlySet<string> = new Set();

/**
 * The control-plane projects the project list must not show as the account's own:
 * `studies` are 虚拟临研 studies (they get the people icon), `drafts` are studies
 * nobody has described yet (they are not in the list at all).
 */
export interface VcrProjectSets {
  studies: ReadonlySet<string>;
  drafts: ReadonlySet<string>;
}

/** Drafts this browser has just made: the answer to 「新建研究」 is known before the list is re-read, and a draft must not flash in the sidebar between the two. */
const hinted = new Set<string>();
const listeners = new Set<() => void>();

/** Say that a project was just made as a draft study, so the sidebar leaves it out at once. */
export function hintVcrDraftProject(projectId: string): void {
  if (!projectId || hinted.has(projectId)) return;
  hinted.add(projectId);
  for (const listener of listeners) listener();
}

/**
 * Which of the account's control-plane projects are 虚拟临研 studies, so the
 * project list can give them the people icon (plan §9.1: 「最近」 里它和其他项目
 * 放在一起，图标换成人形) — and which are drafts, so it can leave those out (R10:
 * a study nobody has described is not a project of the account's, and an hour
 * with nothing said in it deletes it).
 *
 * Read only when the module is offered (`enabled`), and again whenever the
 * account's project list changes (`projectsKey`) — a study is created as an
 * ordinary project first, so a new one arrives the same way any other project
 * does. A list that cannot be read costs the icons, never the list.
 */
export function useVcrProjects(enabled: boolean, projectsKey: string): VcrProjectSets {
  const [sets, setSets] = useState<VcrProjectSets>({ studies: NONE, drafts: NONE });
  // A hint arrives from outside React: the render it asks for is the one that reads `hinted` again.
  const [, rerender] = useState(0);
  const bump = useCallback(() => rerender((value) => value + 1), []);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, [bump]);
  useEffect(() => {
    if (!enabled) {
      setSets({ studies: NONE, drafts: NONE });
      return undefined;
    }
    let live = true;
    void getVcrHome()
      .then((home) => {
        if (!live) return;
        const studies = new Set(home.studies.map((study) => study.projectId));
        const drafts = new Set(home.draftProjectIds);
        // What the list now says is the truth: a hint it has caught up with (the project is a study or a draft there) is forgotten.
        for (const projectId of studies) hinted.delete(projectId);
        for (const projectId of drafts) hinted.delete(projectId);
        setSets({ studies, drafts });
      })
      .catch(() => { /* the folders stay folders */ });
    return () => { live = false; };
  }, [enabled, projectsKey]);
  if (!enabled || !hinted.size) return sets;
  return { studies: sets.studies, drafts: new Set([...sets.drafts, ...hinted]) };
}

/** The studies' projects alone, for the callers that draw only the icon. */
export function useVcrProjectIds(enabled: boolean, projectsKey: string): ReadonlySet<string> {
  return useVcrProjects(enabled, projectsKey).studies;
}
