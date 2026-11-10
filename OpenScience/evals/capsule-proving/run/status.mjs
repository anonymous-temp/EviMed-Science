// STATUS: one line per finished step of a run, the run's own record of what is done.
//
//   <ISO time> DONE <stepKey> <short facts>
//   <ISO time> FAIL <stepKey> <short facts>
//
// A step with a DONE line anywhere in the file is skipped on a rerun; a FAIL line records an attempt and is retried.
// Appends are single `appendFile` calls of one whole line (O_APPEND), serialised per file inside this process, so
// concurrent cases never interleave partial lines.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

/** The states a STATUS line can carry. */
export const STATUS_STATES = Object.freeze(["DONE", "FAIL"]);

/** @type {Map<string, Promise<void>>} file → the tail of its append chain */
const chains = new Map();

/** A step key is one token: no whitespace, at most 300 characters. @param {string} stepKey */
export function validStepKey(stepKey) {
  return typeof stepKey === "string" && /^\S{1,300}$/.test(stepKey);
}

/** Facts on one line: whitespace collapsed, at most 400 characters. @param {unknown} facts */
export function oneLineFacts(facts) {
  const text = typeof facts === "string" ? facts : facts == null ? "" : JSON.stringify(facts);
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * The text of one STATUS line (with its newline).
 * @param {"DONE"|"FAIL"} state @param {string} stepKey @param {unknown} [facts] @param {Date} [at]
 */
export function formatStatusLine(state, stepKey, facts = "", at = new Date()) {
  if (!STATUS_STATES.includes(state)) throw new Error(`unknown STATUS state ${state}`);
  if (!validStepKey(stepKey)) throw new Error("a STATUS step key is one token without whitespace");
  const text = oneLineFacts(facts);
  return `${at.toISOString()} ${state} ${stepKey}${text ? ` ${text}` : ""}\n`;
}

/**
 * One STATUS line parsed, or null for a line that is not one.
 * @param {string} line @returns {{ at: string, state: "DONE"|"FAIL", stepKey: string, facts: string } | null}
 */
export function parseStatusLine(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (DONE|FAIL) (\S+)(?: (.*))?$/.exec(String(line ?? "").replace(/\r$/, ""));
  if (!match) return null;
  return { at: match[1], state: /** @type {"DONE"|"FAIL"} */ (match[2]), stepKey: match[3], facts: match[4] ?? "" };
}

/**
 * Append one line. Resolves once the line is written.
 * @param {string} file @param {"DONE"|"FAIL"} state @param {string} stepKey @param {unknown} [facts] @param {{ now?: () => Date }} [options]
 */
export function appendStatus(file, state, stepKey, facts = "", { now = () => new Date() } = {}) {
  const line = formatStatusLine(state, stepKey, facts, now());
  const key = path.resolve(file);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => appendFile(key, line, { encoding: "utf8", flag: "a", mode: 0o600 }));
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {});
  return next;
}

/**
 * Every parsed line of a STATUS file, oldest first ([] when the file does not exist).
 * @param {string} file
 */
export async function readStatus(file) {
  let text = "";
  try { text = await readFile(file, "utf8"); }
  catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") return []; throw error; }
  return text.split("\n").map(parseStatusLine).filter((entry) => entry !== null);
}

/**
 * The step keys that have a DONE line.
 * @param {string} file @returns {Promise<Set<string>>}
 */
export async function readDone(file) {
  return new Set((await readStatus(file)).filter((entry) => entry.state === "DONE").map((entry) => entry.stepKey));
}

/**
 * A STATUS file bound to one path, with an in-memory set of done keys kept current by its own appends.
 * @param {string} file
 */
export async function openStatus(file) {
  const done = await readDone(file);
  return {
    file,
    done,
    /** @param {string} stepKey */
    isDone: (stepKey) => done.has(stepKey),
    /** @param {string} stepKey @param {unknown} [facts] */
    async markDone(stepKey, facts = "") { await appendStatus(file, "DONE", stepKey, facts); done.add(stepKey); },
    /** @param {string} stepKey @param {unknown} [facts] */
    async markFailed(stepKey, facts = "") { await appendStatus(file, "FAIL", stepKey, facts); },
  };
}
