import type { MapNode } from "@/lib/memoryMapClient";
import { cn } from "@/lib/cn";

/** The shape a mark is drawn in, as a character: the picture's own vocabulary, so a row in the list and a mark in the graph are one thing. */
export function glyphOf(node: Pick<MapNode, "type" | "subtype">): string {
  switch (node.type) {
    case "you": case "project": case "cluster": return "⬢";
    case "document": case "page": return "■";
    case "reference": return "▢";
    case "method": return "▲";
    case "entity": return "◉";
    default: return node.subtype === "decision" || node.subtype === "correction" ? "◆" : "●";
  }
}

/** A mark's shape and state in a row: colour, shape and words (the row says the words). Decoration for a reader who sees; hidden from one who listens. */
export function MarkGlyph({ node }: { node: Pick<MapNode, "type" | "subtype" | "state"> }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block w-4 text-center text-ui leading-none", node.state === "check" ? "text-warn" : node.state === "replaced" ? "text-text-3" : "text-accent")}
    >
      {glyphOf(node)}
    </span>
  );
}
