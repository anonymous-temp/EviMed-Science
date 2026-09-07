import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fsPromises from "node:fs/promises";
import {
  HttpError,
  appendJsonLineNoFollow,
  assertNoSymlinkPath,
  errorDetailShapes,
  openScopedDirectoryNoFollow,
  readFileNoFollow,
  readTextFileNoFollow,
  resolveScopedPath,
  safeId,
  sendError,
  directorySize,
  writeFileAtomicNoFollow,
  writeFileExclusiveNoFollow,
} from "../src/security.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";

test("text fallback treats a missing parent directory as a missing file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-text-fallback-"));
  try {
    assert.equal(await readTextFileNoFollow(root, path.join(root, "absent", "state.json"), "fallback"), "fallback");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The quota monitor walks a workspace an analysis is actively writing to. A
// file removed between readdir and lstat is that workspace being alive, not a
// fault — but only the vanishing-directory case was tolerated, so a run
// deleting its own scratch file raised a raw ENOENT, which is not an HttpError
// and so read as "the check itself failed". The guard stopped the runtime, the
// runtime does not return on its own, and seventeen queued analyses never ran.
//
// The window is between readdir listing a name and lstat reaching it, so the
// only faithful reproduction is to remove the file inside that window.
test("a file removed while the workspace is being measured does not fail the measurement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-directory-size-race-"));
  const realLstat = fsPromises.lstat;
  try {
    await writeFile(path.join(root, "keep.md"), "x".repeat(100), "utf8");
    const doomed = path.join(root, "doomed.md");
    await writeFile(doomed, "y".repeat(4096), "utf8");

    fsPromises.lstat = async (target, ...rest) => {
      if (String(target).endsWith("doomed.md")) {
        await rm(doomed, { force: true });
      }
      return realLstat(target, ...rest);
    };

    const total = await directorySize(root, { maxEntries: 100 });
    assert.equal(total, 100, "the file that survived is counted and the one that vanished is skipped");
  } finally {
    fsPromises.lstat = realLstat;
    await rm(root, { recursive: true, force: true });
  }
});

test("a hard link cannot read a file that lives outside the workspace", async () => {
  // Every other containment check is path-based, and the link's path is
  // genuinely inside the root — only the inode gives it away.
  const base = await mkdtemp(path.join(tmpdir(), "os-web-hardlink-"));
  const root = path.join(base, "workspace");
  await mkdir(root, { recursive: true });
  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "content the workspace must not reach", "utf8");
  const planted = path.join(root, "innocent.txt");
  await link(outside, planted);

  await assert.rejects(
    () => readFileNoFollow(root, planted),
    (error) => error instanceof HttpError && error.status === 403 && error.code === "path_forbidden",
  );

  const ordinary = path.join(root, "ordinary.txt");
  await writeFile(ordinary, "ordinary content", "utf8");
  assert.equal(String(await readFileNoFollow(root, ordinary)), "ordinary content");
  await rm(base, { recursive: true, force: true });
});

test("a FIFO in the workspace is refused instead of blocking the request", async () => {
  // mkfifo needs no privilege, so without O_NONBLOCK any workspace occupant
  // could park a reader in open() forever and the type check below would never
  // be reached.
  const root = await mkdtemp(path.join(tmpdir(), "os-web-fifo-"));
  const fifo = path.join(root, "pipe.txt");
  execFileSync("mkfifo", [fifo]);

  const outcome = await Promise.race([
    readFileNoFollow(root, fifo).then(() => "returned").catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
  ]);
  assert.notEqual(outcome, "blocked", "opening a FIFO must not wait for a writer");
  assert.ok(outcome instanceof HttpError && outcome.code === "not_a_file", `unexpected outcome: ${outcome}`);
  await rm(root, { recursive: true, force: true });
});

test("resolveScopedPath keeps relative paths inside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-"));
  const full = resolveScopedPath(root, "data/table.csv");

  assert.equal(full, path.join(root, "data/table.csv"));
});

