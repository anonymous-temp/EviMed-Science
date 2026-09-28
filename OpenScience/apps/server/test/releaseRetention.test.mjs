import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { plan, releaseImageTags, releasesHeldThroughCurrent, releasesNamedBy } from "../../../scripts/ops/release-retention.mjs";

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

test("same-day releases are ordered by the build time their manifests record, not by hash", async () => {
  // Three releases on one day: by name `7bd5117` sorts after `5898a48`, but
  // it was built seven hours earlier. Keep-2 by name kept the morning build
  // and would have deleted the one that was live until the next cutover.
  const { writeFile } = await import("node:fs/promises");
  const ids = ["evimed-20260908-5898a48", "evimed-20260908-70e93bd", "evimed-20260908-7bd5117", "evimed-20260909-c7434fb"];
  const dir = await releasesDir(ids);
  const built = { "evimed-20260908-7bd5117": "2026-09-08T03:47:04.000Z", "evimed-20260908-5898a48": "2026-09-08T10:42:06.000Z",
    "evimed-20260908-70e93bd": "2026-09-08T10:44:00.000Z", "evimed-20260909-c7434fb": "2026-09-09T05:32:47.000Z" };
  for (const id of ids) {
    await mkdir(path.join(dir, id, "OpenScience/deploy/web"), { recursive: true });
    await writeFile(path.join(dir, id, "OpenScience/deploy/web/release-manifest.json"), JSON.stringify({ source: { createdAt: built[id] } }));
  }
  const result = await plan(dir, 2, async () => new Set());
  assert.deepEqual(result.releases, ["evimed-20260908-7bd5117", "evimed-20260908-5898a48", "evimed-20260908-70e93bd", "evimed-20260909-c7434fb"]);
  assert.deepEqual([...result.keep.keys()].sort(), ["evimed-20260908-70e93bd", "evimed-20260909-c7434fb"]);
  assert.deepEqual(result.remove, ["evimed-20260908-7bd5117", "evimed-20260908-5898a48"]);
});

test("bare-revision release directories are planned, and ordered by their manifests", async () => {
  // The 2026-09-14 redeploy named releases by revision alone. The pattern only
  // matched `evimed-YYYYMMDD-<rev>`, so the weekly timer walked a directory
  // holding ten of them and reported `0 releases, 0 kept, 0 removed` — success
  // wording for a job that had stopped doing anything (2026-09-15 walk, B6).
  const { writeFile } = await import("node:fs/promises");
  const ids = ["28389d824e1f", "98036fb91f51", "f000cf96af5e"];
  const built = { "28389d824e1f": "2026-09-08T02:00:00.000Z", "98036fb91f51": "2026-09-11T02:00:00.000Z",
    "f000cf96af5e": "2026-09-14T08:00:00.000Z" };
  const dir = await releasesDir([...ids, "acceptance", "ops-source-f000cf96af5e"]);
  for (const id of ids) {
    await mkdir(path.join(dir, id, "OpenScience/deploy/web"), { recursive: true });
    await writeFile(path.join(dir, id, "OpenScience/deploy/web/release-manifest.json"), JSON.stringify({ source: { createdAt: built[id] } }));
  }
  const result = await plan(dir, 2, async () => new Set());
  assert.deepEqual(result.releases, ids);
  assert.deepEqual(result.remove, ["28389d824e1f"]);
  // A hex-looking word is a release; a word that is not hex is not, however
  // much it sits beside them.
  assert.ok(!result.releases.includes("acceptance"));
  assert.ok(!result.releases.includes("ops-source-f000cf96af5e"));
});

test("the release `current` points at is kept even when it is neither newest nor mounted", async () => {
  const dir = await releasesDir(IDS);
  await symlink(path.join(dir, "evimed-20260901-aaaaaaa"), path.join(path.dirname(dir), "current"));
  const result = await plan(dir, 1, async () => new Set());
  assert.equal(result.keep.get("evimed-20260901-aaaaaaa"), "current");
  assert.deepEqual(result.remove, ["evimed-20260902-bbbbbbb", "evimed-20260903-ccccccc"]);
});

