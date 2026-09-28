// The specialist engines' requirements.lock files: the fully pinned set each
// image installs (scripts/ops/compile-engine-locks.sh; 2026-09-27 an unpinned
// openai 3.x broke the topic engine at import).
//
// What these tests hold is that a lock still describes its requirements: a
// package added to a requirements file, or an exact pin moved, without the
// lock being compiled again would otherwise build an image from a lock that no
// longer says what the requirements say — and nothing would notice until an
// engine failed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const openScience = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workspace = path.resolve(openScience, "..");
const adapterDir = path.join(openScience, "deploy/specialist-adapter");

/** The five engines the shared adapter Dockerfile builds, and the MetaAgent. */
const ENGINES = ["孟德尔随机化", "文献剂量分析", "科研选题", "论文审稿", "药物安全分析agent"];

/** @param {string} name */
const normalized = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * Requirement lines as `{ name, pin }`, `pin` set for an exact `==` pin.
 * @param {string} text
 */
function requirements(text) {
  return text.split("\n")
    .map((line) => line.split("#", 1)[0].trim())
    .filter((line) => line && !line.startsWith("-"))
    .map((line) => {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(line);
      assert.ok(match, `unreadable requirement: ${line}`);
      const exact = /^==\s*([^\s,;]+)$/.exec(match[2].trim());
      return { name: normalized(match[1]), pin: exact ? exact[1] : null };
    });
}

/** @param {string} text @returns {Map<string, string>} */
function lock(text) {
  const pins = new Map();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/.exec(line.trim());
    if (match && !line.startsWith(" ")) pins.set(normalized(match[1]), match[2]);
  }
  assert.ok(pins.size > 0, "the lock pins nothing: the read is broken");
  return pins;
}

/** @param {string} file */
const read = (file) => readFile(file, "utf8");

test("each engine's lock pins every requirement it names, at the version an exact requirement asks for", async () => {
  const adapter = requirements(await read(path.join(adapterDir, "requirements.txt")));
  const adapterPins = new Map(adapter.map((item) => [item.name, item.pin]));
  assert.ok([...adapterPins.values()].every(Boolean), "the adapter pins each of its requirements exactly");
  let checked = 0;
  for (const engine of ENGINES) {
    const dir = path.join(workspace, "项目代码", engine);
    const pinned = lock(await read(path.join(dir, "requirements.lock")));
    for (const item of requirements(await read(path.join(dir, "requirements.txt")))) {
      assert.ok(pinned.has(item.name), `${engine}: ${item.name} is required but not in requirements.lock; run compile-engine-locks.sh`);
      // The image installs the engine's requirements and then the adapter's,
      // so where both pin a package the adapter's pin is what the image runs.
      const expected = adapterPins.get(item.name) ?? item.pin;
      if (expected) assert.equal(pinned.get(item.name), expected, `${engine}: ${item.name} is pinned ${expected}, the lock says ${pinned.get(item.name)}`);
      checked += 1;
    }
    for (const [name, pin] of adapterPins) {
      assert.equal(pinned.get(name), pin, `${engine}: the adapter pins ${name}==${pin}; the lock says ${pinned.get(name)}`);
    }
  }
  assert.ok(checked > 60, `checked ${checked} requirements`);
});

test("the MetaAgent's and the evidence adapter's locks pin what their images install", async () => {
  const meta = path.join(workspace, "项目代码/meta");
  const pyproject = await read(path.join(meta, "pyproject.toml"));
  const block = /^dependencies = \[([\s\S]*?)^\]/m.exec(pyproject)?.[1] ?? "";
  const declared = requirements([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).join("\n"));
  assert.ok(declared.length > 10, "read the project's dependencies");
  const metaLock = lock(await read(path.join(meta, "requirements.lock")));
  for (const item of declared) {
    assert.ok(metaLock.has(item.name), `meta: ${item.name} is a dependency but not in requirements.lock`);
    if (item.pin) assert.equal(metaLock.get(item.name), item.pin, `meta: ${item.name}`);
  }
  const adapterLock = lock(await read(path.join(adapterDir, "requirements.lock")));
  for (const item of requirements(await read(path.join(adapterDir, "requirements.txt")))) {
    assert.equal(adapterLock.get(item.name), item.pin, `adapter: ${item.name}`);
  }
});

test("every image that has a lock installs it, and the delta installs a lock the running image does not hold", async () => {
  const engine = await read(path.join(adapterDir, "Dockerfile"));
  assert.match(engine, /COPY \$\{AGENT_DIR\}\/requirements\.txt \$\{AGENT_DIR\}\/requirements\.loc\[k\] \/tmp\/agent-requirements\//);
  assert.match(engine, /if \[ -f \/tmp\/agent-requirements\/requirements\.lock \]; then agent_requirements=\/tmp\/agent-requirements\/requirements\.lock; fi/);
  const evidence = await read(path.join(adapterDir, "Dockerfile.evidence"));
  assert.match(evidence, /if \[ -f \/tmp\/adapter-requirements\/requirements\.lock \]; then requirements=\/tmp\/adapter-requirements\/requirements\.lock; fi/);
  const meta = await read(path.join(workspace, "项目代码/meta/Dockerfile.evimed"));
  assert.match(meta, /if \[ -f requirements\.lock \]; then pip install [^\n]*-r requirements\.lock; fi/);
  const delta = await read(path.join(openScience, "scripts/ops/host-engine-delta.sh"));
  assert.match(delta, /same_requirements "\$1" "\$2\/requirements\.lock" "\$3\/requirements\.lock"/);
  for (const call of ['same_inputs "$base" /agent "${agent}"', 'same_inputs "$base" /adapter OpenScience/deploy/specialist-adapter', 'same_inputs "$base" /app 项目代码/meta']) {
    assert.ok(delta.includes(call), `host-engine-delta.sh compares ${call}`);
  }
  // 2026-09-28: a lock the running image does not hold is installed over it
  // (pip moves only what differs), rather than forcing a full rebuild of every
  // engine — the MR engine's R and CRAN packages among them — to adopt a pin.
  for (const call of ['lock_differs "$base" /agent "${agent}"', 'lock_differs "$base" /adapter OpenScience/deploy/specialist-adapter', 'lock_differs "$base" /app 项目代码/meta']) {
    assert.ok(delta.includes(call), `host-engine-delta.sh checks ${call}`);
  }
  assert.match(delta, /RUN pip install --index-url %s --no-cache-dir -r \/agent\/requirements\.lock/);
  assert.match(delta, /RUN pip install --index-url %s --no-cache-dir -r \/adapter\/requirements\.lock/);
  assert.match(delta, /RUN pip install --index-url %s --no-cache-dir -r \/app\/requirements\.lock/);
});
