/**
 * A source as a reference entry, in the two styles a reader copies it in
 * (spec §15.9, §23.2 rule 4, §23.3): GB/T 7714—2015 顺序编码制 for Chinese
 * writing and Vancouver (NLM) for English. Pure functions over whatever
 * metadata the source carries — a report's matrix often records only a title
 * and a DOI or PMID — so a missing part is left out, never invented (the
 * capability is told the same: "do not manufacture missing metadata").
 *
 * Both styles end with the DOI and, for a PubMed record, the PMID (§15.9
 * rule 2). The entry is returned without its list number unless one is asked
 * for: a single copied reference is pasted into someone else's list, where
 * our number would be wrong.
 */

export interface ReferenceAuthor {
  family: string;
  /** Given names or their initials: "Paul M", "P M", "PM". */
  given?: string;
}

export interface ReferenceMetadata {
  /** Personal names ("Holman CD", "Holman, C D'Arcy J", "严若华", or parts), or an organisation as written. */
  authors?: ReadonlyArray<string | ReferenceAuthor>;
  title: string;
  /** The journal, as its own abbreviation or full name. */
  journal?: string;
  year?: string | number;
  volume?: string | number;
  issue?: string | number;
  /** "99-105", "99–105", "a2752". */
  pages?: string;
  doi?: string;
  pmid?: string | number;
  /** The page it was read at, for a source that is not a journal article. */
  url?: string;
}

const CJK = /[㐀-鿿]/;

type Name =
  | { kind: "person"; family: string; initials: string[] }
  | { kind: "cjk"; text: string }
  | { kind: "literal"; text: string };

