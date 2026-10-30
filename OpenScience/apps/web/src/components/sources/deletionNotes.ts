import type { ProjectLibraryLoss, SourceRecord } from "@/lib/sourceClient";

/** The most document titles a sentence names before it counts the rest. */
const TITLES_NAMED = 3;

const quoted = (names: readonly string[]) => names.map((name) => `“${name}”`).join("");

/**
 * What deleting a document does, in the words of the confirmation: the knowledge base lists a file once, and deleting it deletes every
 * copy the account holds of those bytes — in each project that holds it and in 我的资料 — and with the last one the choice of where it
 * takes effect. So the sentence names the projects that hold it, and, apart from them, the projects the person had sent it to, which
 * stop reading it too (`appliesTo`: `"all"`, or the list of every project it was read in). A project that cannot be named any more
 * (deleted) is left out rather than shown as an id.
 */
export function documentDeletionNote(source: SourceRecord, labels: ReadonlyMap<string, string>): { body: string; consequences?: string } {
  const holders = source.holders ?? [];
  const held = new Set(holders.map((holder) => holder.id));
  const places = holders.map((holder) => labels.get(holder.id) ?? holder.name);
  const where = places.length > 0 ? `（所在项目：${quoted(places)}）` : "";
  const body = `这份资料在账户里的所有副本都会删除${where}，删除后不再用于回答。`;
  const applies = source.appliesTo;
  if (applies === "all") return { body, consequences: "它原先对所有项目生效，删除后所有项目都读不到它。" };
  const others = (applies ?? []).filter((id) => !held.has(id)).flatMap((id) => (labels.has(id) ? [labels.get(id) as string] : []));
  return others.length > 0 ? { body, consequences: `它原先还对${quoted(others)}生效，这些项目也读不到它了。` } : { body };
}

/**
 * What deleting a project does to the documents it holds that were sent to other projects: the document goes with its last holder, so
 * the projects it was sent to lose it. Said once for all of them — a few titles, and the projects they were sent to (or every project,
 * where any was sent to all). Null where deleting the project costs no other project a document.
 */
export function projectDeletionNote(losses: readonly ProjectLibraryLoss[], labels: ReadonlyMap<string, string>): string | null {
  if (losses.length === 0) return null;
  const titles = losses.slice(0, TITLES_NAMED).map((loss) => `《${loss.title}》`).join("");
  const more = losses.length > TITLES_NAMED ? `等${losses.length}份` : "";
  const everywhere = losses.some((loss) => loss.projects === "all");
  const ids = [...new Set(losses.flatMap((loss) => (loss.projects === "all" ? [] : loss.projects)))];
  const names = ids.flatMap((id) => (labels.has(id) ? [labels.get(id) as string] : []));
  const reach = everywhere ? "所有项目" : names.length > 0 ? quoted(names) : null;
  return reach === null ? null
    : `只在这个项目里保存、却被设为在${reach}生效的资料（${titles}${more}）会随项目一起删除，那些项目也读不到它们。`;
}
