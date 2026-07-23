import { spawnSync } from "node:child_process";
import path from "node:path";
import { HttpError } from "./security.mjs";

const dockerVolumeNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function assertDockerVolumeName(value) {
  const name = String(value ?? "").trim();
  if (!dockerVolumeNamePattern.test(name)) {
    throw new HttpError(
      500,
      "invalid_runtime_data_volume",
      "Runtime data volume must be a valid Docker volume name.",
    );
  }
  return name;
}

export function assertDockerDataVolumeSupport(config, code = "runtime_volume_subpath_unsupported") {
  if (!config.runtimeDataVolume) return null;
  const result = spawnSync(
    config.runtimeContainerBin,
    ["info", "--format", "{{.ServerVersion}}"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) {
    throw new HttpError(503, "runtime_docker_unavailable", "Docker is unavailable for volume-backed runtime mounts.");
  }
  const version = result.stdout.trim();
  const major = Number(version.match(/^(\d+)/)?.[1]);
  if (!Number.isSafeInteger(major) || major < 26) {
    throw new HttpError(503, code, "Docker Engine 26 or newer is required for project volume subpath mounts.");
  }
  return { version, major };
}

function volumeSubpath(config, target) {
  const dataDir = path.resolve(config.dataDir);
  const absolute = path.resolve(target);
  const relative = path.relative(dataDir, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new HttpError(
      500,
      "runtime_data_path_outside_volume",
      "Runtime project paths must stay inside OPEN_SCIENCE_DATA_DIR.",
    );
  }
  return relative.split(path.sep).join("/");
}

function projectMount(config, target, destination) {
  if (!config.runtimeDataVolume) {
    return `type=bind,src=${target},dst=${destination}`;
  }
  const volume = assertDockerVolumeName(config.runtimeDataVolume);
  return `type=volume,src=${volume},dst=${destination},volume-subpath=${volumeSubpath(config, target)}`;
}

export function dockerWorkspaceMount(config, project) {
  return projectMount(config, project.workspaceDir, "/workspace");
}

export function dockerRuntimeMount(config, runtimeRoot, destination = "/runtime") {
  return projectMount(config, runtimeRoot, destination);
}