test("a release is held by the compose directory a container was created from, not only by its mounts", () => {
  // 2026-09-17, on the host: PostgreSQL and the engines mount nothing from a
  // release, so `releases/39111b6b4821` — the compose files and `.env` they were
  // created from — read as unused and was removed from under them.
  const held = releasesNamedBy("/srv/evimed-science/releases", [
    "/srv/evimed-science/shared/secrets/postgres-password.txt",
    "/srv/evimed-science/releases/a48c91c265af/OpenScience/deploy/web/monitoring/prometheus.json",
    "/srv/evimed-science/releases/39111b6b4821/OpenScience/deploy/web",
    " /srv/evimed-science/releases/39111b6b4821/OpenScience/deploy/web/docker-compose.yml",
    "/srv/evimed-science/releases-old/zzz/x",
    "",
  ]);
  assert.deepEqual([...held].sort(), ["39111b6b4821", "a48c91c265af"]);
});

test("a container that binds through `current` and started before it moved holds the releases built before it started", () => {
  // 2026-09-26 (platform audit I3-1): Prometheus started on 09-24 while
  // `a48c…` was current, was not recreated by the next two switches (its
  // configuration hash had not changed), and by `.Mounts.Source` — which reads
  // `/srv/evimed-science/current/...` — held nothing, so retention deleted the
  // directory it was reading. Its rules, targets and Grafana's dashboards sat
  // at link count 0 for days.
  const at = (iso) => Date.parse(iso);
  const releases = [
    { name: "a48c91c265af", builtAt: at("2026-09-24T05:00:00.000Z") },
    { name: "e5e78fc830c9", builtAt: at("2026-09-25T09:00:00.000Z") },
    { name: "1cf308956b6e", builtAt: at("2026-09-26T12:53:18.000Z") },
  ];
  const switchedAt = at("2026-09-26T13:39:00.000Z");
  const prometheus = { name: "web-prometheus-1", startedAt: at("2026-09-24T07:05:00.000Z") };
  assert.deepEqual([...releasesHeldThroughCurrent([prometheus], switchedAt, releases)], ["a48c91c265af"]);
  // Restarted after the switch, it holds the current release and nothing else.
  assert.deepEqual([...releasesHeldThroughCurrent([{ ...prometheus, startedAt: at("2026-09-26T13:40:00.000Z") }], switchedAt, releases)], []);
  // What cannot be read keeps directories rather than deleting them.
  assert.deepEqual([...releasesHeldThroughCurrent([{ ...prometheus, startedAt: Number.NaN }], switchedAt, releases)].sort(),
    ["1cf308956b6e", "a48c91c265af", "e5e78fc830c9"]);
  assert.deepEqual([...releasesHeldThroughCurrent([prometheus], switchedAt, [...releases, { name: "0ld", builtAt: Number.NaN }])].sort(),
    ["0ld", "a48c91c265af"]);
});

