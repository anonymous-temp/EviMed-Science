import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const environment = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE: "", OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "",
  OPEN_SCIENCE_OBJECT_BACKUP_URI: "", OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "" };
const native = "users/u/projects/p/runtime/container-runtime";

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "bds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const put = async (relative, value) => {
    const target = path.join(data, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
    return target;
  };
  return { root, data, put };
}

async function roundTrip(t, encrypted) {
  const { root, data, put } = await fixture(t);
  const retained = new Map([
    [`${native}/dsh-home/sessions/session-one.jsonl`, '{"seq":1,"type":"user","text":"Synthetic research question"}\n{"seq":2,"type":"assistant","text":"Synthetic answer"}\n'],
    [`${native}/dsh-home/sessions/session-two/log.jsonl`, '{"seq":1,"type":"user","text":"Another retained session"}\n'],
    [`${native}/dsh-home/sessions/session-two/metadata.json`, '{"name":"Synthetic session"}\n'],
    [`${native}/dsh-home/sessions/session-two/attachments/input.csv`, 'group,value\na,1\n'],
    ["users/u/projects/p/workspace/notes with spaces\nand newline.md", "Retain the researcher workspace.\n"],
    ["users/u/projects/p/workspace/container-runtime/ordinary-data.txt", "This is user data, not managed runtime scratch.\n"],
    [`users/u/projects/p/workspace/${"研究资料".repeat(15)}/${"nested-directory/".repeat(12)}${"报告".repeat(35)}.md`, "Preserve Unicode and paths beyond USTAR limits.\n"],
    [`${native}/dsh-home/sessions/session-two/attachments/${"x".repeat(240)}.txt`, "Preserve a legal long attachment filename.\n"],
  ]);
  for (const [relative, contents] of retained) await put(relative, contents);
  const omitted = [
    `${native}/dsh-home/.credentials.yaml`, `${native}/dsh-home/model-gateway-token`,
    `${native}/dsh-home/evimed-workload-token`, `${native}/dsh-home/control-plane-patch.yml`,
    `${native}/dsh-home/package.json`, `${native}/dsh-home/node_modules/example/package.json`,
    `${native}/xdg-cache/cache.bin`, `${native}/home/.cache/cache.bin`, `${native}/tmp/scratch.txt`,
    `${native}/future-runtime-state/credential.txt`, ".runtime-sockets/control.sock",
  ];
  for (const relative of omitted) await put(relative, "SYNTHETIC-RUNTIME-ONLY\n");
  await symlink("package.json", path.join(data, native, "dsh-home/node_modules/example/link"));
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(path.join(data, "live-endpoint"), resolve);
  });
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  const env = { ...environment };
  if (encrypted) {
    const passphrase = path.join(root, "passphrase");
    await writeFile(passphrase, "Synthetic archive passphrase for this fixture only.\n", { mode: 0o600 });
    env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE = passphrase;
  }
  const backup = await execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "backups")], { env });
  const archive = backup.stdout.trim().split(/\r?\n/).at(-1);
  assert.equal(archive.endsWith(".enc"), encrypted);
  const target = path.join(root, "restored");
  await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env });
  for (const [relative, contents] of retained) {
    assert.equal(await readFile(path.join(target, relative), "utf8"), contents, `${relative} must survive a real restore`);
  }
  for (const relative of [...omitted, "live-endpoint"]) {
    await assert.rejects(readFile(path.join(target, relative)), { code: "ENOENT" });
  }
  assert.deepEqual(await readdir(path.join(target, native, "dsh-home")), ["sessions"]);
}

test("real backup and restore retain native DSH journals while omitting runtime credentials and installations", (t) => roundTrip(t, false));
test("encrypted backup and restore retain native DSH journals without runtime credentials or caches", (t) => roundTrip(t, true));

