// A small fake of the EviMed control plane for testing bench-driver.mjs without production.
//
// It models only what the driver touches, with the behaviour read from the product's code (15f7749e8):
// - a project's skill selection is a document with a revision (created at revision 1 with the project, `initializeProject`);
// - `activation.phase` follows `SkillLibraryService.activation`: effective / ready / waiting / pending;
// - a runtime started while a run is `running` in the ledger does not mount a changed selection (`personalGenerationForStart`),
//   one started with nothing running does, and the selection is proven (`effective`) a moment after the runtime started;
// - a run records the runtime's skill pins (`personalSkillGeneration.pins`), the live catalogue lists a mounted personal skill;
// - `stop_runtime` is recorded so the test can tell which groups were stopped and when.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const PROOF_MS = 800;
const RUN_MS = 1200;

export async function startFake({ failSkillCreate = false, preselect = false } = {}) {
  const state = { users: new Map(), projects: new Map(), skills: new Map(), runs: [], sessions: new Map(), calls: [], accountDeleted: false, token: "csrf-token" };
  let runtimeSeq = 0;
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const log = (what, project, extra = {}) => state.calls.push({ at: Date.now(), what, project, ...extra });

  function project(id) { return state.projects.get(id); }
  function mountedPins(p) {
    return p.runtime?.mounted ?? [];
  }
  function startRuntime(p, { dispatch = false } = {}) {
    if (p.runtime) return;
    const busy = dispatch && state.runs.some((r) => r.projectId === p.id && r.status === "running");
    const proven = p.proof && p.proof.revision === p.selection.revision;
    // personalGenerationForStart: a proven generation is mounted; a changed selection is not mounted under work in flight.
    const mounted = proven || !busy ? p.selection.skills.map((s) => ({ ...s, source: "personal" })) : [];
    p.runtime = { id: ++runtimeSeq, mounted, desiredRevision: p.selection.revision };
    log("runtime-start", p.id, { dispatch, mounted: mounted.length });
    if (mounted.length === p.selection.skills.length && p.selection.skills.length) {
      const rt = p.runtime;
      setTimeout(() => { if (p.runtime === rt) p.proof = { revision: rt.desiredRevision, runtime: rt.id }; }, PROOF_MS);
    }
  }
  function activation(p) {
    const live = Boolean(p.runtime);
    const proven = p.proof && p.proof.revision === p.selection.revision && (live ? p.proof.runtime === p.runtime.id : true);
    const phase = proven ? (live ? "effective" : "ready") : (live ? "waiting" : "pending");
    return { phase, live, savedRevision: p.selection.revision, effectiveRevision: proven ? p.proof.revision : null, error: null };
  }
  function finishRun(run) {
    const p = project(run.projectId);
    setTimeout(() => {
      if (run.status !== "running") return;
      run.status = "succeeded"; run.phase = "accepted"; run.finishedAt = new Date().toISOString(); run.durationMs = RUN_MS;
      // The apply worker mounts a selection that was held back, once the work in flight has ended.
      if (p.runtime && p.runtime.mounted.length !== p.selection.skills.length) {
        const rt = p.runtime;
        setTimeout(() => { if (p.runtime === rt) { rt.mounted = p.selection.skills.map((s) => ({ ...s, source: "personal" })); p.proof = { revision: p.selection.revision, runtime: rt.id }; } }, PROOF_MS);
      }
    }, RUN_MS);
  }

  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });

  on("POST", /^\/api\/auth\/register$/, (req, res, _m, body) => { state.users.set(body.username, true); res.setHeader("set-cookie", "sid=fake; Path=/; HttpOnly"); return [201, { data: { csrfToken: state.token } }]; });
  on("DELETE", /^\/api\/account$/, (req) => { if (req.headers["x-open-science-csrf"] !== state.token) return [403, { code: "csrf_required" }]; state.accountDeleted = true; return [200, { data: { deleted: true } }]; });
  on("GET", /^\/api\/credits\/balance$/, () => [200, { data: { available: "200" } }]);
  on("POST", /^\/api\/simulated-wallet\/topups$/, () => [404, { code: "simulated_wallet_not_enabled" }]);
  on("POST", /^\/api\/projects$/, (req, res, _m, body) => {
    if (state.projects.has(body.id)) return [409, { code: "project_exists" }];
    const p = { id: body.id, selection: { revision: 1, skills: [] }, runtime: null, proof: null };
    if (preselect) { p.selection.skills = [{ skillId: "skill:rogue", revision: 1, digest: "sha256:x", nativeName: "personal-rogue" }]; p.selection.revision = 2; }
    state.projects.set(body.id, p); log("project-create", body.id);
    return [200, { data: { id: body.id } }];
  });
  on("DELETE", /^\/api\/projects\/([^/]+)$/, (req, res, m) => { state.projects.delete(decodeURIComponent(m[1])); log("project-delete", decodeURIComponent(m[1])); return [200, { data: {} }]; });
  on("POST", /^\/api\/skills$/, (req, res, _m, body) => {
    if (failSkillCreate) return [503, { code: "product_state_unavailable" }];
    const keys = Object.keys(body).sort().join(",");
    if (keys !== "description,expectedRevision,instructions,title" || body.expectedRevision !== 0) return [400, { code: "extension_contract_invalid" }];
    const id = `skill:${randomUUID()}`;
    const row = { id, revision: 1, payload: { title: body.title, nativeName: `personal-${sha(id).slice(0, 16)}-${sha(id).slice(16, 48)}`, digest: `sha256:${sha(body.instructions)}`, instructions: body.instructions } };
    state.skills.set(id, row); log("skill-create", null, { skillId: id });
    return [201, { data: row }];
  });
  on("GET", /^\/api\/projects\/([^/]+)\/skills$/, (req, res, m) => {
    const p = project(decodeURIComponent(m[1]));
    return p ? [200, { data: { id: `skills:project:${p.id}`, revision: p.selection.revision, payload: { skills: p.selection.skills }, activation: activation(p) } }] : [404, { code: "project_not_found" }];
  });
  on("PUT", /^\/api\/projects\/([^/]+)\/skills$/, (req, res, m, body) => {
    const p = project(decodeURIComponent(m[1]));
    if (Object.keys(body).sort().join(",") !== "expectedRevision,skills") return [400, { code: "extension_contract_invalid" }];
    if (body.expectedRevision !== p.selection.revision) return [409, { code: "product_revision_conflict" }];
    const skills = body.skills.map((s) => { const row = state.skills.get(s.skillId); if (!row || row.revision !== s.revision) throw Object.assign(new Error("missing"), { status: 404 }); return { skillId: s.skillId, revision: s.revision, digest: row.payload.digest, nativeName: row.payload.nativeName }; });
    p.selection = { revision: p.selection.revision + 1, skills };
    log("skill-select", p.id, { skills: skills.length });
    return [200, { data: { id: `skills:project:${p.id}`, revision: p.selection.revision, payload: { skills } } }];
  });
  on("GET", /^\/api\/projects\/([^/]+)\/skills\/effective$/, (req, res, m) => {
    const p = project(decodeURIComponent(m[1]));
    if (!p.runtime) return [503, { code: "product_state_unavailable" }];
    const items = [{ key: `skill:${sha("docx")}`, name: "docx", description: "Word", invocation: { userInvocable: true, modelInvocable: true }, source: "builtin", canDuplicate: true }];
    for (const pin of mountedPins(p)) {
      const row = state.skills.get(pin.skillId);
      items.push({ key: `skill:${sha(pin.skillId)}`, name: pin.nativeName, description: "probe", invocation: { userInvocable: true, modelInvocable: true }, source: "personal", canDuplicate: false,
        personalRef: { skillId: pin.skillId, revision: pin.revision, title: row.payload.title } });
    }
    return [200, { data: { state: "available", runtimeGeneration: `gen-${p.runtime.id}`, items, findings: [] } }];
  });
  on("PUT", /^\/api\/research-sessions\/([^/]+)$/, (req, res, m, body) => { state.sessions.set(m[1], { ...body, projectId: req.headers["x-open-science-project"] }); return [200, { data: { sessionId: m[1], mode: body.mode } }]; });
  on("POST", /^\/api\/agent-runs\/dispatch$/, (req, res, _m, body) => {
    const p = project(req.headers["x-open-science-project"]);
    if (state.runs.some((r) => r.projectId === p.id && r.status === "running")) return [409, { code: "agent_run_active" }];
    const run = { id: `run_${randomUUID().replaceAll("-", "")}`, projectId: p.id, sessionId: body.sessionId, dispatchId: body.dispatchId, status: "running", phase: "running", question: body.text,
      observedMessages: 4, observedToolCalls: 0, startedAt: new Date().toISOString(), effectiveAgentId: "open-domain-answer", effectiveRouteReason: "unrouted:open-domain", model: "deepseek/fake", archived: false };
    state.runs.push(run);
    startRuntime(p, { dispatch: true });
    const pins = mountedPins(p).map((s) => ({ skillId: s.skillId, revision: s.revision, digest: s.digest, nativeName: s.nativeName, source: "personal" }));
    if (pins.length) run.personalSkillGeneration = { generationId: "a".repeat(64), pins };
    run.mountedPins = pins; log("dispatch", p.id, { runId: run.id, pins: pins.length });
    finishRun(run);
    return [202, { data: { ...run } }];
  });
  on("GET", /^\/api\/agent-runs$/, (req) => [200, { data: state.runs.filter((r) => r.projectId === req.headers["x-open-science-project"] && !r.archived) }]);
  on("PATCH", /^\/api\/agent-runs\/([^/]+)$/, (req, res, m, body) => { const r = state.runs.find((x) => x.id === m[1]); r.archived = body.archived === true; return [200, { data: r }]; });
  on("POST", /^\/api\/agent-runs\/([^/]+)\/cancel$/, (req, res, m) => { const r = state.runs.find((x) => x.id === m[1]); if (r.status === "running") { r.status = "canceled"; r.errorCode = "runtime_canceled"; } return [200, { data: { run: r } }]; });
  on("GET", /^\/api\/runs\/([^/]+)\/usage$/, (req, res, m) => [200, { data: { runId: m[1], cost: 0.01, calls: 2, inputTokens: 100, outputTokens: 5, currency: "CNY" } }]);
  on("GET", /^\/api\/runtime\/sessions\/([^/]+)\/transcript$/, (req, res, m) => {
    const run = state.runs.find((r) => r.sessionId === m[1]);
    const p = project(run.projectId);
    if (!p.runtime) return [409, { code: "runtime_not_running" }];
    const skilled = (run.mountedPins ?? []).length > 0;
    const messages = [{ role: "user", parts: [{ type: "text", text: run.question }] }];
    if (skilled) messages.push({ role: "tool", parts: [{ type: "tool", tool: "skill", callId: "c1", status: "completed", input: { name: run.mountedPins[0].nativeName }, output: "loaded", error: null }] });
    messages.push({ role: "assistant", parts: [{ type: "text", text: `42${skilled ? "\nSKILL-PROBE-OK" : ""}` }] });
    return [200, { data: { sessionId: m[1], messages } }];
  });
  on("POST", /^\/api\/commands\/start_runtime$/, (req) => { const p = project(req.headers["x-open-science-project"]); log("start_runtime", p.id); startRuntime(p); return [200, { data: "http://x" }]; });
  on("POST", /^\/api\/commands\/stop_runtime$/, (req) => { const p = project(req.headers["x-open-science-project"]); log("stop_runtime", p.id); p.runtime = null; return [200, { data: null }]; });
  on("POST", /^\/api\/commands\/read_artifact$/, () => [404, { code: "file_not_found" }]);
  on("POST", /^\/api\/files\/upload$/, () => [200, { data: {} }]);
  on("GET", /^\/__state$/, () => [200, { data: { calls: state.calls, accountDeleted: state.accountDeleted, projects: [...state.projects.keys()] } }]);

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const route = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(url.pathname) : null })).find((x) => x.m);
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { /* not JSON */ }
      let out = [404, { code: "not_found" }];
      if (route) { try { out = route.r.fn(req, res, route.m, body); } catch (error) { out = [error.status ?? 500, { code: "fake_error" }]; } }
      res.writeHead(out[0], { "content-type": "application/json" });
      res.end(JSON.stringify(out[1]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, state, close: () => server.close() };
}
