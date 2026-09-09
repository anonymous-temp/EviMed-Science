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
// hydrates the pinned pack inside its build stage; this keeps a second such
// COPY from quietly reintroducing a host-context dependency.
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

test("every git-ignored path the web image copies is generated inside the build", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  const fetcher = await readFile(path.join(repoRoot, "scripts/dev/fetch-skills.sh"), "utf8");

  const copied = [...dockerfile.matchAll(/^COPY --from=build \/app\/(\S+)/gm)].map((match) => match[1]);
  // A parse that found nothing would report a clean Dockerfile.
  assert.ok(copied.length >= 5, `parsed only ${copied.length} COPY lines; the parse is wrong, not the file`);

  const hydratedPath = fetcher.match(/^OUT_DIR="\$ROOT\/([^"\n]+)"$/m)?.[1];
  assert.ok(hydratedPath);
  assert.match(fetcher, /^AI4S_SKILLS_COMMIT="\$\{AI4S_SKILLS_COMMIT:-[a-f0-9]{40}\}"$/m);
  // The apk step rewrites the mirror first since 2026-09-09 (the build stage
  // installed from the default Alpine CDN, which the Tencent host reaches at
  // tens of KB/s); the hydration itself is the same immutable-pin invocation.
  const hydrates = recipe => /RUN (?:sed -ri "[^"]*" \/etc\/apk\/repositories\s*\\\s*\n\s*&& )?apk add --no-cache bash curl python3\s*\\\s*\n\s*&& env -u AI4S_SKILLS_COMMIT bash scripts\/dev\/fetch-skills\.sh/.test(recipe);

  // A git-ignored path is only a problem if it has to arrive WITH the context.
  // `apps/web/dist` is git-ignored and copied, and is fine: the build stage
  // produces it. The difference is evidence in this same file — a RUN that
  // builds it — not a name on an allowlist.
  const buildProduced = (relative) => {
    const workspace = /^apps\/([^/]+)\/dist$/.exec(relative)?.[1];
    if (!workspace) return false;
    return new RegExp(`RUN pnpm --filter \\S*${workspace} build`).test(dockerfile);
  };

  const unguarded = copied.filter((relative) =>
    isIgnored(relative) && !(relative === hydratedPath && hydrates(dockerfile)) && !buildProduced(relative));
  assert.deepEqual(
    unguarded,
    [],
    "these ignored paths are copied but have no build-stage producer",
  );
  assert.equal(hydrates(dockerfile.replace("env -u AI4S_SKILLS_COMMIT bash scripts/dev/fetch-skills.sh", "true")), false);
  assert.equal(hydrates(dockerfile.replace("env -u AI4S_SKILLS_COMMIT", "env")), false, "a caller override cannot move the pinned source");
});
