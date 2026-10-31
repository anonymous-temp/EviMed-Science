import { compact, containsRemoved, similarity } from "../nativeMemoryRejections.mjs";
import { lineFingerprint, normalisedStatement } from "../nativeMemoryOverlay.mjs";

/**
 * 「以前 → 现在」: what the person's memory used to say, read from the revisions the overlay already keeps.
 *
 * The engine's file holds only what is true now, so a line it rewrote leaves nothing in the file; the old words are in the revision that
 * took them out. This module reads those revisions and says which statement replaced which, so the map can draw the old one in grey with a line to
 * the new one, and a recall still reads only what is true now (the file). Two times come with each: when the words were first seen and when
 * they stopped being said — the two ends of a fact's validity that Graphiti keeps on an edge, here derived and never stored.
 *
 * Hidden knowledge:
 *
 * - **A replacement needs both halves in one revision**: a change that took a line out and put another in. Taking out alone is a forget
 *   or a removal (`NOT_A_REPLACEMENT`, and no added line), which is 已忘记的内容's or nobody's, and never drawn. Adding alone is growth.
 * - **Only the engine's and the person's own rewrites count.** A revision of the platform's own checks took out something that was not to be
 *   kept (a secret's shape), an undo or a restore is not a change of mind, and an undone revision did not happen. A forget of the whole file closes its history: what a later
 *   extraction writes to the same place does not bring the forgotten file's old words back. And whatever the platform's checks would refuse today (`refused`) is not drawn from any revision.
 * - **A forgotten line stays forgotten**: what the rejection list holds is not drawn from an engine's rewrite however old the revision that said it. The one
 *   exception is the person's own edit, which puts the line it replaced on that list too, so the engine does not learn it back: that line stays drawn, as it stays in the
 *   drawer's 以前的版本, until a delete scrubs it from the revisions. A line a later revision says again is in force, not replaced.
 * - **A file is one thing; the profile is many.** A topic or entity file is named for what it is about, so its path does what fish-memory's
 *   fact key does and any rewrite of it replaces its previous words. In the one profile document, which line replaced which is decided by the
 *   label before their colon, else the character pairs they share (`similarity`, `SIMILAR`): a line with no such partner in its revision is dropped
 *   rather than tied to a stranger. A person's edit of a file that takes out one line among several and adds an unrelated one has removed that line and replaced nothing, so it needs a partner too.
 * - **Bounded**: at most `MAX_VERSIONS_PER_FILE` old versions of one file; the caller caps the account. Pure; the store reads and hands in.
 *
 * Deletable if the engine keeps a validity interval per statement.
 *
 * @module memoryMapSources/replacedStatements
 */

/** The old versions of one file that are drawn at most, newest first. */
export const MAX_VERSIONS_PER_FILE = 3;
/** The reasons of a revision that is no change of mind, whoever made it. */
const NOT_A_REPLACEMENT = /^(?:forgotten|undo|restored)/iu;
const REWRITERS = new Set(["engine", "user"]);
/** The longest a line's label is, before its colon: past this the colon is in the sentence. */
const MAX_LABEL_CHARS = 20;
/** The share of character pairs two lines hold in common from which one is taken to have replaced the other: stricter than `SIMILAR`, which only decides what a model is asked. */
const PAIRED = 0.45;

/** The label a line names before its colon — 「目标期刊：JASN」 is about 目标期刊 — by format alone; a line with none has none. @param {string} line */
function labelOf(line) {
  const at = line.search(/[：:]/u);
  return at > 0 && at <= MAX_LABEL_CHARS ? compact(line.slice(0, at)) : "";
}

/** @param {any} revision whether this revision can be a rewrite */
function rewrites(revision) {
  return revision.change === "updated" && !revision.undoneAt && REWRITERS.has(revision.actor)
    && revision.before != null && revision.after != null && !NOT_A_REPLACEMENT.test(String(revision.reason ?? ""));
}

/** The line among `added` that replaced this one: the same label before a colon, else enough words in common. @param {string} line @param {readonly string[]} added */
function partnerOf(line, added) {
  const best = added.map((candidate) => ({ candidate, score: labelOf(line) && labelOf(line) === labelOf(candidate) ? 1 : similarity(line, candidate) })).sort((left, right) => right.score - left.score)[0];
  return best && best.score >= PAIRED ? best.candidate : null;
}

/** @param {string} line @param {readonly { fingerprint: string, text: string | null }[]} rejected whether the person removed this line */
function forgotten(line, rejected) {
  const print = lineFingerprint(line);
  return rejected.some((entry) => entry.fingerprint === print || (entry.text && containsRemoved(line, entry.text)));
}

/**
 * @typedef {object} ReplacedStatement
 * @property {string} id the old statement's own stable id
 * @property {string} text its words
 * @property {string[]} lines the statements those words are, which a removal takes out of the history
 * @property {string} successor the id of what replaced it: a record, or the id of the next old statement
 * @property {string} head the record in force at the end of the chain, whose drawer shows the versions
 * @property {string | null} at when the words were first seen, as far as the revisions go back
 * @property {string | null} until when they stopped being said
 */

