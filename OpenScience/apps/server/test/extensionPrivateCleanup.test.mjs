import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removePrivateExtensionFiles } from "../src/extensionPrivateCleanup.mjs";

test("account cleanup removes only its fixed private namespaces without following links or deleting another account", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-extension-purge-")));
  const hash = value => createHash("sha256").update(value).digest("hex");
  try {
    const untouched = path.join(root, "untouched");
    await fs.writeFile(untouched, "outside bytes");
    for (const namespace of ["skill-library", "personal-skill-generations", "extension-generations", "extension-operations"]) {
      const owned = path.join(root, ".openscience", namespace, hash("alice"));
      const other = path.join(root, ".openscience", namespace, hash("bob"));
      await fs.mkdir(path.join(owned, "nested"), { recursive: true });
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(owned, "nested", "resource"), "private bytes");
      await fs.symlink(untouched, path.join(owned, "link"));
      await fs.writeFile(path.join(other, "resource"), "other bytes");
    }
    await removePrivateExtensionFiles(root, "alice");
    await removePrivateExtensionFiles(root, "alice");
    assert.equal(await fs.readFile(untouched, "utf8"), "outside bytes");
    for (const namespace of ["skill-library", "personal-skill-generations", "extension-generations", "extension-operations"]) {
      await assert.rejects(fs.stat(path.join(root, ".openscience", namespace, hash("alice"))), { code: "ENOENT" });
      assert.equal(await fs.readFile(path.join(root, ".openscience", namespace, hash("bob"), "resource"), "utf8"), "other bytes");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