test("docker's own answers are read into the releases held through `current`, by bind mounts only", { skip: process.platform === "win32" }, async () => {
  const { chmod, lutimes, rm, writeFile } = await import("node:fs/promises");
  const { mountedReleases } = await import("../../../scripts/ops/release-retention.mjs");
  const releases = await releasesDir([]);
  const root = path.dirname(releases);
  const built = { a48c91c265af: "2026-09-24T05:00:00.000Z", e5e78fc830c9: "2026-09-25T09:00:00.000Z", "1cf308956b6e": "2026-09-26T12:53:18.000Z" };
  for (const [id, createdAt] of Object.entries(built)) {
    await mkdir(path.join(releases, id, "OpenScience/deploy/web"), { recursive: true });
    await writeFile(path.join(releases, id, "OpenScience/deploy/web/release-manifest.json"), JSON.stringify({ source: { createdAt } }));
  }
  await symlink(path.join(releases, "1cf308956b6e"), path.join(root, "current"));
  const switched = new Date("2026-09-26T13:39:00.000Z");
  await lutimes(path.join(root, "current"), switched, switched);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const web = `${root}/current/OpenScience/deploy/web`;
  // Prometheus binds its rules through `current` and started before the
  // switch; PostgreSQL was created from the compose directory under `current`
  // but binds nothing from it; a stopped one-shot holds nothing open.
  await writeFile(path.join(bin, "docker"), `#!/bin/sh
case "$1" in
  ps) printf 'prom\\npg\\ninit\\n' ;;
  inspect) case "$4" in
    prom) printf '/web-prometheus-1\\ttrue\\t2026-09-24T07:05:00.123456789Z\\n${web}/monitoring/open-science.rules.json\\n\\n${web}/monitoring/open-science.rules.json\\n/var/lib/docker/volumes/web_prometheus-data/_data\\n${web}\\n${web}/docker-compose.yml\\n' ;;
    pg) printf '/web-evimed-postgres-1\\ttrue\\t2026-09-14T11:24:00Z\\n/srv/shared/secrets/postgres-password.txt\\n\\n/srv/shared/secrets/postgres-password.txt\\n${web}\\n${web}/docker-compose.yml\\n' ;;
    init) printf '/web-evimed-openviking-init-1\\tfalse\\t2026-09-01T00:00:00Z\\n${web}/openviking-init.sh\\n\\n${web}/openviking-init.sh\\n${web}\\n\\n' ;;
  esac ;;
esac
`);
  await chmod(path.join(bin, "docker"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    assert.deepEqual([...await mountedReleases(releases)], ["a48c91c265af"]);
  } finally {
    process.env.PATH = saved;
    await rm(root, { recursive: true, force: true });
  }
});

test("a release held through `current` is kept by the plan even past the keep count", async () => {
  const dir = await releasesDir(IDS);
  const held = releasesHeldThroughCurrent(
    [{ name: "web-grafana-1", startedAt: Date.parse("2026-09-01T12:00:00.000Z") }],
    Date.parse("2026-09-04T12:00:00.000Z"),
    IDS.map((name) => ({ name, builtAt: Date.parse(`${name.slice(7, 11)}-${name.slice(11, 13)}-${name.slice(13, 15)}T00:00:00.000Z`) })),
  );
  const result = await plan(dir, 1, async () => held);
  assert.equal(result.keep.get("evimed-20260901-aaaaaaa"), "mounted");
  assert.deepEqual(result.remove, ["evimed-20260902-bbbbbbb", "evimed-20260903-ccccccc"]);
});

test("a release's images are found under the names this deployment actually tags them with", () => {
  // `--images` matched `evimed-runtime-dsh:<release>`, a repository that no
  // longer exists, so it reported success over images it never touched.
  const tags = [
    "open-science-web:526261d6a154",
    "open-science-runtime:dsh-0.1.7-rc.2-uv-0.11.26-526261d6a154",
    "open-science-web:a7af1f75e3d5",
    "open-science-runtime:dsh-0.1.7-rc.2-uv-0.11.26-a7af1f75e3d5",
    "szmi-open-science-web:526261d6a154",
    "postgres:16.14-bookworm",
    "open-science-web:<none>",
  ];
  assert.deepEqual(releaseImageTags(tags, "526261d6a154"), [
    "open-science-web:526261d6a154",
    "open-science-runtime:dsh-0.1.7-rc.2-uv-0.11.26-526261d6a154",
  ]);
  assert.deepEqual(releaseImageTags(tags, "6a154"), [], "a suffix of a revision is not that revision");
  // The flattened copy a later delta was built on leaves with its release.
  const flat = [...tags, "open-science-runtime:dsh-0.1.7-rc.2-uv-0.11.26-526261d6a154-flat"];
  assert.deepEqual(releaseImageTags(flat, "526261d6a154"), [
    "open-science-web:526261d6a154",
    "open-science-runtime:dsh-0.1.7-rc.2-uv-0.11.26-526261d6a154",
    "open-science-runtime:dsh-0.1.7-rc.2-uv-0.11.26-526261d6a154-flat",
  ]);
});
