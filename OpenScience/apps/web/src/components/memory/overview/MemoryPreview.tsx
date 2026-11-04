import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { breath, memoryText } from "@/components/memory/memoryNative";
import { markKindWord } from "@/components/memory/map/mapModel";
import { fetchMemoryProfile } from "@/lib/apiClient";
import { fetchMyCapsule } from "@/lib/memoryClient";
import type { MapEdge, MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { memoryExcerpt } from "@/lib/memoryText";
import type { WebMethod } from "@/lib/methodsClient";

type Detail = { key: string; state: "loading" | "ready" | "missing" | "failed"; text?: string };

/**
 * Anatomy: selected mark, its readable content, related marks and a full-detail action.
 * Variants: memory, capsule entry, method, document and an unselected map.
 * States: loading, missing and failed detail reads are distinct; failure has retry.
 * Hit area: related rows and the full-detail button use shared controls.
 * Keyboard: native buttons keep focus on the selected mark until the reader moves it.
 * Long content: readable excerpts wrap and the original drawer holds the full content.
 * Theme: semantic ink and a single rule separate the preview from the map.
 * Responsive: the overview shows this panel only where the content area fits both columns.
 * Verification: MemoryOverviewPage tests and the rendered memory overview.
 */
export function MemoryPreview({ node, doc, methods, projectName, onSelect, onOpen }: {
  node: MapNode | null;
  doc: MemoryMap | null;
  methods: readonly WebMethod[] | null;
  projectName: (id: string | null) => string | null;
  onSelect: (node: MapNode) => void;
  onOpen: (node: MapNode) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [attempt, setAttempt] = useState(0);
  const kind = node?.open?.kind;
  const id = node?.open && "id" in node.open ? node.open.id : null;
  const key = kind && id ? `${kind}:${id}` : "";

  useEffect(() => {
    if (!key || !id || (kind !== "record" && kind !== "entry")) return undefined;
    let active = true;
    setDetail({ key, state: "loading" });
    const read = kind === "record"
      ? fetchMemoryProfile().then((profile) => {
        const record = profile.records.find((item) => item.id === id && item.status !== "archived");
        return record ? memoryText(record) : null;
      })
      : fetchMyCapsule().then((capsule) => capsule.entries.find((entry) => entry.id === id && entry.payload.status !== "retired")?.payload.content ?? null);
    void read.then((text) => {
      if (active) setDetail({ key, state: text === null ? "missing" : "ready", text: text ?? undefined });
    }, () => { if (active) setDetail({ key, state: "failed" }); });
    return () => { active = false; };
  }, [key, kind, id, attempt, doc]);

  const related = useMemo(() => {
    if (!node || !doc) return [];
    const ids = new Set(doc.edges.flatMap((edge: MapEdge) => {
      if (edge.type === "belongs-to") return [];
      if (edge.from === node.id) return [edge.to];
      if (edge.to === node.id) return [edge.from];
      return [];
    }));
    return doc.nodes.filter((item) => ids.has(item.id)).slice(0, 4);
  }, [doc, node]);

  const method = kind === "method" ? methods?.find((item) => item.id === id) : undefined;
  const read = detail?.key === key ? detail : null;
  const text = method?.summary || (read?.state === "ready" ? read.text : "") || node?.description || "";
  const description = text ? memoryExcerpt(kind === "record" ? breath(text) : text, 360) : "";
  const project = node?.projectId ? projectName(node.projectId) : null;
  // Native memory files can be keyed by an internal snake-case topic. Their stored content is the reader's words.
  const title = node && /^[a-z0-9]+(?:_[a-z0-9]+)+$/iu.test(node.label) ? "记忆内容" : node?.label;

  return (
    <aside aria-label="记忆预览" className="min-w-0 border-l border-border pl-6" aria-live="polite">
      <div className="flex items-center gap-2 text-caption text-text-3"><Sparkles size={16} aria-hidden="true" />记忆预览</div>
      {node ? (
        <div className="mt-8 space-y-5">
          <div>
            <p className="text-caption text-text-3">{[markKindWord(node), project].filter(Boolean).join(" · ")}</p>
            <h2 className="mt-2 break-words text-section font-semibold text-text">{title}</h2>
            {description && description !== title && <p data-prose="" className="mt-3 break-words text-ui leading-6 text-text-2">{description}</p>}
            {read?.state === "loading" && <p role="status" className="mt-3 text-caption text-text-3">正在读取内容</p>}
            {read?.state === "missing" && <p className="mt-3 text-caption text-text-3">这条内容已不存在。</p>}
            {read?.state === "failed" && <div className="mt-3 text-caption text-text-3">暂时读不到完整内容。<Button size="sm" variant="text" onClick={() => setAttempt((value) => value + 1)}>重试</Button></div>}
          </div>
          {node.open && read?.state !== "missing" && <Button variant="secondary" onClick={() => onOpen(node)}>查看详情</Button>}
          {related.length > 0 && (
            <section className="border-t border-border pt-4">
              <h3 className="text-caption font-semibold text-text-2">相连的内容</h3>
              <List label="相连的内容" className="mt-2">
                {related.map((item) => <ListRow key={item.id} title={/^[a-z0-9]+(?:_[a-z0-9]+)+$/iu.test(item.label) ? markKindWord(item) : item.label} onOpen={() => onSelect(item)} chevron={false} />)}
              </List>
            </section>
          )}
        </div>
      ) : <p className="mt-8 text-ui text-text-3">选择星图中的内容。</p>}
    </aside>
  );
}
