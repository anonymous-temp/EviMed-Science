import { useEffect, useState } from "react";
import { getVcrHome } from "@/lib/vcrClient";

const NONE: ReadonlySet<string> = new Set();
const NO_PROJECTS: VcrProjects = { ids: NONE, drafts: NONE };

/** The control-plane projects that are studies, and the ones among them that are still drafts (a study nobody has spoken in yet). */
export interface VcrProjects { ids: ReadonlySet<string>; drafts: ReadonlySet<string> }

/**
 * Which of the account's control-plane projects are 虚拟临研 studies, so the
 * project list can give them the people icon (plan §9.1: 「最近」 里它和其他项目
 * 放在一起，图标换成人形).
 *
 * Read only when the module is offered (`enabled`), and again whenever the
 * account's project list changes (`projectsKey`) — a study is created as an
 * ordinary project first, so a new one arrives the same way any other project
 * does. A list that cannot be read costs the icons, never the list.
 */
export function useVcrProjectIds(enabled: boolean, projectsKey: string): VcrProjects {
  const [found, setFound] = useState<VcrProjects>(NO_PROJECTS);
  useEffect(() => {
    if (!enabled) {
      setFound(NO_PROJECTS);
      return undefined;
    }
    let live = true;
    void getVcrHome()
      .then((home) => {
        // A draft is a study created and not yet begun: it has no name worth listing and no place in the sidebar. The field is read
        // defensively — a control plane that has no draft state sends none, and nothing is hidden.
        if (live) setFound({
          ids: new Set(home.studies.map((study) => study.projectId)),
          drafts: new Set(home.studies.filter((study) => String(study.status) === "draft").map((study) => study.projectId)),
        });
      })
      .catch(() => { /* the folders stay folders */ });
    return () => { live = false; };
  }, [enabled, projectsKey]);
  return found;
}
