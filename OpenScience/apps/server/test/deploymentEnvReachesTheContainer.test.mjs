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
  // Read on the host before anything starts: it is written into
  // monitoring/targets/tls.json, which Prometheus then discovers by file. The
  // value never enters a container, so passing it through compose would be the
  // pretence this test exists to refuse.
  OPEN_SCIENCE_PUBLIC_HEALTH_URL: "scripts/ops/configure-monitoring.mjs",
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
  // The way back to server-side repair rounds, off by default since
  // 2026-09-17. A lever that does not arrive leaves an operator believing the
  // gate sends packages back when it attaches its findings instead.
  OPEN_SCIENCE_GATE_REPAIR_ROUNDS: ["open-science-web"],
  // Declared `true` in .env.example and read by config.mjs, and for a while
  // passed by neither compose service: an operator turning the LLM fallback
  // classifier off got the shipped default and no indication their setting had
  // been dropped on the floor.
  OPEN_SCIENCE_LLM_ROUTING_ENABLED: ["open-science-web"],
  // The learning loop defaults on since 2026-09-08, which is what makes the
  // off switch load-bearing: a deployment that decides not to spend on
  // distillation edits `.env`, and if the variable never reaches the service
  // the loop keeps running and nothing says so. The window and the concurrency
  // are the other two knobs that bound what "on" costs.
  OPEN_SCIENCE_LEARNING_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_WINDOW: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_CONCURRENCY: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_RUN_LIMIT_CNY: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_DAILY_LIMIT_CNY: ["open-science-web"],
  OPEN_SCIENCE_LEARNING_WEEKLY_LIMIT_CNY: ["open-science-web"],
  // The thinking budget was a literal `high` in the gateway until 2026-09-09,
  // so the lever is new and this is what makes it real.
  OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT: ["open-science-web"],
  // Selecting a recall index is a deployment decision, and the failure mode of
  // a missing lever here is the quiet one: the deployment keeps whichever
  // provider the compose default names — `openviking` since 2026-09-11, so an
  // operator who chose `builtin` keeps paying for embeddings — and every recall
  // still returns memories, which is why nothing ever reports the setting was
  // dropped.
  OPEN_SCIENCE_MEMORY_INDEX_PROVIDER: ["open-science-web"],
  OPEN_SCIENCE_MEMORY_INDEX_STRICT: ["open-science-web"],
  OPEN_SCIENCE_OPENVIKING_URL: ["open-science-web"],
  OPEN_SCIENCE_OPENVIKING_ACCOUNT: ["open-science-web"],
  // Read by config.mjs and passed by no compose file until 2026-09-16: turning
  // memory off, opening the agent memory API, or excluding an evaluation's
  // projects from extraction all did nothing from .env. The last one reached
  // production only through a private override's environment map.
  OPEN_SCIENCE_MEMORY_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED: ["open-science-web"],
  OPEN_SCIENCE_MEMORY_EXTRACTION_EXCLUDED_PROJECT_PREFIXES: ["open-science-web"],
  // The two delegation limits that replaced `maxParallelChildren` (2026-09-18).
  // The controller builds the hosted launch plan and so is the service that
  // actually writes them into a runtime container; the web API builds it when
  // it launches directly. The old variable reached neither.
  OPEN_SCIENCE_MAX_CHILDREN_TOTAL: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_MAX_CONCURRENT_CHILDREN: ["open-science-web", "open-science-runtime-controller"],
  // Read by harness-port's compactionConfigFromEnv in both services and passed
  // by no compose file until 2026-09-18: the threshold lever the review's
  // cheapest experiment (0.8 -> 0.5) needs did nothing from .env, and the
  // controller, which writes it into every runtime, never saw it. The gateway
  // body limit reaches the controller because the request-size guard is a
  // share of it.
  OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_THRESHOLD_RATIO: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_TOKENS: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_TOKENS: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_REQUEST_BYTES: ["open-science-web", "open-science-runtime-controller"],
  OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES: ["open-science-web", "open-science-runtime-controller"],
  // The frame layer's per-body off switches: the control every body is
  // measured against has to be reachable from .env.
  OPEN_SCIENCE_RUNTIME_UI_FRAME_OFF: ["open-science-web"],
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
