import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, createRebuildIndex } from "../rebuild-kb-index.mjs";

test("rebuild CLI selects explicit accounts and composes the application's existing library without provider calls", async () => {
  assert.deepEqual(parseArguments(["--user","one","--user","two"]),{ users:["one","two"],all:false });
  assert.deepEqual(parseArguments(["--all"]),{ users:[],all:true });
  for (const argv of [[],["--user"],["--unknown"]]) assert.throws(()=>parseArguments(argv));
  const database={ query:async()=>{ throw new Error("construction must not query or migrate"); } };
  const embedder={ configured:false,counters:{} };
  const index=await createRebuildIndex({ database,config:{ dataDir:"/tmp/evimed-rebuild-cli-test",libraryMaxItems:1000,kbEmbeddingDimension:1024 },embedder });
  assert.equal(index.database,database); assert.equal(index.embedder,embedder);
  assert.equal(index.library.database,database); assert.equal(index.library.sources,index.sources);
  assert.equal(index.library.documents,index.sources.documents);
  assert.equal(index.library.libraryDir("test-user"),"/tmp/evimed-rebuild-cli-test/users/test-user/library");
});
