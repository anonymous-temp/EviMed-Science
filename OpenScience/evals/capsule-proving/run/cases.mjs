// Case lists for the engine-layer runner: every dataset is loaded into the one Case shape of the contract
// (`{ caseId, set, split, userKey, sessions, questions }`), which never carries an answer.
//
// Sets register a loader (`registerSet(name, loader)`); `loadCases` picks the loader, filters by `only`, and checks the
// shape. `synthetic-users` is built in: one user per directory, `<dataDir>/<split>/<user>/input.json`. `input.json`
// and structural schedule/skeleton metadata are read; gold and corruptions are never opened here.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { SET_LOADERS } from "./sets.mjs";

/**
 * @typedef {{ id: string, name: string } | null} CaseProject
 * @typedef {{ role: "user"|"assistant", text: string, at?: string, liveTurn?: "forget" }} CaseMessage
 * @typedef {{ afterMessage: number, kind: string, title: string, text: string }} CaseAttachment
 * @typedef {{ sessionId: string, at: string, project: CaseProject, messages: CaseMessage[], attachments?: CaseAttachment[] }} CaseSession
 * @typedef {{ kind: string, title: string, text: string }} CaseMaterial
 * @typedef {{ qid: string, afterSession: number, asOf: string, text: string, category?: string, project?: CaseProject, materials?: CaseMaterial[] }} CaseQuestion
 * @typedef {{ caseId: string, set: string, split: string, userKey: string, sessions: CaseSession[], questions: CaseQuestion[], meta?: Record<string, unknown> }} Case
 * @typedef {(input: { split: string, dataDir: string, set: string, only?: string[] }) => Promise<Case[]>} SetLoader
 */

/** @type {Map<string, SetLoader>} */
const registry = new Map();

/** Add (or replace) the loader of a dataset. @param {string} name @param {SetLoader} loader */
export function registerSet(name, loader) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw new Error("a set name is lower-case letters, digits, '.', '_' or '-'");
  if (typeof loader !== "function") throw new Error("a set loader is a function");
  registry.set(name, loader);
}

/** The registered set names, sorted. */
export function registeredSets() {
  return [...registry.keys()].sort();
}

const ROLES = new Set(["user", "assistant"]);
const isoOk = (/** @type {unknown} */ value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** @param {any} value @returns {CaseProject} */
function projectOf(value) {
  if (value == null) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || id === "default") return null;
  return { id, name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id };
}

/**
 * One synthetic user's `input.json` in the Case shape. Field names of the generator are mapped (`userId` → `userKey`,
 * `sourceSessionId` → `sessionId`); anything the contract does not name is left out, so nothing else can leak in.
 * @param {any} raw @param {{ set: string, split: string, dirName: string }} where
 * @returns {Case}
 */
export function normalizeSyntheticUser(raw, { set, split, dirName }) {
  const userKey = String(raw?.userKey ?? raw?.userId ?? dirName);
  const sessions = (Array.isArray(raw?.sessions) ? raw.sessions : []).map((session, index) => {
    /** @type {CaseSession} */
    const out = {
      sessionId: String(session?.sessionId ?? session?.sourceSessionId ?? `s${String(index + 1).padStart(3, "0")}`),
      at: String(session?.at ?? ""),
      project: projectOf(session?.project),
      messages: (Array.isArray(session?.messages) ? session.messages : []).map((message) => ({
        role: message?.role, text: typeof message?.text === "string" ? message.text : String(message?.text ?? ""),
        ...(isoOk(message?.at) ? { at: String(message.at) } : {}),
      })),
    };
    if (Array.isArray(session?.attachments) && session.attachments.length) {
      out.attachments = session.attachments.map((item) => ({ afterMessage: Number(item?.afterMessage) || 0, kind: String(item?.kind ?? "document"),
        title: String(item?.title ?? ""), text: String(item?.text ?? "") }));
    }
    return out;
  });
  const questions = (Array.isArray(raw?.questions) ? raw.questions : []).map((question) => {
    /** @type {CaseQuestion} */
    const out = { qid: String(question?.qid ?? ""), afterSession: Number(question?.afterSession), asOf: String(question?.asOf ?? ""), text: String(question?.text ?? "") };
    if (question?.project !== undefined) out.project = projectOf(question.project);
    if (Array.isArray(question?.materials) && question.materials.length) {
      out.materials = question.materials.map((item) => ({ kind: String(item?.kind ?? "document"), title: String(item?.title ?? ""), text: String(item?.text ?? "") }));
    }
    return out;
  });
  return { caseId: String(raw?.caseId ?? userKey), set, split, userKey, sessions, questions,
    meta: { ...(typeof raw?.kind === "string" ? { kind: raw.kind } : {}), ...(typeof raw?.schema === "string" ? { schema: raw.schema } : {}) } };
}

