import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createResearchGoalRoutes } from "../src/researchGoalRoutes.mjs";
import { HttpError, sendError } from "../src/security.mjs";

const USER = { id: "user-a" };
const PROJECT = { id: "project-a", userId: "user-a" };

/** @param {any} goals @param {{ project?: any, csrf?: (path: string) => Promise<void> }} [options] */
async function serve(t, goals, { project = PROJECT, csrf = async () => {} } = {}) {
  const asked = [];
  const routes = createResearchGoalRoutes({
    goals,
    store: {
      ensureSessionUser: async () => ({ user: USER }),
      assertCsrf: async (_req, path) => csrf(path),
      requireProject: async (user, id) => {
        asked.push({ user: user.id, project: id });
        if (id !== project.id) throw new HttpError(404, "project_not_found", "Not found.");
        return project;
      },
    },
  });
  const server = createServer((req, res) => {
    void routes(req, res).then((handled) => { if (!handled) { res.writeHead(599); res.end(); } }, (error) => sendError(res, error));
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", () => resolve(undefined)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { asked, call: (path, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method }) };
}

test("GET lists a project's goals, and says when the deployment keeps none", async (t) => {
  const listed = [];
  const { call } = await serve(t, { list: async (project) => { listed.push(project.id); return [{ sessionId: "s1", status: "paused", reason: "no_progress" }]; } });
  const answer = await call("/api/research-goals?projectId=project-a");
  assert.equal(answer.status, 200);
  assert.deepEqual((await answer.json()).data, { available: true, goals: [{ sessionId: "s1", status: "paused", reason: "no_progress" }] });
  assert.deepEqual(listed, ["project-a"]);

  const off = await serve(t, null);
  assert.deepEqual((await (await off.call("/api/research-goals?projectId=project-a")).json()).data, { available: false, goals: [] });
});

test("pause and resume act on the person's own project, and a deployment with no goals refuses them by name", async (t) => {
  const acts = [];
  const goals = {
    pause: async (project, session) => { acts.push(["pause", project.id, session]); return { sessionId: session, status: "paused" }; },
    resume: async (project, session) => { acts.push(["resume", project.id, session]); return { sessionId: session, status: "active" }; },
  };
  const { call, asked } = await serve(t, goals);
  assert.equal((await (await call("/api/research-goals/s1/pause?projectId=project-a", "POST")).json()).data.status, "paused");
  assert.equal((await (await call("/api/research-goals/s1/resume?projectId=project-a", "POST")).json()).data.status, "active");
  assert.deepEqual(acts, [["pause", "project-a", "s1"], ["resume", "project-a", "s1"]]);
  assert.ok(asked.every((row) => row.user === "user-a"));

  assert.equal((await call("/api/research-goals/s1/pause?projectId=somebody-elses", "POST")).status, 404);
  assert.equal(acts.length, 2, "a project that is not the person's reaches no goal");

  const off = await serve(t, null);
  const refused = await off.call("/api/research-goals/s1/pause?projectId=project-a", "POST");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "research_goal_unavailable");
});

test("a session id outside the wire's shape, an unknown act, a wrong method and a missing token go no further", async (t) => {
  const acts = [];
  const goals = { list: async () => [], pause: async () => { acts.push("pause"); return {}; }, resume: async () => { acts.push("resume"); return {}; } };
  const { call } = await serve(t, goals);
  assert.equal((await call("/api/research-goals/a%20b/pause?projectId=project-a", "POST")).status, 404);
  assert.equal((await call("/api/research-goals/s1/stop?projectId=project-a", "POST")).status, 404);
  assert.equal((await call("/api/research-goals/s1/pause?projectId=project-a")).status, 404);
  assert.equal((await call("/api/research-goals", "POST")).status >= 400, true);
  assert.deepEqual(acts, []);

  const noToken = await serve(t, goals, { csrf: async () => { throw new HttpError(403, "csrf_required", "CSRF token required."); } });
  assert.equal((await noToken.call("/api/research-goals/s1/pause?projectId=project-a", "POST")).status, 403);
  assert.deepEqual(acts, []);
});

test("a path that is not this feature's is left to the next route", async (t) => {
  const { call } = await serve(t, null);
  assert.equal((await call("/api/research-goalsmith?projectId=project-a")).status, 599);
});
