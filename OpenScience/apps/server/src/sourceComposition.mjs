/**
 * What a project's library is made of, by the two things its documents say about themselves: the year they were published
 * and their keywords (2026-10-12, knowledge base P0, report 01 V14 — a ranked table with a bar in the row, at the top of the
 * knowledge base page).
 *
 * Hidden knowledge:
 *
 * - **Read off the metadata the parser recorded** (`metadata.publicationDate`, `metadata.keywords`), never worked out from the
 *   text. A document that says neither is not in that table, and the table says how many do (`dated`, `keyworded`), so a
 *   reader knows a table of three years is the composition of three documents and not of the library.
 * - **A year is a year the date names** in the usual shapes (`2021`, `2021-03-05`, `Mar 2021`): a format, not a reading of
 *   language. A date with no year in it is no year.
 * - **Keywords are one keyword whatever their case**, shown as the spelling met first (the oldest document's: rows come in the
 *   order the documents were added, so the spelling does not depend on the database's row order); a keyword longer than a keyword is a
 *   sentence the parser took for one and is left out.
 * - **The documents of the library, not its derived pages**: a compiled knowledge page (`knowledge-base/wiki/`) is neither
 *   counted nor read.
 * - **Counted, not ranked by anything but the count.** Years run newest first and are cut at the latest twelve; keywords run
 *   most first, then by their characters (the same order on every host), and are cut at ten. Nothing is said about what was cut.
 *
 * @module sourceComposition
 */
import { migrateProductStore } from "./productPersistence.mjs";
import { publicationYear } from "./sourceMetadata.mjs";

/** How many rows each table keeps. */
export const COMPOSITION_YEARS = 12;
export const COMPOSITION_KEYWORDS = 10;
/** A keyword longer than this is not one. */
const KEYWORD_MAX_CHARS = 60;

/**
 * @param {readonly { date?: unknown, keywords?: unknown }[]} documents one entry per document: its publication date and keywords as recorded
 * @returns {{ total: number, dated: number, keyworded: number, years: { year: number, count: number }[], keywords: { keyword: string, count: number }[] }}
 */
export function composeLibrary(documents) {
  /** @type {Map<number, number>} */
  const years = new Map();
  /** @type {Map<string, { keyword: string, count: number }>} */
  const keywords = new Map();
  let dated = 0;
  let keyworded = 0;
  for (const document of documents) {
    const year = publicationYear(document.date);
    if (year !== null) { dated += 1; years.set(year, (years.get(year) ?? 0) + 1); }
    const own = new Map();
    for (const raw of Array.isArray(document.keywords) ? document.keywords : []) {
      const keyword = String(raw ?? "").replace(/\s+/g, " ").trim();
      if (keyword && keyword.length <= KEYWORD_MAX_CHARS && !own.has(keyword.toLowerCase())) own.set(keyword.toLowerCase(), keyword);
    }
    if (own.size > 0) keyworded += 1;
    for (const [key, keyword] of own) {
      const held = keywords.get(key);
      if (held) held.count += 1;
      else keywords.set(key, { keyword, count: 1 });
    }
  }
  return {
    total: documents.length, dated, keyworded,
    years: [...years.entries()].sort((left, right) => right[0] - left[0]).slice(0, COMPOSITION_YEARS).map(([year, count]) => ({ year, count })),
    keywords: [...keywords.values()].sort((left, right) => right.count - left.count || (left.keyword < right.keyword ? -1 : left.keyword > right.keyword ? 1 : 0)).slice(0, COMPOSITION_KEYWORDS),
  };
}

/**
 * The composition of one project's library, from the documents the account holds in it.
 * @param {{ query: (sql: string, values: any[]) => Promise<{ rows: any[] }> }} database the product database
 * @param {string} userId @param {string} projectId
 */
export async function projectComposition(database, userId, projectId) {
  await migrateProductStore(database);
  const result = await database.query(`SELECT d.payload->'metadata'->>'publicationDate' AS date,
      CASE WHEN jsonb_typeof(d.payload->'metadata'->'keywords')='array' THEN d.payload->'metadata'->'keywords' END AS keywords
    FROM evimed_product.documents d
    WHERE d.user_id=$1 AND d.kind='source' AND d.deleted_at IS NULL AND d.project_id=$2
      AND coalesce(d.payload->'paths'->>0,'') NOT LIKE 'knowledge-base/wiki/%'
    ORDER BY d.created_at, d.id`, [userId, projectId]);
  return composeLibrary(result.rows);
}
