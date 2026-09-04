import { create } from "zustand";
import { createWebProject, fetchWebMe, getWebProjectId, hasWebApi, listWebProjects, setWebProjectId, type WebProject } from "@/lib/apiClient";

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
  create: (projectId: string, name?: string) => Promise<WebProject>;
  /** Forget the account's projects after logout. */
  clear: () => void;
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
      const projects = await listWebProjects();
      // The selected id comes from this browser's memory, so it can name a
      // project that no longer exists. The list is the authority: fall back to
      // the one project that is always there rather than showing a switcher
      // whose current entry is missing from its own menu.
      const current = getWebProjectId();
      const resolved = projects.some((p) => p.id === current) ? current : "default";
      if (resolved !== current) setWebProjectId(resolved);
      set({ projects, currentId: resolved, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
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

  create: async (projectId, name = projectId) => {
    const project = await createWebProject(projectId, name);
    set((state) => ({
      projects: [...state.projects.filter((p) => p.id !== project.id), project].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }));
    return project;
  },

  clear: () => set({ projects: [], currentId: getWebProjectId(), loading: false, error: null }),
}));
