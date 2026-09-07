import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NEVER_SHARED_LAYERS } from "@evimed/domain";
import {
  CAPSULE_WORK_STYLE_FACT_KINDS,
  MAX_CAPSULE_ENTRY_PAGES,
  MAX_MOUNTED_CAPSULE_METHODS,
  MAX_MOUNTED_CAPSULE_METHOD_BYTES,
  capsuleMethodDirectoryName,
  capsuleMethodsDirName,
  materializeCapsuleMethods,
  renderCapsuleMethod,
  selectCapsuleMethods,
} from "../src/capsuleMethods.mjs";

/** One approved `method_preference`, in the shape `ProductDocuments.list` returns. */
function entry(id, overrides = {}) {
  const { createdAt = null, ...payload } = overrides;
  return {
    id,
    revision: 1,
    createdAt,
    payload: {
      capsuleId: "capsule-a",
      factKind: "method_preference",
      layer: "methods",
      status: "approved",
      origin: "explicit",
      content: "Always quote the source sentence.",
      ...payload,
    },
  };
}

/**
 * A `CapsuleService` stand-in: the two methods this module is allowed to call.
 *
 * `entries` pages the way `ProductDocuments.list` pages — a bounded slice plus
 * an opaque cursor for the next one — because the bug this fixture exists to
 * catch is a reader that takes the first page and stops.
 */
function fakeCapsules({ projectItems = [], accountItems = [], byCapsule = {}, missing = [] } = {}) {
  const calls = [];
  return {
    calls,
    async active(userId, projectId = null) {
      calls.push(`active:${userId}:${projectId ?? "account"}`);
      return { record: null, items: projectId == null ? accountItems : projectItems };
    },
    async entries(userId, capsuleId, options = {}) {
      calls.push(`entries:${capsuleId}:${options.limit ?? ""}:${options.cursor ?? ""}`);
      if (missing.includes(capsuleId)) {
        throw Object.assign(new Error("The capsule is unavailable."), { status: 404, code: "capsule_not_found" });
      }
      const all = byCapsule[capsuleId] ?? [];
      const limit = Number(options.limit ?? 100);
      const from = options.cursor ? Number(Buffer.from(String(options.cursor), "base64url").toString("utf8")) : 0;
      assert.ok(Number.isSafeInteger(from) && from >= 0, "a cursor must be one this fixture minted");
      const items = all.slice(from, from + limit);
      const next = from + items.length;
      return {
        items,
        nextCursor: next < all.length ? Buffer.from(String(next), "utf8").toString("base64url") : null,
      };
    },
  };
}

async function scratchProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "os-capsule-methods-"));
  const project = { id: "paper1", userId: "alice", rootDir: root, runtimeDir: path.join(root, "runtime") };
  await mkdir(project.runtimeDir, { recursive: true });
  // The same place `capsuleMethodsHostDir` puts it: beside the container's
  // runtime root, not inside it.
  return { project, directory: path.join(project.runtimeDir, capsuleMethodsDirName) };
}

/** Directory names of the mounted methods, which is what the plugin enumerates. */
async function mounted(directory) {
  if (!existsSync(directory)) return [];
  const names = [];
  for (const found of await readdir(directory, { withFileTypes: true })) {
    if (found.isDirectory()) names.push(found.name);
  }
  return names.sort();
}

/** Total bytes of every mounted SKILL.md — what `buildDelegation` re-inlines
 *  into every child prompt, and therefore what the byte budget is about. */
async function mountedBytes(directory) {
  let bytes = 0;
  for (const name of await mounted(directory)) {
    bytes += Buffer.byteLength(await readFile(path.join(directory, name, "SKILL.md"), "utf8"), "utf8");
  }
  return bytes;
}

