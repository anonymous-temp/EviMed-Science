// What deleting a project must not take from the learning loop (audit
// 2026-09-26, L-G1): the jobs move to the learning project, and a waiting
// lesson keeps what it needs to still be learnt — its transcript and a record
// of its run — where the worker reads them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import { LESSON_RUNS_DIR, archivedLessonRun, ensureLearningProject, preserveProjectLessons } from "../src/learningPreservation.mjs";
import { TRANSCRIPT_DIR_NAME, transcriptPath } from "../src/runTranscripts.mjs";

/** @param {string} root @param {string} id */
async function projectAt(root, id) {
  const rootDir = path.join(root, id);
  const project = { id, userId: "u1", rootDir, metaDir: path.join(rootDir, ".openscience"), workspaceDir: path.join(rootDir, "workspace") };
  await mkdir(project.metaDir, { recursive: true });
  return project;
}

/** A transaction client over a fixed job table, recording the statements it was sent. */
function client(rows) {
  /** @type {{sql: string, values: any[]}[]} */
  const statements = [];
  return {
    statements,
    async query(/** @type {string} */ sql, /** @type {any[]} */ values) {
      statements.push({ sql, values });
      if (sql.trimStart().startsWith("SELECT")) return { rows: rows.filter((row) => row.projectId === values[1]), rowCount: rows.length };
      const moved = rows.filter((row) => row.projectId === values[1] && values[3].includes(row.kind));
      for (const row of moved) {
        row.projectId = values[2];
        row.payload = { ...row.payload, sourceProjectId: row.payload.sourceProjectId ?? values[1] };
      }
      return { rows: [], rowCount: moved.length };
    },
  };
}

test("a deleted project's lessons move to the learning project with what the waiting ones need", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-lesson-preservation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await projectAt(root, "paper");
  const learningProject = await projectAt(root, LEARNING_PROJECT_ID);
  await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
  for (const runId of ["run_main", "run_peer", "run_done"]) {
    await writeFile(transcriptPath(project, runId), `{"schemaVersion":1,"runId":"${runId}"}\n`);
  }
  const rows = [
    { id: "j1", kind: "distill", status: "queued", projectId: "paper", payload: { runId: "run_main", trigger: "routine", peerRunIds: ["run_peer"] } },
    { id: "j2", kind: "distill", status: "succeeded", projectId: "paper", payload: { runId: "run_done", trigger: "delivered" } },
    { id: "j3", kind: "consolidate", status: "queued", projectId: "paper", payload: { action: "sleep" } },
    { id: "j4", kind: "distill", status: "queued", projectId: "other", payload: { runId: "run_elsewhere" } },
  ];
  const tx = client(rows);
  const runs = [
    { id: "run_main", sessionId: "s1", status: "succeeded", effectiveAgentId: "meta-analysis", question: "a long private question", transcript: { completeness: "complete" } },
    { id: "run_peer", sessionId: "s2", status: "succeeded", effectiveAgentId: "meta-analysis" },
  ];
  const result = await preserveProjectLessons({ client: tx, userId: "u1", project, learningProject, runs });

  assert.equal(result.moved, 3, "every learning job of the project, finished ones too, as a record");
  assert.deepEqual(result.preserved.sort(), ["run_main", "run_peer"], "only what a waiting lesson reads");
  assert.deepEqual(rows.map((row) => [row.id, row.projectId, row.payload.sourceProjectId ?? null]), [
    ["j1", LEARNING_PROJECT_ID, "paper"],
    ["j2", LEARNING_PROJECT_ID, "paper"],
    ["j3", LEARNING_PROJECT_ID, "paper"],
    ["j4", "other", null],
  ]);
  // The transcript lands where `readRunTranscript` reads it for the learning project.
  assert.equal(await readFile(transcriptPath(learningProject, "run_main"), "utf8"), '{"schemaVersion":1,"runId":"run_main"}\n');
  assert.equal(await readFile(transcriptPath(learningProject, "run_peer"), "utf8"), '{"schemaVersion":1,"runId":"run_peer"}\n');
  await assert.rejects(readFile(transcriptPath(learningProject, "run_done"), "utf8"), { code: "ENOENT" }, "a finished lesson needs nothing");
  // And the run, as much of it as a distillation reads.
  const archived = await archivedLessonRun(learningProject, "run_main");
  assert.deepEqual({ id: archived?.id, effectiveAgentId: archived?.effectiveAgentId, question: archived?.question },
    { id: "run_main", effectiveAgentId: "meta-analysis", question: undefined }, "the question stays behind");
  assert.equal(await archivedLessonRun(learningProject, "run_elsewhere"), null);
  assert.equal(await archivedLessonRun(learningProject, "../escape"), null, "a run id is never a path");
  assert.match(await readFile(path.join(learningProject.metaDir, LESSON_RUNS_DIR, "run_main.json"), "utf8"), /"meta-analysis"/);

  // Idempotent: the jobs are no longer the project's, so a retry moves nothing.
  const again = await preserveProjectLessons({ client: tx, userId: "u1", project, learningProject, runs });
  assert.equal(again.moved, 0);
});

