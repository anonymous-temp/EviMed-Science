import { Menu } from "@/components/ui/Menu";
import { memoryExcerpt } from "@/lib/memoryText";
import { useAskAbout } from "./useAskAbout";

/** What a question about a mark begins with: the mark in the person's own words, and the blank they fill. The words are the page's own, never a prompt. */
export function askDraft(kind: "memory" | "method" | "document", text: string): string {
  const quoted = `“${memoryExcerpt(text, 80)}”`;
  if (kind === "method") return `关于你学会的这个做法${quoted}，我想问：`;
  if (kind === "document") return `关于这份资料${quoted}，我想问：`;
  return `关于你记住的这一条${quoted}，我想问：`;
}

/**
 * The one action a row of the map or an overview card has beside opening: 「就这个提问」, in the row's 「⋯」 (the same quiet control as the
 * header's, so a page that has rows is not given a new kind of control for them).
 */
export function AskMenu({ kind, text, projectId = null }: { kind: "memory" | "method" | "document"; text: string; projectId?: string | null }) {
  const ask = useAskAbout();
  // 「更多」, as every other row's: a name that held the row's own words would match a search of the page for that row twice.
  return <Menu label="更多" items={[{ label: "就这个提问", onSelect: () => ask(askDraft(kind, text), projectId) }]} />;
}
