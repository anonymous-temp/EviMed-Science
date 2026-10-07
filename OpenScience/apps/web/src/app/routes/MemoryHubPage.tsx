import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Brain } from "lucide-react";
import { fetchMemoryProfile, searchMemories, type WebStructuredMemory } from "@/lib/apiClient";
import { listAllHandbooks } from "@/lib/handbooksClient";
import { fetchMyCapsule } from "@/lib/memoryClient";
import { SELF_SECTIONS } from "@/lib/memoryGroups";
import { listAllMethods } from "@/lib/methodsClient";
import { useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { useGeoFeature } from "@/lib/geoClient";
import { useVcrFeature } from "@/lib/vcrClient";
import { useGeoProjectIds } from "@/components/geo/useGeoProjectIds";
import { useVcrProjectIds } from "@/components/vcr/useVcrProjectIds";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { List } from "@/components/ui/ListRow";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { FactDrawer } from "@/components/memory/FactDrawer";
import { ForgottenDrawer } from "@/components/memory/ForgottenDrawer";
import { GrowthPanel } from "@/components/memory/GrowthPanel";
import { MemoryControls } from "@/components/memory/MemoryControls";
import { GroupHeader, MemoryListRow } from "@/components/memory/MemoryRows";
import { HandbookDrawer, MethodDrawer } from "@/components/memory/PracticeDrawer";
import { ProjectScope } from "@/components/memory/ProjectScope";
import { factItems, factRowTitle, factsOfProject, practiceItems, projectChoices, type FactItem, type PracticeItem } from "@/components/memory/memoryItems";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { ShareDrawer } from "./CapsuleTransferPanel";

/** The four tabs: each is one list, or — 成长 — the line and the days under it. */
export type MemoryTab = "self" | "project" | "methods" | "growth";

const TAB_NAMES: Record<MemoryTab, string> = { self: "关于你", project: "项目", methods: "做法", growth: "成长" };

/**
 * Which tab an address asks for. `?tab=methods` is the link the skills page
 * has always carried and `?tab=capsules` the old `/app/capsules` redirect;
 * both were ignored, so every deep link landed on the one list there was.
 */
function tabFromAddress(params: URLSearchParams): MemoryTab | null {
  if (params.get("method")) return "methods";
  const named = params.get("tab");
  return named === "methods" || named === "project" || named === "growth" || named === "self" ? named : null;
}

/** The reads a tab needs that did not answer, named by tab: a list that could not be read is never an empty one. */
const SOURCES_OF: Record<MemoryTab, readonly ("profile" | "mine" | "methods" | "handbooks")[]> = {
  self: ["profile", "mine"], project: ["profile", "mine"], methods: ["methods", "handbooks"], growth: [],
};

/**
 * 「记忆胶囊」 (2026-10-07 plan §3.2, mockup m01): what EviMed keeps about the
 * researcher, as four tabs over one list each, and every row opens a drawer on
 * the right.
 *
 *  - 关于你: facts about the person — background, preferences, how they work
 *    and write — under small headers.
 *  - 项目: a project's facts, one project at a time (the one the shell is in to
 *    begin with), the studies and projects of the modules in a group of their
 *    own in the dropdown.
 *  - 做法: what the platform learned — for every study, and for one research
 *    tool each — read, stopped, or taken back to the version before. Never
 *    typed in: methods are learned, not written (owner ruling 2026-09-20).
 *  - 成长: the line of how much the capsule has come to hold, and what was
 *    learned when.
 *
 * What the page no longer has, and why: the two stat blocks and 「查看做法」
 * counted the same methods three ways and moved nothing the reader could see;
 * 「效果待观察」 and 「完成对照评估」 were a state no code could change (the
 * handbook loop is built without an evaluator, and none can compare a handbook
 * with and without it under the learning budget); 「推断」 sat on every row of
 * a page where nearly every row is learned. A row's origin is said once, in its
 * drawer. The header is the title, the 「记忆」 switch and one 「⋯」 (分享与导入 ·
 * 已忘记的内容 · 本项目不使用记忆 · 重置记忆); the page asks nothing of the
 * server to be read — making the capsule on first use moved to opening 分享与导入.
 *
 * Four reads feed it (the memories, the notes of the researcher's own capsule,
 * the methods, the handbooks), each to its last page. When any fails, one line
 * says so with 重试, and a tab whose own read failed shows nothing rather than
 * 「还没有记忆」.
 */
export function MemoryHubPage() {
  const [params, setParams] = useSearchParams();
  const projects = useProjectStore((state) => state.projects);
  const currentProjectId = useProjectStore((state) => state.currentId);
  const [tab, setTab] = useState<MemoryTab>(() => tabFromAddress(params) ?? "self");
  const [query, setQuery] = useState("");
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<"share" | "forgotten" | null>(null);
  const [found, setFound] = useState<WebStructuredMemory[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [missing, setMissing] = useState<string | null>(null);
  // The tab is chosen for the researcher once: an address that names one, a notice that names a memory or a method, or a tab they
  // clicked is theirs; otherwise the page opens on the first tab that has something in it, when the data is in.
  const landed = useRef(tabFromAddress(params) !== null || params.has("record") || params.has("method"));

  // 「刚记住了 … 撤销」 for what changed by itself since the last visit.
  useMemoryWritePrompt();

  const { data, reload } = useCapsuleData(async () => {
    const settled = await Promise.allSettled([fetchMemoryProfile(), fetchMyCapsule(), listAllMethods("approved"), listAllHandbooks("active")]);
    const read = <T,>(result: PromiseSettledResult<T>) => (result.status === "fulfilled" ? result.value : null);
    return { profile: read(settled[0]), mine: read(settled[1]), methods: read(settled[2]), handbooks: read(settled[3]) };
  });

  // Server-side, and debounced: the box used to be a `toLowerCase().includes` over the rows already loaded, so it could only find what was on screen.
  useEffect(() => {
    const text = query.trim();
    if (!text) { setFound(null); setSearchFailed(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void searchMemories(text).then(
        (page) => { setFound(page.items); setSearchFailed(false); },
        () => setSearchFailed(true),
      ).finally(() => setSearching(false));
    }, 250);
    return () => { clearTimeout(timer); setSearching(false); };
  }, [query, searchAttempt]);

  const geoOn = useGeoFeature() === "on";
  const vcrOn = useVcrFeature() === "on";
  const projectsKey = projects.map((project) => project.id).join("\u0000");
  const geoIds = useGeoProjectIds(geoOn, projectsKey);
  const vcrIds = useVcrProjectIds(vcrOn, projectsKey);
  const labels = useProjectLabels();
  const projectName = (id: string | null) => (id ? labels.get(id) ?? null : null);
  const knownProjects = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);

  const records = useMemo(() => data?.profile?.records ?? [], [data]);
  const entries = useMemo(() => data?.mine?.entries ?? [], [data]);
  const facts = useMemo(() => factItems(found ?? records, entries, { query }), [found, records, entries, query]);
  const everyPractice = useMemo(() => practiceItems(data?.methods ?? [], data?.handbooks ?? []), [data]);
  const practices = useMemo(() => practiceItems(data?.methods ?? [], data?.handbooks ?? [], { query }), [data, query]);

  const self = facts.filter((fact) => fact.group === "self");
  const choices = projectChoices(projects, { vcr: vcrIds, geo: geoIds }, facts);
  // The project shown: the researcher's choice, else the one the shell is in — and a choice the account no longer has is not one.
  const scope = choices.some((choice) => choice.id === projectChoice) ? projectChoice
    : choices.some((choice) => choice.id === currentProjectId) ? currentProjectId : choices[0]?.id ?? null;
  const projectFacts = factsOfProject(facts, scope, knownProjects);

  // An inbox notice names a memory (`?record=`) or a method (`?method=`): its drawer opens, and the address is cleared so a reload does not open it again.
  const handled = useRef(false);
  useEffect(() => {
    if (!data || handled.current) return;
    const recordId = params.get("record");
    const methodId = params.get("method");
    if (!recordId && !methodId) { handled.current = true; return; }
    handled.current = true;
    if (recordId) {
      const target = facts.find((fact) => fact.kind === "record" && fact.record.id === recordId)
        ?? factItems(records, entries).find((fact) => fact.kind === "record" && fact.record.id === recordId);
      if (target) {
        setTab(target.group);
        if (target.group === "project") setProjectChoice(target.projectId);
        setOpenKey(target.key);
      }
    } else if (methodId) {
      const target = everyPractice.methods.find((item) => item.kind === "method" && item.method.id === methodId);
      if (target) setOpenKey(target.key);
      else setMissing(data.methods === null ? "暂时读不到已学做法，请重试。" : "当前列表中没有找到这条做法。");
    }
    const next = new URLSearchParams(params);
    next.delete("record");
    next.delete("method");
    setParams(next, { replace: true });
  }, [data, params, setParams, facts, records, entries, everyPractice]);

  const loading = data === null;
  const unread = (Object.entries(data ?? {}) as [string, unknown][]).filter(([, value]) => value === null).map(([name]) => name);
  const tabUnread = SOURCES_OF[tab].some((name) => unread.includes(name));

  // 关于你 is the first tab and, for most accounts early on, the empty one while 项目 and 做法 hold what was learned: landing on an
  // empty list reads as 「什么都没记住」. A tab whose read failed is not known to be empty, so the choice stops there.
  useEffect(() => {
    if (!data || landed.current) return;
    landed.current = true;
    const everyFact = factItems(records, entries);
    const holds: [MemoryTab, number][] = [
      ["self", everyFact.filter((fact) => fact.group === "self").length],
      ["project", everyFact.filter((fact) => fact.group === "project").length],
      ["methods", everyPractice.methods.length + everyPractice.handbooks.length],
    ];
    for (const [candidate, rows] of holds) {
      if (SOURCES_OF[candidate].some((name) => (data as unknown as Record<string, unknown>)[name] === null)) return;
      if (rows === 0) continue;
      if (candidate === "project") {
        // The dropdown names one project at a time: open the first that has facts when the shell's own has none.
        const withFacts = choices.find((choice) => factsOfProject(everyFact, choice.id, knownProjects).length > 0);
        if (withFacts && factsOfProject(everyFact, scope, knownProjects).length === 0) setProjectChoice(withFacts.id);
      }
      if (candidate !== "self") setTab(candidate);
      return;
    }
  }, [data, records, entries, everyPractice, choices, scope, knownProjects]);

  const counts: Record<MemoryTab, number | undefined> = {
    self: loading ? undefined : self.length,
    project: loading ? undefined : projectFacts.length,
    methods: loading ? undefined : practices.methods.length + practices.handbooks.length,
    growth: undefined,
  };
  // A tab with nothing in it carries no number: 「做法 0」 is a statistic about an empty list, which its empty state already says.
  const tabs: TabItem<MemoryTab>[] = (Object.keys(TAB_NAMES) as MemoryTab[]).map((value) => ({ value, label: TAB_NAMES[value], count: counts[value] || undefined }));

  const opened: FactItem | PracticeItem | null = openKey
    ? [...facts, ...everyPractice.methods, ...everyPractice.handbooks].find((item) => item.key === openKey) ?? null
    : null;
  const close = () => setOpenKey(null);

  const factRows = (rows: readonly FactItem[], label: string) => (
    <List label={label}>
      {rows.map((fact) => (
        <MemoryListRow key={fact.key} title={factRowTitle(fact)} muted={fact.kind === "record" && fact.record.status === "superseded"} onOpen={() => setOpenKey(fact.key)} />
      ))}
    </List>
  );
  const empty = (title: string, description: string) => (
    <EmptyState icon={Brain} title={query.trim() ? "没有找到" : title} description={query.trim() ? undefined : description} />
  );

  const list = () => {
    if (loading || (searching && !found && tab !== "methods" && tab !== "growth")) return <RunsSkeleton filter={false} />;
    if (tab === "growth") {
      return (
        <GrowthPanel
          practices={data.methods === null || data.handbooks === null ? null : everyPractice.methods.length + everyPractice.handbooks.length}
          canOpen={(what, id) => (what === "method" ? everyPractice.methods : everyPractice.handbooks).some((item) => item.key === `${what}:${id}`)}
          onOpen={(what, id) => setOpenKey(`${what}:${id}`)}
        />
      );
    }
    if (tabUnread) return null;
    if (tab === "self") {
      if (self.length === 0) return empty("还没有关于你的记忆", "你在对话里说过的偏好、背景和写作习惯会出现在这里。");
      return (
        <div className="space-y-6">
          {SELF_SECTIONS.map((section) => {
            const rows = self.filter((fact) => fact.section === section.key);
            return rows.length === 0 ? null : (
              <section key={section.key}>
                <GroupHeader>{section.label}</GroupHeader>
                {factRows(rows, `${section.label}`)}
              </section>
            );
          })}
        </div>
      );
    }
    if (tab === "project") {
      return (
        <div className="space-y-4">
          {choices.length > 0 && <ProjectScope choices={choices} value={scope} onChange={setProjectChoice} />}
          {projectFacts.length === 0 ? empty("这个项目还没有记忆", "项目里的研究范围、数据来源和已定的决策会出现在这里。") : factRows(projectFacts, "项目的记忆")}
        </div>
      );
    }
    if (practices.methods.length + practices.handbooks.length === 0) return empty("还没有学到的做法", "做的研究多了，会从中学到做法，出现在这里。");
    return (
      <div className="space-y-6">
        {practices.methods.length > 0 && (
          <section>
            <GroupHeader>所有研究都会用</GroupHeader>
            <List label="所有研究都会用的做法">
              {practices.methods.map((item) => <MemoryListRow key={item.key} title={item.title} summary={item.summary} onOpen={() => setOpenKey(item.key)} />)}
            </List>
          </section>
        )}
        {practices.handbooks.length > 0 && (
          <section>
            <GroupHeader>用在某个科研工具里</GroupHeader>
            <List label="用在某个科研工具里的做法">
              {practices.handbooks.map((item) => (
                <MemoryListRow key={item.key} title={item.title} summary={item.summary} end={<span className="text-caption text-text-3">{item.tool}</span>} onOpen={() => setOpenKey(item.key)} />
              ))}
            </List>
          </section>
        )}
      </div>
    );
  };

  return (
    <PageShell
      title="记忆胶囊"
      actions={<MemoryControls onReset={reload} onShare={() => setDrawer("share")} onForgotten={() => setDrawer("forgotten")} />}
    >
      {/* One row: the tabs, and the search box at its end; on a phone the box takes its own line. */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border">
        <Tabs label="记忆" items={tabs} value={tab} onChange={(next) => { landed.current = true; setTab(next); }} className="min-w-0 flex-1 border-b-0" />
        {tab !== "growth"
          ? <SearchInput label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} className="mb-1.5 w-full sm:w-60" />
          // 成长 has nothing to search, and the row keeps its height so the rule under the tabs does not jump between tabs.
          : <div aria-hidden="true" className="mb-1.5 h-control" />}
      </div>
      {unread.length > 0 && <LoadError className="mt-4" message="没有读到全部记忆。" onRetry={reload} />}
      {searchFailed && <LoadError className="mt-4" message="搜索没有完成。" onRetry={() => setSearchAttempt((value) => value + 1)} />}
      {missing && <p role="status" className="mt-4 text-ui text-text-2">{missing}</p>}
      <div className="mt-4">{list()}</div>

      {opened?.kind === "record" || opened?.kind === "entry" ? (
        <FactDrawer
          key={opened.key}
          item={opened}
          projectName={opened.group === "project" ? projectName(opened.projectId) : null}
          onClose={close}
          onChanged={reload}
        />
      ) : opened?.kind === "method" ? (
        <MethodDrawer key={opened.key} method={opened.method} onClose={close} onChanged={reload} />
      ) : opened?.kind === "handbook" ? (
        <HandbookDrawer key={opened.key} handbook={opened.handbook} tool={opened.tool} onClose={close} onChanged={reload} />
      ) : null}
      {drawer === "share" && <ShareDrawer onClose={() => setDrawer(null)} onImported={reload} />}
      {drawer === "forgotten" && (
        <ForgottenDrawer
          records={records}
          entries={data?.mine?.forgotten ?? []}
          projectName={projectName}
          onClose={() => setDrawer(null)}
          onChanged={reload}
        />
      )}
    </PageShell>
  );
}
