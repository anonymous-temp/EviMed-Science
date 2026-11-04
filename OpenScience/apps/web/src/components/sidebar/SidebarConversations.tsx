import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { fetchWebMe, getVerifiedWebActor, listWebAgentRuns, listWebProjects, type VerifiedWebActor } from "@/lib/apiClient";
import { groupConversations, conversationBegan } from "@/lib/conversations";
import { listGeoProjects, type GeoProjectSummary } from "@/lib/geoClient";
import { geoChatPath } from "@/lib/geoLocation";
import { listGeoConversations, openGeoConversation, type GeoConversationSummary } from "@/lib/geoNativeClient";
import { useProjectStore } from "@/lib/projects";
import { chatPath } from "@/lib/runLocation";
import { RUNS_CHANGED_EVENT, runMoment } from "@/lib/runPresentation";
import { CONVERSATION_SETTLED_EVENT } from "@/lib/runtimeUiBridge";
import { conversationNavigationState, newRuntimeUiIntent, prepareRuntimeUiIntent, scopedConversationPath } from "@/lib/runtimeUiNavigation";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";
import { vcrChatPath } from "@/lib/studyLocation";
import { getVcrHome } from "@/lib/vcrClient";
import { studyOfPath } from "@/components/vcr/useVcrFinishedToasts";
import { FilterSelect } from "@/components/ui/FilterChips";
import { ProjectBrowser } from "./ProjectBrowser";

type Entry = { key: string; projectId: string; projectName: string; sessionId: string; title: string; at: number; geoId?: string; studyId?: string; geoOwnerId?: string };
type Data = { key: string; entries: Entry[]; projects: GeoProjectSummary[]; cursors: Record<string, string>; loadedGeo: string[]; loading: boolean; failed: string[]; actor: VerifiedWebActor | null };
const empty = (key: string): Data => ({ key, entries: [], projects: [], cursors: {}, loadedGeo: [], loading: true, failed: [], actor: null });
const moment = (at: string | null) => { const n = Date.parse(at ?? ""); return Number.isFinite(n) ? n : 0; };
const geoEntries = (project: GeoProjectSummary, rows: GeoConversationSummary[]): Entry[] => rows.map(row => ({ key: `geo:${project.id}:${row.sessionId}`, projectId: project.projectId, projectName: project.name, sessionId: row.sessionId, title: row.title, at: moment(row.createdAt), geoId: project.id }));
async function limited<T>(values: T[], action: (value: T) => Promise<void>, current: () => boolean) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(3, values.length) }, async () => { while (current() && index < values.length) { const value = values[index++]; await action(value); } }));
}
function storageGet(key: string) { try { return sessionStorage.getItem(key); } catch { return null; } }
function storageSet(key: string, value: string) { try { sessionStorage.setItem(key, value); } catch { /* in-memory request remains stable */ } }
function storageRemove(key: string) { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } }

