import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useAddressOpen, useAddressText } from "@/lib/addressState";
import { useCapsuleData } from "@/components/capsule/useCapsuleData";
import { usePageScroll } from "@/lib/pageScroll";
import { Brain } from "lucide-react";
import { searchMemories, type WebStructuredMemory } from "@/lib/apiClient";
import type { ReceivedCapsule } from "@/lib/memoryClient";
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
import { MEMORY_OVERVIEW_ADDRESS, memoryTabAddress, MemoryFrame, type MemoryTab } from "@/components/memory/MemoryFrame";
import { GroupSection, MemoryListRow, PendingMemoryRows } from "@/components/memory/MemoryRows";
import { MethodDrawer } from "@/components/memory/PracticeDrawer";
import { enabledPackCount, ReceivedTab } from "@/components/memory/ReceivedTab";
import { readHandover } from "@/components/memory/handover";
import { factItems, factRowSummary, OTHER_PROJECT_LABEL, practiceItems, type FactItem, type PracticeItem } from "@/components/memory/memoryItems";
import { ImportDialog } from "@/components/memory/ImportDialog";
import { RememberDialog } from "@/components/memory/RememberDialog";
import { useMemoryReads, type MemoryRead } from "@/components/memory/useMemoryReads";
import { usePendingMemory } from "@/components/memory/usePendingMemory";
import { useMemoryWritePrompt } from "@/components/memory/useMemoryWritePrompt";
import { useKnowledgeConversation } from "@/components/sources/useKnowledgeConversation";
import { ShareDrawer, type ShareTab } from "./CapsuleTransferPanel";
import { knownErrorCodeMessage } from "@evimed/domain";

/**
 * Which section an address asks for. `?tab=methods` is the link the skills page
 * has always carried and `?tab=capsules` the old `/app/capsules` redirect;
 * both were ignored, so every deep link landed on the one list there was.
 */
function tabFromAddress(params: URLSearchParams): MemoryTab | null {
  if (params.get("method")) return "methods";
  const named = params.get("tab");
  return named === "methods" || named === "self" || named === "received" ? named : null;
}

/** The reads a section needs that did not answer, named by section: a list that could not be read is never an empty one. */
const SOURCES_OF: Record<MemoryTab, readonly MemoryRead[]> = {
  self: ["profile", "mine"], methods: ["methods"], received: ["received"],
};

/** What a conversation begun from an empty list leaves in the composer, unsent: the blanks are the person's to fill. */
const SELF_DRAFT = "请记住关于我的这些：\n\n我的专业和背景：\n我的写作和回答偏好：\n我常做的事：";

/**
 * 「记忆胶囊」 (2026-10-07 plan §3.2, mockup m01): what EviMed keeps about the
 * researcher, as three lists beside a left column (`MemoryFrame`), and every
 * row opens a drawer on the right.
 *
 *  - 关于你: facts about the person — background, preferences, how they work
 *    and write — under small headers; at the end, 「项目记忆」: the memories that
 *    carry a project (the card its facts were written under, decisions, working
 *    facts, open items), each row naming its project in plain text. A person has
 *    one capsule and a project is a label on a memory, so there is no section
 *    for a project (owner, 2026-10-28: the 项目 tab's card, its capability table
 *    and its works were a second, smaller page about one project, and its list of
 *    memories was empty for most accounts); `?tab=project` arrives here.
 *  - 做法: what the platform learned, read, stopped, or taken back to the
 *    version before. Never typed in: methods are learned, not written (owner
 *    ruling 2026-09-20).
 *  - 收到的: the packs other people shared and the platform's starter packs, one row each — a switch puts one in force, a press opens
 *    what is in it — and, above them, what this account could hand over (2026-10-27; it was a card of 总览).
 *  - 总览 (`/app/memory/overview`): a data page of its own that wears this page's frame — the capsule as four numbers, the changes over
 *    time and, with enough to see, the relations and topics (the map's former tab). 「成长」 was a tab until 2026-10-17: the line of how
 *    much the capsule held said "grew to 75" over a line that fell to 42; `?tab=growth` arrives at the overview.
 *
 * What the page no longer has, and why: the two stat blocks and 「查看做法」
 * counted the same methods three ways and moved nothing the reader could see;
 * 「效果待观察」 and 「完成对照评估」 were a state no code could change (no
 * evaluator can compare a method with and without it under the learning
 * budget); 「推断」 sat on every row of a page where nearly every row is
 * learned, and then once in every drawer: whose words a memory is, is not said
 * on the page at all (owner ruling of 2026-10-10).
 * The navigation, the switch, 「记住这一条」, the 「⋯」 menu (分享与导入 · 已忘记的内容 · 当前项目（…）不使用记忆 · 重置记忆) and the section's
 * toolbar are `MemoryFrame`'s, which the overview draws too, so the two pages are one frame; the page asks nothing of the server to be
 * read — making the capsule on first use moved to opening 分享与导入.
 *
 * Three reads feed it (the memories, the notes of the researcher's own capsule,
 * the methods), each to its last page. When any fails, one line says so with
 * 重试, and a list whose own read failed shows nothing rather than 「还没有记忆」.
 *
 * Where the reader is lives in the address (design reference A08): `?tab=`,
 * `?q=` for the search and `?open=` for the row whose drawer is open — so
 * Back from a conversation a drawer linked to, a reload and a pasted link all
 * find the same list with the same row open. A choice the address does not make
 * is the page's own (the first list with something in it).
 */
