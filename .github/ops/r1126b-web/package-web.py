#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import sys

work, out = map(Path, sys.argv[1:])
source = os.environ["PRODUCT_REVISION"]
release = os.environ["release"]
created = os.environ["created"]
reference = os.environ["reference"]
run = os.environ["GITHUB_RUN_ID"]
attempt = os.environ["GITHUB_RUN_ATTEMPT"]
base = json.loads((work / "base-image.json").read_text())[0]
image = json.loads((work / "web-image.json").read_text())[0]
base_identity = json.loads((work / "base-web.tar.json").read_text())
old_layers = base["RootFS"]["Layers"]
layers = image["RootFS"]["Layers"]
assert len(layers) > len(old_layers) and layers[:len(old_layers)] == old_layers
assert (image["Os"], image["Architecture"]) == ("linux", "amd64")
old_config, config = base["Config"], image["Config"]
for key in ("User", "Cmd", "Entrypoint", "WorkingDir", "Volumes", "ExposedPorts", "Healthcheck", "StopSignal", "OnBuild"):
    assert config.get(key) == old_config.get(key), key
assert config["Labels"] == {
    **old_config["Labels"],
    "org.opencontainers.image.version": release,
    "org.opencontainers.image.revision": source,
    "org.opencontainers.image.created": created,
}
env = lambda c: dict(item.split("=", 1) for item in c["Env"])
assert env(config) == {
    **env(old_config),
    "OPEN_SCIENCE_RELEASE_ID": release,
    "OPEN_SCIENCE_SOURCE_REVISION": source,
    "OPEN_SCIENCE_BUILD_CREATED": created,
}
entry = {"reference": reference, "imageId": image["Id"], "platform": "linux/amd64", "diffIds": layers}
prepared = {"schemaVersion": 1, "scope": "candidate-web-image", "sourceRevision": source,
            "workflowRun": run, "workflowAttempt": attempt, "releaseId": release,
            "roles": {"web": {"reference": reference, "imageId": image["Id"]}}, "images": [entry]}
(out / "prepared-export.json").write_text(json.dumps(prepared, indent=2) + "\n")
script = Path("OpenScience/scripts/ops/extension-acceptance-archive.py").absolute()
spec = importlib.util.spec_from_file_location("release_archive", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
measured = module.measure_archive(out)
archive = measured["archive"]
assert len(measured["verifiedImages"]) == 1
identity = measured["verifiedImages"][0]
assert identity["configDigest"] == entry["imageId"]
assert archive["uniqueUncompressedLayerBytes"] < 1024 ** 3
assert archive["compressedBytes"] < 256 * 1024 ** 2
receipt = {
    "sourceRevision": source, "workflowRun": run, "workflowAttempt": attempt, "workflowHead": os.environ["GITHUB_SHA"],
    "webArchiveSha256": "sha256:" + archive["sha256"], "reference": reference,
    "baseWebConfigDigest": base_identity["configDigest"], "baseRevision": base_identity["sourceRevision"],
    "baseDiffIds": old_layers, "rootFsPrefixVerified": True, "originalSmokePassed": True,
    "configDigest": identity["configDigest"], "releaseId": release, "createdAt": created,
    "webLayerBytes": archive["uniqueUncompressedLayerBytes"],
    "largestWebLayerBytes": max(part["uncompressedBytes"] for part in archive["layers"]),
    "image": entry, "ciIdentity": identity,
}
(out / "web.tar.json").write_text(json.dumps(receipt, indent=2) + "\n")
(out / "web.tar.gz.sha256").write_text(archive["sha256"] + "  web.tar.gz\n")
(out / "images.tar.gz").rename(out / "web.tar.gz")
(out / "images.tar.gz.sha256").unlink()
(out / "health.json").write_bytes((work / "health.json").read_bytes())
print(json.dumps({k: receipt[k] for k in ("sourceRevision", "workflowRun", "releaseId", "configDigest", "webLayerBytes")}))
