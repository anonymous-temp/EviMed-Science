import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('assessment_archive', Path(__file__).parents[1] / 'extension-acceptance-archive.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture(root, tamper=False, gzip_layer=False):
    import gzip
    layer = b'actual shared public layer' * 100
    layer_digest = 'sha256:' + hashlib.sha256(layer).hexdigest()
    images, entries, manifest = [], [], []
    for i in range(2):
        config = json.dumps({'os': 'linux', 'architecture': 'amd64', 'rootfs': {'type': 'layers', 'diff_ids': [layer_digest]}, 'config': {'Labels': {'fixture': str(i)}}}).encode()
        digest = hashlib.sha256(config).hexdigest()
        reference = 'evimed-extension-assessment:source-role-' + str(i)
        images.append({'reference': reference, 'imageId': 'sha256:' + digest, 'platform': 'linux/amd64', 'diffIds': [layer_digest]})
        entries.append((digest + '.json', config))
        manifest.append({'Config': digest + '.json', 'RepoTags': [reference], 'Layers': ['shared/layer.tar']})
    entries.extend([('shared/layer.tar', gzip.compress(layer) if gzip_layer else layer + (b'tampered' if tamper else b'')), ('manifest.json', json.dumps(manifest).encode())])
    with tarfile.open(root / 'images.tar.gz', 'w:gz') as archive:
        for name, content in entries:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    (root / 'prepared-export.json').write_text(json.dumps({'images': images, 'qualified': False}))
    return layer


class AssessmentArchive(unittest.TestCase):
    def test_shared_layers_are_measured_once_and_bound_to_config_for_both_encodings(self):
        for compressed in (False, True):
            with self.subTest(compressed=compressed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                layer = fixture(root, gzip_layer=compressed)
                result = MODULE.measure_archive(root)
                self.assertFalse(result['qualified'])
                self.assertEqual(result['archive']['uniqueLayerCount'], 1)
                self.assertEqual(result['archive']['uniqueUncompressedLayerBytes'], len(layer))
                self.assertEqual(len(result['verifiedImages']), 2)
                self.assertEqual(result['archive']['sha256'], hashlib.sha256((root / 'images.tar.gz').read_bytes()).hexdigest())
                self.assertEqual((root / 'manifest.json').stat().st_mode & 0o777, 0o400)

    def test_changed_layers_refuse_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root, tamper=True)
            with self.assertRaisesRegex(ValueError, 'layer_bytes_mismatch'):
                MODULE.measure_archive(root)
            self.assertFalse((root / 'manifest.json').exists())

    def test_core_role_aliases_share_one_retained_image_and_bind_the_deployment_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layer = fixture(root)
            metadata = json.loads((root / 'prepared-export.json').read_text())
            metadata['scope'] = 'candidate-core-image-subset'
            image = metadata['images'][0]
            metadata['roles'] = {role: {'imageId': image['imageId'], 'reference': image['reference']} for role in ('web', 'controller', 'backup')}
            content = b'exact candidate deployment identity'
            (root / 'release-manifest.json').write_bytes(content)
            metadata['files'] = [{'path': 'release-manifest.json', 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}]
            (root / 'prepared-export.json').write_text(json.dumps(metadata))
            report = MODULE.measure_archive(root)
            self.assertEqual(report['roles']['web'], report['roles']['controller'])
            self.assertEqual(report['archive']['uniqueUncompressedLayerBytes'], len(layer))
            self.assertEqual(report['archive']['expandedArchiveMemberBytes'], 10240)
            (root / 'release-manifest.json').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'subset_file_identity'):
                MODULE.measure_archive(root)

    def test_unselected_extra_images_and_wrong_role_bindings_are_refused(self):
        for change, diagnostic in ((lambda value: value['images'].pop(), 'reference_inventory_mismatch'),
                                   (lambda value: value.update(roles={'vcr': {'imageId': 'sha256:'+'0'*64, 'reference': value['images'][0]['reference']}}), 'subset_role_identity')):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fixture(root)
                metadata = json.loads((root / 'prepared-export.json').read_text())
                change(metadata)
                (root / 'prepared-export.json').write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, diagnostic):
                    MODULE.measure_archive(root)
                self.assertFalse((root / 'manifest.json').exists())

    def test_wrong_prepared_image_refuses_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            metadata = json.loads((root / 'prepared-export.json').read_text())
            metadata['images'][0]['imageId'] = 'sha256:' + '0' * 64
            (root / 'prepared-export.json').write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'export_image_identity'):
                MODULE.measure_archive(root)


if __name__ == '__main__':
    unittest.main()
