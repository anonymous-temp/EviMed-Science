import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronLeft, Download, RefreshCw } from "lucide-react";
import { hasWebApi, fetchWebMe } from "@/lib/apiClient";
import { downloadKnowledgeVault, getSourceComposition, listProjectOutputs, vaultErrorMessage, type LibraryComposition as Composition, type ProjectOutput } from "@/lib/knowledgeBaseClient";
import { listPath, type KnowledgeListState, type KnowledgeView } from "@/lib/knowledgeNav";
import { productErrorMessage } from "@/lib/productClient";
import { knowledgePagesOffered, requestKnowledgeCompile } from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { buttonClasses } from "@/components/ui/Button";
import { ActivityStrip } from "@/components/ui/ActivityStrip";
import { Menu } from "@/components/ui/Menu";
import { StepState } from "@/components/ui/StepState";
import { Toolbar, type ToolbarChips, type ToolbarProps } from "@/components/ui/Toolbar";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { KnowledgeStatusDot } from "./KnowledgeStatusDot";
import { KnowledgeTree, KnowledgeTreeMissing } from "./KnowledgeTree";
import { LibraryComposition } from "./LibraryComposition";
import { ProjectOutputsList } from "./ProjectOutputsList";
import { groupRows, statusLine } from "./knowledgeView";
import { roundKey, useKnowledgeStatus, useKnowledgeTree } from "./useKnowledge";

/** Whether the deployment compiles knowledge pages at all (`features.knowledgePages`), read once. */
export function usePagesOffered(): boolean {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let active = true;
    fetchWebMe().then((me) => { if (active) setOffered(knowledgePagesOffered(me)); }).catch(() => { /* not offered */ });
    return () => { active = false; };
  }, []);
  return offered;
}

/**
 * What the knowledge base says of one project — the part of it that is a project's and not the account's: the pages the platform compiled
 * from its documents (知识页), the picture of them (图谱) and the files its conversations delivered (对话产出). The documents themselves are
 * the account's and are the other view; this is the pane the project list on the left chooses in.
 *
 * The header is the project's name, the one dot that says when its pages need attention (`KnowledgeStatusDot`) and 「更多」, which holds what
 * is the project's to do: 重新整理知识页, 导出到 Obsidian, 在记忆总览中查看. Under it, the compile's activity while a round runs, the one row
 * of controls — the search, and for the graph the kind of graph — and the view. 「资料组成」, what the project's documents are made of, stands
 * at the head of the pages. Where the list is not beside the pane (a narrow window) a way back to the projects stands over the title.
 */
