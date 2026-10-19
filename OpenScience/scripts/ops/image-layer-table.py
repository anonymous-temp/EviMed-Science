#!/usr/bin/env python3
"""Print each image's layers -- diff ID, bytes, the instruction that made it.

    docker save <ref>... | image-layer-table.py --json out.json role=<ref>...
    image-layer-table.py --compare previous.json current.json

The serving host credits a release only for the layers it already holds, by
diff ID (admit-core-artifact.py: missing content and missing snapshots, plus
the largest layer), so what a release costs the host is the bytes of the layers
whose diff IDs are new. The first form reads one `docker save` stream (layers
are skipped, never stored), prints a table per image and writes it as JSON; the
second compares two such files, as two CI runs wrote them, and prints what the
later one adds.

Sizes are the stored layer blobs' bytes as `docker save` writes them:
uncompressed tars on the classic image store (blob digest == diff ID), which is
what the host's admission counts as `uncompressedBytes`. A blob whose digest is
not its diff ID is marked compressed.
"""
from __future__ import annotations

import argparse
import json
import sys
import tarfile

MAX_METADATA_BYTES = 4 * 1024 * 1024


def read_stream(source, roles):
    sizes, documents, manifest = {}, {}, None
    with tarfile.open(fileobj=source, mode="r|") as archive:
        for member in archive:
            archive.members.clear()
            if not member.isfile():
                continue
            sizes[member.name] = member.size
            if member.name == "manifest.json" or (member.name.startswith("blobs/sha256/") and member.size <= MAX_METADATA_BYTES):
                content = archive.extractfile(member).read()
                if member.name == "manifest.json":
                    manifest = json.loads(content)
                    continue
                try:
                    parsed = json.loads(content)
                except (UnicodeDecodeError, ValueError):
                    continue
                if isinstance(parsed, dict) and "rootfs" in parsed:
                    documents[member.name] = parsed
    if not isinstance(manifest, list):
        raise SystemExit("image-layer-table: the stream carries no manifest.json")
    images = {}
    for role, reference in roles.items():
        entry = next((item for item in manifest if reference in (item.get("RepoTags") or [])), None)
        if entry is None:
            raise SystemExit(f"image-layer-table: {reference} is not in the stream")
        config = documents[entry["Config"]]
        diff_ids = config["rootfs"]["diff_ids"]
        made_by = [step.get("created_by", "") for step in config.get("history", []) if not step.get("empty_layer")]
        if len(made_by) != len(diff_ids):
            made_by = [""] * len(diff_ids)
        layers = []
        for index, (path, diff_id) in enumerate(zip(entry["Layers"], diff_ids)):
            layers.append({"index": index, "diffId": diff_id, "bytes": sizes[path],
                           "compressed": path.rsplit("/", 1)[-1] != diff_id.split(":", 1)[-1],
                           "createdBy": " ".join(made_by[index].split())[:160]})
        images[role] = {"reference": reference, "layers": layers, "bytes": sum(layer["bytes"] for layer in layers)}
    return images


def human(count):
    for unit in ("B", "KB", "MB", "GB"):
        if count < 1024 or unit == "GB":
            return f"{count:.0f} {unit}" if unit == "B" else f"{count:.2f} {unit}"
        count /= 1024
    return str(count)


def print_tables(images, out=sys.stdout):
    for role, image in images.items():
        print(f"== {role} ({image['reference']}): {len(image['layers'])} layers, {human(image['bytes'])}", file=out)
        for layer in image["layers"]:
            mark = " (compressed)" if layer["compressed"] else ""
            print(f"  {layer['index']:>3}  {layer['diffId'][7:19]}  {layer['bytes']:>12}  {human(layer['bytes']):>10}{mark}  {layer['createdBy'][:100]}", file=out)


def compare(previous, current, out=sys.stdout):
    total_new = 0
    held = {layer["diffId"] for image in previous["images"].values() for layer in image["layers"]}
    for role, image in current["images"].items():
        before = previous["images"].get(role)
        same_prefix = 0
        if before:
            for old, new in zip(before["layers"], image["layers"]):
                if old["diffId"] != new["diffId"]:
                    break
                same_prefix += 1
        new_layers = [layer for layer in image["layers"] if layer["diffId"] not in held]
        added = sum(layer["bytes"] for layer in new_layers)
        total_new += added
        print(f"== {role}: {len(image['layers'])} layers; the first {same_prefix} keep their diff IDs; "
              f"{len(new_layers)} new, {added} bytes ({human(added)}) of {human(image['bytes'])}", file=out)
        for layer in new_layers:
            print(f"  new {layer['index']:>3}  {layer['diffId'][7:19]}  {human(layer['bytes']):>10}  {layer['createdBy'][:100]}", file=out)
        held.update(layer["diffId"] for layer in new_layers)
    print(f"== new layer bytes in total: {total_new} ({human(total_new)})", file=out)
    return total_new


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--json", help="write the tables here")
    parser.add_argument("--compare", nargs=2, metavar=("PREVIOUS", "CURRENT"), help="print what CURRENT adds to PREVIOUS")
    parser.add_argument("roles", nargs="*", help="role=reference, one per image in the stream")
    args = parser.parse_args(argv)
    if args.compare:
        with open(args.compare[0], encoding="utf-8") as left, open(args.compare[1], encoding="utf-8") as right:
            compare(json.load(left), json.load(right))
        return 0
    roles = dict(item.split("=", 1) for item in args.roles)
    if not roles:
        parser.error("name at least one role=reference")
    images = read_stream(sys.stdin.buffer, roles)
    print_tables(images)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump({"images": images}, handle, indent=2)
            handle.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