test("a routine lesson keeps its own project's peers; a peer in another project stays where the distillation reads it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-lesson-preservation-peers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await projectAt(root, "paper");
  const learningProject = await projectAt(root, LEARNING_PROJECT_ID);
  await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
  for (const runId of ["run_main", "run_near"]) {
    await writeFile(transcriptPath(project, runId), `{"schemaVersion":1,"runId":"${runId}"}\n`);
  }
  const rows = [{ id: "j1", kind: "distill", status: "queued", projectId: "paper", payload: {
    runId: "run_main", trigger: "routine", peers: [{ runId: "run_near", projectId: "paper" }, { runId: "run_far", projectId: "other-paper" }],
  } }];
  const runs = [{ id: "run_main", sessionId: "s1", status: "succeeded", kernelRequestIds: ["req_1", 7], nativeTurn: { startSeq: 4, userSeq: 5 } }];
  const result = await preserveProjectLessons({ client: client(rows), userId: "u1", project, learningProject, runs });
  assert.deepEqual(result.preserved.sort(), ["run_main", "run_near"]);
  assert.equal(await readFile(transcriptPath(learningProject, "run_near"), "utf8"), '{"schemaVersion":1,"runId":"run_near"}\n');
  // The turns that were the run's, so a correction read later is its own.
  const archived = await archivedLessonRun(learningProject, "run_main");
  assert.deepEqual([archived?.kernelRequestIds, archived?.nativeTurn], [["req_1"], { startSeq: 4, userSeq: 5 }]);
});

test("the learning project itself is never preserved into itself, and nothing moves without a transaction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-lesson-preservation-self-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const learningProject = await projectAt(root, LEARNING_PROJECT_ID);
  const tx = client([]);
  assert.deepEqual(await preserveProjectLessons({ client: tx, userId: "u1", project: learningProject, learningProject }), { moved: 0, preserved: [] });
  assert.deepEqual(await preserveProjectLessons({ client: null, userId: "u1", project: await projectAt(root, "paper"), learningProject }), { moved: 0, preserved: [] });
  assert.equal(tx.statements.length, 0);
  await assert.rejects(preserveProjectLessons({ client: tx, userId: "u1", project: await projectAt(root, "paper"), learningProject: { id: "somewhere-else" } }),
    { code: "learning_project_invalid" });
});

test("the learning project is made on first use, as the learning runtime makes it", async () => {
  /** @type {string[]} */
  const made = [];
  const projects = new Map();
  const store = {
    async requireProject(/** @type {any} */ _user, /** @type {string} */ id) {
      if (!projects.has(id)) throw Object.assign(new Error("missing"), { code: "project_not_found", status: 404 });
      return projects.get(id);
    },
    async createProject(/** @type {any} */ _user, /** @type {string} */ id, /** @type {string} */ name) { made.push(`${id}:${name}`); projects.set(id, { id }); },
  };
  assert.deepEqual(await ensureLearningProject(store, { id: "u1" }), { id: LEARNING_PROJECT_ID });
  assert.deepEqual(await ensureLearningProject(store, { id: "u1" }), { id: LEARNING_PROJECT_ID });
  assert.deepEqual(made, [`${LEARNING_PROJECT_ID}:EviMed 学习`], "once");
});

test("a handbook source survives owned project deletion but cannot borrow another project's archive", async (t) => {
  const { resolveLessonSourceRun } = await import("../src/learningPreservation.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "evimed-handbook-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await projectAt(root, "gone");
  const learningProject = await projectAt(root, LEARNING_PROJECT_ID);
  const jobs = client([{ id: "j", kind: "distill", status: "queued", projectId: "gone", payload: { runId: "source-run" } }]);
  await preserveProjectLessons({ client: jobs, userId: "u1", project: source, learningProject,
    runs: [{ id: "source-run", effectiveAgentId: "meta-analysis" }] });
  const store = { userById: async (id) => id === "u1" ? { id } : null,
    requireProject: async (_user, id) => { if (id === LEARNING_PROJECT_ID) return learningProject; throw Object.assign(new Error("gone"), { status: 404 }); } };
  const agentRuns = { list: async () => [] };
  assert.equal((await resolveLessonSourceRun(store, agentRuns, "u1", "gone", "source-run")).effectiveAgentId, "meta-analysis");
  assert.equal(await resolveLessonSourceRun(store, agentRuns, "u1", "other", "source-run"), null);
  assert.equal(await resolveLessonSourceRun(store, agentRuns, "foreign", "gone", "source-run"), null);
});
