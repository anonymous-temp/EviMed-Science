#!/usr/bin/env bash
# Flatten a runtime image into one filesystem layer with the same configuration,
# so the next delta release can be built on it.
#
#   host-flatten-runtime-image.sh <SOURCE_IMAGE> <TARGET_IMAGE>
#
# Why: a delta release is built FROM the live release's image
# (host-delta-release.sh, Dockerfile.delta) and adds about twenty layers, so the
# chain only grows. At 422 layers (evimed-5a78008d89ba-1, 2026-09-19) the next
# delta stopped at its first COPY with `mount options is too long`: the
# containerd overlayfs snapshotter passes every lower layer's path in one mount
# option string, and a page holds only so many. Running containers were still
# fine; building on the image was not.
#
# How: the filesystem is exported from a created (never started) container and
# imported as one layer; the image configuration is read from the source and
# written back with `docker import --change`, except SHELL, which import cannot
# set, so a one-line build adds it. Nothing is rebuilt and nothing is fetched:
# the result holds the same files as the source. The delta built on it runs the
# image's own build smoke (booting the kernel), which is the functional check;
# this script checks that the configuration came across unchanged.
set -euo pipefail
SRC="${1:?source image}"
DST="${2:?target image}"
docker image inspect "$SRC" > /dev/null
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; docker rm -f "evimed-flatten-$$" > /dev/null 2>&1 || true' EXIT

docker image inspect -f '{{json .Config}}' "$SRC" > "$WORK/config.json"
# One `--change` per instruction, NUL-separated so a value may hold anything.
python3 - "$WORK/config.json" > "$WORK/changes" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
out = []
if c.get("User"): out.append(f"USER {c['User']}")
if c.get("WorkingDir"): out.append(f"WORKDIR {c['WorkingDir']}")
for entry in c.get("Env") or []:
    key, _, value = entry.partition("=")
    out.append(f"ENV {key}={json.dumps(value)}")
if c.get("Entrypoint"): out.append("ENTRYPOINT " + json.dumps(c["Entrypoint"]))
if c.get("Cmd"): out.append("CMD " + json.dumps(c["Cmd"]))
if c.get("Volumes"): out.append("VOLUME " + json.dumps(sorted(c["Volumes"])))
if c.get("ExposedPorts"): out.extend(f"EXPOSE {port}" for port in sorted(c["ExposedPorts"]))
if c.get("StopSignal"): out.append(f"STOPSIGNAL {c['StopSignal']}")
for key, value in sorted((c.get("Labels") or {}).items()):
    out.append(f"LABEL {json.dumps(key)}={json.dumps(value)}")
if c.get("Healthcheck") or c.get("OnBuild"):
    sys.exit("the source image declares a HEALTHCHECK or ONBUILD, which import cannot carry; extend this script")
sys.stdout.write("\0".join(out))
PY
args=()
while IFS= read -r -d '' change; do args+=(--change "$change"); done < <(cat "$WORK/changes"; printf '\0')

docker create --name "evimed-flatten-$$" "$SRC" > /dev/null
docker export "evimed-flatten-$$" | docker import "${args[@]}" - "${DST}-imported" > /dev/null
shell=$(python3 -c 'import json,sys; s=json.load(open(sys.argv[1])).get("Shell"); print(json.dumps(s) if s else "")' "$WORK/config.json")
if [ -n "$shell" ]; then
  printf 'FROM %s\nSHELL %s\n' "${DST}-imported" "$shell" > "$WORK/Dockerfile"
  docker build -q -t "$DST" -f "$WORK/Dockerfile" "$WORK" > /dev/null
  docker rmi "${DST}-imported" > /dev/null
else
  docker tag "${DST}-imported" "$DST" && docker rmi "${DST}-imported" > /dev/null
fi

# The configuration must be the source's, field for field.
python3 - "$WORK/config.json" <(docker image inspect -f '{{json .Config}}' "$DST") <<'PY'
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
fields = ("User", "WorkingDir", "Env", "Entrypoint", "Cmd", "Volumes", "ExposedPorts", "StopSignal", "Labels", "Shell")
bad = [f for f in fields if (a.get(f) or None) != (b.get(f) or None)]
if bad:
    sys.exit(f"configuration differs after flattening: {bad}")
print("configuration identical:", ", ".join(fields))
PY
echo "$DST layers=$(docker image inspect -f '{{len .RootFS.Layers}}' "$DST") (source had $(docker image inspect -f '{{len .RootFS.Layers}}' "$SRC"))"