export function MemoryHubPage() {
  const [params] = useSearchParams();
  const feature = useMemoryMapFeature();
  // A plain entry opens the overview, the capsule as one picture; explicit list, search and record links keep their destination.
  if (params.size === 0) {
    if (feature === "loading") return <RunsSkeleton filter={false} />;
    if (feature === "on") return <Navigate to={MEMORY_OVERVIEW_ADDRESS} replace />;
  }
  // 「成长」 is the overview's chart now: an address that names the old tab goes to the overview
  // (where the deployment draws it), else to the first list. `?tab=capsules` was `/app/capsules`'s and lands on the overview too.
  if (params.get("tab") === "growth" || params.get("tab") === "capsules") {
    if (feature === "loading") return <RunsSkeleton filter={false} />;
    return <Navigate to={feature === "on" ? MEMORY_OVERVIEW_ADDRESS : memoryTabAddress("self")} replace />;
  }
  // 项目 was a section until 2026-10-28: its memories are 关于你's last group now. The address keeps what is still meaningful (the row and the search).
  if (params.get("tab") === "project") {
    const next = new URLSearchParams(params);
    next.set("tab", "self");
    next.delete("project");
    return <Navigate to={`/app/memory?${next.toString()}`} replace />;
  }
  return <MemoryHub overviewOn={feature === "on"} />;
}

/**
 * The 收到的 tab's body: the packs, and above them what this account could hand over. The hand-over is read here, when the tab is open,
 * and not with the lists — it is a preview of an export, and a failed read leaves the sentence out instead of saying nothing is there.
 * With no pack at all the tab is a recipe whose one button opens 分享与导入 on 导入.
 */
function ReceivedPanel({ packs, onShare, onImport, onChanged }: {
  packs: readonly ReceivedCapsule[];
  onShare: () => void;
  onImport: () => void;
  onChanged: () => void;
}) {
  const handover = useCapsuleData(readHandover);
  if (packs.length === 0) {
    return (
      <EmptyState
        icon={Brain} title="还没有收到胶囊" description="别人分享给你的做法，收下后一键就能启用，不会混进你自己的记忆。"
        action={<Button variant="secondary" onClick={onImport}>分享与导入</Button>}
      />
    );
  }
  return <ReceivedTab packs={packs} handover={handover.data} onShare={onShare} onChanged={onChanged} />;
}

