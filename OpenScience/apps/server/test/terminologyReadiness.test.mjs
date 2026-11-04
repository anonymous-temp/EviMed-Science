import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readinessTerminology, resetTerminologyReadiness } from "../src/terminologyReadiness.mjs";

const URL_ = "http://evimed-drug-evidence-adapter:8026/api/v1/evimed/terminology-lookup";
const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("nothing is configured: the fact says so and asks nobody", async () => {
  resetTerminologyReadiness();
  assert.deepEqual(await readinessTerminology({}, { fetcher: async () => { throw new Error("asked"); } }), { required: false, configured: false, loaded: false });
});

test("through the adapter the fact is the adapter's own: loaded with its release and entity count, or not with its reason; never a failure", async () => {
  resetTerminologyReadiness();
  const config = { evimedAdapterUrls: { terminologyLookup: URL_ } };
  const loaded = await readinessTerminology(config, { fetcher: answer({ terminology: { available: true, release: "evimed-terminology-v1", entities: 291507 } }) });
  assert.deepEqual(loaded, { required: false, configured: true, via: "adapter", loaded: true, release: "evimed-terminology-v1", entities: 291507 });
  resetTerminologyReadiness();
  const absent = await readinessTerminology(config, { fetcher: answer({ terminology: { configured: true, available: false, reason: "terminology_unavailable" } }) });
  assert.deepEqual([absent.loaded, absent.reason, absent.required], [false, "terminology_unavailable", false]);
  resetTerminologyReadiness();
  assert.equal((await readinessTerminology(config, { fetcher: answer({}, 503) })).reason, "adapter_status_503");
  resetTerminologyReadiness();
  assert.equal((await readinessTerminology(config, { fetcher: async () => { throw new Error("refused"); } })).reason, "adapter_unreachable");
  resetTerminologyReadiness();
  assert.equal((await readinessTerminology({ evimedAdapterUrls: { terminologyLookup: "not a url" } })).reason, "adapter_url_invalid");
});

test("the adapter is asked once a minute and the answer is shared", async () => {
  resetTerminologyReadiness();
  let asked = 0;
  let clock = 1_000_000;
  const config = { evimedAdapterUrls: { terminologyLookup: URL_ } };
  const deps = { fetcher: async () => { asked += 1; return new Response(JSON.stringify({ terminology: { available: true, release: "r", entities: 1 } })); }, now: () => clock };
  await readinessTerminology(config, deps);
  await readinessTerminology(config, deps);
  assert.equal(asked, 1);
  clock += 61_000;
  await readinessTerminology(config, deps);
  assert.equal(asked, 2);
});

test("a host runtime's file is looked at: present and usable, missing, or a link", async () => {
  resetTerminologyReadiness();
  const directory = await mkdtemp(join(tmpdir(), "term-ready-"));
  try {
    const file = join(directory, "terminology.sqlite");
    assert.equal((await readinessTerminology({ terminologyDb: file })).reason, "file_missing");
    await writeFile(file, "x".repeat(10));
    assert.deepEqual(await readinessTerminology({ terminologyDb: file }), { required: false, configured: true, via: "file", loaded: true, bytes: 10 });
    await symlink(file, join(directory, "link.sqlite"));
    assert.equal((await readinessTerminology({ terminologyDb: join(directory, "link.sqlite") })).reason, "file_not_usable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
