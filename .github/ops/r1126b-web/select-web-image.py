#!/usr/bin/env python3
"""Keep the CI web image's exact OCI blobs while dropping other images."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tarfile
import zipfile

CHUNK = 1024 ** 2
GIB = 1024 ** 3
blob_pattern = re.compile(r"blobs/sha256/[a-f0-9]{64}")


def require(ok, code):
    if not ok:
        raise SystemExit(code)


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def path_of(digest):
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "invalid digest")
    return "blobs/sha256/" + digest[7:]


def file_sha(file):
    with file.open("rb") as stream:
        return "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()


class DigestReader:
    def __init__(self, stream):
        self.stream = stream
        self.hash = hashlib.sha256()

    def read(self, size):
        data = self.stream.read(size)
        self.hash.update(data)
        return data

    def digest(self):
        return "sha256:" + self.hash.hexdigest()


def write_member(tar, name, content):
    item = tarfile.TarInfo(name)
    item.size = len(content)
    item.mode = 0o444
    tar.addfile(item, io.BytesIO(content))


def build(zip_path, out_path, revision, run, attempt, artifact_sha):
    require(file_sha(zip_path) == artifact_sha, "GitHub artifact digest differs")
    with zipfile.ZipFile(zip_path) as artifact:
        entries = artifact.infolist()
        names = [item.filename for item in entries]
        require(len(names) == len(set(names)) and all("/" not in name for name in names), "unexpected artifact entries")
        require(all(item.file_size <= (3 * GIB if item.filename == "images.tar.gz" else CHUNK) for item in entries), "artifacts exceed known bounds")
        prepared = json.loads(artifact.read("prepared-export.json"))
        measured = json.loads(artifact.read("manifest.json"))
        for report in [prepared, measured]:
            require(report["scope"] == "candidate-core-image-subset"
                    and report["sourceRevision"] == revision
                    and str(report["workflowRun"]) == run
                    and str(report["workflowAttempt"]) == attempt, "CI source or run differs")
        require(measured["images"] == prepared["images"] and measured["roles"] == prepared["roles"], "CI inventories disagree")
        for item in prepared["files"]:
            raw = artifact.read(item["path"])
            require(len(raw) == item["bytes"] and sha(raw) == "sha256:" + item["sha256"], "CI metadata digest differs")
        expect = prepared["roles"]["web"]
        reference = expect["reference"]
        image = next(r for r in prepared["images"] if r["reference"] == reference)
        verified = next(r for r in measured["verifiedImages"] if reference in r["references"])
        digest = expect["imageId"]
        release = prepared["releaseId"]
        require(image["imageId"] == verified["configDigest"] == digest
                and image["platform"] == verified["platform"] == "linux/amd64"
                and image["diffIds"] == verified["rootfs"]["diff_ids"]
                and verified["labels"]["org.opencontainers.image.version"] == release
                and verified["labels"]["org.opencontainers.image.revision"] == revision, "web identity differs")
        created = verified["labels"]["org.opencontainers.image.created"]
        by_diff = {item["diffId"]: item for item in measured["archive"]["layers"]}
        selected_layers = [by_diff[diff] for diff in image["diffIds"]]
        layers = {item["path"]: item for item in selected_layers}
        require(all(blob_pattern.fullmatch(name) for name in layers), "non-OCI layer path")
        require(sum(item["storedBytes"] for item in layers.values()) <= 700 * CHUNK,
                "web archive does not fit the measured staging envelope")
        config_path = path_of(digest)
        expected_checksum = sha_value(artifact.read("images.tar.gz.sha256").decode().split()[0])
        require(expected_checksum == sha_value(measured["archive"]["sha256"]), "CI archive metadata disagrees")

        docs = {}
        written = set()
        with artifact.open("images.tar.gz") as stream, tarfile.open(out_path, "x:gz", compresslevel=1) as result:
            reader = DigestReader(stream)
            with gzip.GzipFile(fileobj=reader) as decompressed:
                with tarfile.open(fileobj=decompressed, mode="r|") as source:
                    seen = set()
                    for item in source:
                        name = item.name
                        require(name not in seen, "duplicate source archive member")
                        seen.add(name)
                        if name in layers:
                            require(item.isfile() and item.size == layers[name]["storedBytes"], "web layer size differs")
                            raw = DigestReader(source.extractfile(item))
                            result.addfile(item, raw)
                            require(path_of(raw.digest()) == name, "web layer digest differs")
                            written.add(name)
                        elif item.isfile() and item.size < 256 * 1024 and (
                            blob_pattern.fullmatch(name) or name in {"index.json", "manifest.json", "oci-layout"}
                        ):
                            raw = source.extractfile(item).read()
                            try:
                                doc = json.loads(raw)
                            except (ValueError, UnicodeDecodeError):
                                continue
                            docs[name] = (doc, raw)
                    while decompressed.read(CHUNK):
                        pass
            require(reader.digest() == expected_checksum, "CI archive digest differs")
            require(written == set(layers), "web layer missing")

            config, raw = docs[config_path]
            require(sha(raw) == digest and config["rootfs"]["diff_ids"] == image["diffIds"]
                    and config["os"] == "linux" and config["architecture"] == "amd64"
                    and config["config"]["Labels"] == verified["labels"], "web config differs")
            write_member(result, config_path, raw)

            compatibility = next(entry for entry in docs["manifest.json"][0] if reference in entry["RepoTags"])
            ordered_paths = [item["path"] for item in selected_layers]
            require(compatibility["Config"] == config_path and compatibility["Layers"] == ordered_paths,
                    "Docker compatibility manifest differs")
            write_member(result, "manifest.json", json.dumps([{**compatibility, "RepoTags": [reference]}]).encode())

            index = docs["index.json"][0]
            matches = []
            for descriptor in index["manifests"]:
                native_path = path_of(descriptor["digest"])
                doc, raw = docs[native_path]
                if doc.get("config", {}).get("digest") != digest:
                    continue
                require(sha(raw) == descriptor["digest"] and len(raw) == descriptor["size"]
                        and doc["config"]["size"] == len(docs[config_path][1])
                        and [path_of(layer["digest"]) for layer in doc["layers"]] == ordered_paths
                        and [layer["size"] for layer in doc["layers"]] == [item["storedBytes"] for item in selected_layers], "OCI manifest differs")
                matches.append((descriptor, raw))
            require(len(matches) == 1, "web OCI manifest missing or ambiguous")
            descriptor, raw_manifest = matches[0]
            write_member(result, path_of(descriptor["digest"]), raw_manifest)
            write_member(result, "index.json", json.dumps({**index, "manifests": [descriptor]}).encode())
            write_member(result, "oci-layout", docs["oci-layout"][1])

    layer_bytes = sum(item["uncompressedBytes"] for item in layers.values())
    largest = max(item["uncompressedBytes"] for item in layers.values())
    receipt = {"sourceRevision": revision, "workflowRun": run, "workflowAttempt": attempt, "githubArtifactSha256": artifact_sha,
               "ciCoreArchiveSha256": expected_checksum, "webArchiveSha256": file_sha(out_path), "reference": reference,
               "configDigest": digest, "ociManifestDigest": descriptor["digest"], "releaseId": release, "createdAt": created,
               "webLayerBytes": layer_bytes, "largestWebLayerBytes": largest, "image": image, "ciIdentity": verified}
    with out_path.with_suffix(".json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print(json.dumps({k: v for k, v in receipt.items() if k not in {"image", "ciIdentity"}}), flush=True)


def sha_value(value):
    require(re.fullmatch(r"[a-f0-9]{64}", value), "invalid SHA256 value")
    return "sha256:" + value


if __name__ == "__main__":
    build(Path(sys.argv[1]), Path(sys.argv[2]), *sys.argv[3:])
