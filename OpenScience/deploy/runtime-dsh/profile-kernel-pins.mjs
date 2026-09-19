// pnpm resolves a profile independently of the npm-installed CLI. Reuse the
// verified CLI's exact namespace closure, including explicit peer providers.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readManifest(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid manifest: ${file}`);
  return value;
}

export function verifiedKernelPins(cliManifestPath, version, cordisVersion) {
  const cli = readManifest(cliManifestPath);
  if (cli.name !== "@deepseek-ai/dsh" || cli.version !== version) throw new Error("CLI does not match the requested kernel pin");
  const cliDir = path.dirname(cliManifestPath);
  const scopes = [path.join(cliDir, "node_modules", "@deepseek-ai"), path.dirname(cliDir)];
  const pins = new Map();
  for (const scope of scopes) {
    if (!existsSync(scope)) continue;
    for (const entry of readdirSync(scope, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(scope, entry.name, "package.json");
      if (!existsSync(file)) continue;
      const pkg = readManifest(file);
      if (pkg.name !== `@deepseek-ai/${entry.name}` || typeof pkg.version !== "string" || !pkg.version) {
        throw new Error(`Invalid CLI namespace package: ${entry.name}`);
      }
      if (/^@deepseek-ai\/dsh(?:-|$)/.test(pkg.name) && pkg.version !== version) {
        throw new Error(`CLI kernel package differs from the pin: ${pkg.name}@${pkg.version}`);
      }
      if (pins.has(pkg.name) && pins.get(pkg.name) !== pkg.version) throw new Error(`Ambiguous CLI package versions: ${pkg.name}`);
      pins.set(pkg.name, pkg.version);
    }
  }
  if ([...pins.keys()].filter(name => /^@deepseek-ai\/dsh(?:-|$)/.test(name)).length < 100) {
    throw new Error("CLI kernel inventory is incomplete");
  }
  for (const name of ["@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) {
    if (pins.get(name) !== version) throw new Error(`CLI kernel package is missing: ${name}`);
  }
  if (pins.get("@deepseek-ai/cordis") !== cordisVersion) throw new Error("CLI cordis does not match the requested pin");
  return Object.fromEntries([...pins].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Exact versions for the peers a community bundle declares outside the
 * kernel's namespace (`@changfenhuang/dsh-annotation` asks for the bare
 * `cordis`). pnpm installs a missing peer on its own, at whatever the range
 * resolves to on the day of the build; an override makes it the version the
 * bundle was booted against, and a kernel package can never be one of them.
 * @param {string[]} specs `name@version`, exact
 * @returns {Record<string, string>}
 */
export function peerPins(specs = []) {
  /** @type {Record<string, string>} */
  const pins = {};
  for (const spec of specs) {
    const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(spec));
    if (!match) throw new Error(`A peer pin is name@exact-version: ${JSON.stringify(spec)}`);
    if (match[1].startsWith("@deepseek-ai/")) throw new Error(`The kernel closure pins ${match[1]}; a community peer pin cannot`);
    pins[match[1]] = match[2];
  }
  return pins;
}

export function seedProfileKernelPins(cliManifestPath, profileDir, policyPath, version, cordisVersion, communityPeers = {}) {
  const pins = verifiedKernelPins(cliManifestPath, version, cordisVersion);
  const file = path.join(profileDir, "package.json");
  const manifest = readManifest(file);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error("Initialize the profile through dsh before pinning its kernel");
  const policy = readFileSync(policyPath, "utf8");
  if (/^overrides\s*:/m.test(policy)) throw new Error("Profile policy already defines overrides");
  // rc.1's plugin manager reconciles only dependencies into active bundle
  // layers. devDependencies satisfy pnpm 11.7's prerelease peer resolution
  // without activating every bundle shipped by the CLI. The final plugin add
  // uses --save-prod to promote only the intended runtime bundles.
  manifest.devDependencies = { ...manifest.devDependencies, ...pins };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  // Community peers are overrides only: pnpm installs them for the bundle that
  // asks, and a devDependency would make the profile hold one no bundle does.
  const overrides = Object.entries({ ...pins, ...communityPeers }).map(([name, pin]) => `  ${JSON.stringify(name)}: ${JSON.stringify(pin)}`).join("\n");
  writeFileSync(path.join(profileDir, "pnpm-workspace.yaml"), `${policy.trimEnd()}\n\noverrides:\n${overrides}\n`);
  return pins;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cliManifestPath, profileDir, policyPath, version, cordisVersion, ...peers] = process.argv.slice(2);
  if (!cliManifestPath || !profileDir || !policyPath || !version || !cordisVersion) {
    throw new Error("Usage: profile-kernel-pins.mjs CLI_PACKAGE_JSON PROFILE_DIR POLICY_YAML DSH_VERSION CORDIS_VERSION [PEER@EXACT_VERSION ...]");
  }
  const community = peerPins(peers);
  const pins = seedProfileKernelPins(cliManifestPath, profileDir, policyPath, version, cordisVersion, community);
  console.log(`Pinned ${Object.keys(pins).length} profile namespace packages to the verified CLI closure`
    + (Object.keys(community).length ? ` and ${Object.keys(community).length} community peer(s): ${Object.entries(community).map(([n, v]) => `${n}@${v}`).join(", ")}` : ""));
}
