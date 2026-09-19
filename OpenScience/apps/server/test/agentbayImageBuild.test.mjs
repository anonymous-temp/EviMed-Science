import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// scripts/ops/agentbay-image-build.sh against stand-ins for the AgentBay CLI
// and docker: what it builds, what it registers, and what it never prints.
// The live build needs an AgentBay account and a docker daemon; this is the
// part that does not.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(repoRoot, "scripts/ops/agentbay-image-build.sh");

const TEMPLATE = [
  "FROM agentbay-registry.cn-hangzhou.cr.aliyuncs.com/system/code-space-debian-12:20260901",
  "LABEL com.aliyun.agentbay.template=code-space",
  "ENV AGENTBAY_AGENT_HOME=/opt/agentbay",
  "RUN echo system-defined",
  "WORKDIR /root",
];

/**
 * @param {import("node:test").TestContext} t
 * @param {{ systemLines?: number, template?: string[] }} [options]
 */
async function stage(t, { systemLines = 5, template = TEMPLATE } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rt-abimg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "template"), `${template.join("\n")}\n# user section below\n`);
  const agentbay = `#!/usr/bin/env bash
set -euo pipefail
echo "agentbay $*" >> "${root}/calls"
case "$1 $2" in
  "image init")
    cp "${root}/template" Dockerfile
    echo "[SUCCESS] Dockerfile template downloaded successfully!"
    echo "[IMPORTANT] The first ${systemLines} line(s) of the Dockerfile are system-defined and cannot be modified."
    ;;
  "docker login")
    echo "Credential expires at: 2026-09-20 12:28:55"
    echo "Password: fake-registry-password"
    echo "Image registry path:   fake-registry.cn-hangzhou.cr.aliyuncs.com/customer_cli/1234"
    echo "Login Succeeded"
    ;;
  "image create-from-template")
    echo "[DATA]"
    echo "  ImageId: imgc-0a9mg1hbjw1b7r564"
    ;;
  "image list")
    echo '{"totalCount":1,"images":[{"imageId":"imgc-0a9mg1hbjw1b7r564","statusDisplay":"Available"}]}'
    ;;
  "image activate")
    echo "[SUCCESS] Image activated successfully!"
    ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;
  const docker = `#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "${root}/calls"
if [ "$1" = build ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -f ]; then cp "$2" "${root}/built.Dockerfile"; fi
    shift
  done
fi
`;
  await writeFile(path.join(root, "agentbay"), agentbay);
  await writeFile(path.join(root, "docker"), docker);
  await chmod(path.join(root, "agentbay"), 0o755);
  await chmod(path.join(root, "docker"), 0o755);
  const run = (args, env = {}) => spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${root}:${process.env.PATH}`, HOME: root, ...env },
  });
  return { root, run, calls: async () => (await readFile(path.join(root, "calls"), "utf8")).split("\n").filter(Boolean) };
}

test("the image is the template's system-defined lines verbatim, then this repository's body, built for x86 and registered", async (t) => {
  const { root, run, calls } = await stage(t);
  const result = run(["--tag", "rel-1", "--activate", "--release-id", "evimed-abc-1"], { NPM_REGISTRY: "https://registry.npmmirror.com" });
  assert.equal(result.status, 0, result.stderr);
  const built = await readFile(path.join(root, "built.Dockerfile"), "utf8");
  const lines = built.split("\n");
  assert.deepEqual(lines.slice(0, 5), TEMPLATE, "the first five lines are the vendor's, untouched");
  assert.equal((built.match(/^FROM /gm) ?? []).length, 1, "the stand-in FROM of Dockerfile.agentbay is gone");
  assert.doesNotMatch(built, /AGENTBAY_LOCAL_BASE|end of the AgentBay template header/);
  assert.match(built, /^RUN bash \/usr\/local\/lib\/evimed\/install-runtime\.sh session$/m);
  assert.equal(built.trimEnd().split("\n").at(-1), "USER root");

  const recorded = await calls();
  const build = recorded.find((line) => line.startsWith("docker build"));
  assert.match(build, /--platform linux\/amd64/);
  assert.match(build, /-t fake-registry\.cn-hangzhou\.cr\.aliyuncs\.com\/customer_cli\/1234:rel-1/);
  assert.match(build, /--build-arg RELEASE_ID=evimed-abc-1/);
  assert.match(build, /--build-arg NPM_REGISTRY=https:\/\/registry\.npmmirror\.com/);
  assert.ok(build.endsWith(` ${repoRoot}`), "the build context is the repository, so COPY paths stay relative");
  assert.ok(recorded.includes("docker push fake-registry.cn-hangzhou.cr.aliyuncs.com/customer_cli/1234:rel-1"));
  assert.ok(recorded.includes("agentbay image create-from-template --source-image /customer_cli/1234:rel-1 --name evimed-runtime-rel-1 --imageId code-space-debian-12"));
  assert.ok(recorded.some((line) => line === "agentbay image activate imgc-0a9mg1hbjw1b7r564 --cpu 4 --memory 8 --lifecycle-mode auto --lifecycle-max-runtime 240 --lifecycle-idle-timeout 30"));
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), "OPEN_SCIENCE_AGENTBAY_IMAGE_ID=imgc-0a9mg1hbjw1b7r564");
  assert.doesNotMatch(result.stdout + result.stderr, /fake-registry-password/, "nothing the login prints but the registry path is repeated");
});

test("the number of system-defined lines is the template's own, not a guess", async (t) => {
  const template = [...TEMPLATE, "ENV AGENTBAY_EXTRA=1", "USER root"];
  const { root, run } = await stage(t, { systemLines: 7, template });
  const result = run(["--tag", "rel-2"]);
  assert.equal(result.status, 0, result.stderr);
  const built = await readFile(path.join(root, "built.Dockerfile"), "utf8");
  assert.deepEqual(built.split("\n").slice(0, 7), template);
});

test("a template that breaks AgentBay's own rules is refused before anything is built", async (t) => {
  const { run, calls } = await stage(t, { template: ["LABEL no-from-here=1", "ENV A=1", "ENV B=2", "ENV C=3", "ENV D=4"] });
  const result = run(["--tag", "rel-3"]);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /the template must hold the only FROM/);
  assert.ok(!(await calls()).some((line) => line.startsWith("docker")), "nothing was built or pushed");
  const refused = spawnSync("bash", [script, "--tag", "../escape"], { encoding: "utf8" });
  assert.equal(refused.status, 64);
  const base = spawnSync("bash", [script, "--tag", "rel", "--base", "windows_latest"], { encoding: "utf8" });
  assert.equal(base.status, 64);
});