export function ProjectKnowledge({ projectId, label, view, listState, update, pagesOffered, query, onQuery, split, onAddDocuments }: {
  projectId: string;
  label: string;
  view: Exclude<KnowledgeView, "documents">;
  listState: KnowledgeListState;
  update: (patch: Partial<KnowledgeListState>) => void;
  pagesOffered: boolean;
  /** What the search box holds, and how it changes (the page keeps it, with the address following). */
  query: string;
  onQuery: (value: string) => void;
  /** The project list is beside this pane. */
  split: boolean;
  /** 「添加资料」 where the pages have nothing to be made of yet: the page's own upload, aimed at this project. */
  onAddDocuments: (projectId: string) => void;
}) {
  const navigate = useNavigate();
  const { status: knowledge, setStatus: setKnowledge } = useKnowledgeStatus(projectId, pagesOffered);
  const knowledgeRound = roundKey(knowledge);
  const line = pagesOffered ? statusLine(knowledge) : null;
  const compiling = line?.busy === true;
  const [asking, setAsking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const compileNow = async () => {
    setAsking(true);
    try { setKnowledge(await requestKnowledgeCompile(projectId)); toast.success("已开始重新整理，稍后回来即可看到"); }
    catch (failure) { toast.error(productErrorMessage(failure)); }
    finally { setAsking(false); }
  };
  const exportVault = async () => {
    setExporting(true);
    try { await downloadKnowledgeVault(projectId); }
    catch (failure) { toast.error(`没能导出：${vaultErrorMessage(failure)}`); }
    finally { setExporting(false); }
  };

  // 「对话产出」: the files the project's conversations delivered. An index of the run ledger; nothing in it is a document of the library.
  const [outputs, setOutputs] = useState<ProjectOutput[] | null>(null);
  const [outputsFailed, setOutputsFailed] = useState(false);
  const [outputsAttempt, setOutputsAttempt] = useState(0);
  useEffect(() => {
    if (view !== "outputs") return undefined;
    setOutputs(null);
    setOutputsFailed(false);
    let active = true;
    listProjectOutputs(projectId).then(
      (items) => { if (active) setOutputs(items); },
      () => { if (active) { setOutputs([]); setOutputsFailed(true); } },
    );
    return () => { active = false; };
  }, [view, projectId, outputsAttempt]);

  // 「资料组成」: what the project's documents are made of, counted by the control plane and read again when a round ends. An addition to
  // the page: a read that fails leaves the page without it.
  const [composition, setComposition] = useState<Composition | null>(null);
  useEffect(() => {
    setComposition(null);
    if (view !== "pages") return undefined;
    let active = true;
    getSourceComposition(projectId).then(
      (value) => { if (active) setComposition(value); },
      () => { /* the page stands without it */ },
    );
    return () => { active = false; };
  }, [view, projectId, knowledgeRound]);

  // The compiled files: the tree is read for the project, so the pages view can say how many it holds.
  const { tree, failed: treeFailed, retry: retryTree } = useKnowledgeTree(projectId, view !== "outputs", knowledgeRound);
  const pageCount = tree ? groupRows(tree.pages).reduce((sum, group) => sum + group.rows.length, 0) : 0;

  // What the pages and the graph say when there is nothing to show: what the pages are made of, what they will be, and the one thing to do.
  // A round that is running is not an empty page (the strip over the view says so), and a project that has enough documents is asked to
  // compile, not to add more. Until the compile's own status is read the recipe waits for it where the deployment compiles at all.
  const readable = knowledge?.readable ?? 0;
  const missing = knowledge ? Math.max(1, knowledge.minSources - knowledge.readable) : null;
  const recipe = pagesOffered && knowledge === null ? <FilesSkeleton /> : (
    <StepState
      phase="empty" step={line?.canCompile ? "整理知识页" : "添加资料"} noun="知识页"
      uses={[{ label: `这个项目的 ${readable} 份资料${knowledge?.state === "below_threshold" && missing ? `（还差 ${missing} 份）` : ""}`, onOpen: () => navigate(listPath({ scope: null, kind: null, q: "" })) }]}
      gives="按类整理好的页面，和页面之间的关系图"
      onStart={hasWebApi ? (line?.canCompile ? () => void compileNow() : () => onAddDocuments(projectId)) : undefined}
      starting={line?.canCompile ? asking : false}
      reason="还不能添加资料。"
    />
  );

  // The graph's two kinds are a view of the same project, not a narrowing of a list: navigation, not a filter.
  const graphNavigation: ToolbarChips[] = [{
    kind: "chips", label: "图谱的类型", neutral: "wiki", options: [{ value: "wiki", label: "页面之间" }, { value: "kg", label: "实体和关系" }],
    value: listState.graph === "kg" ? "kg" : "wiki", pinned: true, onChange: (next) => update({ graph: next === "kg" ? "kg" : null, focus: null, depth: null }),
  }];
  const toolbar: ToolbarProps = {
    label: view === "pages" ? "知识页的搜索" : view === "graph" ? "图谱的筛选" : "对话产出的搜索",
    filters: [],
    navigation: view === "graph" ? graphNavigation : [],
    search: { label: view === "outputs" ? "搜索对话产出" : "搜索资料和内容", value: query, onChange: onQuery, onClear: () => onQuery("") },
    summary: view === "pages" ? (pageCount > 0 ? `${pageCount} 页` : undefined) : view === "outputs" ? (outputs ? `${outputs.length} 个文件` : undefined) : undefined,
  };
  // The tree is searched by what is typed; a typed search stays with the view it was typed in.
  const search = listState.q;

  const pagesBody = treeFailed && !tree ? (
    <KnowledgeTreeMissing onRetry={retryTree} />
  ) : !tree || (compiling && tree.pages.length === 0) ? <FilesSkeleton /> : <KnowledgeTree rows={tree.pages} query={search} listState={listState} empty={recipe} />;

  const backToProjects = useMemo(() => listPath({ ...listState, scope: null, focus: null, depth: null }), [listState]);
  return (
    <div data-project-knowledge={projectId} className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-6 py-6">
        {!split && (
          <nav aria-label="返回" className="-mt-2 mb-2 flex min-w-0 items-center">
            <Link to={backToProjects} className={buttonClasses({ variant: "text", size: "sm", className: "-ml-2 gap-1 px-2 text-text-3 hover:text-text" })}>
              <ChevronLeft size={16} aria-hidden="true" />项目
            </Link>
          </nav>
        )}
        <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
            <h2 className="line-clamp-2 text-section font-semibold text-text">{label}</h2>
            {pagesOffered && <KnowledgeStatusDot status={knowledge} asking={asking} onCompile={() => void compileNow()} />}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Menu label="更多" items={[
              { label: "在记忆总览中查看", onSelect: () => navigate("/app/memory/overview") },
              ...(pagesOffered && line?.canCompile ? [{ label: asking ? "正在重新整理" : "重新整理知识页", icon: RefreshCw, disabled: asking, onSelect: () => void compileNow() }] : []),
              { label: exporting ? "正在导出" : "导出到 Obsidian", icon: Download, disabled: exporting || !hasWebApi, onSelect: () => void exportVault() },
            ]} />
          </div>
        </header>
        {compiling && knowledge && (
          <div className="mb-3">
            <ActivityStrip
              label="整理知识页"
              phase={[knowledge.pages > 0 ? `已有 ${knowledge.pages} 页` : "", knowledge.typedPages.kg > 0 ? `${knowledge.typedPages.kg} 个实体` : ""].filter(Boolean).join("，") || undefined}
              startedAt={knowledge.stage?.startedAt ?? null}
              {...(knowledge.state === "queued" ? { waiting: "资料有更新，稍后会自动开始" } : {})}
            />
          </div>
        )}
        <div className="mb-4"><Toolbar {...toolbar} /></div>
        {view === "pages" && composition && <LibraryComposition composition={composition} />}
        {view === "pages" && pagesBody}
        {view === "graph" && (
          <KnowledgeGraphView projectId={projectId} kind={listState.graph === "kg" ? "kg" : "wiki"} listState={listState} version={knowledgeRound} onChange={update} empty={recipe} />
        )}
        {view === "outputs" && <ProjectOutputsList items={outputs} failed={outputsFailed} query={search} onRetry={() => setOutputsAttempt((value) => value + 1)} />}
      </div>
    </div>
  );
}