/** The initials of given names: "C D'Arcy J" → C D J; "Jean-Paul" → J P; "PM" → P M. */
function initialsOf(given: string): string[] {
  return given
    .replace(/\./g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .flatMap((part) => (/^[A-Z]{1,4}$/.test(part) ? [...part] : [part[0]!.toUpperCase()]));
}

/**
 * One author read as a person where the form is unambiguous — family then
 * initials ("Holman CD", "Holman C. D."), "Family, Given", or parts — and
 * otherwise kept as written: "Paul Ridker" and "World Health Organization"
 * cannot be told apart by their shape, and a name turned inside out is worse
 * than one left alone.
 */
function nameOf(author: string | ReferenceAuthor): Name | null {
  if (typeof author !== "string") {
    const family = author.family.trim();
    if (!family) return null;
    if (CJK.test(family)) return { kind: "cjk", text: `${family}${author.given?.trim() ?? ""}` };
    return { kind: "person", family, initials: initialsOf(author.given ?? "") };
  }
  const text = author.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (CJK.test(text)) return { kind: "cjk", text };
  const comma = /^([^,]+),\s*(.+)$/.exec(text);
  if (comma) return { kind: "person", family: comma[1]!.trim(), initials: initialsOf(comma[2]!) };
  const tokens = text.split(" ");
  let split = tokens.length;
  while (split > 1 && /^(?:[A-Z]\.?){1,4}$/.test(tokens[split - 1]!)) split -= 1;
  if (split < tokens.length) {
    return { kind: "person", family: tokens.slice(0, split).join(" "), initials: initialsOf(tokens.slice(split).join(" ")) };
  }
  return { kind: "literal", text };
}

function names(metadata: ReferenceMetadata): Name[] {
  return (metadata.authors ?? []).map(nameOf).filter((name): name is Name => name !== null);
}

/** Whether the entry is written in Chinese, which decides 等 over et al. */
function chinese(metadata: ReferenceMetadata, list: Name[]): boolean {
  return list[0]?.kind === "cjk" || (list.length === 0 && CJK.test(metadata.title));
}

const clean = (value: string | number | undefined | null): string => (value === undefined || value === null ? "" : String(value).trim());
/** A page range with a hyphen, as both styles write it. */
const pageRange = (pages: string): string => pages.replace(/\s*[–—~～]\s*/g, "-");
/** A DOI without its resolver or label. */
export function bareDoi(value: string): string {
  return value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
}
const withoutFinalStop = (text: string): string => text.trim().replace(/[.。]+$/, "");
/** A part followed by the style's full stop, unless it already ends a sentence. */
const sentence = (text: string): string => (/[.?!。？！]$/.test(text) ? text : `${text}.`);

function numbered(index: number | undefined, entry: string, style: "gbt" | "vancouver"): string {
  if (index === undefined) return entry;
  return style === "gbt" ? `[${index}] ${entry}` : `${index}. ${entry}`;
}

/**
 * GB/T 7714—2015, 顺序编码制:
 *
 *   严若华, 彭晓霞. 医学期刊统计报告要求的详述与解读[J]. 中华流行病学杂志, 2019, 40(1): 99-105. DOI: 10.3760/….
 *
 * Personal names family first, a Latin family name in capitals and its
 * initials spaced without stops (HOLMAN C D J); at most three, then “等” for
 * a Chinese entry and “et al.” for a Latin one (§8.1). An entry with no
 * responsible person begins with its title, which the sequential system
 * allows. The type mark is [J] for an article (a journal, a DOI or a PMID
 * says it is one), [EB/OL] for a page read online, [Z] otherwise.
 */
export function formatGbt7714(metadata: ReferenceMetadata, index?: number): string {
  const list = names(metadata);
  const people = list.slice(0, 3).map((name) =>
    name.kind === "person" ? [name.family.toUpperCase(), ...name.initials].join(" ") : name.text);
  if (list.length > 3) people.push(chinese(metadata, list) ? "等" : "et al.");
  const authors = people.length ? sentence(people.join(", ")) : "";

  const doi = metadata.doi ? bareDoi(metadata.doi) : "";
  const pmid = clean(metadata.pmid);
  const journal = clean(metadata.journal);
  const url = clean(metadata.url);
  const type = journal || doi || pmid ? "J" : url ? "EB/OL" : "Z";
  const parts = [authors, `${withoutFinalStop(metadata.title)}[${type}].`];

  const year = clean(metadata.year);
  if (type === "J" && journal) {
    const volume = clean(metadata.volume);
    const issue = clean(metadata.issue);
    const pages = clean(metadata.pages);
    let where = journal;
    if (year) where += `, ${year}`;
    if (volume) where += `, ${volume}`;
    if (issue) where += `(${issue})`;
    if (pages) where += `: ${pageRange(pages)}`;
    parts.push(`${where}.`);
  } else if (type === "EB/OL") {
    // (更新或修改日期) before the address, as §8.8 writes an online source.
    parts.push(year ? `(${year}). ${url}.` : `${url}.`);
  } else if (year) {
    parts.push(`${year}.`);
  }
  if (doi) parts.push(`DOI: ${doi}.`);
  if (pmid) parts.push(`PMID: ${pmid}.`);
  return numbered(index, parts.filter(Boolean).join(" "), "gbt");
}

/**
 * Vancouver, as the NLM writes it (Citing Medicine):
 *
 *   Zhang M, Holman CD, Price SD, Sanfilippo FM, Preen DB, Bulsara MK. Comorbidity … study. BMJ. 2009;338:a2752. doi:10.1136/bmj.a2752. PMID: 19129307.
 *
 * Family name then initials run together; at most six, then “et al.”. A page
 * read online and not published in a journal is “[Internet]” with
 * “Available from:” its address.
 */
export function formatVancouver(metadata: ReferenceMetadata, index?: number): string {
  const list = names(metadata);
  const people = list.slice(0, 6).map((name) =>
    name.kind === "person" ? `${name.family}${name.initials.length ? ` ${name.initials.join("")}` : ""}` : name.text);
  if (list.length > 6) people.push("et al.");
  const authors = people.length ? sentence(people.join(", ")) : "";

  const doi = metadata.doi ? bareDoi(metadata.doi) : "";
  const pmid = clean(metadata.pmid);
  const journal = clean(metadata.journal);
  const url = clean(metadata.url);
  const year = clean(metadata.year);
  const online = !journal && !doi && !pmid && Boolean(url);
  const parts = [authors, online ? `${withoutFinalStop(metadata.title)} [Internet].` : sentence(metadata.title.trim())];

  if (journal) {
    const volume = clean(metadata.volume);
    const issue = clean(metadata.issue);
    const pages = clean(metadata.pages);
    let where = year;
    if (volume) where += where ? `;${volume}` : volume;
    if (issue) where += `(${issue})`;
    if (pages) where += `:${pageRange(pages)}`;
    parts.push(sentence(journal), where ? `${where}.` : "");
  } else if (year) {
    parts.push(`${year}.`);
  }
  if (online) parts.push(`Available from: ${url}`);
  if (doi) parts.push(`doi:${doi}.`);
  if (pmid) parts.push(`PMID: ${pmid}.`);
  return numbered(index, parts.filter(Boolean).join(" "), "vancouver");
}

/**
 * The DOI and PMID an identifier names — "PMID:30221597", "DOI 10.1056/…",
 * "doi:10.1136/bmj.a2752", a bare "10.…" or a doi.org address.
 */
export function identifiersOf(...values: ReadonlyArray<string | undefined | null>): { doi?: string; pmid?: string } {
  const found: { doi?: string; pmid?: string } = {};
  for (const value of values) {
    const text = (value ?? "").trim();
    if (!text) continue;
    const pmid = /^pmid\s*:?\s*(\d{1,9})$/i.exec(text);
    if (pmid && !found.pmid) found.pmid = pmid[1];
    const doi = /(?:^|doi\.org\/|doi\s*:?\s*)(10\.\d{4,9}\/\S+)$/i.exec(text);
    if (doi && !found.doi) found.doi = doi[1];
  }
  return found;
}