function MemoryHub({ overviewOn }: { overviewOn: boolean }) {
  const [params, setParams] = useSearchParams();
  const currentProjectId = useProjectStore((state) => state.currentId);
  // The list the address names, else the one the page picked for the researcher once the data was in (below).
  const named = tabFromAddress(params);
  const [pickedTab, setPickedTab] = useState<MemoryTab>("self");
  const tab = named ?? pickedTab;
  const search = useAddressText("q", 80);
  // The packs received have no search: a handful of rows, and what a search of memories finds is not in them.
  const query = tab === "received" ? "" : search.draft;
  const { value: openKey, open: setOpenKey, close } = useAddressOpen("open");
  const [drawer, setDrawer] = useState<"share" | "forgotten" | "remember" | "import" | null>(null);
  // 分享与导入 opens on the tab the press named: 导出 from the menu and the hand-over sentence, 导入 from the 收到的 toolbar.
  const [shareTab, setShareTab] = useState<ShareTab>("export");
  const openShare = (next: ShareTab) => { setShareTab(next); setDrawer("share"); };
  const [found, setFound] = useState<WebStructuredMemory[] | null>(null);
  // What the conversations behind a search's hits were about, for the drawer's source link.
  const [searchConversations, setSearchConversations] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [missing, setMissing] = useState<string | null>(null);
  // The list is chosen for the researcher once: an address that names one, a notice that names a memory or a method, or a link they
  // pressed is theirs; otherwise the page opens on the first list that has something in it, when the data is in.
  const [chosen, setChosen] = useState(() => params.has("record") || params.has("method"));
  const landed = chosen || named !== null;

  // 「刚记住了 … 撤销」 for what changed by itself since the last visit.
  useMemoryWritePrompt();

  // Four reads, each drawn as it arrives: a list fills when the reads it is made of are in, not when the slowest of the four has answered.
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

  const records = useMemo(() => data.profile?.records ?? [], [data.profile]);
  // The notes in force and, among them, the ones an outside agent proposed that wait for the researcher (待确认 in their drawer).
  const entries = useMemo(() => [...(data.mine?.entries ?? []), ...(data.mine?.candidates ?? [])], [data.mine]);
  const facts = useMemo(() => factItems(found ?? records, entries, { query }), [found, records, entries, query]);
  const everyPractice = useMemo(() => practiceItems(data.methods ?? []), [data.methods]);
  const practices = useMemo(() => practiceItems(data.methods ?? [], { query }), [data.methods, query]);

  // 关于你 is the person's own memories and, after them, the ones that carry a project: one list, one capsule.
  const self = facts.filter((fact) => fact.group === "self");
  const projectFacts = facts.filter((fact) => fact.group === "project");
  // Every memory the page holds, whatever the search shows: a drawer's related memories open from here.
  const everyFact = useMemo(() => factItems(records, entries), [records, entries]);

  // An inbox notice names a memory (`?record=`) or a method (`?method=`): its drawer opens, and the address is cleared so a reload does not open it again.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const recordId = params.get("record");
    const methodId = params.get("method");
    if (!recordId && !methodId) { handled.current = true; return; }
    // The reads the address names, not all three: a link to a memory opens when the memories are in, whatever the methods are doing.
    if (!readIn(recordId ? SOURCES_OF.self : SOURCES_OF.methods)) return;
    handled.current = true;
    const next = new URLSearchParams(params);
    if (recordId) {
      const target = facts.find((fact) => fact.kind === "record" && fact.record.id === recordId)
        ?? factItems(records, entries).find((fact) => fact.kind === "record" && fact.record.id === recordId);
      // A project's memory is a row of 关于你 too.
      if (target) {
        next.set("tab", "self");
        next.set("open", target.key);
      }
    } else if (methodId) {
      const target = everyPractice.find((item) => item.method.id === methodId);
      next.set("tab", "methods");
      if (target) next.set("open", target.key);
      else setMissing(data.methods === null ? "暂时读不到已学做法，请重试。" : "当前列表中没有找到这条做法。");
    }
    next.delete("record");
    next.delete("method");
    setParams(next, { replace: true });
  }, [data.methods, readIn, params, setParams, facts, records, entries, everyPractice]);

  const serviceDown = data.serviceDown;
  // The packs received are the 收到的 list's alone: a failure to read them is not said over the memories.
  const unread = (["profile", "mine", "methods", "received"] as const)
    .filter((name) => data[name] === null && !(serviceDown && name === "profile") && (name !== "received" || tab === "received"));
  const tabUnread = SOURCES_OF[tab].some((name) => unread.includes(name));
  // What 「记住这一条」 asked and is not written yet (about twelve seconds), and whether that is taking longer than it should.
  const pending = useMemo(() => data.profile?.pending ?? [], [data.profile]);
  const pendingState = usePendingMemory(pending, reload);

  // 关于你 is the first list and, for most accounts early on, the empty one while 做法 holds what was learned: landing on an empty list
  // reads as 「什么都没记住」. A list whose read failed is not known to be empty, so the choice stops there. The choice is made as the reads
  // come in, in the lists' order: the first list whose reads are in and that holds something, and no later one is waited for.
  useEffect(() => {
    if (landed) return;
    const holds: [MemoryTab, number][] = [
      ["self", everyFact.length],
      ["methods", everyPractice.length],
    ];
    for (const [candidate, rows] of holds) {
      if (!readIn(SOURCES_OF[candidate])) return;
      if (SOURCES_OF[candidate].some((name) => data[name] === null)) { setChosen(true); return; }
      if (rows === 0) continue;
      if (candidate !== "self") setPickedTab(candidate);
      setChosen(true);
      return;
    }
    setChosen(true);
  }, [landed, data, readIn, everyFact, everyPractice]);

  // A list with nothing in it carries no number: 「做法 0」 is a statistic about an empty list, which its empty state already says.
  // The list's own reads decide when its number is drawn, and until the page has chosen where to land no list is: it would be the wrong one.
  const loading = (name: MemoryTab) => !readIn(SOURCES_OF[name]);
  const counts: Record<MemoryTab, number | undefined> = {
    self: loading("self") ? undefined : facts.length,
    methods: loading("methods") ? undefined : practices.length,
    received: loading("received") ? undefined : enabledPackCount(data.received ?? []),
  };
  const scrollAnchor = usePageScroll(readIn(SOURCES_OF[tab]) && landed);

  const opened: FactItem | PracticeItem | null = openKey
    ? [...facts, ...everyFact, ...everyPractice].find((item) => item.key === openKey) ?? null
    : null;
  // Where a conversation begun from an empty list goes: the project the shell is in (what is said about the person belongs to the account,
  // whichever project it is said in). The words are left in the composer, unsent.
  const speak = useKnowledgeConversation(currentProjectId ?? "");
  const speakAbout = (draft: string) => (currentProjectId ? () => speak(draft, []) : undefined);

  /** A project's memory says whose it is in plain words at its end — a label, not a control; a project the account no longer has is 未归入项目. */
  const factRows = (rows: readonly FactItem[], label: string, named = false) => (
    <List label={label}>
      {rows.map((fact) => (
        <MemoryListRow
          key={fact.key} title={fact.text} summary={factRowSummary(fact)} onOpen={() => setOpenKey(fact.key)}
          end={named ? projectName(fact.projectId) ?? OTHER_PROJECT_LABEL : undefined}
        />
      ))}
    </List>
  );
  // Waiting words head the list of memories, but not a search: that is a list of hits.
  const waiting = pending.length > 0 && !query.trim() ? <PendingMemoryRows items={pending} slow={pendingState.slow} /> : null;
  // An empty list says what will be here and gives the one thing to do about it — or, where nothing can be done (a practice is learned,
  // never typed), why there is no button. A search with no hit has the box's own 「清除搜索」 over it, and says only that.
  const empty = (title: string, description: string, action?: { label: string; onPress: (() => void) | undefined }) => (
    query.trim()
      ? <EmptyState icon={Brain} title="没有找到" reason="换个关键词试试，或清空搜索框看全部。" />
      : <EmptyState icon={Brain} title={title} description={action?.onPress ? description : undefined} reason={action?.onPress ? undefined : description}
        action={action?.onPress ? <Button variant="secondary" onClick={action.onPress}>{action.label}</Button> : undefined} />
  );

  const list = () => {
    if (loading(tab) || !landed || (searching && !found && tab !== "methods")) return <RunsSkeleton filter={false} />;
    if (serviceDown && tab === "self") {
      return <LoadError message={knownErrorCodeMessage("memory_engine_unavailable") ?? "记忆服务暂时不可用。"} onRetry={reload} />;
    }
    if (tabUnread) return null;
    if (tab === "received") {
      return <ReceivedPanel packs={data.received ?? []} onShare={() => openShare("export")} onImport={() => openShare("import")} onChanged={reload} />;
    }
    if (tab === "self") {
      if (facts.length === 0) {
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
          {projectFacts.length > 0 && (
            <GroupSection title="项目记忆">
              {factRows(projectFacts, "项目记忆", true)}
            </GroupSection>
          )}
        </div>
      );
    }
    if (practices.length === 0) return empty("还没有学到的做法", "做的研究多了，会从中学到做法，出现在这里。");
    return (
      <GroupSection title="所有研究都会用">
        <List label="所有研究都会用的做法">
          {practices.map((item) => <MemoryListRow key={item.key} title={item.title} summary={item.summary} onOpen={() => setOpenKey(item.key)} />)}
        </List>
      </GroupSection>
    );
  };

  return (
    <MemoryFrame
      tab={tab}
      counts={counts}
      overview={overviewOn}
      controls={{
        onReset: reload,
        onShare: () => openShare("export"),
        onForgotten: () => setDrawer("forgotten"),
        onRemember: () => setDrawer("remember"),
        onImport: () => setDrawer("import"),
      }}
      toolbar={tab === "received"
        ? { label: "收到的胶囊", actions: <Button size="sm" variant="secondary" onClick={() => openShare("import")}>分享与导入</Button> }
        : { label: "搜索记忆", search: { label: "搜索记忆", value: query, maxLength: 80, onChange: search.setDraft, onClear: search.clear, inputProps: search.composition } }}
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
      ) : null}
      {drawer === "remember" && <RememberDialog onClose={() => setDrawer(null)} onAsked={reload} />}
      {drawer === "import" && <ImportDialog onClose={() => setDrawer(null)} onSaved={reload} />}
      {drawer === "share" && <ShareDrawer initialTab={shareTab} onClose={() => setDrawer(null)} onImported={reload} />}
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