test("a project with no active capsule mounts nothing, and leaves no directory to write into", async () => {
  const { project, directory } = await scratchProject();
  try {
    const result = await materializeCapsuleMethods({ capsules: fakeCapsules(), project, directory });
    assert.equal(result.count, 0);
    assert.equal(result.bytes, 0);
    // Not "an empty directory": nothing mounts it, so an empty one left behind
    // is a directory with no reader and, inside a read-write runtime mount, a
    // writable path the design says is read-only.
    assert.equal(existsSync(directory), false, "a project with no methods must leave no methods directory");
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("a control plane without a capsule service mounts nothing rather than failing a launch", async () => {
  const { project, directory } = await scratchProject();
  try {
    const result = await materializeCapsuleMethods({ capsules: null, project, directory });
    assert.equal(result.count, 0);
    assert.equal(existsSync(directory), false);
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("two approved work-style entries mount as two read-only SKILL.md files with the expected bytes", async () => {
  const { project, directory } = await scratchProject();
  try {
    const capsules = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: {
        "capsule-a": [
          entry("m2", { content: "先写结论，再列证据。", factKind: "writing_style" }),
          entry("m1"),
        ],
      },
    });
    const result = await materializeCapsuleMethods({ capsules, project, directory });
    assert.equal(result.count, 2);
    assert.deepEqual(await mounted(directory), ["m1", "m2"]);
    assert.equal(
      await readFile(path.join(directory, "m1", "SKILL.md"), "utf8"),
      [
        "---",
        "name: method-m1",
        "description: 用户记忆胶囊中的工作方式（method_preference），作为背景参考，不替代证据，也不改变交付要求。",
        "whenToUse: 当这条方法适用于当前任务时参考它。",
        "source_kind: method_preference",
        "source_digest: 7f02c2036f17e9574cd6aa0c1608cd3a1d42b594c481107307b250111529f781",
        "---",
        "",
        "Always quote the source sentence.",
        "",
      ].join("\n"),
    );
    assert.equal(
      await readFile(path.join(directory, "m2", "SKILL.md"), "utf8"),
      [
        "---",
        "name: method-m2",
        "description: 用户记忆胶囊中的工作方式（writing_style），作为背景参考，不替代证据，也不改变交付要求。",
        "whenToUse: 当这条方法适用于当前任务时参考它。",
        "source_kind: writing_style",
        "source_digest: f36a77e5009ae85b5d5d31b9f38ce17a56fa67adf1a4a4b52bfbb410bf1c23a7",
        "---",
        "",
        "先写结论，再列证据。",
        "",
      ].join("\n"),
    );
    // The reported byte count is the bytes that were written, because that is
    // the number the budget is spent against.
    assert.equal(result.bytes, await mountedBytes(directory));
    // The run may read its methods and may never write one: a method the model
    // could edit is a method the user never approved.
    assert.equal((await stat(path.join(directory, "m1", "SKILL.md"))).mode & 0o777, 0o444);
    assert.equal((await stat(path.join(directory, "m1"))).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    // Account-wide and project-scoped activations are both read, the way
    // `CapsuleService.recall` reads them.
    assert.deepEqual(capsules.calls.slice(0, 2), ["active:alice:paper1", "active:alice:account"]);
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("candidate, retired, sources-layer and non-work-style entries are not mounted", async () => {
  const { project, directory } = await scratchProject();
  try {
    const capsules = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "guest" }],
      byCapsule: {
        "capsule-a": [
          // An imported pack's entries arrive exactly like this. Mounting one
          // would run a stranger's method without the recipient adopting it.
          entry("imported", { status: "candidate", origin: "system" }),
          entry("withdrawn", { status: "retired" }),
          entry("knowledge", { factKind: "project_fact", layer: "knowledge" }),
          // A work-style kind in the layer that never leaves the account. The
          // transfer service's export predicate excludes it by layer, not by
          // kind, and this filter is that predicate.
          entry("about-my-corpus", { factKind: "preference", layer: "sources" }),
          entry("blank", { content: "   " }),
          entry("kept"),
        ],
      },
    });
    const result = await materializeCapsuleMethods({ capsules, project, directory });
    assert.equal(result.count, 1);
    assert.deepEqual(await mounted(directory), ["kept"]);
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("approved methods are found past the first page of a capsule's entries", async () => {
  const { project, directory } = await scratchProject();
  try {
    // `ProductDocuments.list` returns a capsule's facts newest first, of every
    // kind, 100 to a page. A capsule with a year of notes and a work style
    // adopted on day one puts every mountable entry on the third page.
    const rows = [
      ...Array.from({ length: 245 }, (_, index) => entry(`fact${String(index).padStart(3, "0")}`, {
        factKind: "project_fact",
        layer: "knowledge",
      })),
      ...Array.from({ length: 5 }, (_, index) => entry(`method${index}`, { content: `Method ${index}.` })),
    ];
    const capsules = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: { "capsule-a": rows },
    });
    const result = await materializeCapsuleMethods({ capsules, project, directory });
    assert.equal(result.count, 5, "an unpaged read finds none of these and says nothing about it");
    assert.deepEqual(await mounted(directory), ["method0", "method1", "method2", "method3", "method4"]);
    const pages = capsules.calls.filter((call) => call.startsWith("entries:"));
    assert.equal(pages.length, 3, "250 entries at 100 to a page is three reads");
    assert.equal(pages[0].endsWith(":"), true, "the first read carries no cursor");
    assert.equal(pages.slice(1).every((call) => !call.endsWith(":")), true, "the later reads carry the served cursor");
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("an entry approved today is mounted from a later page, ahead of a newer one that was not", async () => {
  const { project, directory } = await scratchProject();
  try {
    // The list order and the selection order are two different orders.
    // `ProductDocuments.list` sorts by `created_at DESC`, and `documents.put`
    // leaves `created_at` alone when a status changes, so approving a note
    // written months before every other row moves it to the front of the
    // selection and not one row in the list: it is still on page three. A
    // reader that stops paging once it holds enough candidates therefore drops
    // exactly the entry the user just put in force.
    const createdAt = (index) => new Date(Date.UTC(2026, 2, 1) - index * 86_400_000).toISOString();
    const rows = Array.from({ length: 250 }, (_, index) => {
      // Written and approved on the same day, so page one alone already offers
      // more candidates than a runtime can mount.
      if (index < 100) {
        return entry(`recent${String(index).padStart(3, "0")}`, {
          content: `Method ${index}.`,
          createdAt: createdAt(index),
          curatedAt: createdAt(index),
        });
      }
      if (index === 200) {
        return entry("approved-today", {
          content: "Cite the label, not the review.",
          createdAt: createdAt(index),
          curatedAt: "2026-06-01T00:00:00.000Z",
        });
      }
      return entry(`fact${String(index).padStart(3, "0")}`, {
        factKind: "project_fact",
        layer: "knowledge",
        createdAt: createdAt(index),
      });
    });
    // The premise, asserted rather than assumed: this fixture serves what the
    // store serves — newest created first — and the entry approved today is one
    // of the oldest rows in the capsule.
    assert.deepEqual(
      rows.map((row) => row.createdAt),
      [...rows.map((row) => row.createdAt)].sort().reverse(),
      "the fixture must serve created_at DESC, or it is not modelling ProductDocuments.list",
    );
    assert.ok(rows[200].createdAt < rows[99].createdAt, "the approved entry must really be older than page one");

    const capsules = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: { "capsule-a": rows },
    });
    const result = await materializeCapsuleMethods({ capsules, project, directory });
    assert.equal(result.count, MAX_MOUNTED_CAPSULE_METHODS);
    const names = await mounted(directory);
    assert.deepEqual(
      names,
      [
        "approved-today",
        ...Array.from({ length: MAX_MOUNTED_CAPSULE_METHODS - 1 }, (_, index) => `recent${String(index).padStart(3, "0")}`),
      ].sort(),
      "the most recently approved entry is mounted, and the newest entry it outranks is the one left behind",
    );
    assert.equal(names.includes("approved-today"), true, "an entry cannot be dropped before it is ranked");
    assert.equal(names.includes("recent031"), false, "something on page one has to give way, or nothing was ranked");
    // The bound that survives: the capsule is walked to its end, and never
    // deeper than the page bound.
    const pages = capsules.calls.filter((call) => call.startsWith("entries:"));
    assert.equal(pages.length, 3, "250 entries at 100 to a page is three reads; stopping earlier ranks a page, not a capsule");
    assert.ok(pages.length <= MAX_CAPSULE_ENTRY_PAGES);
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("paging is bounded by the page bound, whether or not the capsule offers mountable entries", async () => {
  const { project, directory } = await scratchProject();
  try {
    // Every row is mountable, so a reader with no bound at all would walk fifty
    // pages of one capsule at every launch. The count cap bounds what is
    // mounted; the page bound is what bounds the reading, and it is the only
    // thing that does — "enough candidates" is not a place a reader may stop,
    // because the list is ordered by creation and the selection is not.
    const eligible = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: {
        "capsule-a": Array.from({ length: 5_000 }, (_, index) => entry(`m${String(index).padStart(4, "0")}`, {
          curatedAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
        })),
      },
    });
    const filled = await materializeCapsuleMethods({ capsules: eligible, project, directory });
    assert.equal(filled.count, MAX_MOUNTED_CAPSULE_METHODS);
    assert.deepEqual(
      await mounted(directory),
      Array.from({ length: MAX_MOUNTED_CAPSULE_METHODS }, (_, index) => `m${String(index).padStart(4, "0")}`).sort(),
      "the cap keeps the most recently confirmed methods, not the first ones read",
    );
    assert.equal(
      eligible.calls.filter((call) => call.startsWith("entries:")).length,
      MAX_CAPSULE_ENTRY_PAGES,
      "a capsule of approved methods is read to the page bound and no further",
    );

    // Nothing is mountable, so the reader pages until the same bound and stops:
    // a runtime launch is bounded work, and the rest stays recallable.
    const barren = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: {
        "capsule-a": Array.from({ length: 5_000 }, (_, index) => entry(`f${index}`, {
          factKind: "project_fact",
          layer: "knowledge",
        })),
      },
    });
    const empty = await materializeCapsuleMethods({ capsules: barren, project, directory });
    assert.equal(empty.count, 0);
    assert.equal(
      barren.calls.filter((call) => call.startsWith("entries:")).length,
      MAX_CAPSULE_ENTRY_PAGES,
      "a capsule is read at most to the page bound, or a launch waits on the whole account",
    );
    assert.ok(
      MAX_CAPSULE_ENTRY_PAGES <= 10,
      "a launch reads eight capsules this deep before the runtime starts; ten pages is what that budget affords",
    );
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("a hostile entry id cannot escape the methods directory", async () => {
  const { project, directory } = await scratchProject();
  try {
    const shallow = "../escaped-sibling";
    const deep = "../../../../etc/evimed-owned";
    const capsules = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: {
        "capsule-a": [
          entry(shallow),
          entry(deep),
          entry("runtime-note:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
        ],
      },
    });
    const result = await materializeCapsuleMethods({ capsules, project, directory });
    assert.equal(result.count, 3);
    const names = await mounted(directory);
    assert.equal(names.length, 3);
    for (const name of names) {
      assert.equal(name.includes("/"), false);
      assert.equal(name.includes(".."), false);
      // Every mounted method is a real file inside the directory, so the three
      // above were written rather than silently dropped.
      assert.match(await readFile(path.join(directory, name, "SKILL.md"), "utf8"), /^---\nname: method-/);
    }
    // The paths those two ids resolve to if the sanitiser stops working — one
    // inside the project, one outside it — rather than paths the escape could
    // never have reached anyway.
    for (const id of [shallow, deep]) {
      const escaped = path.resolve(directory, id);
      assert.equal(escaped.startsWith(directory + path.sep), false, "the fixture ids must really point outside");
      assert.equal(existsSync(escaped), false, `an entry id must not write to ${escaped}`);
      assert.equal(existsSync(path.dirname(path.join(escaped, "SKILL.md"))), false);
    }
    // An id that is already one safe segment keeps its own name; the two above
    // are not, so both took the digest form.
    assert.equal(capsuleMethodDirectoryName("plain-id_9"), "plain-id_9");
    assert.match(capsuleMethodDirectoryName("../../etc"), /^_[0-9a-f]{32}$/);
    assert.equal(
      capsuleMethodDirectoryName("../../etc"),
      capsuleMethodDirectoryName("../../etc"),
      "the same id must always name the same directory",
    );
    assert.notEqual(capsuleMethodDirectoryName("../../etc"), capsuleMethodDirectoryName("../../etd"));
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("the directory is rebuilt, so a retired method disappears from the next run", async () => {
  const { project, directory } = await scratchProject();
  try {
    const first = await materializeCapsuleMethods({
      capsules: fakeCapsules({
        projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
        byCapsule: { "capsule-a": [entry("kept"), entry("dropped")] },
      }),
      project,
      directory,
    });
    assert.equal(first.count, 2);
    const second = await materializeCapsuleMethods({
      capsules: fakeCapsules({
        projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
        byCapsule: { "capsule-a": [entry("kept"), entry("dropped", { status: "retired" })] },
      }),
      project,
      directory,
    });
    assert.equal(second.count, 1);
    assert.deepEqual(await mounted(directory), ["kept"], "a stale method is a rule the user believes they removed");
    const third = await materializeCapsuleMethods({
      capsules: fakeCapsules({
        projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
        byCapsule: { "capsule-a": [entry("kept", { status: "retired" })] },
      }),
      project,
      directory,
    });
    assert.equal(third.count, 0);
    assert.equal(existsSync(directory), false, "retiring the last method takes the directory with it");
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("a deleted capsule is skipped and a real read failure is not swallowed", async () => {
  const { project, directory } = await scratchProject();
  try {
    const capsules = fakeCapsules({
      projectItems: [{ capsuleId: "capsule-gone", mode: "own" }, { capsuleId: "capsule-a", mode: "blend" }],
      accountItems: [{ capsuleId: "capsule-a", mode: "own" }],
      byCapsule: { "capsule-a": [entry("kept")] },
      missing: ["capsule-gone"],
    });
    const result = await materializeCapsuleMethods({ capsules, project, directory });
    assert.equal(result.count, 1, "a capsule that was deleted must not stop the runtime from starting");
    // The same capsule activated in both scopes is read once, as in `recall`.
    assert.equal(capsules.calls.filter((call) => call.startsWith("entries:capsule-a")).length, 1);

    const broken = {
      async active() { return { record: null, items: [{ capsuleId: "capsule-a", mode: "own" }] }; },
      async entries() { throw Object.assign(new Error("pool exhausted"), { code: "product_store_unavailable" }); },
    };
    await assert.rejects(
      () => materializeCapsuleMethods({ capsules: broken, project, directory }),
      (error) => /** @type {any} */ (error)?.code === "product_store_unavailable",
    );
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("no more than the mount cap is written, and which methods survive is decided, not incidental", async () => {
  const { project, directory } = await scratchProject();
  try {
    // Confirmed one day apart, oldest id first, so "the newest confirmations
    // survive" and "the first ids survive" cannot both be true.
    const many = Array.from({ length: MAX_MOUNTED_CAPSULE_METHODS + 5 }, (_, index) => entry(
      `m${String(index).padStart(3, "0")}`,
      { curatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString() },
    ));
    const result = await materializeCapsuleMethods({
      capsules: fakeCapsules({ projectItems: [{ capsuleId: "capsule-a", mode: "own" }], byCapsule: { "capsule-a": many } }),
      project,
      directory,
    });
    assert.equal(result.count, MAX_MOUNTED_CAPSULE_METHODS);
    assert.deepEqual(
      await mounted(directory),
      many.slice(5).map((item) => item.id).sort(),
      "the five oldest confirmations are the five that stay in the capsule",
    );
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("the byte budget truncates the mounted set, because every method is re-inlined into every child prompt", async () => {
  const { project, directory } = await scratchProject();
  try {
    const content = "R".repeat(5_000);
    const size = Buffer.byteLength(
      renderCapsuleMethod({ directoryName: "m00", factKind: "method_preference", content }),
      "utf8",
    );
    const fits = Math.floor(MAX_MOUNTED_CAPSULE_METHOD_BYTES / size);
    assert.ok(fits > 1 && fits < 10, "the fixture must straddle the budget for this test to mean anything");
    const rows = Array.from({ length: 10 }, (_, index) => entry(`m${String(index).padStart(2, "0")}`, {
      content,
      curatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    }));
    const result = await materializeCapsuleMethods({
      capsules: fakeCapsules({ projectItems: [{ capsuleId: "capsule-a", mode: "own" }], byCapsule: { "capsule-a": rows } }),
      project,
      directory,
    });
    assert.equal(result.count, fits, "the count cap alone would have mounted all ten");
    assert.ok(result.bytes <= MAX_MOUNTED_CAPSULE_METHOD_BYTES);
    assert.equal(await mountedBytes(directory), result.bytes);
    assert.deepEqual(
      await mounted(directory),
      rows.slice(10 - fits).map((item) => item.id).sort(),
      "what survives truncation is what the user most recently confirmed",
    );
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("one method larger than the whole budget is still mounted, and nothing follows it", async () => {
  const { project, directory } = await scratchProject();
  try {
    // 20,000 characters is what `CapsuleService.addEntry` accepts, and in
    // Chinese that is 60,000 bytes. A budget that can select nothing at all
    // would leave this feature dark for the user who wrote one long method.
    const huge = entry("only-method", {
      content: "方".repeat(20_000),
      curatedAt: "2026-02-01T00:00:00.000Z",
    });
    const small = entry("also-approved", { content: "Short.", curatedAt: "2026-01-01T00:00:00.000Z" });
    const result = await materializeCapsuleMethods({
      capsules: fakeCapsules({
        projectItems: [{ capsuleId: "capsule-a", mode: "own" }],
        byCapsule: { "capsule-a": [huge, small] },
      }),
      project,
      directory,
    });
    assert.ok(result.bytes > MAX_MOUNTED_CAPSULE_METHOD_BYTES);
    assert.deepEqual(await mounted(directory), ["only-method"]);
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("the selection is a function of the entries, not of the order they were served in", async () => {
  const scope = { userId: "alice", projectId: "paper1" };
  const rows = [
    entry("b", { curatedAt: "2026-01-02T00:00:00.000Z" }),
    entry("a", { curatedAt: "2026-01-02T00:00:00.000Z" }),
    entry("c", { curatedAt: "2026-01-03T00:00:00.000Z" }),
    entry("d", { createdAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const forward = await selectCapsuleMethods(
    fakeCapsules({ projectItems: [{ capsuleId: "capsule-a", mode: "own" }], byCapsule: { "capsule-a": rows } }),
    scope,
  );
  const reversed = await selectCapsuleMethods(
    fakeCapsules({ projectItems: [{ capsuleId: "capsule-a", mode: "own" }], byCapsule: { "capsule-a": [...rows].reverse() } }),
    scope,
  );
  // Newest confirmation first; two confirmed in the same moment are ordered by
  // id, so nothing is left to the page order. `d` was never re-confirmed, so it
  // ranks by the day it was created.
  assert.deepEqual(forward.map((method) => method.id), ["c", "a", "b", "d"]);
  assert.deepEqual(reversed.map((method) => method.id), forward.map((method) => method.id));
  assert.deepEqual(reversed.map((method) => method.document), forward.map((method) => method.document));
});

test("a symlinked methods directory is refused", async () => {
  const { project, directory } = await scratchProject();
  try {
    const outside = path.join(project.rootDir, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(path.dirname(directory), { recursive: true });
    await symlink(outside, directory);
    await assert.rejects(
      () => materializeCapsuleMethods({ capsules: fakeCapsules(), project, directory }),
      (error) => /** @type {any} */ (error)?.code === "path_forbidden",
    );
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});

test("the eligibility filter is the transfer service's export predicate, kinds and layer clause alike", async () => {
  // Read as text, because `WORKSTYLE` and the export query are private to that
  // module. The two decide the same thing from opposite ends -- what a
  // work-style pack may carry, and what a work-style pack may execute -- so a
  // kind or a layer admitted by one and not the other is either an entry that
  // ships and never runs or one that runs and never ships.
  const source = await readFile(new URL("../src/capsuleTransferService.mjs", import.meta.url), "utf8");
  const declared = /const WORKSTYLE = \[([^\]]*)\]/.exec(source);
  assert.ok(declared, "capsuleTransferService.mjs no longer declares WORKSTYLE; this comparison found nothing to compare");
  const kinds = declared[1].split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.ok(kinds.length >= 4, "the scan read no kinds at all");
  assert.deepEqual([...CAPSULE_WORK_STYLE_FACT_KINDS], kinds);
  // The clause the previous version of this test left out while claiming the
  // two predicates were the same.
  const excluded = [...source.matchAll(/payload->>'layer'<>'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(excluded.length >= 1, "the scan found no layer exclusion in the export query at all");
  assert.deepEqual([...new Set(excluded)], [...NEVER_SHARED_LAYERS]);
});

test("renderCapsuleMethod keeps the user's own text and stays deterministic", () => {
  const method = { directoryName: "m1", factKind: "tooling", content: "Use R for survival curves.\n\n\n" };
  const first = renderCapsuleMethod(method);
  assert.equal(first, renderCapsuleMethod(method));
  assert.ok(first.endsWith("Use R for survival curves.\n"), "trailing blank lines are normalised, the text is not");
  assert.equal(first.includes("Use R for survival curves."), true);
});

test("a rendered method survives the frontmatter reader the plugin actually uses", async () => {
  const { parseFrontmatter } = await import("../../../packages/socket/plugins/capsule.mjs");
  const front = parseFrontmatter(renderCapsuleMethod({
    directoryName: "m1",
    factKind: "preference",
    content: "Prefer absolute risk over relative risk.",
  }));
  assert.equal(front.name, "method-m1");
  assert.ok(front.description.includes("preference"));
  assert.ok(front.whenToUse);
});

test("scratch fixtures write nothing outside the temporary project", async () => {
  const { project, directory } = await scratchProject();
  try {
    await writeFile(path.join(project.rootDir, "sentinel"), "keep", "utf8");
    await materializeCapsuleMethods({ capsules: fakeCapsules(), project, directory });
    assert.equal(await readFile(path.join(project.rootDir, "sentinel"), "utf8"), "keep");
  } finally {
    await rm(project.rootDir, { recursive: true, force: true });
  }
});
