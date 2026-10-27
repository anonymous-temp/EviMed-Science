import { Toolbar } from "@/components/ui/Toolbar";
import { GraphView, type GraphActions } from "@/components/memory/map/GraphView";
import { TopicsView } from "@/components/memory/map/TopicsView";
import type { NarrowedMap } from "@/components/memory/map/mapModel";
import type { MapEdge, MapTopic, MemoryMap } from "@/lib/memoryMapClient";

const OPTIONS = [{ value: "graph", label: "关系" }, { value: "topics", label: "主题" }] as const;

/**
 * 「关系与主题」: the memories drawn as the lines between them (关系) or as what they are about (主题), one at a time over the same document and
 * the same selection, switched by the one two-way switch at the end of the card's heading. The heading is the card's own conclusion — 「42 件现行的记忆，
 * 连着 14 份资料和 4 个项目」 or 「记忆分成 6 个主题」 — so the block is one card of the kind the change chart is, and not a section holding a card.
 * Every mark opens the drawer the table's rows open; a topic chosen narrows the chart and the table, and a press on it again lets go.
 *
 * The switch is a block's own view switch standing in its card (`Toolbar`'s `views`, as the drawer of 分享与导入 has its two): the same underlined tabs
 * as the page's tab bar, not a new look for the page to pay for. The page draws this only when there is something to see (`exploreOffered`).
 */
export function ExplorePanel({ explore, onExplore, doc, narrowed, actions, selectedMark, topics, topic, grouping, topicsStatus, onChooseTopic, onHideEdge, onChanged }: {
  explore: "graph" | "topics";
  onExplore: (next: "graph" | "topics") => void;
  doc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  narrowed: NarrowedMap;
  actions: GraphActions;
  /** The mark whose drawer is open: it is lit in the graph. */
  selectedMark: string | null;
  topics: readonly MapTopic[];
  topic: string | null;
  grouping: boolean;
  topicsStatus: "ready" | "stale" | "empty" | "off";
  onChooseTopic: (id: string | null) => void;
  onHideEdge: (edge: MapEdge) => Promise<void>;
  onChanged: () => void;
}) {
  const meta = <Toolbar label="关系与主题" views={{ label: "关系与主题", items: OPTIONS, value: explore, onChange: (next) => onExplore(next as "graph" | "topics") }} />;
  return explore === "graph"
    ? <GraphView doc={doc} narrowed={narrowed} selected={selectedMark} actions={actions} onHideEdge={onHideEdge} meta={meta} />
    : <TopicsView topics={topics} selected={topic} grouping={grouping} status={topicsStatus} onChoose={onChooseTopic} onChanged={onChanged} meta={meta} />;
}