test("native session symlinks are rejected instead of being hidden by the runtime exclusion", async (t) => {
  const { root, data, put } = await fixture(t);
  const outside = path.join(root, "outside");
  await writeFile(outside, "Synthetic secret outside the data root.\n");
  const journal = await put(`${native}/dsh-home/sessions/retained.jsonl`, "{}\n");
  await symlink(outside, path.join(path.dirname(journal), "linked.jsonl"));
  await assert.rejects(execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "backups")], { env: environment }),
    (error) => /Refusing to back up data directory containing symbolic links/.test(error.stderr));
});

for (const relative of [native, `${native}/dsh-home`, `${native}/dsh-home/sessions`]) {
  test(`backup rejects a linked native session ancestor: ${relative}`, async (t) => {
    const { root, data, put } = await fixture(t);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "private.txt"), "Synthetic outside data.\n");
    await put("users/u/projects/p/workspace/note.txt", "Retained workspace.\n");
    await mkdir(path.dirname(path.join(data, relative)), { recursive: true });
    await symlink(outside, path.join(data, relative));
    await assert.rejects(execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "backups")], { env: environment }),
      (error) => /Refusing to back up data directory containing symbolic links/.test(error.stderr));
  });
}

for (const ancestor of [`${native}/dsh-home/sessions`, "users/u/projects/p/workspace/inputs"]) {
  test(`backup fails closed when an ancestor changes after inventory: ${ancestor}`, async (t) => {
    const { root, data, put } = await fixture(t);
    const relative = `${ancestor}/customer.jsonl`;
    await put(relative, "SYNTHETIC_CUSTOMER_RECORD\n");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const privateBytes = "SYNTHETIC_OUTSIDE_PRIVATE_BYTES\n";
    await writeFile(path.join(outside, "customer.jsonl"), privateBytes);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const realTar = (await execute("which", ["tar"])).stdout.trim();
    const marker = path.join(root, "swapped");
    for (const [name, command] of [["tar", "EVIMED_TEST_REAL_TAR"], ["node", "EVIMED_TEST_REAL_NODE"]]) {
      const wrapper = path.join(bin, name);
      await writeFile(wrapper, `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  case "$argument" in
    -czf|*/backup-archive.mjs)
      if [ ! -e "$EVIMED_TEST_SWAP_MARKER" ]; then
        mv "$EVIMED_TEST_SWAP_TARGET" "$EVIMED_TEST_SWAP_TARGET.saved"
        ln -s "$EVIMED_TEST_OUTSIDE" "$EVIMED_TEST_SWAP_TARGET"
        touch "$EVIMED_TEST_SWAP_MARKER"
      fi
      ;;
  esac
done
exec "$${command}" "$@"
`);
      await chmod(wrapper, 0o700);
    }
    const backups = path.join(root, "backups");
    let result;
    let failure;
    try {
      result = await execute("bash", [path.join(ops, "backup-data.sh"), data, backups], { env: { ...environment,
        PATH: `${bin}:${process.env.PATH}`, EVIMED_TEST_REAL_TAR: realTar, EVIMED_TEST_REAL_NODE: process.execPath,
        EVIMED_TEST_SWAP_MARKER: marker, EVIMED_TEST_SWAP_TARGET: path.join(data, ancestor), EVIMED_TEST_OUTSIDE: outside } });
    } catch (error) { failure = error; }
    assert.equal(await readFile(marker, "utf8"), "", "the fixture must actually replace the ancestor after inventory");
    if (result) {
      const archive = result.stdout.trim().split(/\r?\n/).at(-1);
      const archived = await execute(realTar, ["-xOzf", archive, `./${relative}`]);
      assert.equal(archived.stdout.includes(privateBytes), false, "the published archive must never contain bytes from outside the data root");
    }
    assert.ok(failure, "ancestor replacement must fail the backup, not become a tolerated file-changed warning");
    assert.deepEqual((await readdir(backups)).filter(name => name.includes(".tar.gz")), [], "failed output must not be published or left as a temporary archive");
  });
}
