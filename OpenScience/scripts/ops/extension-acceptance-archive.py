#!/usr/bin/env python3
"""Measure the exact deduplicated assessment archive without extracting image layers."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile

SPEC = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('image-archive-inventory.py'))
INVENTORY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INVENTORY)
MAX_EXPANDED = 8 * 1024**3
MAX_COMPRESSED = 3 * 1024**3


def chunks(stream):
    total = 0
    while True:
        data = stream.read(1024 * 1024)
        if not data:
            return
        total += len(data)
        INVENTORY.require(total <= MAX_EXPANDED, 'expanded_archive_bound')
        yield data


class ExpandedStream:
    """Count all expanded tar bytes, including headers and trailing padding."""
    def __init__(self, stream):
        self.stream, self.bytes = stream, 0

    def read(self, size=-1):
        INVENTORY.require(0 <= size <= MAX_EXPANDED, 'unbounded_archive_read')
        data = self.stream.read(size)
        self.bytes += len(data)
        INVENTORY.require(self.bytes <= MAX_EXPANDED, 'expanded_archive_bound')
        return data


def measure_archive(root):
    root = Path(root)
    expected = json.loads((root / 'prepared-export.json').read_text())
    expected_images = {item['reference']: item for item in expected['images']}
    for role in expected.get('roles', {}).values():
        image = expected_images.get(role.get('reference'))
        INVENTORY.require(image and image['imageId'] == role.get('imageId'), 'subset_role_identity')
    for record in expected.get('files', []):
        parts = Path(record['path']).parts
        INVENTORY.require(parts and not Path(record['path']).is_absolute() and not any(part in {'.', '..'} for part in parts), 'subset_file_path')
        target = root
        for part in parts:
            target /= part
            INVENTORY.require(not target.is_symlink(), 'subset_file_link')
        INVENTORY.require(target.is_file() and target.stat().st_size == record['bytes'] and record['bytes'] <= 32 * 1024**2, 'subset_file_identity')
        hasher = hashlib.sha256()
        with target.open('rb') as stream:
            for data in chunks(stream):
                hasher.update(data)
        INVENTORY.require(hasher.hexdigest() == record['sha256'], 'subset_file_identity')
    archive_file = root / 'images.tar.gz'
    INVENTORY.require(0 < archive_file.stat().st_size <= MAX_COMPRESSED, 'compressed_archive_bound')
    archive_digest = hashlib.sha256()
    with archive_file.open('rb') as stream:
        for data in chunks(stream):
            archive_digest.update(data)
    members, manifest, expanded_bytes, decoded_bytes = {}, None, 0, 0
    with gzip.open(archive_file, 'rb') as decompressed:
        expanded = ExpandedStream(decompressed)
        with tarfile.open(fileobj=expanded, mode='r|', tarinfo=INVENTORY.BoundedTarInfo) as archive:
            member_count = 0
            while True:
                member = archive.next()
                archive.members.clear()
                if member is None:
                    break
                member_count += 1
                INVENTORY.require(member_count <= INVENTORY.MAX_MEMBERS, 'archive_member_limit')
                INVENTORY.require(0 <= member.size <= MAX_EXPANDED, 'expanded_member_bound')
                if not member.isfile():
                    continue
                stream = archive.extractfile(member)
                if member.name == 'manifest.json':
                    INVENTORY.require(member.size <= INVENTORY.MAX_METADATA_BYTES, 'metadata_size_limit')
                    manifest = INVENTORY.parse_json(stream.read(INVENTORY.MAX_METADATA_BYTES + 1))
                    continue
                # Hash actual stored layers and their uncompressed bytes; configs are small and harmless.
                buffered = io.BufferedReader(stream)
                compressed = buffered.peek(2)[:2] == b'\x1f\x8b'
                decoded = gzip.GzipFile(fileobj=buffered) if compressed else buffered
                digest, size = hashlib.sha256(), 0
                for data in chunks(decoded):
                    size += len(data)
                    decoded_bytes += len(data)
                    INVENTORY.require(decoded_bytes <= MAX_EXPANDED, 'decoded_archive_bound')
                    digest.update(data)
                members[member.name] = {'path': member.name, 'storedBytes': member.size,
                                        'uncompressedBytes': size, 'diffId': 'sha256:' + digest.hexdigest()}
        for _data in chunks(expanded):
            pass
        expanded_bytes = expanded.bytes
    with archive_file.open('rb') as stream:
        images = INVENTORY.read_inventory(stream, [item['reference'] for item in expected['images']])
    expected_images = {item['reference']: item for item in expected['images']}
    for image in images:
        INVENTORY.require(len(image['references']) == 1, 'unexpected_image_alias')
        admitted = expected_images[image['references'][0]]
        INVENTORY.require(image['configDigest'] == admitted['imageId'] and image['platform'] == admitted['platform']
                          and image['rootfs']['diff_ids'] == admitted['diffIds'], 'export_image_identity')
    unique = {}
    for entry in manifest:
        image = next(value for value in images if value['references'] == entry['RepoTags'])
        INVENTORY.require(len(entry['Layers']) == len(image['rootfs']['diff_ids']), 'layer_count_mismatch')
        for name, diff_id in zip(entry['Layers'], image['rootfs']['diff_ids']):
            layer = members.get(name)
            INVENTORY.require(layer and layer['diffId'] == diff_id, 'layer_bytes_mismatch')
            if diff_id in unique:
                INVENTORY.require(unique[diff_id]['uncompressedBytes'] == layer['uncompressedBytes'], 'shared_layer_size_mismatch')
            else:
                unique[diff_id] = layer
    total = sum(item['uncompressedBytes'] for item in unique.values())
    report = {**expected, 'archive': {'path': 'images.tar.gz', 'sha256': archive_digest.hexdigest(),
                                    'compressedBytes': archive_file.stat().st_size,
                                    'expandedArchiveMemberBytes': expanded_bytes,
                                    'uniqueUncompressedLayerBytes': total,
                                    'conservativeDownloadAndLoadBytes': archive_file.stat().st_size + expanded_bytes + total,
                                    'uniqueLayerCount': len(unique), 'layers': list(unique.values())},
              'verifiedImages': images}
    # Budget is recorded, not authorization to load on any host; its 10 GiB free floor remains mandatory.
    (root / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
    os.chmod(root / 'manifest.json', 0o400)
    (root / 'images.tar.gz.sha256').write_text(archive_digest.hexdigest() + '  images.tar.gz\n')
    os.chmod(root / 'images.tar.gz.sha256', 0o400)
    return report


if __name__ == '__main__':
    result = measure_archive(Path(os.environ['RUNNER_TEMP']) / 'evimed-extension-assessment')
    print(json.dumps({'qualified': False, 'images': len(result['images']), 'compressedBytes': result['archive']['compressedBytes'],
                      'uniqueUncompressedLayerBytes': result['archive']['uniqueUncompressedLayerBytes'],
                      'conservativeDownloadAndLoadBytes': result['archive']['conservativeDownloadAndLoadBytes']}))
