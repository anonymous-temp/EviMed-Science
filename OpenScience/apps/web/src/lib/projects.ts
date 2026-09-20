import { flushSync } from "react-dom";
import { create } from "zustand";
import { webErrorMessage, createWebProject, fetchWebMe, getWebProjectId, hasWebApi, listWebProjects, renameWebProject, setWebProjectId, type WebMe, type WebProject } from "@/lib/apiClient";
import { clearScrollMemory } from "@/lib/scrollMemory";
import { warmWebRuntime } from "@/lib/runtimeWarm";

/**
 * The projects this account owns, and which one the shell is looking at.
 *
 * A project is a tenant of one: its own workspace directory, its own runtime
 * container, its own runs. Everything the shell shows is scoped to it, so the
 * shell keys its routed pages on `currentId` (AppShell): a switch remounts
 * every page under the new project, which cannot miss a page the way re-keying
 * each surface by hand would, and costs no document reload. The conversation
 * surface is the one exception — it lives above the router and is cached per
 * project (`SessionFrameHost`), because each of its frames is a container
 * document, a websocket and a kernel handshake. It used to reload
 * — `window.location.assign("/app/chat")` on every switch — and a reload is
 * the whole shell, its chunks and the kernel frame, fetched again to change one
 * header (2026-09-19, 「点一个切换的话就得重新刷新一遍」).
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
  /** The project a switch is proving while its answer is out, else null. */
  switching: string | null;
  loading: boolean;
  /** Why the list could not be read, for the sidebar to show in place. */
  error: string | null;
  load: () => Promise<void>;
  /**
   * Moves the shell to `projectId` in place, once the control plane has shown
   * the account can open it.
   *
   * `land`, when given, runs in the same render as the move: it is the
   * navigation to the page the switch was for, and it must navigate with
   * `{ flushSync: true }` to join that render. Resolves once the shell is on
   * the project — at once, calling `land`, when it already is — and without
   * moving when a later switch overtook this one. Rejects with the reason when
   * the project cannot be opened; the shell then stays where it was.
   */
  select: (projectId: string, land?: () => void) => Promise<void>;
  /** Creates a project from its name; the server chooses the id. */
  create: (name: string) => Promise<WebProject>;
  rename: (projectId: string, name: string) => Promise<WebProject>;
  /** Forget the account's projects after logout. */
  clear: () => void;
}

/**
 * Which switch is the latest. A switch waits on a round trip, so two can
 * overlap — a click on one project's task and, before the answer, on another
 * project's — and the later click is the one the researcher meant. Only the
 * latest may move the shell; an earlier one that answers late does nothing.
 */
let switchGeneration = 0;

/** Which `load` is the latest, for the same reason: an older list answering
 *  last would drop a project created in between. */
let loadGeneration = 0;

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
  switching: null,
  loading: false,
  error: null,

  load: async () => {
    if (!hasWebApi) return;
    const request = ++loadGeneration;
    set({ loading: true, error: null });
    try {
      const projects = sortProjects(await listWebProjects());
      if (request !== loadGeneration) return;
      // The selected id comes from this browser's memory, so it can name a
      // project that no longer exists. The list is the authority: fall back to
      // the one project that is always there — in place, like any switch —
      // rather than showing a list whose current entry is missing from it.
      const current = getWebProjectId();
      const resolved = projects.some((p) => p.id === current) ? current : "default";
      if (resolved !== current) setWebProjectId(resolved);
      if (resolved !== get().currentId) clearScrollMemory();
      set({ projects, currentId: resolved, loading: false });
    } catch (error) {
      if (request !== loadGeneration) return;
      set({ loading: false, error: webErrorMessage(error) });
    }
  },

  select: async (projectId, land) => {
    const generation = ++switchGeneration;
    if (projectId === get().currentId) {
      // Also how a click on this project overrides a switch still proving
      // another one: the generation above is what makes that switch stand down.
      if (get().switching) set({ switching: null });
      land?.();
      return;
    }
    set({ switching: projectId });
    let me: WebMe | null;
    try {
      // Proved on its own request. The tab's header — which every page still
      // on screen sends — moves only once this answers, so a project the
      // account cannot open is never the tab's project, not even for the
      // length of the round trip, and a refusal has nothing to roll back.
      me = await fetchWebMe({ projectId });
    } catch (error) {
      if (generation !== switchGeneration) return;
      set({ switching: null });
      throw error;
    }
    if (generation !== switchGeneration) return;
    if (!me || me.project.id !== projectId) {
      set({ switching: null });
      throw new Error("该项目当前不可用。");
    }
    setWebProjectId(projectId);
    // Remembered offsets are keyed by path, and a path is relative to its
    // project's workspace: two projects' `outputs/report.md` would share one.
    // The reload this replaced cleared them as a side effect.
    clearScrollMemory();
    // One render for the new project and the page it lands on. The router
    // renders a navigation as a transition, after the store's own update has
    // rendered, so without this the page at the old address mounts under the
    // new project first — a task of project A opened in project B's runtime,
    // or B's knowledge base flashing before B's task — and fires its requests.
    flushSync(() => {
      set({ currentId: projectId, switching: null });
      land?.();
    });
    warmWebRuntime(projectId);
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

  clear: () => {
    // A switch still proving belongs to the account that just left.
    switchGeneration += 1;
    loadGeneration += 1;
    set({ projects: [], currentId: getWebProjectId(), switching: null, loading: false, error: null });
  },
}));
