import { FilterChips } from "@/components/ui/FilterChips";
import { Tabs } from "@/components/ui/Tabs";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import type { KnowledgeListState } from "@/lib/knowledgeNav";
import type { ReactNode } from "react";
import { KnowledgeGraphView } from "./KnowledgeGraphView";
import { KnowledgeTree, KnowledgeTreeMissing } from "./KnowledgeTree";
import { useKnowledgeTree } from "./useKnowledge";

type View = "pages" | "graph";

/**
 * What the 知识页 filter of the knowledge base shows: the project's compiled files, as a tree by type or as a graph (the pages
 * and their links, or the entities and their relations). The view, the graph's kind, the mark in focus and how far it reaches are
 * in the address, so a reload and the way back from a page land on the picture as it was. Where the tree cannot be read, the
 * plain list of documents (`fallback`) stands in for it.
 */
export function KnowledgePanel({ projectId, listState, version, onChange, fallback }: {
  projectId: string;
  listState: KnowledgeListState;
  /** What the last compile left; both views are read again when it changes. */
  version: string;
  onChange: (patch: Partial<KnowledgeListState>) => void;
  fallback: ReactNode;
}) {
  const view: View = listState.view === "graph" ? "graph" : "pages";
  const { tree, failed, retry } = useKnowledgeTree(projectId, view === "pages", version);
  return (
    <div data-knowledge-panel={view}>
      <Tabs label="知识页的视图" className="mb-4" value={view} onChange={(next) => onChange(next === "graph"
        ? { kind: "wiki", view: "graph", graph: null, focus: null, depth: null } : { view: null, graph: null, focus: null, depth: null })}
        items={[{ value: "pages", label: "页面" }, { value: "graph", label: "图谱" }]} />
      {view === "graph" ? (
        <>
          <FilterChips label="图谱的类型" className="mb-3" value={listState.graph === "kg" ? "kg" : "wiki"}
            onChange={(next) => onChange({ graph: next === "kg" ? "kg" : null, focus: null, depth: null })}
            options={[{ value: "wiki", label: "页面之间" }, { value: "kg", label: "实体和关系" }]} />
          <KnowledgeGraphView projectId={projectId} kind={listState.graph === "kg" ? "kg" : "wiki"} listState={listState} version={version} onChange={onChange} />
        </>
      ) : failed && !tree ? (
        <>
          <KnowledgeTreeMissing onRetry={retry} />
          {fallback}
        </>
      ) : !tree ? <FilesSkeleton /> : <KnowledgeTree rows={tree.pages} query={listState.q} listState={listState} />}
    </div>
  );
}