test("resolveScopedPath rejects absolute paths and traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-"));

  assert.throws(() => resolveScopedPath(root, "/etc/passwd"), HttpError);
  assert.throws(() => resolveScopedPath(root, "../secret.txt"), HttpError);
  assert.throws(() => resolveScopedPath(root, "nested/../../secret.txt"), HttpError);
  assert.throws(() => resolveScopedPath(root, "C:\\Users\\secret.txt"), HttpError);
});

test("safeId accepts compact ids and rejects path-like ids", () => {
  assert.equal(safeId("project_1"), "project_1");
  assert.throws(() => safeId("../project"), HttpError);
});

test("assertNoSymlinkPath refuses a symlinked root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-security-root-"));
  try {
    const realRoot = path.join(parent, "real-root");
    const linkedRoot = path.join(parent, "linked-root");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);

    await assert.rejects(
      () => assertNoSymlinkPath(linkedRoot, path.join(linkedRoot, "artifact.txt"), { allowMissingTail: true }),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("scoped no-follow file helpers atomically write and read nested files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-io-"));
  try {
    const file = path.join(root, "nested", "artifact.txt");
    await writeFileAtomicNoFollow(root, file, "first", { encoding: "utf8" });
    await writeFileAtomicNoFollow(root, file, "second", { encoding: "utf8" });
    assert.equal(await readFileNoFollow(root, file, "utf8"), "second");
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ["artifact.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive scoped writes are atomic and never replace user files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-exclusive-"));
  try {
    const file = path.join(root, "example", "README.md");
    await writeFileExclusiveNoFollow(root, file, "bundled", { encoding: "utf8" });
    await assert.rejects(
      () => writeFileExclusiveNoFollow(root, file, "replacement", { encoding: "utf8" }),
      (err) => err?.code === "EEXIST",
    );
    assert.equal(await readFileNoFollow(root, file, "utf8"), "bundled");
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ["README.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scoped no-follow file helpers reject final and parent symlinks without changing outside files", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-security-io-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "final.txt"));
    await assert.rejects(
      () => readFileNoFollow(root, path.join(root, "final.txt"), "utf8"),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
    await assert.rejects(
      () => writeFileAtomicNoFollow(root, path.join(root, "final.txt"), "changed", { encoding: "utf8" }),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
    await symlink(outside, path.join(root, "linked-parent"));
    await assert.rejects(
      () => writeFileAtomicNoFollow(root, path.join(root, "linked-parent", "secret.txt"), "changed", { encoding: "utf8" }),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Linux scoped directory handles stay pinned when a path is replaced by an outside symlink", { skip: process.platform !== "linux" }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-security-fd-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  const nested = path.join(root, "nested");
  const moved = path.join(root, "moved");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  const opened = await openScopedDirectoryNoFollow(root, nested);
  try {
    await rename(nested, moved);
    await symlink(outside, nested);
    await writeFile(path.join(opened.path, "pinned.txt"), "safe", "utf8");
    assert.equal(await readFile(path.join(moved, "pinned.txt"), "utf8"), "safe");
    await assert.rejects(() => readFile(path.join(outside, "pinned.txt"), "utf8"), (err) => err?.code === "ENOENT");
  } finally {
    await opened.handle.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("appendJsonLineNoFollow rotates oversized jsonl logs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-logs-"));
  const file = path.join(root, ".openscience", "audit.jsonl");

  await appendJsonLineNoFollow(root, file, { message: "first".repeat(20) }, { maxBytes: 80 });
  await appendJsonLineNoFollow(root, file, { message: "second".repeat(20) }, { maxBytes: 80 });

  const current = await readFile(file, "utf8");
  const rotated = await readFile(`${file}.1`, "utf8");
  assert.equal(current.includes("second"), true);
  assert.equal(current.includes("first"), false);
  assert.equal(rotated.includes("first"), true);
});

test("appendJsonLineNoFollow refuses symlinked rotation targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-logs-"));
  const file = path.join(root, ".openscience", "audit.jsonl");
  const outside = path.join(root, "outside.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{\"message\":\"old\"}\n", "utf8");
  await writeFile(outside, "{\"message\":\"outside\"}\n", "utf8");
  await symlink(outside, `${file}.1`);

  await assert.rejects(
    () => appendJsonLineNoFollow(root, file, { message: "new".repeat(20) }, { maxBytes: 8 }),
    HttpError,
  );
  assert.equal(await readFile(outside, "utf8"), "{\"message\":\"outside\"}\n");
});

