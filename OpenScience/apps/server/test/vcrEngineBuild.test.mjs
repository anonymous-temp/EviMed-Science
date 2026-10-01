import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../项目代码/vcr-engine");
const configure = path.join(engineRoot, "scripts/configure-apt.sh");
const mirrors = {
  APT_MIRROR: "https://mirror.example/ubuntu/",
  UBUNTU_SECURITY_MIRROR: "https://security.example/ubuntu/",
  UBUNTU_PORTS_MIRROR: "https://ports.example/ubuntu-ports/",
};

/** @param {string} directory @param {Record<string, string>} env */
const runConfigure = (directory, env = mirrors) => spawnSync("sh", [configure, directory], {
  encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
});

test("APT mirrors cover classic and deb822 sources without changing suites, components or unrelated repositories", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-apt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "sources.list.d"));
  const fixtures = {
    "sources.list": "deb http://archive.ubuntu.com/ubuntu jammy main universe\ndeb https://security.ubuntu.com/ubuntu jammy-security main universe\n",
    "sources.list.d/updates.list": "deb https://archive.ubuntu.com/ubuntu jammy-updates main universe\n",
    "sources.list.d/ubuntu.sources": "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: jammy jammy-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu\nSuites: jammy-security\nComponents: main universe\n",
    "sources.list.d/ports.sources": "Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports\nSuites: jammy jammy-security\nComponents: main universe\n",
    "sources.list.d/vendor.list": "deb https://vendor.example/packages stable main\n",
  };
  for (const [file, value] of Object.entries(fixtures)) await writeFile(path.join(directory, file), value);
  const result = runConfigure(directory);
  assert.equal(result.status, 0, result.stderr);
  for (const [file, value] of Object.entries(fixtures)) {
    const expected = value
      .replaceAll(/https?:\/\/archive\.ubuntu\.com\/ubuntu/g, "https://mirror.example/ubuntu")
      .replaceAll(/https?:\/\/security\.ubuntu\.com\/ubuntu/g, "https://security.example/ubuntu")
      .replaceAll(/https?:\/\/ports\.ubuntu\.com\/ubuntu-ports/g, "https://ports.example/ubuntu-ports");
    assert.equal(await readFile(path.join(directory, file), "utf8"), expected, file);
  }
  assert.equal(runConfigure(directory).status, 0, "reapplying mirrors is safe");
  assert.ok((await readdir(path.join(directory, "sources.list.d"))).every((file) => !file.endsWith(".vcr-original")));
});

test("malformed or credential-bearing mirror URLs fail before changing any source", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-apt-refuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = "deb http://archive.ubuntu.com/ubuntu jammy main\n";
  const source = path.join(directory, "sources.list");
  await writeFile(source, original);
  const authenticated = new URL("https://mirror.example/ubuntu");
  authenticated.username = "fixture";
  authenticated.password = String(42);
  for (const mirror of ["ftp://mirror.example/ubuntu", authenticated.href, "https://mirror.example/ubuntu?key=value", "https://mirror.example/ubuntu\nhttps://other.example/ubuntu", "https://mirror.example/ubuntu|other"]) {
    const result = runConfigure(directory, { ...mirrors, APT_MIRROR: mirror });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected a public HTTP\(S\) repository URL/);
    assert.equal(await readFile(source, "utf8"), original);
    assert.ok(!result.stderr.includes(mirror), "an invalid endpoint is never echoed");
  }
});

test("missing APT sources fail instead of silently using an unintended repository", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-apt-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(runConfigure(directory).stderr, /no APT source files found/);
});

test("the engine build fixes its R and OS base and installs Python in a virtual environment", async () => {
  const dockerfile = await readFile(path.join(engineRoot, "Dockerfile"), "utf8");
  const lock = JSON.parse(await readFile(path.join(engineRoot, "R/package-lock.json"), "utf8"));
  assert.match(dockerfile, /^ARG R_BASE_IMAGE=docker\.io\/rocker\/r-ver:4\.3\.3@sha256:732d15020af326da9e919c07f70ca32bf5d3e409220af32e0a4b6d0a89437309$/m);
  assert.match(dockerfile, /test "\$\{ID\}:\$\{VERSION_CODENAME\}" = "ubuntu:jammy"/);
  assert.ok(dockerfile.includes(`as.character(getRversion()) == "${lock.rVersion}"`));
  assert.match(dockerfile, /COPY scripts\/configure-apt\.sh \/usr\/local\/bin\/vcr-configure-apt/);
  assert.match(dockerfile, /python3 -m venv \/opt\/vcr-venv/);
  assert.match(dockerfile, /ENV PATH=\/opt\/vcr-venv\/bin:\$\{PATH\}/);
  assert.doesNotMatch(dockerfile, /--break-system-packages|apt-get (?:upgrade|dist-upgrade)|--force-overwrite/);
  assert.match(dockerfile, /package lock verified/);
  assert.match(dockerfile, /setdiff\(names\(inst\), want\[, 1\]\)/);
});

test("the supported Compose build uses VCR Ubuntu repositories independently of Debian service mirrors", async () => {
  const web = path.resolve(engineRoot, "../../OpenScience/deploy/web");
  const compose = YAML.parse(await readFile(path.join(web, "docker-compose.yml"), "utf8"), { logLevel: "silent" });
  const args = compose.services["evimed-vcr-engine"].build.args;
  const documented = await readFile(path.join(web, ".env.example"), "utf8");
  for (const [argument, variable, endpoint] of [
    ["APT_MIRROR", "OPEN_SCIENCE_VCR_UBUNTU_ARCHIVE_MIRROR", "http://archive.ubuntu.com/ubuntu"],
    ["UBUNTU_SECURITY_MIRROR", "OPEN_SCIENCE_VCR_UBUNTU_SECURITY_MIRROR", "http://security.ubuntu.com/ubuntu"],
    ["UBUNTU_PORTS_MIRROR", "OPEN_SCIENCE_VCR_UBUNTU_PORTS_MIRROR", "http://ports.ubuntu.com/ubuntu-ports"],
  ]) {
    assert.equal(args[argument], `\${${variable}:-${endpoint}}`);
    assert.ok(documented.includes(`${variable}=${endpoint}`));
  }
  assert.equal(args.DEBIAN_SECURITY_MIRROR, undefined);
  assert.ok(!args.APT_MIRROR.includes("OPEN_SCIENCE_APT_MIRROR"));
});
