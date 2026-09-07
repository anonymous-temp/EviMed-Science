import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const cleanEnvironment = {
  ...process.env,
  OPEN_SCIENCE_BACKUP_PASSPHRASE: "",
  OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "",
  OPEN_SCIENCE_OBJECT_BACKUP_URI: "",
  OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "",
};

function tarNumber(buffer, offset, length) {
  const value = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function tarEntries(archive) {
  const body = gunzipSync(archive);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= body.length;) {
    const header = body.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    if (type !== "x") {
      entries.set(name.replace(/\/$/, ""), {
        gid: tarNumber(header, 116, 8),
        mode: tarNumber(header, 100, 8),
        type,
        uid: tarNumber(header, 108, 8),
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "recovery-primitives-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const backups = path.join(root, "backups");
  await mkdir(data, { mode: 0o750 });
  const payload = path.join(data, "payload.txt");
  await writeFile(payload, "synthetic recovery member\n", { mode: 0o640 });
  await chmod(data, 0o750);
  await chmod(payload, 0o640);
  return { backups, data, payload, root };
}

async function capture(data, backups, env = cleanEnvironment) {
  const result = await execute("bash", [path.join(ops, "backup-data.sh"), data, backups], { env });
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

test("backup archives the exact numeric uid, gid, and mode inventoried for every entry", async (t) => {
  const { backups, data, payload } = await fixture(t);
  const archive = await capture(data, backups);
  const entries = tarEntries(await readFile(archive));
  const expectedRoot = await stat(data);
  const expectedPayload = await stat(payload);

  assert.deepEqual(entries.get("."), {
    gid: expectedRoot.gid,
    mode: expectedRoot.mode & 0o7777,
    type: "5",
    uid: expectedRoot.uid,
  });
  assert.deepEqual(entries.get("payload.txt"), {
    gid: expectedPayload.gid,
    mode: expectedPayload.mode & 0o7777,
    type: "0",
    uid: expectedPayload.uid,
  });
});

test("backup fails closed when entry metadata changes after inventory", async (t) => {
  const { backups, data, payload, root } = await fixture(t);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const wrapper = path.join(bin, "node");
  await writeFile(wrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  chmod 0600 "$EVIMED_TEST_MUTATE_PATH"
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`);
  await chmod(wrapper, 0o700);

  await assert.rejects(
    capture(data, backups, {
      ...cleanEnvironment,
      PATH: `${bin}:${process.env.PATH}`,
      EVIMED_TEST_MUTATE_PATH: payload,
      EVIMED_TEST_REAL_NODE: process.execPath,
    }),
    (error) => {
      assert.match(error.stderr, /Backup source identity changed after inventory/);
      return true;
    },
  );
  assert.deepEqual(await readdir(backups), []);
});

test("strict backup rejects a same-inode content change without publishing an archive or checksum", async (t) => {
  const { backups, data, payload, root } = await fixture(t);
  const bin = path.join(root, "strict-bin");
  await mkdir(bin);
  const wrapper = path.join(bin, "node");
  await writeFile(wrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  "$EVIMED_TEST_REAL_NODE" -e 'const fs=require("node:fs"); const file=process.argv[1]; fs.writeFileSync(file,"synthetic changed member!\\n"); fs.utimesSync(file,new Date(1000),new Date(2000));' "$EVIMED_TEST_MUTATE_PATH"
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`);
  await chmod(wrapper, 0o700);
  const env = {
    ...cleanEnvironment,
    PATH: `${bin}:${process.env.PATH}`,
    EVIMED_TEST_MUTATE_PATH: payload,
    EVIMED_TEST_REAL_NODE: process.execPath,
  };

  const legacy = await execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "legacy")], { env });
  assert.match(legacy.stderr, /backup note: 1 file\(s\) changed while being read/);
  assert.ok(legacy.stdout.trim().endsWith(".tar.gz"));

  await writeFile(payload, "synthetic recovery member\n");
  await assert.rejects(
    execute("bash", [path.join(ops, "backup-data.sh"), data, backups], {
      env: { ...env, OPEN_SCIENCE_BACKUP_STRICT: "true" },
    }),
    (error) => {
      assert.match(error.stderr, /strict backup refused a changing source/);
      return true;
    },
  );
  assert.deepEqual(await readdir(backups), []);
});

test("strict backup binds ctime and content when a same-size rewrite restores the original mtime", async (t) => {
  const { backups, data, payload, root } = await fixture(t);
  const original = await stat(payload, { bigint: true });
  const bin = path.join(root, "ctime-bin");
  await mkdir(bin);
  const wrapper = path.join(bin, "node");
  await writeFile(wrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  python3 -c 'import os,sys; p=sys.argv[1]; open(p,"wb").write(b"synthetic changed member!\\n"); os.utime(p, ns=(int(sys.argv[2]),int(sys.argv[3])))' "$EVIMED_TEST_MUTATE_PATH" "$EVIMED_TEST_ATIME_NS" "$EVIMED_TEST_MTIME_NS"
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`);
  await chmod(wrapper, 0o700);

  await assert.rejects(
    execute("bash", [path.join(ops, "backup-data.sh"), data, backups], {
      env: {
        ...cleanEnvironment,
        PATH: `${bin}:${process.env.PATH}`,
        OPEN_SCIENCE_BACKUP_STRICT: "true",
        EVIMED_TEST_ATIME_NS: String(original.atimeNs),
        EVIMED_TEST_MTIME_NS: String(original.mtimeNs),
        EVIMED_TEST_MUTATE_PATH: payload,
        EVIMED_TEST_REAL_NODE: process.execPath,
      },
    }),
    (error) => {
      assert.match(error.stderr, /strict backup refused|identity changed/);
      return true;
    },
  );
  assert.deepEqual(await readdir(backups), []);
});

test("strict backup revalidates a file replaced after its bytes were read", async (t) => {
  const { backups, data, payload, root } = await fixture(t);
  await writeFile(path.join(data, "z-large.bin"), randomBytes(32 * 1024 * 1024));
  const replacement = path.join(root, "replacement.txt");
  await writeFile(replacement, "synthetic replacement data\n");
  const marker = path.join(root, "replaced");
  const bin = path.join(root, "post-read-bin");
  await mkdir(bin);
  const wrapper = path.join(bin, "node");
  await writeFile(wrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  python3 -c 'import os,sys,time; out,target,replacement,marker=sys.argv[1:]; deadline=time.time()+10
while time.time()<deadline:
  try:
    if os.stat(out).st_size > 65536:
      os.replace(replacement,target); open(marker,"w").close(); break
  except FileNotFoundError: pass
  time.sleep(.005)' "$4" "$EVIMED_TEST_MUTATE_PATH" "$EVIMED_TEST_REPLACEMENT" "$EVIMED_TEST_MARKER" &
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`);
  await chmod(wrapper, 0o700);

  await assert.rejects(
    execute("bash", [path.join(ops, "backup-data.sh"), data, backups], {
      env: {
        ...cleanEnvironment,
        PATH: `${bin}:${process.env.PATH}`,
        OPEN_SCIENCE_BACKUP_STRICT: "true",
        EVIMED_TEST_MARKER: marker,
        EVIMED_TEST_MUTATE_PATH: payload,
        EVIMED_TEST_REAL_NODE: process.execPath,
        EVIMED_TEST_REPLACEMENT: replacement,
      },
    }),
    (error) => {
      assert.match(error.stderr, /strict backup refused|identity changed/);
      return true;
    },
  );
  await access(marker);
  assert.deepEqual(await readdir(backups), []);
});

test("numeric-owner restore is explicit, root-gated, and leaves the target untouched on refusal", async (t) => {
  const { backups, data, root } = await fixture(t);
  const archive = await capture(data, backups);
  const target = path.join(root, "restored");

  if (process.getuid?.() !== 0) {
    await assert.rejects(
      execute("bash", [path.join(ops, "restore-data.sh"), "--numeric-owner", archive, target], { env: cleanEnvironment }),
      (error) => {
        assert.match(error.stderr, /numeric_owner_requires_root/);
        return true;
      },
    );
    await assert.rejects(access(target), { code: "ENOENT" });
    return;
  }

  await execute("bash", [path.join(ops, "restore-data.sh"), "--numeric-owner", archive, target], { env: cleanEnvironment });
  const restored = await stat(path.join(target, "payload.txt"));
  const original = await stat(path.join(data, "payload.txt"));
  assert.deepEqual([restored.uid, restored.gid, restored.mode & 0o7777], [original.uid, original.gid, original.mode & 0o7777]);
});
