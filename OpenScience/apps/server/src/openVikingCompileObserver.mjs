import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import fs from "node:fs";
import { PINNED } from "./pinnedVersions.mjs";
import { COMPILE_SCOPE_PROOF, compileProofDigest } from "./openVikingCompileExecution.mjs";
import { HttpError } from "./security.mjs";

const execute = promisify(execFile);
const SCRIPT = fs.readFileSync(new URL("./openVikingCompileObserver.py", import.meta.url), "utf8");
const SERVICE = "evimed-openviking";
const CONFIG_MOUNT = "/run/openviking-secrets";
const ID = /^[a-f0-9]{64}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const failure = () => new HttpError(503, "openviking_compile_unverified", "Shared knowledge compilation is temporarily unavailable.");
const unavailable = () => new HttpError(503, "runtime_controller_unavailable", "The compile configuration could not be observed.");

/** Fixed, read-only operations in the controller that already owns Docker.
 * Resolve the controller's own Compose project, not the first engine on a
 * host that can also run isolated acceptance stacks. No caller parameters. */
export function createOpenVikingCompileObserver(config, { run = null, self = hostname() } = {}) {
  const command = run ?? (async args => (await execute(config.runtimeContainerBin, args,
    { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout);
  const inspect = async (kind, name) => JSON.parse(await command([kind, "inspect", "--format", "{{json .}}", name]));
  const assert = condition => { if (!condition) throw failure(); };
  return async () => {
    try {
      assert(/^[a-f0-9]{12,64}$/.test(self));
      const own = await inspect("container", self);
      const project = own.Config?.Labels?.["com.docker.compose.project"];
      assert(own.Config?.Labels?.["com.docker.compose.service"] === "open-science-runtime-controller"
        && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(project));
      const ids = (await command(["ps", "--filter", `label=com.docker.compose.project=${project}`,
        "--filter", `label=com.docker.compose.service=${SERVICE}`, "--no-trunc", "--format", "{{.ID}}"])).trim().split(/\s+/).filter(Boolean);
      if (!ids.length) throw unavailable();
      assert(ids.length === 1 && ID.test(ids[0]));
      const before = await inspect("container", ids[0]);
      const labels = before.Config?.Labels ?? {};
      assert(labels["com.docker.compose.project"] === project && labels["com.docker.compose.service"] === SERVICE);
      if (before.State?.Running !== true || before.State?.Restarting !== false || before.State?.Health?.Status !== "healthy") throw unavailable();
      assert(SHA.test(before.Image) && before.Id === ids[0]);
      assert(JSON.stringify(before.Config.Entrypoint) === '["openviking-entrypoint"]'
        && (!before.Config.Cmd || before.Config.Cmd.length === 0));
      const mounts = before.Mounts ?? [];
      const secrets = mounts.filter(mount => mount.Destination === CONFIG_MOUNT);
      assert(secrets.length === 1 && secrets[0].Type === "volume" && secrets[0].RW === false);
      assert(!mounts.some(mount => {
        const dest = String(mount.Destination ?? "");
        return dest.startsWith(`${CONFIG_MOUNT}/`) || ["/app/.venv", "/usr/local/bin"].some(root =>
          dest === "/" || dest === root || dest.startsWith(`${root}/`) || root.startsWith(`${dest}/`));
      }));
      const volume = await inspect("volume", secrets[0].Name);
      assert(volume.Labels?.["com.docker.compose.project"] === project
        && volume.Labels?.["com.docker.compose.volume"] === "evimed-openviking-secrets");
      const image = await inspect("image", before.Image);
      const digests = image.RepoDigests ?? [];
      assert(image.Id === before.Image && image.Os === "linux" && (digests.includes(`${PINNED.openviking.image}@${PINNED.openviking.imageDigest}`)
        || (image.Architecture === "amd64" && digests.includes(`${PINNED.openviking.image}@${PINNED.openviking.linuxAmd64Digest}`))));
      let sample;
      try { sample = JSON.parse(await command(["exec", ids[0], "/app/.venv/bin/python", "-I", "-B", "-c", SCRIPT, JSON.stringify(COMPILE_SCOPE_PROOF)])); }
      catch (error) {
        let result;
        try { result = JSON.parse(String(error?.stdout ?? "")); } catch { result = null; }
        if (result?.state === "rejected" && result.code === "configuration_or_code_rejected") throw failure();
        throw unavailable();
      }
      if (sample?.state === "unavailable") throw unavailable();
      assert(sample.configPath === `${CONFIG_MOUNT}/ov.conf` && sample.backend === "direct"
        && sample.allowExec === false && sample.allowCompileExec === false);
      const after = await inspect("container", ids[0]);
      const identity = value => ({ id: value.Id, image: value.Image, state: value.State, restarts: value.RestartCount,
        mounts: value.Mounts, config: value.Config });
      // Health-check logs change while the instance does not. Retain status,
      // start time and PID; never return its commands, environment or logs.
      const stable = value => { const item = identity(value); item.state = { Running: value.State?.Running,
        Restarting: value.State?.Restarting, StartedAt: value.State?.StartedAt, Pid: value.State?.Pid,
        health: value.State?.Health?.Status }; return item; };
      if (compileProofDigest(stable(before)) !== compileProofDigest(stable(after))) throw unavailable();
      return { version: 1, instance: before.Id, imageDigest: PINNED.openviking.imageDigest,
        configDigest: sample.configDigest, configPath: sample.configPath, backend: sample.backend,
        allowExec: false, allowCompileExec: false, codeDigest: sample.codeDigest, processDigest: sample.processDigest };
    } catch (error) {
      if (error instanceof HttpError && ["openviking_compile_unverified", "runtime_controller_unavailable"].includes(error.code)) throw error;
      throw unavailable();
    }
  };
}
