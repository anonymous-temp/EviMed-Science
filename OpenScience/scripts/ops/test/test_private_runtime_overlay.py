"""Synthetic crypto and fixed-admission tests; no private pack or image execution."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

SCRIPT = Path(__file__).resolve().parents[1] / 'private-runtime-overlay.py'
SPEC = importlib.util.spec_from_file_location('private_overlay', SCRIPT)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class CryptoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        cls.public = cls.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        cls.private = cls.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='private-overlay-synthetic-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.image = os.urandom(1024**2 + 307)
        self.log = b'SYNTHETIC_METHOD_NOT_FOR_PUBLIC_LOGS\n' * 80
        self.provenance = {'recipeRevision': 'a' * 40, 'baseSourceRevision': 'b' * 40,
                           'baseWorkflow': {'artifactSha256': 'sha256:' + 'c' * 64, 'archiveSha256': 'd' * 64},
                           'derivedRuntime': {'nativeImageId': 'sha256:' + 'e' * 64, 'orderedRootfs': ['sha256:' + 'f' * 64]}}
        self.cipher = self.root / 'runtime.bundle.enc'
        # Disk admission is independently tested below; these tests exercise actual encryption bytes.
        with patch.object(M, 'capacity'):
            self.metadata = M.encrypt_bundle(io.BytesIO(self.image), {'smoke-build.log': self.log},
                                             self.cipher, self.public, self.provenance)
        self.destination = self.root / 'authenticated.zip'

    def assert_rejected(self, metadata=None, error=Exception):
        with self.assertRaises(error):
            M.decrypt_bundle(self.cipher, metadata or self.metadata, self.private, self.destination)
        self.assertFalse(self.destination.exists())
        self.assertFalse(self.destination.with_name(self.destination.name + '.partial').exists())

    def test_actual_streaming_roundtrip_and_private_modes(self):
        M.decrypt_bundle(self.cipher, self.metadata, self.private, self.destination)
        with zipfile.ZipFile(self.destination) as archive:
            self.assertEqual(archive.namelist(), ['images.tar', 'smoke-build.log'])
            # A consumer can stream this member without writing another raw tar.
            with archive.open('images.tar') as image:
                self.assertEqual(hashlib.sha256(image.read()).digest(), hashlib.sha256(self.image).digest())
            self.assertEqual(archive.read('smoke-build.log'), self.log)
        self.assertNotIn(b'SYNTHETIC_METHOD_NOT_FOR_PUBLIC_LOGS', self.cipher.read_bytes())
        self.assertEqual(self.cipher.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(self.metadata['provenance']['baseWorkflow']['artifactSha256'][7:],
                            self.metadata['provenance']['baseWorkflow']['archiveSha256'])

    def test_ciphertext_tamper_even_with_recomputed_public_hash(self):
        raw = bytearray(self.cipher.read_bytes()); raw[len(raw) // 2] ^= 1
        self.cipher.write_bytes(raw)
        metadata = copy.deepcopy(self.metadata)
        metadata['protection']['ciphertextSha256'] = M.digest(raw)
        self.assert_rejected(metadata, InvalidTag)

    def test_aad_recipe_identity_tamper(self):
        metadata = copy.deepcopy(self.metadata); metadata['provenance']['recipeRevision'] = '0' * 40
        self.assert_rejected(metadata, InvalidTag)

    def test_aad_base_zip_identity_tamper(self):
        metadata = copy.deepcopy(self.metadata)
        metadata['provenance']['baseWorkflow']['artifactSha256'] = 'sha256:' + '0' * 64
        self.assert_rejected(metadata, InvalidTag)

    def test_nonce_and_tag_tamper(self):
        for field in ['nonce', 'tag']:
            with self.subTest(field=field):
                metadata = copy.deepcopy(self.metadata)
                raw = bytearray(base64.b64decode(metadata['protection'][field])); raw[0] ^= 1
                metadata['protection'][field] = base64.b64encode(raw).decode()
                self.assert_rejected(metadata, InvalidTag)

    def test_wrapped_key_tamper(self):
        metadata = copy.deepcopy(self.metadata)
        raw = bytearray(base64.b64decode(metadata['protection']['wrappedKey'])); raw[-1] ^= 1
        metadata['protection']['wrappedKey'] = base64.b64encode(raw).decode()
        self.assert_rejected(metadata, ValueError)

    def test_wrong_recipient_rejected_without_plaintext(self):
        other = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        private = other.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        with self.assertRaisesRegex(ValueError, 'recipient_mismatch'):
            M.decrypt_bundle(self.cipher, self.metadata, private, self.destination)
        self.assertFalse(self.destination.exists())

    def test_truncated_cipher_and_unknown_suite_rejected(self):
        raw = self.cipher.read_bytes(); self.cipher.write_bytes(raw[:-1]); self.assert_rejected(error=ValueError)
        self.cipher.write_bytes(raw)
        metadata = copy.deepcopy(self.metadata); metadata['protection']['algorithm'] = 'AES-CBC'
        self.assert_rejected(metadata, ValueError)

    def test_preexisting_partial_and_symlink_are_preserved(self):
        partial = self.destination.with_name(self.destination.name + '.partial')
        partial.write_bytes(b'previous-owner-data')
        with self.assertRaises(FileExistsError):
            M.decrypt_bundle(self.cipher, self.metadata, self.private, self.destination)
        self.assertEqual(partial.read_bytes(), b'previous-owner-data')
        partial.unlink()
        protected = self.root / 'protected'; protected.write_bytes(b'protected')
        partial.symlink_to(protected)
        with self.assertRaises(FileExistsError):
            M.decrypt_bundle(self.cipher, self.metadata, self.private, self.destination)
        self.assertTrue(partial.is_symlink())
        self.assertEqual(protected.read_bytes(), b'protected')

    def test_publication_cannot_overwrite_a_racing_destination(self):
        link = os.link
        def racing_link(source, destination, **kwargs):
            destination.write_bytes(b'other-owner-destination')
            return link(source, destination, **kwargs)
        with patch.object(M.os, 'link', side_effect=racing_link):
            with self.assertRaises(FileExistsError):
                M.decrypt_bundle(self.cipher, self.metadata, self.private, self.destination)
        self.assertEqual(self.destination.read_bytes(), b'other-owner-destination')
        self.assertFalse(self.destination.with_name(self.destination.name + '.partial').exists())

    def test_fresh_export_uses_independent_key_nonce_and_cipher(self):
        with patch.object(M, 'capacity'):
            second = M.encrypt_bundle(io.BytesIO(self.image), {}, self.root / 'second.enc', self.public, self.provenance)
        for field in ['nonce', 'wrappedKey', 'ciphertextSha256']:
            self.assertNotEqual(self.metadata['protection'][field], second['protection'][field])


class BoundaryTests(unittest.TestCase):
    def test_export_deadline_joins_stalled_pipe_and_tolerates_short_silence(self):
        child = subprocess.Popen(['python3', '-c', 'import time,sys;time.sleep(1.15);sys.stdout.buffer.write(b"ok");sys.stdout.flush()'], stdout=subprocess.PIPE, start_new_session=True)
        try:
            reader = M.DeadlineReader(child.stdout, time.monotonic() + 3)
            self.assertEqual(reader.read(2), b'ok')
            self.assertEqual(reader.read(2), b'')
            self.assertEqual(child.wait(timeout=2), 0)
        finally:
            child.stdout.close()
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=2)
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, 'rb', buffering=0) as stream:
            try:
                with self.assertRaisesRegex(ValueError, 'pipe_deadline'):
                    M.DeadlineReader(stream, time.monotonic() + .03).read(1)
            finally:
                os.close(write_fd)

    def test_pack_archive_hash_is_required_before_extraction(self):
        with tempfile.TemporaryDirectory() as root:
            destination = Path(root) / 'pack'
            with self.assertRaisesRegex(ValueError, 'archive_hash'):
                M.extract_pack(b'not the admitted pack', destination)
            self.assertFalse(destination.exists())

    def test_pack_tar_traversal_and_symlink_are_rejected(self):
        for name, link in [('geo-private/../../escape', False), ('geo-private/link', True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w:gz') as archive:
                    entry = tarfile.TarInfo(name); entry.size = 1
                    if link: entry.type = tarfile.SYMTYPE; entry.linkname = '/etc/passwd'; entry.size = 0
                    archive.addfile(entry, io.BytesIO(b'x'))
                raw = data.getvalue()
                # Parser negative controls use an explicit synthetic archive identity, never the real pack.
                with patch.object(M, 'PACK_BYTES', len(raw)), patch.object(M, 'PACK_SHA', M.digest(raw)):
                    with self.assertRaisesRegex(ValueError, 'pack_member'):
                        M.extract_pack(raw, Path(root) / 'pack')
                self.assertFalse((Path(root) / 'escape').exists())

    def test_capacity_retains_exact_floor_and_upcoming_charge(self):
        with patch.object(M.shutil, 'disk_usage') as usage:
            usage.return_value.free = M.FLOOR + 100
            M.capacity('/tmp', 100)
            with self.assertRaisesRegex(ValueError, 'capacity_floor'): M.capacity('/tmp', 101)
            usage.return_value.free = M.FLOOR - 1
            with self.assertRaisesRegex(ValueError, 'capacity_floor'): M.capacity('/tmp')

    def test_docker_subprocess_does_not_receive_control_plane_or_pack_secrets(self):
        result = subprocess.CompletedProcess([], 0, b'{}', b'')
        with patch.dict(os.environ, {'GH_TOKEN': 'synthetic-token', 'EVIMED_GEO_CHUNK_01': 'synthetic-pack', 'DEEPSEEK_API_KEY': 'synthetic-provider'}):
            with patch.object(M.subprocess, 'run', return_value=result) as call:
                M.command(['docker', 'info'])
                self.assertNotIn('GH_TOKEN', call.call_args.kwargs['env'])
                self.assertNotIn('EVIMED_GEO_CHUNK_01', call.call_args.kwargs['env'])
                self.assertNotIn('DEEPSEEK_API_KEY', call.call_args.kwargs['env'])

    def test_untrusted_push_context_refuses_before_checkout_or_secret_read(self):
        with patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_REF': M.OPS_REF}):
            with patch.object(M, 'command') as command:
                with self.assertRaisesRegex(ValueError, 'trusted_push'): M.admit_context()
                command.assert_not_called()

    def test_workflow_has_only_fixed_push_and_three_public_outputs(self):
        workflow = (SCRIPT.parents[3] / '.github/workflows/private-runtime.yml').read_text()
        self.assertNotIn('pull_request:', workflow)
        self.assertNotIn('workflow_dispatch:', workflow)
        self.assertIn('branches: [ops/private-runtime-20261002]', workflow)
        self.assertEqual(workflow.count('secrets.EVIMED_GEO_CHUNK_'), 36)
        uploaded = workflow.split('      - name: Upload only encrypted private runtime')[1].split('      - name: Remove only')[0]
        self.assertIn('/runtime.bundle.enc', uploaded)
        self.assertIn('/protection.json\n', uploaded)
        self.assertIn('/protection.json.sha256', uploaded)
        self.assertNotIn('/smoke-build.log', uploaded)
        self.assertNotIn('/context', uploaded)
        self.assertNotIn('if: always()', uploaded)


if __name__ == '__main__':
    unittest.main()
