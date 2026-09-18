import { create } from "zustand";
import { webErrorMessage, createWebProject, fetchWebMe, getWebProjectId, hasWebApi, listWebProjects, renameWebProject, setWebProjectId, type WebProject } from "@/lib/apiClient";

/**
 * The projects this account owns, and which one the shell is looking at.
 *
 * A project is a tenant of one: its own workspace directory, its own runtime
 * container, its own runs. Everything the shell shows is scoped to it, which
 * is why the switch below reloads rather than re-fetching — see `select`.
 *
 * The id is not in any URL. It travels as a request header the API client adds
 * (`X-Open-Science-Project`), and the control plane answers `/api/me` with the
 * project it actually resolved, so a browser holding a deleted project's id
 * corrects itself on the first read instead of 404ing the whole account.
 */
interface ProjectState {
  /** Every project the account owns, by name. Empty until `load` answers. */
  projects: WebProject[];
  /** The selected project's id. Never empty — "default" always exists. */
  currentId: string;
  loading: boolean;
  /** Why the list could not be read, for the switcher to show in place. */
  error: string | null;
  load: () => Promise<void>;
  select: (projectId: string) => Promise<void>;
  /** Creates a project from its name; the server chooses the id. */
  create: (name: string) => Promise<WebProject>;
  rename: (projectId: string, name: string) => Promise<WebProject>;
  /** Forget the account's projects after logout. */
  clear: () => void;
}

/**
 * The order every project list shows: the account's own 「我的研究」 first,
 * then by name as a Chinese reader sorts (pinyin). The server's own order
 * depends on its database collation, which is not a reading order.
 */
export function sortProjects(projects: WebProject[]): WebProject[] {
  return [...projects].sort((a, b) => {
    if (a.id === "default" || b.id === "default") return a.id === "default" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh") || a.id.localeCompare(b.id);
  });
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentId: getWebProjectId(),
  loading: false,
  error: null,

  load: async () => {
    if (!hasWebApi) return;
    set({ loading: true, error: null });
    try {
      const projects = sortProjects(await listWebProjects());
      // The selected id comes from this browser's memory, so it can name a
      // project that no longer exists. The list is the authority: fall back to
      // the one project that is always there rather than showing a switcher
      // whose current entry is missing from its own menu.
      const current = getWebProjectId();
      const resolved = projects.some((p) => p.id === current) ? current : "default";
      if (resolved !== current) setWebProjectId(resolved);
      set({ projects, currentId: resolved, loading: false });
    } catch (error) {
      set({ loading: false, error: webErrorMessage(error) });
    }
  },

  select: async (projectId) => {
    if (projectId === get().currentId) return;
    const previous = get().currentId;
    setWebProjectId(projectId);
    // Prove the project resolves before committing the browser to it. A switch
    // that lands on a project the account cannot open would otherwise leave
    // every subsequent request failing with no way back.
    let me;
    try {
      me = await fetchWebMe();
    } catch (error) {
      setWebProjectId(previous);
      throw error;
    }
    if (!me || me.project.id !== projectId) {
      setWebProjectId(previous);
      throw new Error("该项目当前不可用。");
    }
    // A reload, not a re-render. Every surface in the shell is project-scoped —
    // the runs ledger, the file tree, the notebooks, and the framed runtime,
    // which is a different container on a different origin holding its own
    // cookie. Re-keying each of them by hand is a list that grows silently
    // wrong every time a page is added; discarding the document cannot.
    if (typeof window !== "undefined") window.location.assign("/app/chat");
    else set({ currentId: projectId });
  },

  create: async (name) => {
    const project = await createWebProject(name.trim());
    set((state) => ({ projects: sortProjects([...state.projects.filter((p) => p.id !== project.id), project]) }));
    return project;
  },

  rename: async (projectId, name) => {
    const renamed = await renameWebProject(projectId, name.trim());
    set((state) => ({
      projects: sortProjects(state.projects.map((p) => (p.id === projectId ? { ...p, ...renamed } : p))),
    }));
    return renamed;
  },

  clear: () => set({ projects: [], currentId: getWebProjectId(), loading: false, error: null }),
}));
