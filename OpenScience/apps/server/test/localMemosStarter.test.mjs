import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureLocalMemos,
  isMemosReady,
  registerMemosCleanup,
  waitForMemos,
} from "../../../scripts/dev/local-memos.mjs";

test("isMemosReady accepts a healthy Memos response and rejects failures", async () => {
  assert.equal(await isMemosReady({ fetchImpl: async () => new Response(null, { status: 200 }) }), true);
  assert.equal(await isMemosReady({ fetchImpl: async () => new Response(null, { status: 503 }) }), false);
  assert.equal(
    await isMemosReady({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    false,
  );
});

test("waitForMemos polls until the service is ready", async () => {
  let attempts = 0;
  const ready = await waitForMemos({
    fetchImpl: async () => new Response(null, { status: ++attempts >= 3 ? 200 : 503 }),
    timeoutMs: 100,
    intervalMs: 1,
  });
  assert.equal(ready, true);
  assert.equal(attempts, 3);
});

test("ensureLocalMemos skips startup without a configured PAT", async () => {
  const child = await ensureLocalMemos({
    memosRoot: "/missing",
    dataDir: "/missing",
    accessTokenFile: "/missing/pat",
    spawnImpl: () => {
      throw new Error("must not spawn");
    },
  });
  assert.equal(child, null);
});

test("ensureLocalMemos starts the vendored service with bounded arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-memos-start-"));
  const tokenFile = path.join(root, "memos.pat");
  await writeFile(tokenFile, "test-token", { mode: 0o600 });
  let command;
  let args;
  let options;
  const fakeChild = {
    killed: false,
    once() {},
    kill() {
      this.killed = true;
    },
  };
  let probes = 0;
  const child = await ensureLocalMemos({
    memosRoot: root,
    dataDir: path.join(root, "data"),
    accessTokenFile: tokenFile,
    spawnImpl: (nextCommand, nextArgs, nextOptions) => {
      command = nextCommand;
      args = nextArgs;
      options = nextOptions;
      return fakeChild;
    },
    fetchImpl: async () => new Response(null, { status: ++probes >= 2 ? 200 : 503 }),
  });
  assert.equal(child, fakeChild);
  assert.equal(command, "go");
  assert.deepEqual(args.slice(0, 4), ["run", "./cmd/memos", "--addr", "127.0.0.1"]);
  assert.equal(options.cwd, root);
  assert.equal(options.stdio, "inherit");
});

test("registerMemosCleanup terminates only the child when the wrapper exits", () => {
  const processRef = new EventEmitter();
  const child = {
    killed: false,
    kill(signal) {
      assert.equal(signal, "SIGTERM");
      this.killed = true;
    },
  };
  registerMemosCleanup(child, processRef);
  processRef.emit("exit");
  assert.equal(child.killed, true);
});
