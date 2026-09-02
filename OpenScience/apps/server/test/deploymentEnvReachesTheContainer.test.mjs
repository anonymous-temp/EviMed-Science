// A deployment knob that cannot reach the process it configures.
//
// The web service passes environment item by item — there is no env_file on it
// — so a variable absent from that list is absent from the container no matter
// what .env says. Two load-bearing ones were missing, and both fail in the
// shape this codebase keeps meeting: nothing happens, and nothing says so.
//
//   OPEN_SCIENCE_RUNTIME_KERNEL was the kernel rollback lever, and it is the
//   reason this file exists: with the shipped default `dsh`, setting it back in
//   .env and restarting would have left the deployment on DSH, reported
//   success, and told the operator that rolling back did not help — the worst
//   possible answer to get mid-incident. The lever is gone with the kernel it
//   led to, and the variable is refused by name; the property outlived both.
//
//   OPEN_SCIENCE_SAAS_PROFILE_UNCONFIGURED declares, one at a time, the
//   surfaces this deployment has chosen not to configure. Undeliverable, it
//   leaves readiness red with exactly the same four items it was red with
//   before, so the declaration reads as having been rejected.
//
// The value-less form (`KEY:`) is deliberate and was verified against the
// deployment host's own Compose: set in .env it passes the value through, and
// unset it is absent from the container rather than empty. `${KEY:-}` would
// deliver an empty string, which `Number("")` turns into 0 and a validating
// parser turns into a startup failure.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const deployDir = path.join(repoRoot, "deploy/web");

/** Variables the deployment sets for a host-side ops script, which never enters
 *  a container. The exemption names the script, and the test reads that script:
 *  an entry that stops being true stops protecting anything. */
const hostSideOnly = {
  OPEN_SCIENCE_PREFLIGHT_ALERT_DELIVERY: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PREFLIGHT_MIN_FREE_BYTES: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PREFLIGHT_MONITORING: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PREFLIGHT_OBJECT_STORAGE: "scripts/ops/host-preflight.mjs",
  OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR: "scripts/ops/configure-production-state.mjs",
};

/** The levers whose whole purpose is to be set at deploy time, and the services
 *  that have to receive them.
 *
 *  `OPEN_SCIENCE_RUNTIME_KERNEL` used to head this list. It was the kernel
 *  rollback lever, and it is gone with the kernel it rolled back to — the
 *  variable is refused by name now, so a deployment that still set it would be
 *  told so at startup rather than ignored. What stays is the property it was
 *  written to prove: a documented lever that no service receives is a knob that
 *  does nothing and says nothing. */
const operatorLevers = {
  OPEN_SCIENCE_SAAS_PROFILE_UNCONFIGURED: ["open-science-web"],
  // Declared `true` in .env.example and read by config.mjs, and for a while
  // passed by neither compose service: an operator turning the LLM fallback
  // classifier off got the shipped default and no indication their setting had
  // been dropped on the floor.
  OPEN_SCIENCE_LLM_ROUTING_ENABLED: ["open-science-web"],
};

async function composeFiles() {
  const names = (await readdir(deployDir)).filter((name) => name.endsWith(".yml")).sort();
  assert.ok(names.length >= 5, `found ${names.length} compose files; the scan is wrong, not the directory`);
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(path.join(deployDir, name), "utf8") })));
}

test("every documented deployment variable is named where something can act on it", async () => {
  const example = await readFile(path.join(deployDir, ".env.example"), "utf8");
  // Commented keys count: a commented example is still an instruction, and it
  // is the form the rollback lever takes.
  const documented = [...example.matchAll(/^#? *(OPEN_SCIENCE_[A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.ok(documented.length >= 100, `parsed ${documented.length} keys from .env.example; the parse is wrong`);

  const files = await composeFiles();
  const named = new Set(files.flatMap(({ text }) => [...text.matchAll(/OPEN_SCIENCE_[A-Z0-9_]+/g)].map((m) => m[0])));
  assert.ok(named.size >= 100, `parsed ${named.size} names from the compose files; the parse is wrong`);

  const unreachable = [...new Set(documented)].filter((key) => !named.has(key)).sort();
  const unexplained = unreachable.filter((key) => !Object.hasOwn(hostSideOnly, key));
  assert.deepEqual(
    unexplained,
    [],
    `.env.example documents ${unexplained.join(", ")}, and no compose file passes ${unexplained.length === 1 ? "it" : "them"} anywhere`,
  );

  // An exemption that has become false, or was never true, protects nothing.
  for (const [key, script] of Object.entries(hostSideOnly)) {
    assert.ok(unreachable.includes(key), `${key} no longer needs a host-side exemption; drop it from the list`);
    const source = await readFile(path.join(repoRoot, script), "utf8");
    assert.ok(source.includes(key), `${key} is exempted as host-side for ${script}, which never names it`);
  }
});

test("the operator levers reach the services that read them", async () => {
  const files = await composeFiles();
  for (const [key, services] of Object.entries(operatorLevers)) {
    for (const service of services) {
      const carriers = files.filter(({ text }) => {
        const environment = YAML.parse(text)?.services?.[service]?.environment;
        return environment != null && Object.hasOwn(environment, key);
      });
      assert.ok(
        carriers.length > 0,
        `no compose file passes ${key} to ${service}, so setting it in .env changes nothing there`,
      );
    }
  }
});

test("no compose file pins an operator lever to a literal", async () => {
  // Two overlays once set the same key to two different literals on the same
  // service, and which one won depended on the order of -f flags. The .env
  // value was unreadable from either. A lever must be interpolated or passed
  // through, never written down.
  const files = await composeFiles();
  const levers = Object.keys(operatorLevers);
  for (const { name, text } of files) {
    const document = YAML.parse(text);
    for (const [service, definition] of Object.entries(document?.services ?? {})) {
      for (const [key, value] of Object.entries(definition?.environment ?? {})) {
        if (!levers.includes(key)) continue;
        assert.ok(
          value == null || String(value).includes(`\${${key}`),
          `${name} pins ${key} on ${service} to the literal ${JSON.stringify(value)}; .env can no longer move it`,
        );
      }
    }
  }
});
