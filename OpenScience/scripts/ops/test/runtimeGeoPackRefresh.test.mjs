import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { refreshGeoPack } from "../../../deploy/runtime-dsh/refresh-geo-pack.mjs";
import { rename } from "node:fs/promises";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-geo-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await mkdir(source); await mkdir(target);
  await writeFile(path.join(target, "old.md"), "private base bytes\n");
  return { source, target };
}

test("README-only public source preserves the installed private pack byte for byte", async (t) => {
  const { source, target } = await fixture(t);
  await writeFile(path.join(source, "README.md"), "public placeholder\n");
  assert.equal(await refreshGeoPack(source, target), "preserved");
  assert.deepEqual(await readdir(target), ["old.md"]);
  assert.equal(await readFile(path.join(target, "old.md"), "utf8"), "private base bytes\n");
});

test("a complete pack replaces the installed tree including removed files", async (t) => {
  const { source, target } = await fixture(t);
  await mkdir(path.join(source, "skills", "method"), { recursive: true });
  await writeFile(path.join(source, "skills", "method", "SKILL.md"), "new private method\n");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  await writeFile(path.join(source, "VENDORED.json"), JSON.stringify({ package: "geo-skills", files: 1,
    tree: digest(`skills/method/SKILL.md\0${digest("new private method\n")}\n`) }));
  assert.equal(await refreshGeoPack(source, target), "replaced");
  assert.deepEqual((await readdir(target)).sort(), ["VENDORED.json", "skills"]);
  assert.equal(await readFile(path.join(target, "skills", "method", "SKILL.md"), "utf8"), "new private method\n");
});

for (const incomplete of ["skills-only", "receipt-only", "empty-skills", "unexpected-file"]) {
  test(`partial pack ${incomplete} is refused without changing the base`, async (t) => {
    const { source, target } = await fixture(t);
    if (incomplete === "skills-only") await mkdir(path.join(source, "skills"));
    if (["receipt-only", "empty-skills"].includes(incomplete)) await writeFile(path.join(source, "VENDORED.json"), "{}\n");
    if (incomplete === "empty-skills") await mkdir(path.join(source, "skills"));
    if (incomplete === "unexpected-file") await writeFile(path.join(source, "method.md"), "partial\n");
    await assert.rejects(refreshGeoPack(source, target), /incomplete|partial/i);
    assert.equal(await readFile(path.join(target, "old.md"), "utf8"), "private base bytes\n");
  });
}

test("a truncated receipt-bound pack is refused before replacing the base", async (t) => {
  const { source, target } = await fixture(t);
  await mkdir(path.join(source, "skills", "method"), { recursive: true });
  await writeFile(path.join(source, "skills", "method", "SKILL.md"), "truncated method\n");
  await writeFile(path.join(source, "VENDORED.json"), JSON.stringify({ package: "geo-skills", files: 2, tree: "0".repeat(64) }));
  await assert.rejects(refreshGeoPack(source, target), /incomplete|partial/i);
  assert.equal(await readFile(path.join(target, "old.md"), "utf8"), "private base bytes\n");
});

test("a complete pack can populate a base that predates the private pack", async (t) => {
  const { source, target } = await fixture(t);
  await rm(target, { recursive: true });
  await mkdir(path.join(source, "skills", "method"), { recursive: true });
  await writeFile(path.join(source, "skills", "method", "SKILL.md"), "new private method\n");
  const digest = value => createHash("sha256").update(value).digest("hex");
  await writeFile(path.join(source, "VENDORED.json"), JSON.stringify({ package: "geo-skills", files: 1,
    tree: digest(`skills/method/SKILL.md\0${digest("new private method\n")}\n`) }));
  assert.equal(await refreshGeoPack(source, target), "replaced");
  assert.equal(await readFile(path.join(target, "skills", "method", "SKILL.md"), "utf8"), "new private method\n");
});

test("a pack replaces a base directory that rename cannot move (overlayfs EXDEV in a delta build)", async (t) => {
  // 2026-10-24: the first delta release after this script failed at its rename — the base image's
  // /opt/evimed/skills/geo-private lives in a lower layer, and overlayfs answers EXDEV.
  const { source, target } = await fixture(t);
  await mkdir(path.join(source, "skills", "method"), { recursive: true });
  await writeFile(path.join(source, "skills", "method", "SKILL.md"), "new private method\n");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  await writeFile(path.join(source, "VENDORED.json"), JSON.stringify({ package: "geo-skills", files: 1,
    tree: digest(`skills/method/SKILL.md\0${digest("new private method\n")}\n`) }));
  const exdev = async (from, to) => {
    if (from === target) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return rename(from, to);
  };
  assert.equal(await refreshGeoPack(source, target, { renameImpl: exdev }), "replaced");
  assert.deepEqual((await readdir(target)).sort(), ["VENDORED.json", "skills"]);
  assert.equal(await readFile(path.join(target, "skills", "method", "SKILL.md"), "utf8"), "new private method\n");
  assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.startsWith(".evimed-geo-pack-")), []);
});