/**
 * @param {object} input
 * @param {string} input.fileId the file's record id
 * @param {string} input.body what the file says now
 * @param {readonly any[]} input.history its revisions, oldest first
 * @param {boolean} input.perLine whether each line is a record of its own (the profile)
 * @param {(body: unknown) => string[]} input.statementsOf a text's statements, as the store reads them
 * @param {(line: string) => string} input.recordIdOfLine the record of a line in force (when `perLine`)
 * @param {readonly { fingerprint: string, text: string | null }[]} [input.rejected]
 * @param {(line: string) => boolean} [input.refused] what the platform's checks would take out of a memory today
 * @returns {ReplacedStatement[]} oldest first
 */
export function replacedStatements({ fileId, body, history, perLine, statementsOf, recordIdOfLine, rejected = [], refused = () => false }) {
  const current = new Map(statementsOf(body).map((line) => [normalisedStatement(line), line]));
  /** @type {Map<string, string>} when each statement was first seen */
  const first = new Map();
  const seen = (/** @type {unknown} */ text, /** @type {string | null} */ at) => {
    for (const line of statementsOf(text)) if (at && !first.has(normalisedStatement(line))) first.set(normalisedStatement(line), at);
  };
  /** @type {{ text: string, lines: string[], key: string, next: string | null, until: string | null, byPerson: boolean }[]} */
  const steps = [];
  for (const revision of history) {
    const at = revision.changedAt ?? null;
    if (revision.change === "deleted" && !revision.undoneAt) { steps.length = 0; first.clear(); continue; }
    if (revision.before != null) seen(revision.before, first.size ? null : at);
    if (rewrites(revision)) {
      const before = statementsOf(revision.before);
      const after = statementsOf(revision.after);
      const keptAfter = new Set(after.map(normalisedStatement));
      const keptBefore = new Set(before.map(normalisedStatement));
      const removed = before.filter((line) => !keptAfter.has(normalisedStatement(line)));
      const added = after.filter((line) => !keptBefore.has(normalisedStatement(line)));
      const byPerson = revision.actor === "user";
      if (removed.length && added.length) {
        if (perLine) {
          for (const line of removed) {
            const partner = refused(line) ? null : partnerOf(line, added);
            if (partner) steps.push({ text: line, lines: [line], key: normalisedStatement(line), next: normalisedStatement(partner), until: at, byPerson });
          }
        } else {
          // One line for one line is that line changing; more than that, a person's edit replaced only what has a partner, and the rest they took out.
          const onePerOne = removed.length === 1 && added.length === 1;
          const lines = removed.filter((line) => !current.has(normalisedStatement(line)) && !refused(line)
            && (byPerson ? onePerOne || partnerOf(line, added) !== null : !forgotten(line, rejected)));
          if (lines.length) steps.push({ text: lines.join(" "), lines, key: `r${revision.id}`, next: null, until: at, byPerson });
        }
      }
    }
    if (revision.after != null) seen(revision.after, at);
  }

  if (perLine) {
    // The newest word on each line: a line replaced twice over (it came back in between) is told by its last replacement.
    /** @type {Map<string, (typeof steps)[number]>} */
    const lastOf = new Map();
    for (const step of steps) lastOf.set(step.key, step);
    /** @type {(key: string, trail?: Set<string>) => string | null} the line in force a chain of replacements ends on */
    const headOf = (key, trail = new Set()) => {
      if (current.has(key)) return key;
      const step = lastOf.get(key);
      return step?.next && !trail.has(key) ? headOf(step.next, trail.add(key)) : null;
    };
    const old = [...lastOf.values()].filter((step) => !current.has(step.key) && (step.byPerson || !forgotten(step.text, rejected)));
    const kept = new Set(old.map((step) => step.key));
    /** @type {ReplacedStatement[]} */
    const out = [];
    for (const step of old) {
      const head = headOf(step.key);
      if (!head || !step.next || (!current.has(step.next) && !kept.has(step.next))) continue;
      const lineId = (/** @type {string} */ key) => `${fileId}_${lineFingerprint(key).slice(0, 12)}`;
      out.push({
        id: `${lineId(step.key)}~old`, text: step.text, lines: step.lines,
        successor: current.has(step.next) ? recordIdOfLine(/** @type {string} */ (current.get(step.next))) : `${lineId(step.next)}~old`,
        head: recordIdOfLine(/** @type {string} */ (current.get(head))), at: first.get(step.key) ?? null, until: step.until,
      });
    }
    // A chain whose next link was just dropped has no way to its head: it goes too.
    const ids = new Set(out.map((statement) => statement.id));
    return out.filter((statement) => !statement.successor.endsWith("~old") || ids.has(statement.successor));
  }

  const versions = steps.slice(-MAX_VERSIONS_PER_FILE);
  return versions.map((step, index) => ({
    id: `${fileId}~${step.key}`, text: step.text, lines: step.lines,
    successor: index + 1 < versions.length ? `${fileId}~${versions[index + 1].key}` : fileId,
    head: fileId, at: index > 0 ? versions[index - 1].until : history[0]?.changedAt ?? null, until: step.until,
  }));
}
