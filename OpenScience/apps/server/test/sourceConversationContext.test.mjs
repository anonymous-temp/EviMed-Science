import assert from "node:assert/strict";
import test from "node:test";
import { sourceConversationContext } from "../src/sourceConversationContext.mjs";

test("a selected library, even a small one, names only readable selected documents and their real paths", async () => {
  const rows = {
    selected: { projectId: "p", display: { title: "Selected paper" }, payload: { outputs: { artifactPath: "knowledge-base/.evimed-derived/selected/index.md" } } },
    shared: { projectId: "other", display: { title: "Shared paper" } },
    private: { projectId: "other", display: { title: "Do not read" } },
  };
  const asked = [];
  const service = { get: async (user, id) => { assert.equal(user, "owner"); return rows[id] ?? null; },
    appliesTo: async (user, source, projectId) => { asked.push([user, projectId]); return source === rows.shared; } };
  const note = await sourceConversationContext(service, { userId: "owner", id: "p" }, { sourceScope: ["selected", "shared", "private", "deleted"] });
  // The check is asked for this project, never for the account: a document the library puts in another project is not selectable here.
  assert.deepEqual(asked, [["owner", "p"], ["owner", "p"]]);
  assert.match(note, /Selected paper/);
  assert.match(note, /library\/shared\/index.md/);
  assert.match(note, /\.evimed-knowledge\/\.evimed-derived\/selected\/index.md/);
  assert.doesNotMatch(note, /Do not read|private|deleted/);
  assert.match(note, /including when reading files directly/);
  assert.equal(await sourceConversationContext(service, { id: "p" }, { sourceScope: null }), null);
  assert.match(await sourceConversationContext(service, { id: "p" }, { sourceScope: null }, true), /replaces any document selection stated in earlier turns/);
});

test("an unavailable scoped library never becomes an instruction to read everything", async () => {
  const note = await sourceConversationContext({ get: async () => null }, { id: "p" }, { sourceScope: ["gone"] });
  assert.match(note, /do not substitute other documents/);
  assert.ok(note.endsWith("[]"));
  await assert.rejects(sourceConversationContext({ get: async () => { throw new Error("database down"); } }, { id: "p" }, { sourceScope: ["gone"] }), /database down/);
});

test("explicit selected-empty context never advertises unrestricted knowledge", async () => {
  const context = await sourceConversationContext(null, { userId: "user-1", id: "project-1" }, { sourceScope: [] }, true);
  assert.match(context, /No selected document is currently eligible/);
  assert.match(context, /do not broaden/);
  assert.doesNotMatch(context, /currently applies no document selection/);
});

test('project source context excludes library and unproven derived pages before their titles and paths are rendered', async () => {
  const rows = {
    local: { id: 'local', projectId: 'p', payload: { metadata: { title: 'Project source' }, outputs: { artifactPath: 'knowledge-base/local/index.md' } } },
    derived: { id: 'derived', projectId: 'p', payload: { metadata: { title: 'Unproven private synthesis' }, outputs: { artifactPath: 'knowledge-base/derived/index.md' } } },
    foreign: { id: 'foreign', projectId: 'other', display: { title: 'Private library title' } },
  };
  const service = { get: async (_user, id) => rows[id], appliesTo: async () => { throw new Error('Library must not be consulted'); } };
  const note = await sourceConversationContext(service, { userId: 'owner', id: 'p' }, { sourceScope: Object.keys(rows) }, false,
    { includeLibrary: false, acceptSource: async source => source.id === 'local' });
  assert.match(note, /Project source/); assert.match(note, /local\/index.md/);
  assert.doesNotMatch(note, /private|Private|library\//);
  await assert.rejects(sourceConversationContext(service, { userId: 'owner', id: 'p' }, { sourceScope: ['local'] }, false,
    { includeLibrary: false, acceptSource: async () => { throw new Error('Source proof unavailable'); } }), /Source proof unavailable/);
});
