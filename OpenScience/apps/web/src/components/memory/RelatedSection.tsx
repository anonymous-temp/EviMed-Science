import { useEffect, useState } from "react";
import { Link } from "react-router";
import { formatDay } from "@/lib/format";
import { fetchRecordLinks, type RecordLinks, type RecordNeighbour } from "@/lib/memoryMapClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { ConversationLink } from "./ConversationLink";
import { DrawerSection } from "./DrawerSection";

/** What a check found about a source, in a few words; nothing for a source that is as it was. */
const SOURCE_STATE_WORDS: Record<string, string> = { retracted: "已撤回", changed: "有更新", expired: "已过期" };

/** What a source is, when it has no title of its own. */
function sourceKind(type: string): string {
  return type === "knowledge_source" ? "资料" : type === "doi" ? "论文" : type === "evidence_card" ? "证据卡" : "前沿动态";
}

/** Whether there is anything to say. */
export function hasLinks(links: RecordLinks | null): boolean {
  return Boolean(links && (links.rests.length || links.replaced.length || links.replacedBy || links.conflicts.length || links.usedIn.length));
}

/**
 * 「关联」: what a memory is tied to (spec §2, V6) — the backlinks of a note app, which are the part of a graph people actually
 * use. What it rests on, what it replaced and what replaced it, what it disagrees with, and the conversations it was handed to. A
 * neighbour that is a memory opens in this drawer when the page can open it (`onOpenRecord`); a document opens on its own page; a
 * paper opens at its DOI.
 *
 * Read when the drawer opens, from the records that own the relations; a read that fails leaves no section, and the drawer stands
 * as it was (principle 19). How often a memory was used is the platform's bookkeeping and is not here.
 */
export function RelatedSection({ recordId, onOpenRecord, canOpen }: {
  recordId: string;
  /** Opens another memory in the drawer; absent where the page cannot. */
  onOpenRecord?: (recordId: string) => void;
  canOpen?: (recordId: string) => boolean;
}) {
  const [links, setLinks] = useState<RecordLinks | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLinks(null);
    fetchRecordLinks(recordId).then((found) => { if (!cancelled) setLinks(found); }, () => undefined);
    return () => { cancelled = true; };
  }, [recordId]);
  if (!links || !hasLinks(links)) return null;

  const neighbour = (entry: RecordNeighbour, prefix: string) => {
    const words = entry.sensitive ? "这是一条敏感记忆" : memoryExcerpt(entry.text, 80);
    const span = [formatDay(entry.from), formatDay(entry.to)].filter(Boolean).join("～");
    const openable = onOpenRecord && !entry.sensitive && (canOpen ? canOpen(entry.id) : true);
    return (
      <li key={`${prefix}-${entry.id}`} className="text-ui text-text-2">
        {openable
          ? <button type="button" onClick={() => onOpenRecord(entry.id)} className="max-w-measure text-left text-accent hover:underline">{`${prefix}：“${words}”`}</button>
          : <span>{`${prefix}：“${words}”`}</span>}
        {span && <span className="text-text-3">{`（${span}）`}</span>}
      </li>
    );
  };

  return (
    <DrawerSection label="关联">
      <ul className="space-y-1.5">
        {links.rests.map((rest) => {
          const title = rest.type === "doi" ? `论文 ${rest.id}` : rest.title ? `《${memoryExcerpt(rest.title, 60)}》` : `一份${sourceKind(rest.type)}`;
          const state = SOURCE_STATE_WORDS[rest.state];
          const text = `依据：${title}${state ? `（${state}）` : ""}`;
          return (
            <li key={`rest-${rest.type}-${rest.id}`} className={`text-ui ${state ? "text-warn-strong" : "text-text-2"}`}>
              {rest.href?.startsWith("/") ? <Link to={rest.href} className="text-accent hover:underline">{text}</Link>
                : rest.href ? <a href={rest.href} target="_blank" rel="noreferrer" className="text-accent hover:underline">{text}</a>
                  : <span>{text}</span>}
            </li>
          );
        })}
        {links.replaced.map((entry) => neighbour(entry, "替代了"))}
        {links.replacedBy && neighbour(links.replacedBy, "后来被替代为")}
        {links.conflicts.map((entry) => neighbour(entry, "和它不一致"))}
        {links.usedIn.map((use) => (
          <li key={`use-${use.sessionId}`} className="text-ui text-text-2">
            <ConversationLink projectId={use.projectId} sessionId={use.sessionId}>{`用在对话：《${memoryExcerpt(use.title || "对话", 40)}》${use.at ? `（${formatDay(use.at)}）` : ""}`}</ConversationLink>
          </li>
        ))}
      </ul>
    </DrawerSection>
  );
}
