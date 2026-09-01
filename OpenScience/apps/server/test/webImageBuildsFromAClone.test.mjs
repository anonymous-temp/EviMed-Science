// The web image must be buildable from what git actually carries.
//
// deploy/web/Dockerfile hard-COPYs runtime/skills/external/ai4s-skills, and
// .gitignore excludes that whole directory on purpose: the third-party packs
// are fetched by commit pin so they never enter this repo's history. Every
// image built on the deployment host succeeded anyway, because the release
// directory happened to hold 4.6 MB of content no version control tracked —
// and a clean clone failed with `"...ai4s-skills": not found`, which names
// neither the cause nor the remedy.
//
// Both halves of one hole: a stranger cannot build the image, and our own
// images depended on something outside version control. The Dockerfile now
// checks and says what to run; this keeps a second such COPY from quietly
// reintroducing it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** git's own answer, not a re-implementation of .gitignore's matching rules. */
function isIgnored(relative) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relative], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("every git-ignored path the web image copies is checked for, by name", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");

  const copied = [...dockerfile.matchAll(/^COPY --from=build \/app\/(\S+)/gm)].map((match) => match[1]);
  // A parse that found nothing would report a clean Dockerfile.
  assert.ok(copied.length >= 5, `parsed only ${copied.length} COPY lines; the parse is wrong, not the file`);

  const guarded = new Set([...dockerfile.matchAll(/for pack in ([^;]+); do/g)]
    .flatMap((match) => match[1].trim().split(/\s+/)));

  // A git-ignored path is only a problem if it has to arrive WITH the context.
  // `apps/desktop/dist` is git-ignored and copied, and is fine: the build stage
  // produces it. The difference is evidence in this same file — a RUN that
  // builds it — not a name on an allowlist.
  const buildProduced = (relative) => {
    const workspace = /^apps\/([^/]+)\/dist$/.exec(relative)?.[1];
    if (!workspace) return false;
    return new RegExp(`RUN pnpm --filter \\S*${workspace} build`).test(dockerfile);
  };

  const unguarded = copied.filter((relative) =>
    isIgnored(relative) && !guarded.has(relative) && !buildProduced(relative));
  assert.deepEqual(
    unguarded,
    [],
    "these are copied into the image but git does not carry them, and nothing tells a builder how to obtain them; "
    + "add them to the Dockerfile's pack check (and to scripts/dev/fetch-skills.sh) or stop ignoring them",
  );

  // And the check must actually name the remedy — an early failure that says
  // only "missing" trades one unhelpful message for another.
  assert.match(dockerfile, /fetch-skills\.sh/, "the guard must name the script that fixes it");
});