/** Apply only structural annotations. Plant identities and their values never enter the Case.
 * Message offsets are zero-based schedule annotations, reviewed outside the runner; missing offsets fail closed
 * when live turns are requested. Question categories join on the generator's declared question, never on anchors.
 * @param {Case} item @param {any} skeleton @param {any} schedule
 */
export function annotateSyntheticUser(item, skeleton, schedule) {
  if (!skeleton || !schedule) return item;
  const plants = new Map((skeleton.plants ?? []).map(plant => [plant.id, plant]));
  for (const event of schedule.events ?? []) {
    if (event.kind !== "forget" || plants.get(event.plantId)?.category !== "forget") continue;
    const planned = schedule.sessions?.find(session => session.index === event.session);
    const session = item.sessions.find(session => session.sessionId === planned?.id);
    if (!session) throw new Error(`${item.caseId}: forget session is missing`);
    const insert = planned.inserts?.find(insert => insert.plantId === event.plantId && insert.event === "forget");
    const index = event.messageIndex ?? insert?.messageIndex;
    if (index === undefined) {
      item.meta ??= {};
      item.meta.unlocatedLiveTurns = Number(item.meta.unlocatedLiveTurns ?? 0) + 1;
      continue;
    }
    if (!Number.isInteger(index) || index < 0 || session.messages[index]?.role !== "user"
      || session.messages[index + 1]?.role !== "assistant") throw new Error(`${item.caseId}: invalid forget messageIndex`);
    session.messages[index].liveTurn = "forget";
  }
  for (const question of item.questions) {
    const categories = new Set([...plants.values()].filter(plant => plant.question === question.text).map(plant => plant.category));
    if (categories.size === 1) question.category = [...categories][0];
  }
  return item;
}

/**
 * What is wrong with a Case, as readable lines ([] when it is sound).
 * @param {Case} item @returns {string[]}
 */
export function caseIssues(item) {
  const issues = [];
  const where = item?.caseId ?? "?";
  if (!item || typeof item.caseId !== "string" || !/^[A-Za-z0-9_:.-]{1,96}$/.test(item.caseId)) issues.push(`${where}: caseId must be 1-96 of [A-Za-z0-9_:.-]`);
  if (typeof item?.userKey !== "string" || !/^[A-Za-z0-9_:.-]{1,96}$/.test(item.userKey)) issues.push(`${where}: userKey must be 1-96 of [A-Za-z0-9_:.-]`);
  const sessions = Array.isArray(item?.sessions) ? item.sessions : [];
  const ids = new Set();
  sessions.forEach((session, index) => {
    if (typeof session?.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(session.sessionId)) issues.push(`${where}: session ${index + 1} has an id outside [A-Za-z0-9_-]{1,64}`);
    else if (ids.has(session.sessionId)) issues.push(`${where}: session id ${session.sessionId} repeats`);
    ids.add(session?.sessionId);
    if (!isoOk(session?.at)) issues.push(`${where}: session ${session?.sessionId} has no ISO time`);
    if (!Array.isArray(session?.messages) || !session.messages.length) issues.push(`${where}: session ${session?.sessionId} has no messages`);
    for (const [index, message] of (session?.messages ?? []).entries()) {
      if (!ROLES.has(message?.role)) { issues.push(`${where}: session ${session?.sessionId} has a message whose role is not user/assistant`); break; }
      if (message.liveTurn !== undefined && (message.liveTurn !== "forget" || message.role !== "user" || session.messages[index + 1]?.role !== "assistant")) issues.push(`${where}: session ${session.sessionId} has an invalid liveTurn`);
    }
  });
  const qids = new Set();
  for (const question of Array.isArray(item?.questions) ? item.questions : []) {
    if (!question?.qid) issues.push(`${where}: a question has no qid`);
    else if (qids.has(question.qid)) issues.push(`${where}: qid ${question.qid} repeats`);
    qids.add(question?.qid);
    if (!Number.isInteger(question?.afterSession) || question.afterSession < 0 || question.afterSession > sessions.length) issues.push(`${where}: ${question?.qid} afterSession is not 0..${sessions.length}`);
    if (!isoOk(question?.asOf)) issues.push(`${where}: ${question?.qid} has no ISO asOf`);
    if (!String(question?.text ?? "").trim() && !Array.isArray(question?.probe)) issues.push(`${where}: ${question?.qid} has no text`);
  }
  return issues;
}

