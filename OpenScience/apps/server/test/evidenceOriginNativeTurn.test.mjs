// The card a conversation was started from (evidence-flywheel F06) is recorded on a run by the road that has no dispatch: a
// message typed into the kernel's own application and adopted from its transcript, bound to a research session made before
// anyone typed. Both roads reserve their run against the same session record, so a card cannot be forgotten by one road.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunStore } from "../src/agentRuns.mjs";
import { normalizeTranscript, transcriptToLedgerMessages } from "../src/dshRuntimeAdapter.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/dsh/native-turn-frames.json", import.meta.url), "utf8"));
const CARD = "ec_0123456789abcdef";

async function setup(t, { originCardOf, onOriginCardRun }) {
  const root = await mkdtemp(path.join(tmpdir(), "native-origin-"));
  const project = { id: "p1", userId: "u1", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  const binding = { sessionId: fixture.sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const store = new AgentRunStore({ get: async () => binding }, {
    model: "deepseek/deepseek-v4-pro",
    readSessionHistory: async () => transcriptToLedgerMessages(normalizeTranscript(fixture.sessionId, fixture.events)),
    readSessionStatus: async () => "idle",
    originCardOf, onOriginCardRun,
  });
  store.scheduleMonitor = () => {};
  t.after(async () => { await store.closeProject(project); await rm(root, { recursive: true, force: true }); });
  return { store, project, adopt: () => store.adoptRuntimeSession(project, fixture.sessionId, { transcript: normalizeTranscript(fixture.sessionId, fixture.events), routeTurn: async () => ({}) }) };
}

test("every run adopted from the bound conversation's transcript records the card, once, and the citation is told once per run", async (t) => {
  const told = [];
  const f = await setup(t, { originCardOf: async (_project, session) => (session.sessionId === fixture.sessionId ? CARD : null), onOriginCardRun: async (_project, run) => { told.push(run.id); } });
  await f.adopt();
  await f.adopt();
  const runs = await f.store.list(f.project);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.originCardId === CARD), "both native turns started from the card");
  assert.deepEqual([...told].sort(), runs.map((run) => run.id).sort(), "told once for each run, and not again when the transcript is read again");
});

test("a conversation with no card, a resolver that fails and a card id of no shape leave the runs as they would have been", async (t) => {
  for (const originCardOf of [async () => null, async () => { throw new Error("database down"); }, async () => "not-a-card-id"]) {
    const f = await setup(t, { originCardOf, onOriginCardRun: async () => { throw new Error("must not be asked"); } });
    await f.adopt();
    const runs = await f.store.list(f.project);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((run) => run.originCardId === undefined));
  }
});
