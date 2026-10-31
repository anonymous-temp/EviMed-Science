import { Toolbar } from "@/components/ui/Toolbar";
import { GraphView, type GraphActions } from "@/components/memory/map/GraphView";
import type { NarrowedMap } from "@/components/memory/map/mapModel";
import { StarMapView } from "@/components/memory/map/star/StarMapView";
import { TopicsView } from "@/components/memory/map/TopicsView";
import type { MapEdge, MapTopic, MemoryMap } from "@/lib/memoryMapClient";
import type { ExploreView } from "./useOverviewSelection";

const WORDS: Readonly<Record<ExploreView, string>> = { star: "星图", graph: "关系", topics: "主题" };

/**
 * 「星图、关系与主题」: what is remembered as a night sky (星图, where a real GPU and a wide screen are there, `useStarAllowed`), as the lines between the memories (关系) or as what they
 * are about (主题), one at a time over the same document and the same selection, switched by the one switch at the end of the card's heading. The heading is the card's own conclusion
 * — 「42 件现行的记忆，连着 14 份资料和 4 个项目」 or 「记忆分成 6 个主题」 — so the block is one card of the kind the change chart is, and not a section holding a card.
 * Every mark opens the drawer the table's rows open; a topic chosen narrows the chart and the table, and a press on it again lets go.
 *
 * The switch is a block's own view switch standing in its card (`Toolbar`'s `views`, as the drawer of 分享与导入 has its two): the same underlined tabs
 * as the page's tab bar, not a new look for the page to pay for. The page draws this only when there is something to see, and offers only the views that have something to show (`views`).
 */
export function ExplorePanel({ explore, views, onExplore, doc, layoutDoc, narrowed, actions, selectedMark, topics, topic, grouping, topicsStatus, onChooseTopic, onHideEdge, onChanged, onStarUnavailable }: {
  explore: ExploreView;
  views: readonly ExploreView[];
  onExplore: (next: ExploreView) => void;
  doc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  /** The whole document, so that narrowing never moves a star. */
  layoutDoc: Pick<MemoryMap, "nodes" | "edges" | "truncated">;
  narrowed: NarrowedMap;
  actions: GraphActions;
  /** The mark whose drawer is open: it is lit in the picture. */
  selectedMark: string | null;
  topics: readonly MapTopic[];
  topic: string | null;
  grouping: boolean;
  topicsStatus: "ready" | "stale" | "empty" | "off";
  onChooseTopic: (id: string | null) => void;
  onHideEdge: (edge: MapEdge) => Promise<void>;
  onChanged: () => void;
  onStarUnavailable: () => void;
}) {
  const name = views.includes("star") ? "星图、关系与主题" : "关系与主题";
  const meta = views.length > 1
    ? <Toolbar label={name} views={{ label: name, items: views.map((value) => ({ value, label: WORDS[value] })), value: explore, onChange: (next) => onExplore(next as ExploreView) }} />
    : undefined;
  if (explore === "star") return <StarMapView layoutDoc={layoutDoc} narrowed={narrowed} selected={selectedMark} actions={actions} meta={meta} onUnavailable={onStarUnavailable} />;
  return explore === "graph"
    ? <GraphView doc={doc} narrowed={narrowed} selected={selectedMark} actions={actions} onHideEdge={onHideEdge} meta={meta} />
    : <TopicsView topics={topics} selected={topic} grouping={grouping} status={topicsStatus} onChoose={onChooseTopic} onChanged={onChanged} meta={meta} />;
}
