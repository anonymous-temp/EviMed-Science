import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../../../../.github/workflows/knowledge-plugin.yml", import.meta.url), "utf8"));
const steps = workflow.jobs.qualify.steps;
const step = (name) => steps.find((item) => item.name === name);

function programs(script) {
  return [...script.matchAll(/python - <<'([A-Z]+)'\n([\s\S]*?)\n\1(?:\n|$)/g)].map((match) => match[2]);
}

test("plugin PR qualification and release exports use read-only permissions and exact source", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  const job = workflow.jobs.qualify;
  assert.equal(job["runs-on"], "ubuntu-22.04");
  assert.match(job.env.FULL_RELEASE, /github.event_name == 'push'/);
  assert.match(job.env.FULL_RELEASE, /refs\/heads\/codex\/release-/);
  assert.match(job.env.FULL_RELEASE, /\[full-release\]/);
  assert.match(step("Run plugin tests against disposable PostgreSQL").run, /psycopg.connect/);
  assert.match(step("Build exact plugin image on isolated runner").run, /PLUGIN_BUILD=\$GITHUB_SHA/);
  assert.match(step("Build exact plugin image on isolated runner").run, /--platform linux\/amd64/);
  assert.match(step("Qualify built imports registry and database-backed HTTP").run, /KNOWLEDGE_PLUGIN_CRAWL=0/);
  assert.equal(step("Export bounded plugin-only release artifact").if, "env.FULL_RELEASE == 'true'");
  for (const item of steps.filter((item) => item.uses?.startsWith("actions/upload-artifact@"))) {
    assert.equal(item.with["if-no-files-found"], "error");
  }
});

test("all inline qualification programs compile", () => {
  const bodies = steps.flatMap((item) => programs(item.run ?? ""));
  assert.ok(bodies.length >= 6);
  const result = spawnSync("python3", ["-c", "import json,sys; [compile(s, '<workflow>', 'exec') for s in json.load(sys.stdin)]"], {
    input: JSON.stringify(bodies), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("actual qualification program binds image source and rejects stale or unsafe fixture", () => {
  const program = programs(step("Qualify built imports registry and database-backed HTTP").run)
    .find((body) => body.includes("subprocess.check_output"));
  assert.ok(program);
  const fixture = [
    "import json, os, subprocess, tempfile",
    "from pathlib import Path",
    "image = {'Id':'sha256:candidate','Os':'linux','Architecture':'amd64','RootFS':{'Layers':['sha256:layer']},'Config':{'User':'10002:10002','Labels':{'org.opencontainers.image.revision':'candidate'}}}",
    "container = {'Image':image['Id'],'HostConfig':{'ReadonlyRootfs':True,'CapDrop':['ALL']}}",
    "subprocess.check_output = lambda args: json.dumps([container if args[1] == 'inspect' else image]).encode()",
    "with tempfile.TemporaryDirectory() as directory:",
    "    os.environ.update(RUNNER_TEMP=directory,IMAGE='evimed-knowledge-plugin:ci-candidate',GITHUB_SHA='candidate',GITHUB_RUN_ID='42',GITHUB_RUN_ATTEMPT='1')",
    "    Path(directory,'plugin-base.json').write_text('{}')",
    "    Path(directory,'plugin-health.json').write_text('{}')",
    "    source = json.load(__import__('sys').stdin)",
    "    exec(source)",
    "    report = json.loads(Path(directory,'plugin-qualification.json').read_text())",
    "    assert report['sourceRevision'] == 'candidate' and report['configDigest'] == image['Id'] and report['workflowRun'] == '42'",
    "    for target,key,value in [(image['Config']['Labels'],'org.opencontainers.image.revision','stale'),(container,'Image','sha256:wrong'),(container['HostConfig'],'ReadonlyRootfs',False)]:",
    "        original = target[key]",
    "        target[key] = value",
    "        try:",
    "            exec(source)",
    "        except AssertionError:",
    "            pass",
    "        else:",
    "            raise AssertionError('Invalid fixture was qualified')",
    "        target[key] = original",
  ].join("\n");
  const result = spawnSync("python3", ["-c", fixture], { input: JSON.stringify(program), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