test("Linux scoped reads survive a concurrent atomic replace of the same file", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-replace-"));
  const file = path.join(root, "ledger.jsonl");
  await writeFile(file, "seed\n", "utf8");
  let missing = 0;
  const replaces = (async () => {
    for (let round = 0; round < 1200; round += 1) {
      await writeFileAtomicNoFollow(root, file, `line ${round}\n`, { encoding: "utf8" });
    }
  })();
  const reads = (async () => {
    for (let round = 0; round < 1200; round += 1) {
      try {
        await readFileNoFollow(root, file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "file_not_found") missing += 1;
        else throw error;
      }
    }
  })();
  try {
    await Promise.all([replaces, reads]);
    assert.equal(missing, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux descriptor checks do not accept a live file named like an unlinked one", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-deleted-"));
  const file = path.join(root, "report (deleted)");
  await writeFile(file, "present\n", "utf8");
  try {
    assert.equal(await readFileNoFollow(root, file, "utf8"), "present\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A response double that records exactly what sendError put on the wire. */
function captureResponse() {
  const captured = { status: 0, headers: {}, body: "" };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = { ...headers };
    },
    end(body) {
      captured.body = String(body ?? "");
    },
  };
}

// A budget refusal knows which of the three ceilings stopped the request, and
// the researcher cannot act without it: the 24-hour ceiling frees itself as
// spend ages out of the window, the 7-day one takes a week to.
// The ledger already built that answer and the boundary used to drop it, so a
// weekly cap and a daily blip arrived as the same sentence.
test("a budget refusal tells the client which ceiling it hit", () => {
  const res = captureResponse();
  sendError(res, new HttpError(402, "usage_budget_exceeded", "This request exceeds the account spending limit.", {
    window: "week", limit: 12, committed: 12.4, requested: 0.3, currency: "CNY",
  }), { requestId: "req_1" });

  assert.equal(res.captured.status, 402);
  assert.deepEqual(JSON.parse(res.captured.body), {
    error: "This request exceeds the account spending limit.",
    code: "usage_budget_exceeded",
    requestId: "req_1",
    details: { window: "week", limit: 12, committed: 12.4, requested: 0.3, currency: "CNY" },
  });
});

// The admission check names no `requested` amount because it refuses before
// pricing anything. An absent key is omitted, not sent as null.
test("a budget refusal without a requested amount omits the key", () => {
  const res = captureResponse();
  sendError(res, new HttpError(402, "usage_budget_exceeded", "This account reached its spending limit.", {
    window: "day", limit: 5, committed: 5, currency: "CNY",
  }));

  assert.deepEqual(JSON.parse(res.captured.body).details, { window: "day", limit: 5, committed: 5, currency: "CNY" });
});

// Every other error must answer exactly what it answered before this channel
// existed, key for key, so a client parsing today's shape keeps working.
test("an error whose code declares no details answers the unchanged three-key envelope", () => {
  const quota = captureResponse();
  // The same bag a budget refusal carries, on a code that declared no shape.
  sendError(quota, new HttpError(413, "project_quota_exceeded", "Project storage quota exceeded.", {
    window: "week", limit: 12, committed: 12.4, currency: "CNY",
  }), { requestId: "req_2" });
  assert.equal(quota.captured.body, '{"error":"Project storage quota exceeded.","code":"project_quota_exceeded","requestId":"req_2"}');

  const rate = captureResponse();
  sendError(rate, new HttpError(429, "too_many_requests", "Too many requests.", { retryAfterSeconds: 7 }));
  assert.equal(rate.captured.body, '{"error":"Too many requests.","code":"too_many_requests","requestId":null}');
  assert.equal(rate.captured.headers["Retry-After"], "7");

  const raw = captureResponse();
  sendError(raw, new Error("boom"));
  assert.equal(raw.captured.body, '{"error":"boom","code":"internal_error","requestId":null}');

  // Readiness and profile checks build plain Errors that carry a `details`
  // property for internal reporting. Those are not HttpErrors and must not
  // start riding out to the browser now that the envelope has a slot for them.
  const readiness = captureResponse();
  sendError(readiness, Object.assign(new Error("check_failed"), { details: { field: "OPEN_SCIENCE_DATA_DIR" } }));
  assert.equal(readiness.captured.body, '{"error":"check_failed","code":"internal_error","requestId":null}');
});

/** A value shaped exactly like a live API key — the `sk-` prefix plus enough
 *  key material for a scanner to classify it as one — assembled at run time so
 *  that no such literal sits in the source tree. `pnpm audit:source-secrets`
 *  (step 2 of `pnpm ci:web`) refuses a credential-shaped literal even inside a
 *  test written to prove such a value never travels, and it is right to: a
 *  scanner cannot read intent. Assembling it here keeps the injected value
 *  byte-identical to what a real leak would look like. */
const credentialShapedValue = ["sk", "live", "a1b2c3d4e5f6a7b8c9d0e1f2"].join("-");

// The channel's safety is structural: a value reaches the wire only if the
// declared shape names its key and the declared acceptor returns it, and every
// acceptor yields a finite number or a member of a closed set written in the
// module. This pins that a call site cannot smuggle anything else out.
test("a details bag cannot carry an Error, a function, a getter or an unexpected key", () => {
  const bag = {
    window: "week",
    limit: 12,
    committed: 12.4,
    currency: "CNY",
    cause: new Error("ENOENT: open '/srv/evimed/.evimed-local/secrets/deepseek.api-key'"),
    retry: () => "callable",
    sql: "SELECT reserved_cost FROM evimed_usage.model_requests WHERE user_id=$1",
    apiKey: credentialShapedValue,
    stack: new Error("boom").stack,
  };
  // A getter on a declared key must not be invoked, and must not contribute.
  Object.defineProperty(bag, "requested", { enumerable: true, get: () => 999 });

  const error = new HttpError(402, "usage_budget_exceeded", "This request exceeds the account spending limit.", bag);
  const res = captureResponse();
  sendError(res, error);

  const body = JSON.parse(res.captured.body);
  assert.deepEqual(Object.keys(body.details).sort(), ["committed", "currency", "limit", "window"]);
  for (const leaked of ["deepseek.api-key", credentialShapedValue, "SELECT", "evimed_usage", "callable", "999", "/srv/"]) {
    assert.equal(res.captured.body.includes(leaked), false, `${leaked} reached the client`);
  }
});

// The vocabularies are closed. A window the UI has no name for, a limit that is
// not a finite number and a currency the price list does not use are dropped
// rather than passed through for the browser to interpret.
test("a details bag is filtered to the declared vocabulary and number types", () => {
  const error = new HttpError(402, "usage_budget_exceeded", "This account reached its spending limit.", {
    window: "month", limit: Number.NaN, committed: "12.4", requested: Number.POSITIVE_INFINITY, currency: "USD",
  });
  assert.equal(error.details, undefined);

  const res = captureResponse();
  sendError(res, error);
  assert.equal(res.captured.body, '{"error":"This account reached its spending limit.","code":"usage_budget_exceeded","requestId":null}');
});

// The bag is read by own data property only, so a prototype cannot supply one.
test("a details bag does not inherit values from a prototype", () => {
  const error = new HttpError(402, "usage_budget_exceeded", "Over budget.", Object.create({ window: "run", limit: 3 }));
  assert.equal(error.details, undefined);
});

// `details` is an ordinary writable property, so the guarantee above has to be
// a property of the send and not of the constructor. Readiness and profile
// checks already build errors carrying an internal `details` bag — a path, a
// failing field, a stack — and the day one of them raises an HttpError instead
// of a plain Error, the filter is the only thing standing between that bag and
// the browser.
test("a details bag assigned after construction is filtered again at the wire", () => {
  const undeclared = new HttpError(500, "internal_error", "Readiness check failed.");
  undeclared.details = {
    path: "/srv/evimed/.evimed-local/secrets/deepseek.api-key",
    stack: new Error("boom").stack,
  };
  const first = captureResponse();
  sendError(first, undeclared);
  assert.equal(first.captured.body, '{"error":"Readiness check failed.","code":"internal_error","requestId":null}');

  // A declared code is filtered the same way: the two keys it declares survive,
  // the smuggled ones do not.
  const declared = new HttpError(402, "usage_budget_exceeded", "This account reached its spending limit.");
  declared.details = {
    window: "day", limit: 5, committed: 5, currency: "CNY",
    stack: new Error("boom").stack, apiKey: credentialShapedValue,
  };
  const second = captureResponse();
  sendError(second, declared);
  assert.deepEqual(JSON.parse(second.captured.body).details, { window: "day", limit: 5, committed: 5, currency: "CNY" });
  assert.equal(second.captured.body.includes(credentialShapedValue), false);
  assert.equal(second.captured.body.includes("/srv/"), false);
});

// The comment on `errorDetailShapes` says every acceptor yields a finite number
// or a member of a closed set written in that module. Nothing enforced that:
// adding `reason: (value) => (typeof value === "string" ? value : undefined)`
// to a declared shape would put arbitrary caller strings on the wire with the
// whole suite green. This is the test that fails instead.
test("every declared acceptor is a finite number or a closed set, never a free string", () => {
  const hostile = [
    new Error("boom").stack,
    "/srv/evimed/.evimed-local/secrets/deepseek.api-key",
    credentialShapedValue,
    "SELECT reserved_cost FROM evimed_usage.model_requests WHERE user_id=$1",
    "usr_alice@example.com",
    "postgres://control-plane.internal:5432",
  ];
  const codes = Object.entries(errorDetailShapes);
  assert.ok(codes.length > 0, "no code declares a shape, so this test proves nothing");

  for (const [code, shape] of codes) {
    const keys = Object.entries(shape);
    assert.ok(keys.length > 0, `${code} declares an empty shape`);
    for (const [key, accept] of keys) {
      assert.ok(
        accept.kind === "finite-number" || accept.kind === "closed-set",
        `${code}.${key} uses an acceptor that is neither vocabulary, so what it lets through is unknown`,
      );
      if (accept.kind === "closed-set") {
        assert.ok(accept.allowed.length > 0, `${code}.${key} declares an empty closed set`);
        for (const member of accept.allowed) assert.equal(accept(member), member);
      }
      // Through the boundary, not just the acceptor: a hostile value placed on
      // this key by a call site must not appear in the response body.
      for (const value of hostile) {
        assert.equal(accept(value), undefined, `${code}.${key} accepted a caller string`);
        const res = captureResponse();
        sendError(res, new HttpError(402, code, "Refused.", { [key]: value }));
        assert.equal(res.captured.body.includes(value), false, `${code}.${key} carried a caller string to the client`);
      }
    }
  }
});

/** A database double answering only the three questions these two refusals ask:
 *  the advisory lock, the reservation lookup, and the spend totals. It runs the
 *  real ledger code path without Postgres, which is what lets the refusal the
 *  browser actually receives be built by the ledger rather than by this test. */
function ledgerDatabase(totals) {
  const query = async (sql) => (String(sql).includes("day_settled")
    ? { rows: [{ day_settled: 0, week_settled: 0, day_open: 0, week_open: 0, run_committed: 0, ...totals }], rowCount: 1 }
    : { rows: [], rowCount: 0 });
  return { query, transaction: (run) => run({ query }) };
}

// The declared shape and the ledger that fills it live in different files, and
// a key renamed on one side fails nothing on its own: the boundary drops it,
// the browser rejects a bag missing a required key, and the account page goes
// quiet again — which is the state this whole change exists to end. So the
// refusal is built by the real ledger and read off the real wire.
//
// This is the admission check, the one budget refusal that reaches a browser
// today (server.mjs dispatches a prompt through it, and its HttpError travels
// to the single sendError at the boundary).
test("the ledger's admission refusal reaches the client with every key it built", async () => {
  const ledger = new UsageLedger(ledgerDatabase({ week_settled: 12.4 }));
  const refusal = await ledger.assertWithinLimits("usr_alice", { dailyLimit: 20, weeklyLimit: 12 })
    .then(() => null, (error) => error);
  assert.ok(refusal instanceof HttpError, "the ledger did not refuse, so this test proves nothing");
  assert.equal(refusal.status, 402);

  const res = captureResponse();
  sendError(res, refusal, { requestId: "req_3" });
  assert.deepEqual(JSON.parse(res.captured.body), {
    error: "This account reached its spending limit.",
    code: "usage_budget_exceeded",
    requestId: "req_3",
    details: { window: "week", limit: 12, committed: 12.4, currency: "CNY" },
  });
});

// The reservation refusal is richer — it prices the request, so it names the
// amount asked for and can refuse a single run's budget. It is answered by the
// model gateway's own envelope today rather than by `sendError`, so what this
// pins is that the boundary is ready for it: every key the ledger builds is
// declared, and none is dropped on the way out.
test("the ledger's reservation refusal survives the boundary whole", async () => {
  const ledger = new UsageLedger(ledgerDatabase({ day_settled: 4.9 }));
  const refusal = await ledger.reserveModel({
    id: "usage_1", userId: "usr_alice", projectId: "prj_default", model: "deepseek-chat",
    priceVersion: "2026-01-01", currency: "CNY", requestFingerprint: "a".repeat(64),
    estimatedCost: 0.3, dailyLimit: 5, weeklyLimit: 40,
  }).then(() => null, (error) => error);
  assert.ok(refusal instanceof HttpError, "the ledger did not refuse, so this test proves nothing");

  const res = captureResponse();
  sendError(res, refusal);
  assert.deepEqual(JSON.parse(res.captured.body).details, {
    window: "day", limit: 5, committed: 4.9, requested: 0.3, currency: "CNY",
  });
});

// The client parses this channel with its own copy of the two closed sets, and
// a set that drifts is invisible: the server would send a window the browser
// discards, and the account page would fall back to a sentence that names no
// ceiling. Until the vocabulary lives in `@evimed/domain` (it does not — the
// registry there has no `usage_budget_exceeded` entry at all), the two copies
// are compared here, at the boundary that declares them.
test("the browser accepts exactly the vocabulary this module declares", async () => {
  const client = await readFile(new URL("../../web/src/lib/apiClient.ts", import.meta.url), "utf8");
  const declared = (name) => {
    const block = new RegExp(`const ${name}: WebUsageBudget\\w+\\[\\] = \\[([^\\]]*)\\]`).exec(client);
    assert.ok(block, `${name} was not found in apiClient.ts — this test cannot conclude anything`);
    return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };
  const shape = errorDetailShapes.usage_budget_exceeded;
  assert.deepEqual(declared("usageBudgetWindows").sort(), [...shape.window.allowed].sort());
  assert.deepEqual(declared("usageBudgetCurrencies").sort(), [...shape.currency.allowed].sort());
});
