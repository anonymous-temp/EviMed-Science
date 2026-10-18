import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useAddressOpen, useAddressText, withParam } from "@/lib/addressState";
import { usePageScroll } from "@/lib/pageScroll";
import { Brain } from "lucide-react";
import { searchMemories, type WebStructuredMemory } from "@/lib/apiClient";
import { SELF_SECTIONS } from "@/lib/memoryGroups";
import { useProjectLabels } from "@/lib/projectNames";
import { useProjectStore } from "@/lib/projects";
import { useMemoryMapFeature } from "@/lib/memoryMapFeature";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { List } from "@/components/ui/ListRow";
import { FactDrawer } from "@/components/memory/FactDrawer";
import { ForgottenDrawer } from "@/components/memory/ForgottenDrawer";
import { MemoryControls } from "@/components/memory/MemoryControls";
import { MEMORY_TIME_ADDRESS, memoryTabAddress, MemoryFrame, type MemoryPageTab, type MemoryTab } from "@/components/memory/MemoryFrame";
import { GroupSection, MemoryListRow, PendingMemoryRows } from "@/components/memory/MemoryRows";
import { HandbookDrawer, MethodDrawer } from "@/components/memory/PracticeDrawer";
import { ProjectOverview } from "@/components/memory/ProjectOverview";
import { factItems, factRowSummary, factRowTitle, factsOfProject, OTHER_PROJECT, practiceItems, projectScopeGroups, type FactItem, type PracticeItem } from "@/components/memory/memoryItems";
import { RememberDialog } from "@/components/memory/RememberDialog";
import { useMemoryReads, type MemoryRead } from "@/components/memory/useMemoryReads";
import { usePendingMemory } from "@/components/memory/usePendingMemory";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { useProjectChoices } from "@/components/memory/useProjectChoices";
import { useProjectOverview } from "@/components/memory/useProjectOverview";
import { useKnowledgeConversation } from "@/components/sources/useKnowledgeConversation";
import { ShareDrawer } from "./CapsuleTransferPanel";
import { knownErrorCodeMessage } from "@evimed/domain";

/**
 * Which tab an address asks for. `?tab=methods` is the link the skills page
 * has always carried and `?tab=capsules` the old `/app/capsules` redirect;
 * both were ignored, so every deep link landed on the one list there was.
 */
function tabFromAddress(params: URLSearchParams): MemoryTab | null {
  if (params.get("method")) return "methods";
  const named = params.get("tab");
  return named === "methods" || named === "project" || named === "self" ? named : null;
}

/** The reads a tab needs that did not answer, named by tab: a list that could not be read is never an empty one. */
const SOURCES_OF: Record<MemoryTab, readonly MemoryRead[]> = {
  self: ["profile", "mine"], project: ["profile", "mine"], methods: ["methods", "handbooks"],
};

/** What a conversation begun from an empty tab leaves in the composer, unsent: the blanks are the person's to fill. */
const SELF_DRAFT = "请记住关于我的这些：\n\n我的专业和背景：\n我的写作和回答偏好：\n我常做的事：";
const PROJECT_DRAFT = "我来说说这个项目的情况，请记住：\n\n目标：\n用到的资料：\n现在进行到：";

/**
 * 「记忆胶囊」 (2026-10-07 plan §3.2, mockup m01): what EviMed keeps about the
 * researcher, as four tabs over one list each, and every row opens a drawer on
 * the right.
 *
 *  - 关于你: facts about the person — background, preferences, how they work
 *    and write — under small headers.
 *  - 项目: a project's facts, one project at a time (the one the shell is in to
 *    begin with), the studies and projects of the modules in a group of their
 *    own in the dropdown. Above them, for that project (2026-10-12, the owner's
 *    choice A — nothing of the kind is the account's, and none has a page): the
 *    card its facts were written under, what its conversations did and what they
 *    delivered, and a line when the project has memory switched off.
 *  - 做法: what the platform learned — for every study, and for one research
 *    tool each — read, stopped, or taken back to the version before. Never
 *    typed in: methods are learned, not written (owner ruling 2026-09-20).
 *  - 地图: the memory map (`/app/memory/map`), a page of its own that wears this page's frame. 「成长」 was the fourth tab until
 *    2026-10-17: the line of how much the capsule held said "grew to 75" over a line that fell to 42; what happened each week is
 *    the map's 「时间」 view now, and `?tab=growth` arrives there.
 *
 * What the page no longer has, and why: the two stat blocks and 「查看做法」
 * counted the same methods three ways and moved nothing the reader could see;
 * 「效果待观察」 and 「完成对照评估」 were a state no code could change (the
 * handbook loop is built without an evaluator, and none can compare a handbook
 * with and without it under the learning budget); 「推断」 sat on every row of
 * a page where nearly every row is learned, and then once in every drawer: whose
 * words a memory is, is not said on the page at all (owner ruling of 2026-10-10).
 * The tabs, the toolbar's search and the project scope of the header are `MemoryFrame`'s, which the map draws too, so the two pages are one
 * column and one band. The header is the title, the 「记忆」 switch and one 「⋯」 (分享与导入 ·
 * 已忘记的内容 · 本项目不使用记忆 · 重置记忆); the page asks nothing of the
 * server to be read — making the capsule on first use moved to opening 分享与导入.
 *
 * Four reads feed it (the memories, the notes of the researcher's own capsule,
 * the methods, the handbooks), each to its last page. When any fails, one line
 * says so with 重试, and a tab whose own read failed shows nothing rather than
 * 「还没有记忆」.
 *
 * Where the reader is lives in the address (design reference A08): `?tab=`,
 * `?project=` on 项目, `?q=` for the search and `?open=` for the row whose
 * drawer is open — so Back from a conversation a drawer linked to, a reload and
 * a pasted link all find the same list with the same row open. A choice the
 * address does not make is the page's own (the first tab with something in it).
 */