export function SidebarConversations({ geoId, geo, vcr, onCurrentModule }: { geoId: string | null; geo: boolean; vcr: boolean; onCurrentModule: (module: "geo" | "vcr" | null) => void }) {
  const location = useLocation(), navigate = useNavigate();
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  const studyId = vcr ? studyOfPath(location.pathname) : null;
  const context = geoId ?? studyId;
  const [choice, setChoice] = useState<{ context: string | null; scope: "project" | "all" }>({ context, scope: context ? "project" : "all" });
  const scope = choice.context === context ? choice.scope : context ? "project" : "all";
  const [revision, setRevision] = useState(0);
  const actionKey = JSON.stringify([generation, geoId, studyId, scope, location.key]);
  const key = JSON.stringify([actionKey, revision]);
  const liveAction = useRef(actionKey); liveAction.current = actionKey;
  const liveKey = useRef(key); liveKey.current = key;
  const [data, setData] = useState<Data>(() => empty(key));
  const view = data.key === key ? data : empty(key);
  const [search, setSearch] = useState({ generation, value: "" });
  const query = search.generation === generation ? search.value : "";
  const [management, setManagement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const requests = useRef(new Map<string, string>());
  useEffect(() => subscribeSessionBoundary(() => {
    requests.current.clear();
    try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const name = sessionStorage.key(i); if (name?.startsWith("geo-create-request:")) sessionStorage.removeItem(name); } } catch { /* storage unavailable */ }
  }), []);
  const click = useRef(0);
  const selection = useRef<AbortController | null>(null);
  useEffect(() => { setBusy(false); return () => { selection.current?.abort(); }; }, [actionKey]);
  const alive = (expected: string, gen: number) => liveKey.current === expected && sessionGeneration() === gen;
  const actionAlive = () => liveAction.current === actionKey && sessionGeneration() === generation;
  const update = (expected: string, fn: (old: Data) => Data) => setData(old => old.key === expected ? fn(old) : old);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => setRevision(value => value + 1), 200); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener(RUNS_CHANGED_EVENT, refresh); window.addEventListener(CONVERSATION_SETTLED_EVENT, refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(timer); window.removeEventListener(RUNS_CHANGED_EVENT, refresh); window.removeEventListener(CONVERSATION_SETTLED_EVENT, refresh); document.removeEventListener("visibilitychange", visible); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && alive(key, generation);
    setData(empty(key)); setNotice(""); setManagement(false);
    void (async () => {
      const failures: string[] = [];
      const me = await fetchWebMe().catch(() => null);
      const actor = getVerifiedWebActor();
      if (!current()) return;
      if (!me || !actor) failures.push("账号状态未能验证");
      let geoProjects: GeoProjectSummary[] = [];
      let geoKnown = !geo;
      if (geo) {
        try { geoProjects = await listGeoProjects(); geoKnown = true; }
        catch { failures.push("GEO 项目未能读取"); }
      }
      if (!current()) return;
      const selected = scope === "project" ? geoProjects.filter(project => project.id === geoId) : geoProjects;
      update(key, old => ({ ...old, actor, projects: selected, failed: [...failures] }));
      await limited(selected, async project => {
        try {
          const page = await listGeoConversations(project.id);
          if (current()) update(key, old => ({ ...old, entries: [...old.entries, ...geoEntries(project, page.items)], loadedGeo: [...old.loadedGeo, project.id], cursors: page.nextCursor ? { ...old.cursors, [project.id]: page.nextCursor } : old.cursors }));
        } catch { if (current()) update(key, old => ({ ...old, failed: [...old.failed, `“${project.name}”的 GEO 和个人会话暂未完整显示，请重试`] })); }
      }, current);
      if (!current()) return;
      if (scope === "all" && geoKnown) {
        let projects: Awaited<ReturnType<typeof listWebProjects>> = [];
        let studies: Awaited<ReturnType<typeof getVcrHome>>["studies"] = [];
        try { projects = await listWebProjects(); } catch { failures.push("普通项目未能读取"); }
        let studyKnown = !vcr;
        if (vcr) try { studies = (await getVcrHome()).studies; studyKnown = true; } catch { failures.push("研究归属未能读取，普通项目暂未加载"); }
        if (!current()) return;
        const geoOwned = new Set(geoProjects.filter(project => project.access?.owner === true).map(project => project.projectId));
        const currentId = useProjectStore.getState().currentId;
        onCurrentModule(geoOwned.has(currentId) ? "geo" : studyKnown && studies.some(study => study.projectId === currentId && study.purpose !== "task") ? "vcr" : null);
        await limited(studyKnown ? projects : [], async project => {
          try {
            const runs = await listWebAgentRuns({ projectId: project.id });
            const conversations = groupConversations(runs).filter(row => /^[A-Za-z0-9_-]{1,128}$/.test(row.sessionId));
            const study = studies.find(row => row.projectId === project.id && row.purpose !== "task");
            const primary = study ? study.originatingSessionId !== undefined ? study.originatingSessionId : [...conversations].sort((a, b) => conversationBegan(a) - conversationBegan(b))[0]?.sessionId : null;
            const ownedGeo = geoProjects.find(candidate => candidate.projectId === project.id && candidate.access?.owner === true);
            const rows: Entry[] = conversations.map(row => ({ ...(ownedGeo ? { geoOwnerId: ownedGeo.id } : {}), key: `project:${project.id}:${row.sessionId}`, projectId: project.id, projectName: project.name, sessionId: row.sessionId, title: row.titleRun.title || row.titleRun.question || "对话", at: runMoment(row.lead), ...(study && row.sessionId === primary ? { studyId: study.id } : {}) }));
            if (current()) update(key, old => ({ ...old, entries: [...old.entries, ...rows] }));
          } catch { if (current()) update(key, old => ({ ...old, failed: [...old.failed, `“${project.name}”的 GEO 和个人会话暂未完整显示，请重试`] })); }
        }, current);
      } else if (scope === "all" && !geoKnown) failures.push("为避免重复，普通项目暂未加载");
      if (current()) update(key, old => ({ ...old, failed: [...new Set([...old.failed, ...failures])], loading: false }));
    })();
    return () => { cancelled = true; };
  }, [key, generation, geo, vcr, geoId, scope, onCurrentModule]);

  async function loadMore(id: string) {
    const cursor = view.cursors[id], project = view.projects.find(row => row.id === id); if (!cursor || !project) return;
    try {
      const page = await listGeoConversations(id, cursor); if (!alive(key, generation)) return;
      update(key, old => { if (old.cursors[id] !== cursor) return old; const cursors = { ...old.cursors }; if (page.nextCursor) cursors[id] = page.nextCursor; else delete cursors[id]; const rows = new Map(old.entries.map(item => [item.key, item])); geoEntries(project, page.items).forEach(item => rows.set(item.key, item)); return { ...old, entries: [...rows.values()], cursors }; });
    } catch { if (alive(key, generation)) setNotice("更多对话暂时无法读取，请重试。"); }
  }
  const currentProject = view.projects.find(project => project.id === geoId);
  const canCreate = Boolean(view.actor && currentProject?.access?.abilities.includes("run") && currentProject.access.abilities.includes("edit"));
  async function create() {
    if (!geoId || !currentProject || !view.actor || !canCreate || busy) return;
    const actor = view.actor;
    const storageKey = `geo-create-request:${encodeURIComponent(actor.tenantId)}:${encodeURIComponent(actor.userId)}:${encodeURIComponent(geoId)}`;
    const requestId = requests.current.get(storageKey) || storageGet(storageKey) || crypto.randomUUID();
    requests.current.set(storageKey, requestId); storageSet(storageKey, requestId); setBusy(true); setNotice("");
    try {
      const descriptor = await openGeoConversation(geoId, { kind: "new", requestId });
      if (descriptor.projectId !== currentProject.projectId || descriptor.scope.kind !== "geo" || descriptor.scope.geoProjectId !== geoId || descriptor.sessionId !== descriptor.scope.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.sessionId)) throw new Error("Conversation mismatch");
      if (!actionAlive()) return;
      requests.current.delete(storageKey); storageRemove(storageKey);
      update(liveKey.current, old => ({ ...old, entries: [...old.entries.filter(row => row.key !== `geo:${geoId}:${descriptor.sessionId}`), ...geoEntries(currentProject, [{ sessionId: descriptor.sessionId, title: "新对话", createdAt: new Date().toISOString() }])] }));
      const intent = newRuntimeUiIntent(undefined, descriptor.sessionId, { projectId: descriptor.projectId, scope: descriptor.scope }); intent.kind = "open";
      navigate(geoChatPath(geoId, descriptor.sessionId), { state: { runtimeUiIntent: prepareRuntimeUiIntent(intent) } });
    } catch { if (actionAlive()) setNotice("新建结果暂不可确认，系统不会再次创建。请稍后重试；若仍无法确认，请联系管理员。"); }
    finally { if (actionAlive()) setBusy(false); }
  }
  function open(item: Entry) {
    const attempt = ++click.current;
    selection.current?.abort();
    if (item.geoId) { navigate(geoChatPath(item.geoId, item.sessionId)); return; }
    const target = item.studyId ? vcrChatPath(item.studyId) : scopedConversationPath(chatPath(item.sessionId), item.projectId);
    const controller = new AbortController(); selection.current = controller;
    void useProjectStore.getState().select(item.projectId, () => {
      if (!actionAlive() || click.current !== attempt) return;
      navigate(target, { state: item.studyId ? undefined : conversationNavigationState(undefined, item.projectId), flushSync: true });
    }, controller.signal).catch(() => { if (actionAlive() && click.current === attempt) setNotice("无法打开这个项目，请稍后重试。"); });
  }
  const associated = new Set(view.entries.filter(item => item.geoId).map(item => `${item.geoId}:${item.sessionId}`));
  const rows = [...new Map(view.entries.map(item => [item.key, item])).values()].filter(item => !item.geoOwnerId || (view.loadedGeo.includes(item.geoOwnerId) && !view.cursors[item.geoOwnerId] && !associated.has(`${item.geoOwnerId}:${item.sessionId}`))).filter(item => `${item.title} ${item.projectName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  return <section aria-label="对话" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="flex items-center gap-2 px-4 pt-3 text-caption text-text-3"><span>对话</span>
      {context && <FilterSelect label="对话范围" options={[{ value: "project", label: "本项目" }, { value: "all", label: "全部最近" }]} value={scope} onChange={value => { if (value) setChoice({ context, scope: value }); }} />}
      {geoId && scope === "project" && canCreate && <button type="button" onClick={() => void create()} disabled={busy} aria-label="新建本项目对话">＋</button>}
    </div>
    {!(scope === "project" && studyId) && <input className="mx-4 mt-2 min-w-0 bg-transparent text-caption" aria-label="搜索最近对话" placeholder="搜索对话或项目" value={query} onChange={event => setSearch({ generation, value: event.target.value })} />}
    {notice && <p role="alert" className="px-4 text-caption">{notice}</p>}
    {scope === "project" && studyId ? <ProjectBrowser vcr studyScope={studyId} onCurrentModule={onCurrentModule} /> : <>
      {view.loading && <p role="status" className="px-4 text-caption">正在读取对话</p>}
      {view.failed.map(message => <p role="alert" key={message} className="px-4 text-caption">{message}</p>)}
      {view.failed.length > 0 && <button type="button" className="px-4 text-left text-caption text-link" onClick={() => setRevision(value => value + 1)}>重试读取</button>}
      {!view.loading && !view.failed.length && !rows.length && <p className="px-4 text-caption text-text-3">没有对话</p>}
      {rows.map(item => <button key={item.key} type="button" onClick={() => open(item)} aria-current={(item.geoId ? location.pathname === geoChatPath(item.geoId, item.sessionId) || new URLSearchParams(location.search).get("session") === item.sessionId && geoId === item.geoId : location.pathname === (item.studyId ? vcrChatPath(item.studyId) : chatPath(item.sessionId))) ? "page" : undefined} className="flex w-full gap-2 px-4 py-1 text-left text-ui aria-[current=page]:bg-surface-2"><span className="min-w-0 flex-1 truncate">{item.title}</span>{scope === "all" && <span className="max-w-24 truncate text-text-3">{item.projectName}</span>}</button>)}
      {view.entries.some(item => item.geoOwnerId && view.cursors[item.geoOwnerId]) && <p className="px-4 text-caption text-text-3">请加载该 GEO 项目的更多对话，以显示其余个人会话。</p>}
      {Object.keys(view.cursors).map(id => <button type="button" className="px-4 text-left text-caption text-link" key={id} onClick={() => void loadMore(id)}>加载更多：{view.projects.find(project => project.id === id)?.name}</button>)}
    </>}
    {(scope === "all" || Boolean(geoId)) && <><button type="button" className="px-4 pt-3 text-left text-caption text-link" aria-expanded={management} onClick={() => setManagement(value => !value)}>管理项目与对话</button>{management && <ProjectBrowser geo={geo} vcr={vcr} excludeGeo={scope === "all"} onCurrentModule={onCurrentModule} />}</>}
  </section>;
}
