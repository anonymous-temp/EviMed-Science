import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { plan } from "../../../scripts/ops/release-retention.mjs";

/**
 * A releases directory holding the given ids, newest last.
 *
 * @param {readonly string[]} ids @returns {Promise<string>}
 */
async function releasesDir(ids) {
  const root = await mkdtemp(path.join(tmpdir(), "release-retention-"));
  const releases = path.join(root, "releases");
  await mkdir(releases);
  for (const id of ids) await mkdir(path.join(releases, id));
  return releases;
}

const IDS = [
  "evimed-20260901-aaaaaaa",
  "evimed-20260902-bbbbbbb",
  "evimed-20260903-ccccccc",
  "evimed-20260904-ddddddd",
];

test("the newest releases are kept and the rest are removable", async () => {
  const dir = await releasesDir(IDS);
  const result = await plan(dir, 2, async () => new Set());
  assert.deepEqual([...result.keep.keys()].sort(), ["evimed-20260903-ccccccc", "evimed-20260904-ddddddd"]);
  assert.deepEqual(result.remove, ["evimed-20260901-aaaaaaa", "evimed-20260902-bbbbbbb"]);
});

test("a release a container still mounts is kept however old it is", async () => {
  const dir = await releasesDir(IDS);
  // This is the case that matters: on the production host the active release
  // mounts its own manifest and an older one still supplies a receipt, so a
  // rule that counted only names would delete a directory out from under a
  // running container.
  const result = await plan(dir, 1, async () => new Set(["evimed-20260901-aaaaaaa"]));
  assert.equal(result.keep.get("evimed-20260901-aaaaaaa"), "mounted");
  assert.equal(result.keep.get("evimed-20260904-ddddddd"), "newest");
  assert.deepEqual(result.remove, ["evimed-20260902-bbbbbbb", "evimed-20260903-ccccccc"]);
});

test("a release that is both newest and mounted says so once, and is never removed", async () => {
  const dir = await releasesDir(IDS);
  const result = await plan(dir, 1, async () => new Set(["evimed-20260904-ddddddd"]));
  assert.equal(result.keep.get("evimed-20260904-ddddddd"), "newest+mounted");
  assert.ok(!result.remove.includes("evimed-20260904-ddddddd"));
});

test("an unreadable container list refuses rather than reporting nothing in use", async () => {
  const dir = await releasesDir(IDS);
  // An empty set would read as "no release is in use" and delete the live one.
  // Propagating is the only safe answer.
  await assert.rejects(
    () => plan(dir, 1, async () => { throw new Error("docker unreachable"); }),
    /docker unreachable/,
  );
});

test("names that are not release ids are left alone entirely", async () => {
  const dir = await releasesDir(IDS);
  await mkdir(path.join(dir, "acceptance"));
  await symlink(path.join(dir, IDS[3]), path.join(dir, "current"));
  const result = await plan(dir, 1, async () => new Set());
  assert.ok(!result.remove.includes("acceptance"));
  assert.ok(!result.remove.includes("current"));
  assert.ok((await readdir(dir)).includes("acceptance"));
});

test("a symlinked releases directory is refused", async () => {
  const dir = await releasesDir(IDS);
  const link = path.join(path.dirname(dir), "link");
  await symlink(dir, link);
  await assert.rejects(() => plan(link, 1, async () => new Set()), /must not be a symbolic link/);
});