export function MemoryHubPage() {
  const [params] = useSearchParams();
  const feature = useMemoryMapFeature();
  // 「成长」 is the map's time view now: an address that names the old tab goes there (where the deployment draws the map), else to the first list.
  if (params.get("tab") === "growth") {
    if (feature === "loading") return <RunsSkeleton filter={false} />;
    return <Navigate to={feature === "on" ? MEMORY_TIME_ADDRESS : memoryTabAddress("self")} replace />;
  }
  return <MemoryHub mapOn={feature === "on"} />;
}

function MemoryHub({ mapOn }: { mapOn: boolean }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const projects = useProjectStore((state) => state.projects);
  const currentProjectId = useProjectStore((state) => state.currentId);
  // The tab the address names, else the one the page picked for the researcher once the data was in (below).
  const [pickedTab, setPickedTab] = useState<MemoryTab>("self");
  const tab = tabFromAddress(params) ?? pickedTab;
  const search = useAddressText("q", 80);
  const query = search.draft;
  // The project the address names, else the one with facts the page picked when the shell's own had none.
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const projectChoice = params.get("project") ?? pickedProject;
  const { value: openKey, open: setOpenKey, close } = useAddressOpen("open");
  const [drawer, setDrawer] = useState<"share" | "forgotten" | "remember" | null>(null);
  const [found, setFound] = useState<WebStructuredMemory[] | null>(null);
  // What the conversations behind a search's hits were about, for the drawer's source link.
  const [searchConversations, setSearchConversations] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [missing, setMissing] = useState<string | null>(null);
  // The tab is chosen for the researcher once: an address that names one, a notice that names a memory or a method, or a tab they
  // clicked is theirs; otherwise the page opens on the first tab that has something in it, when the data is in.
  const [landed, setLanded] = useState(() => tabFromAddress(params) !== null || params.has("record") || params.has("method"));

  // 「刚记住了 … 撤销」 for what changed by itself since the last visit.
  useMemoryWritePrompt();

  // Four reads, each drawn as it arrives: a tab fills when the reads it is made of are in, not when the slowest of the four has answered.
  const { data, reload } = useMemoryReads();
  const readIn = useCallback((names: readonly MemoryRead[]) => names.every((name) => data[name] !== undefined), [data]);

  // Server-side, and debounced: the box used to be a `toLowerCase().includes` over the rows already loaded, so it could only find what was on screen.
  useEffect(() => {
    const text = query.trim();
    if (!text) { setFound(null); setSearchFailed(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void searchMemories(text).then(
        (page) => { setFound(page.items); setSearchConversations(page.conversations ?? {}); setSearchFailed(false); },
        () => setSearchFailed(true),
      ).finally(() => setSearching(false));
    }, 250);
    return () => { clearTimeout(timer); setSearching(false); };
  }, [query, searchAttempt]);

  const labels = useProjectLabels();
  const projectName = (id: string | null) => (id ? labels.get(id) ?? null : null);
  const knownProjects = useMemo(() => new Set(projects.map((project) => project.id)), [projects]);

  const records = useMemo(() => data.profile?.records ?? [], [data.profile]);
  const entries = useMemo(() => data.mine?.entries ?? [], [data.mine]);
  const facts = useMemo(() => factItems(found ?? records, entries, { query }), [found, records, entries, query]);
  const everyPractice = useMemo(() => practiceItems(data.methods ?? [], data.handbooks ?? []), [data.methods, data.handbooks]);
  const practices = useMemo(() => practiceItems(data.methods ?? [], data.handbooks ?? [], { query }), [data.methods, data.handbooks, query]);

  const self = facts.filter((fact) => fact.group === "self");
  const choices = useProjectChoices(facts);
  // The project shown: the researcher's choice, else the one the shell is in — and a choice the account no longer has is not one.
  const scope = choices.some((choice) => choice.id === projectChoice) ? projectChoice
    : choices.some((choice) => choice.id === currentProjectId) ? currentProjectId : choices[0]?.id ?? null;
  const projectFacts = factsOfProject(facts, scope, knownProjects);
  // Every memory the page holds, whatever the search shows: the project card opens its memories from here.
  const everyFact = useMemo(() => factItems(records, entries), [records, entries]);
  // The top of the 项目 tab: the card, what the project did and what it delivered. Not while a search is on — that is a list of hits.
  const { overview, reload: reloadOverview } = useProjectOverview(tab === "project" && !query.trim() ? scope : null);

  // An inbox notice names a memory (`?record=`) or a method (`?method=`): its drawer opens, and the address is cleared so a reload does not open it again.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const recordId = params.get("record");
    const methodId = params.get("method");
    if (!recordId && !methodId) { handled.current = true; return; }
    // The reads the address names, not all four: a link to a memory opens when the memories are in, whatever the methods are doing.
    if (!readIn(recordId ? SOURCES_OF.self : SOURCES_OF.methods)) return;
    handled.current = true;
    const next = new URLSearchParams(params);
    if (recordId) {
      const target = facts.find((fact) => fact.kind === "record" && fact.record.id === recordId)
        ?? factItems(records, entries).find((fact) => fact.kind === "record" && fact.record.id === recordId);
      if (target) {
        next.set("tab", target.group);
        if (target.group === "project" && target.projectId) next.set("project", target.projectId);
        next.set("open", target.key);
      }
    } else if (methodId) {
      const target = everyPractice.methods.find((item) => item.kind === "method" && item.method.id === methodId);
      next.set("tab", "methods");
      if (target) next.set("open", target.key);
      else setMissing(data.methods === null ? "暂时读不到已学做法，请重试。" : "当前列表中没有找到这条做法。");
    }
    next.delete("record");
    next.delete("method");
    setParams(next, { replace: true });
  }, [data.methods, readIn, params, setParams, facts, records, entries, everyPractice]);

  const serviceDown = data.serviceDown;
  const unread = (["profile", "mine", "methods", "handbooks"] as const).filter((name) => data[name] === null && !(serviceDown && name === "profile"));
  const tabUnread = SOURCES_OF[tab].some((name) => unread.includes(name));
  // What 「记住这一条」 asked and is not written yet (about twelve seconds), and whether that is taking longer than it should.
  const pending = useMemo(() => data.profile?.pending ?? [], [data.profile]);
  const pendingState = usePendingMemory(pending, reload);
  const native = data.profile?.engine === "native";

  // 关于你 is the first tab and, for most accounts early on, the empty one while 项目 and 做法 hold what was learned: landing on an
  // empty list reads as 「什么都没记住」. A tab whose read failed is not known to be empty, so the choice stops there. The choice is made as
  // the reads come in, in the tabs' order: the first tab whose reads are in and that holds something, and no later one is waited for.
  useEffect(() => {
    if (landed) return;
    const everyFact = factItems(records, entries);
    const holds: [MemoryTab, number][] = [
      ["self", everyFact.filter((fact) => fact.group === "self").length],
      ["project", everyFact.filter((fact) => fact.group === "project").length],
      ["methods", everyPractice.methods.length + everyPractice.handbooks.length],
    ];
    for (const [candidate, rows] of holds) {
      if (!readIn(SOURCES_OF[candidate])) return;
      if (SOURCES_OF[candidate].some((name) => data[name] === null)) { setLanded(true); return; }
      if (rows === 0) continue;
      if (candidate === "project") {
        // The dropdown names one project at a time: open the first that has facts when the shell's own has none.
        const withFacts = choices.find((choice) => factsOfProject(everyFact, choice.id, knownProjects).length > 0);
        if (withFacts && factsOfProject(everyFact, scope, knownProjects).length === 0) setPickedProject(withFacts.id);
      }
      if (candidate !== "self") setPickedTab(candidate);
      setLanded(true);
      return;
    }
    setLanded(true);
  }, [landed, data, readIn, records, entries, everyPractice, choices, scope, knownProjects]);

  // A tab with nothing in it carries no number: 「做法 0」 is a statistic about an empty list, which its empty state already says.
  // The tab's own reads decide when its number is drawn, and until the page has chosen where to land no list is: it would be the wrong one.
  const loading = (name: MemoryTab) => !readIn(SOURCES_OF[name]);
  const counts: Record<MemoryTab, number | undefined> = {
    self: loading("self") ? undefined : self.length,
    project: loading("project") ? undefined : projectFacts.length,
    methods: loading("methods") ? undefined : practices.methods.length + practices.handbooks.length,
  };
  const scrollAnchor = usePageScroll(readIn(SOURCES_OF[tab]) && landed);

  const opened: FactItem | PracticeItem | null = openKey
    ? [...facts, ...everyFact, ...everyPractice.methods, ...everyPractice.handbooks].find((item) => item.key === openKey) ?? null
    : null;
  const setProjectChoice = (id: string | null) => { if (id) setParams((current) => withParam(current, "project", id), { replace: true }); };
  const chooseTab = (next: MemoryPageTab) => {
    // 地图 is a page of its own that reads as this page's last tab.
    if (next === "map") { navigate(memoryTabAddress("map")); return; }
    setLanded(true);
    setParams((current) => withParam(current, "tab", next));
  };
  // Where a conversation begun from an empty tab goes: the project the 项目 tab names, else the one the shell is in (what is said about the
  // person belongs to the account, whichever project it is said in). The words are left in the composer, unsent.
  const speakProject = tab === "project" && scope && scope !== OTHER_PROJECT ? scope : currentProjectId;
  const speak = useKnowledgeConversation(speakProject ?? "");
  const speakAbout = (draft: string) => (speakProject ? () => speak(draft, []) : undefined);

  const factRows = (rows: readonly FactItem[], label: string) => (
    <List label={label}>
      {rows.map((fact) => (
        <MemoryListRow key={fact.key} title={factRowTitle(fact)} summary={factRowSummary(fact)} muted={fact.kind === "record" && fact.record.status === "superseded"} onOpen={() => setOpenKey(fact.key)} />
      ))}
    </List>
  );
  // Waiting words head the two lists of memories, but not a search: that is a list of hits.
  const waiting = pending.length > 0 && !query.trim() ? <PendingMemoryRows items={pending} slow={pendingState.slow} /> : null;
  // An empty list says what will be here and gives the one thing to do about it — or, where nothing can be done (a practice is learned,
  // never typed), why there is no button. A search with no hit has the box's own 「清除搜索」 over it, and says only that.
  const empty = (title: string, description: string, action?: { label: string; onPress: (() => void) | undefined }) => (
    query.trim()
      ? <EmptyState icon={Brain} title="没有找到" reason="换个关键词试试，或清空搜索框看全部。" />
      : <EmptyState icon={Brain} title={title} description={action?.onPress ? description : undefined} reason={action?.onPress ? undefined : description}
        action={action?.onPress ? <Button onClick={action.onPress}>{action.label}</Button> : undefined} />
  );

  const list = () => {
    if (loading(tab) || !landed || (searching && !found && tab !== "methods")) return <RunsSkeleton filter={false} />;
    if (serviceDown && (tab === "self" || tab === "project")) {
      return <LoadError message={knownErrorCodeMessage("memory_engine_unavailable") ?? "记忆服务暂时不可用。"} onRetry={reload} />;
    }
    if (tabUnread) return null;
    if (tab === "self") {
      if (self.length === 0) {
        return waiting ?? empty("还没有关于你的记忆", "你在对话里说过的偏好、背景和写作习惯会出现在这里。", { label: "在对话里说说你自己", onPress: speakAbout(SELF_DRAFT) });
      }
      return (
        <div className="space-y-6">
          {waiting}
          {SELF_SECTIONS.map((section) => {
            const rows = self.filter((fact) => fact.section === section.key);
            return rows.length === 0 ? null : (
              <GroupSection key={section.key} title={section.label}>
                {factRows(rows, `${section.label}`)}
              </GroupSection>
            );
          })}
        </div>
      );
    }
    if (tab === "project") {
      // Something sits above the list when the card, the ranking or the works have something to say, when the project's memory is
      // switched off, or when the card is the one quiet line a project with memories and no card yet gets.
      const above = overview !== null && (overview.paused || overview.card.length + overview.capabilities.length + overview.works.length > 0
        || projectFacts.length > 0);
      return (
        <div className="space-y-4">
          {overview && (
            <ProjectOverview
              overview={overview}
              hasMemories={projectFacts.length > 0}
              onSpeak={speakAbout(PROJECT_DRAFT)}
              canOpen={(recordId) => everyFact.some((fact) => fact.key === `record:${recordId}`)}
              onOpen={(recordId) => setOpenKey(`record:${recordId}`)}
            />
          )}
          {waiting}
          {projectFacts.length === 0 ? (waiting ? null : empty("这个项目还没有记忆", "你在对话里说过的目标、资料和已定的事会出现在这里。", { label: "在对话里说说这个项目", onPress: scope === null || scope === OTHER_PROJECT ? undefined : speakAbout(PROJECT_DRAFT) }))
            // Under the card, the ranking and the works, the list needs its own name; alone, the tab names it.
            : above ? <GroupSection title="记忆">{factRows(projectFacts, "项目的记忆")}</GroupSection>
              : factRows(projectFacts, "项目的记忆")}
        </div>
      );
    }
    if (practices.methods.length + practices.handbooks.length === 0) return empty("还没有学到的做法", "做的研究多了，会从中学到做法，出现在这里。");
    return (
      <div className="space-y-6">
        {practices.methods.length > 0 && (
          <GroupSection title="所有研究都会用">
            <List label="所有研究都会用的做法">
              {practices.methods.map((item) => <MemoryListRow key={item.key} title={item.title} summary={item.summary} onOpen={() => setOpenKey(item.key)} />)}
            </List>
          </GroupSection>
        )}
        {practices.handbooks.length > 0 && (
          <GroupSection title="用在某个科研工具里">
            <List label="用在某个科研工具里的做法">
              {practices.handbooks.map((item) => (
                <MemoryListRow key={item.key} title={item.title} summary={item.summary} end={<span className="text-caption text-text-3">{item.tool}</span>} onOpen={() => setOpenKey(item.key)} />
              ))}
            </List>
          </GroupSection>
        )}
      </div>
    );
  };

  return (
    <MemoryFrame
      tab={tab}
      counts={counts}
      map={mapOn}
      onTab={chooseTab}
      scope={tab === "project" && choices.length > 0 ? { label: "项目", groups: projectScopeGroups(choices), value: scope, onChange: setProjectChoice } : undefined}
      actions={(
        <MemoryControls
          onReset={reload}
          onSettingsChanged={reloadOverview}
          onShare={() => setDrawer("share")}
          onForgotten={() => setDrawer("forgotten")}
          onRemember={native ? () => setDrawer("remember") : undefined}
        />
      )}
      toolbar={{ label: "搜索记忆", search: { label: "搜索记忆", value: query, maxLength: 80, onChange: search.setDraft, onClear: search.clear, inputProps: search.composition } }}
    >
      <span ref={scrollAnchor} hidden />
      {unread.length > 0 && <LoadError className="mb-4" message="没有读到全部记忆。" onRetry={reload} />}
      {searchFailed && <LoadError className="mb-4" message="搜索没有完成。" onRetry={() => setSearchAttempt((value) => value + 1)} />}
      {missing && <p role="status" className="mb-4 text-ui text-text-2">{missing}</p>}
      <div>{list()}</div>

      {opened?.kind === "record" || opened?.kind === "entry" ? (
        <FactDrawer
          key={opened.key}
          item={opened}
          projectName={opened.group === "project" ? projectName(opened.projectId) : null}
          conversations={{ ...data.profile?.conversations, ...searchConversations }}
          siblings={records}
          onClose={close}
          onChanged={reload}
          onOpenRecord={(recordId) => setOpenKey(`record:${recordId}`)}
          canOpenRecord={(recordId) => everyFact.some((fact) => fact.key === `record:${recordId}`)}
        />
      ) : opened?.kind === "method" ? (
        <MethodDrawer key={opened.key} method={opened.method} onClose={close} onChanged={reload} />
      ) : opened?.kind === "handbook" ? (
        <HandbookDrawer key={opened.key} handbook={opened.handbook} tool={opened.tool} onClose={close} onChanged={reload} />
      ) : null}
      {drawer === "remember" && (
        <RememberDialog
          projectId={tab === "project" && scope && scope !== OTHER_PROJECT ? scope : null}
          onClose={() => setDrawer(null)}
          onAsked={reload}
        />
      )}
      {drawer === "share" && <ShareDrawer onClose={() => setDrawer(null)} onImported={reload} />}
      {drawer === "forgotten" && (
        <ForgottenDrawer
          records={records}
          entries={data.mine?.forgotten ?? []}
          projectName={projectName}
          onClose={() => setDrawer(null)}
          onChanged={reload}
        />
      )}
    </MemoryFrame>
  );
}