/** The checkpoints of a Case: the distinct `afterSession` values of its questions, ascending. @param {Case} item */
export function checkpointsOf(item) {
  return [...new Set((item.questions ?? []).map((question) => question.afterSession))].sort((a, b) => a - b);
}

/** @param {string} directory */
async function isDirectory(directory) {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

/**
 * `synthetic-users`: `<dataDir>/<split>/<user>/input.json`, users sorted by directory name. The sealed split is read the same
 * way from `<dataDir>/sealed/` (by symmetry; this code never opens it unless asked to).
 * @type {SetLoader}
 */
async function loadSyntheticUsers({ split, dataDir, set }) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(split)) throw new Error(`unknown split ${split}`);
  const root = path.join(dataDir, split);
  if (!await isDirectory(root)) throw new Error(`no ${split} directory under the data directory`);
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name)).map((entry) => entry.name).sort();
  const cases = [];
  for (const name of names) {
    const file = path.join(root, name, "input.json");
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") continue; throw error; }
    const metadata = async file => {
      try { return JSON.parse(await readFile(path.join(root, name, file), "utf8")); }
      catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    };
    const [skeleton, schedule] = await Promise.all([metadata("skeleton.json"), metadata("schedule.json")]);
    cases.push(annotateSyntheticUser(normalizeSyntheticUser(JSON.parse(text), { set, split, dirName: name }), skeleton, schedule));
  }
  return cases;
}

registerSet("synthetic-users", loadSyntheticUsers);
// Every other development and public set (`sets.mjs`), under the name its loader is listed by.
for (const [name, loader] of Object.entries(SET_LOADERS)) if (!registry.has(name)) registerSet(name, loader);

/** @param {string | readonly string[] | null | undefined} only */
function onlyList(only) {
  if (only == null || only === "") return null;
  const list = (Array.isArray(only) ? only : String(only).split(",")).map((item) => String(item).trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

/**
 * The cases of one set and split, filtered by `only` (case ids or user keys), each checked against the contract shape.
 * @param {{ set: string, split: string, dataDir: string, only?: string | readonly string[] | null }} options
 * @returns {Promise<Case[]>}
 */
export async function loadCases({ set, split, dataDir, only = null }) {
  const loader = registry.get(set);
  if (!loader) throw new Error(`unknown set ${set} (registered: ${registeredSets().join(", ") || "none"})`);
  if (!dataDir) throw new Error("a data directory is required");
  const wanted = onlyList(only);
  const cases = (await loader({ split, dataDir, set, ...(wanted ? { only: [...wanted] } : {}) })).filter((item) => !wanted || wanted.has(item.caseId) || wanted.has(item.userKey));
  if (wanted) {
    const found = new Set(cases.flatMap((item) => [item.caseId, item.userKey]));
    const missing = [...wanted].filter((name) => !found.has(name));
    if (missing.length) throw new Error(`--only names cases that are not in ${set}/${split}: ${missing.join(", ")}`);
  }
  const issues = cases.flatMap(caseIssues);
  if (issues.length) throw new Error(`the ${set}/${split} cases have ${issues.length} shape problem(s):\n${issues.slice(0, 20).join("\n")}`);
  const caseIds = new Set();
  for (const item of cases) {
    if (caseIds.has(item.caseId)) throw new Error(`case id ${item.caseId} repeats in ${set}/${split}`);
    caseIds.add(item.caseId);
  }
  return cases;
}
