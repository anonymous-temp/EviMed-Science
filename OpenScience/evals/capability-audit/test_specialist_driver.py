"""Offline audit protocol tests; toy bytes are not execution certification."""
import base64
import copy
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import hosted_receipts as hosted
import public_mr_fixture as public_mr
import run_specialist_jobs as driver
import run_tool_audit as audit
import verify_release_audit as release


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.workspace = self.repo / "workspaces/audit"
        self.workspace.mkdir(parents=True)
        self.scope = {"userId": "audit-user", "projectId": "audit-project", "activeWorkspace": ""}
        self.expected = {"executionEvidence": {"agentSourceSha256": "a" * 64, "adapterSha256": "b" * 64},
            "adapterEvidence": {"sha256": "c" * 64, "files": 3}}
        # Deterministic TEST-only signing material is derived in memory; no
        # production private key is read, serialized or written by these tests.
        self.signing = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        self.public_pem = self.signing.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        self.key_id = "ed25519-" + hosted.digest(self.signing.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
        self.manifest = json.loads(public_mr.MANIFEST.read_text())
        prefix = public_mr.fixture_prefix(self.manifest)
        for item in self.manifest["files"]:
            blob = ("TEST-only official source stand-in " + item["name"]).encode()
            item.update(bytes=len(blob), sha256=hosted.digest(blob))
            hosted.write_new(self.workspace, prefix + "/" + item["name"], blob)
        for name in self.manifest["outputs"]:
            blob = ("TEST-only input " + name).encode()
            self.manifest["outputs"][name] = {"bytes": len(blob), "sha256": hosted.digest(blob)}
            hosted.write_new(self.workspace, prefix + "/" + name, blob)
        hosted.write_new(self.workspace, prefix + "/fixture-manifest.json", hosted.canonical(self.manifest) + b"\n")
        original_manifest_loader = public_mr.load_manifest
        loader = patch.object(public_mr, "load_manifest", side_effect=lambda path=public_mr.MANIFEST:
            self.manifest if Path(path) == public_mr.MANIFEST else original_manifest_loader(path))
        loader.start(); self.addCleanup(loader.stop)
        self.default_key_loader = hosted.trusted_public_key
        key_loader = patch.object(hosted, "trusted_public_key", return_value=self.public_pem)
        key_loader.start(); self.addCleanup(key_loader.stop)
        self.request = public_mr.arguments_for_manifest(self.manifest)
        self.exposure_path = self.request["exposureSource"]["path"]
        self.outcome_path = self.request["outcomeSource"]["path"]
        self.artifact = "mendelian-randomization-runs/mr-fixture-12345/output/report.md"
        hosted.write_new(self.workspace, self.artifact, b"fixture managed report")
        self.proof = {"schemaVersion": 1, "tool": "mendelian_randomization", "jobId": "mr-fixture-12345", "jobStatus": "succeeded",
            "scope": self.scope, "requestSha256": hosted.digest(hosted.canonical(self.request)), **self.expected,
            "inputs": [hosted.file_receipt(self.workspace, name) for name in (self.exposure_path, self.outcome_path)],
            "fixture": public_mr.fixture_binding(self.manifest),
            "artifacts": [hosted.file_receipt(self.workspace, self.artifact)], "completedAt": datetime.now(timezone.utc).isoformat()}
        self.response = {"status": "success", "data": {"jobId": self.proof["jobId"], "jobStatus": "succeeded", "auditReceipt": self.proof,
            "provenance": {"workspaceDir": "/private/must-not-travel"}}, "summary": "not retained", "artifacts": [{"path": self.artifact}]}

    def sign(self, proof):
        proof.pop("attestation", None)
        signature = self.signing.sign(hosted.canonical(proof))
        proof["attestation"] = {"algorithm": "Ed25519", "keyId": self.key_id, "signature": base64.b64encode(signature).decode()}


    def capture(self):
        self.sign(self.proof)
        return hosted.capture_receipt(self.workspace, "mendelian_randomization", self.request, self.response, self.scope,
            expected_job_id=self.proof["jobId"], expected=self.expected, trustedPublicKey=self.public_pem)

    def test_verified_capture_harvest_snapshot_survives_private_queue_deletion(self):
        retained = self.capture()
        self.assertNotIn(b"private", hosted.read_owned(self.workspace, retained))
        queue = self.root / "private-queue"
        queue.mkdir()
        (queue / "job.json").write_text("private authority not an export")
        with patch.object(hosted, "current_evidence", return_value=self.expected), patch.object(audit, "REPO", self.repo):
            result = audit.latest_specialist_receipt("mendelian_randomization", [self.workspace], 14)
            self.assertEqual(result["receiptKind"], "isolated-adapter-v1")
            target = self.repo / "results/new/evidence"
            audit.snapshot_evidence([result], target)
            shutil.rmtree(queue)
            shutil.rmtree(self.workspace)
            proof = hosted.validate_receipt(json.loads(hosted.read_owned(target, retained)), target, "mendelian_randomization", 14)
            self.assertEqual(proof["jobId"], self.proof["jobId"])
            self.assertFalse((target / "job-state" / (self.proof["jobId"] + ".json")).exists())
            document = {"schemaVersion": 3, "probedAt": datetime.now(timezone.utc).isoformat(), "registered": 1,
                "executionCertified": 1, "operational": 1, "unverified": 0, "errors": 0, "results": [result]}
            registry = SimpleNamespace(TOOL_DEFINITIONS=[{"name": "mendelian_randomization"}], OPTIONAL_TOOLS=[])
            with patch.object(release, "read", return_value=document), patch.object(release, "EVIDENCE", target), patch.object(release, "load_module", return_value=registry):
                release.verify_tools()
                result["scope"] = {**result["scope"], "projectId": "swapped"}
                with self.assertRaises(SystemExit):
                    release.verify_tools()
            with self.assertRaises(hosted.ReceiptError):
                audit.snapshot_evidence([], target)

    def test_current_source_changes_force_rerun_using_the_same_eligibility_check(self):
        self.capture()
        with patch.object(hosted, "current_evidence", return_value=self.expected), patch.object(audit, "REPO", self.repo), patch.object(driver, "load_audit", return_value=audit):
            self.assertIsNotNone(driver.fresh_terminal_job(self.workspace, "mendelian_randomization", 14))
            with patch.object(hosted, "current_evidence", return_value={**self.expected, "adapterEvidence": {"sha256": "d" * 64}}):
                self.assertIsNone(driver.fresh_terminal_job(self.workspace, "mendelian_randomization", 14))

    def test_status_or_capabilities_alone_cannot_become_a_receipt(self):
        for data in [{"configured": True}, {"jobId": self.proof["jobId"], "jobStatus": "succeeded"}]:
            with self.assertRaisesRegex(hosted.ReceiptError, "missing:auditReceipt"):
                hosted.capture_receipt(self.workspace, "mendelian_randomization", self.request, {"status": "success", "data": data}, self.scope, expected_job_id=self.proof["jobId"])

    def test_swapped_artifact_and_source_input_bytes_are_rejected(self):
        for relative in [self.artifact, self.exposure_path]:
            original = (self.workspace / relative).read_bytes()
            (self.workspace / relative).write_bytes(b"swapped")
            with self.assertRaisesRegex(hosted.ReceiptError, "artifact_changed"):
                self.capture()
            (self.workspace / relative).write_bytes(original)

    def test_traversal_parent_symlinks_and_false_scope_are_rejected(self):
        for bad in ["../secret", "/private/file", "data/../secret", "data\\secret"]:
            with self.assertRaises(hosted.ReceiptError):
                hosted.read_owned(self.workspace, bad)
        (self.workspace / "linked").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(hosted.ReceiptError):
            hosted.read_owned(self.workspace, "linked/secret")
        self.response["data"]["auditReceipt"]["scope"] = {**self.scope, "projectId": "other"}
        with self.assertRaisesRegex(hosted.ReceiptError, "scope_invalid"):
            self.capture()

    def test_request_hash_and_unknown_private_receipt_fields_are_rejected(self):
        self.response["data"]["auditReceipt"]["requestSha256"] = "0" * 64
        with self.assertRaisesRegex(hosted.ReceiptError, "request_changed"):
            self.capture()
        self.response["data"]["auditReceipt"]["requestSha256"] = hosted.digest(hosted.canonical(self.request))
        self.response["data"]["auditReceipt"]["token"] = "must-not-copy"
        with self.assertRaisesRegex(hosted.ReceiptError, "private_or_unknown"):
            self.capture()

    def test_legacy_non_mr_receipts_keep_the_original_source_and_artifact_requirements(self):
        agent = self.root / "项目代码/科研选题"
        agent.mkdir(parents=True)
        state = {"jobId": "topic-fixture-12345", "status": "succeeded", "updatedAt": datetime.now(timezone.utc).isoformat(),
            "root": str(agent), "executionEvidence": {"legacy": "current"}, "artifacts": [{"path": self.artifact}]}
        hosted.write_new(self.workspace, "research-topic-runs/.jobs/topic-fixture-12345.json", hosted.canonical(state))
        module = SimpleNamespace(execution_evidence=lambda *_: {"legacy": "current"})
        with patch.object(audit, "REPO", self.repo), patch.object(audit, "SPECIALIST_SOURCES", self.root / "项目代码"), patch.object(audit, "load_execution_evidence", return_value=module):
            result = audit.latest_specialist_receipt("research_topic_selection", [self.workspace], 14)
            self.assertTrue(result["operational"])
            target = self.repo / "legacy-snapshot/evidence"
            audit.snapshot_evidence([result], target)
            retained = json.loads(hosted.read_owned(target, "job-state/topic-fixture-12345.json"))
            self.assertEqual(retained["artifacts"], [self.artifact])
            self.assertEqual(retained["root"], "科研选题")
            result["artifacts"] = [hosted.file_receipt(self.workspace, self.exposure_path)]
            with self.assertRaisesRegex(hosted.ReceiptError, "legacy_artifact_binding_changed"):
                audit.snapshot_evidence([result], self.repo / "rejected-snapshot/evidence")
            module.execution_evidence = lambda *_: {"legacy": "changed"}
            self.assertIsNone(audit.latest_specialist_receipt("research_topic_selection", [self.workspace], 14))

    def test_public_fixture_is_generated_from_pinned_bytes_with_independent_source_declarations(self):
        workspace = self.repo / "fixture-preparation"
        workspace.mkdir()
        manifest = json.loads(public_mr.MANIFEST.read_text())
        cache = self.root / "cache"
        cache.mkdir()
        for item in manifest["files"]:
            blob = ("offline toy " + item["name"]).encode()
            (cache / item["name"]).write_bytes(blob)
            item.update(bytes=len(blob), sha256=hosted.digest(blob))
        outputs = {name: (name + " fixture bytes").encode() for name in manifest["outputs"]}
        for name, blob in outputs.items():
            manifest["outputs"][name] = {"bytes": len(blob), "sha256": hosted.digest(blob)}
        spec = self.root / "fixture.json"
        spec.write_text(json.dumps(manifest))
        def runner(command, **kwargs):
            self.assertEqual(command[1], "--vanilla")
            self.assertNotIn("OPENGWAS_JWT", kwargs["env"])
            for name, blob in outputs.items():
                (Path(command[-1]) / name).write_bytes(blob)
            return SimpleNamespace(returncode=0)
        with patch.object(public_mr.shutil, "which", return_value="/fixture/Rscript"):
            args = public_mr.prepare(workspace, cache=cache, manifest_path=spec, runner=runner)
            self.assertEqual(args["analysisDirection"], "forward")
            self.assertIs(args["exposureSource"]["instrumentsPreclumped"], True)
            self.assertIs(args["outcomeSource"]["instrumentsPreclumped"], False)
            for role in ("exposureSource", "outcomeSource"):
                self.assertEqual(args[role]["columnMapping"], public_mr.MAPPING)
                self.assertTrue(args[role]["clumpingProvenance"])
                self.assertTrue((workspace / args[role]["path"]).is_file())
            self.assertNotIn("jwt", json.dumps(args).lower())
            (workspace / args["exposureSource"]["path"]).write_bytes(b"changed")
            with self.assertRaisesRegex(hosted.ReceiptError, "hash_mismatch"):
                public_mr.prepare(workspace, cache=cache, manifest_path=spec, runner=runner)

    def test_adapter_is_required_and_scope_must_match_the_shared_workspace(self):
        token = self.root / "token"
        payload = base64.urlsafe_b64encode(json.dumps({"v": 1, "aud": "evimed-adapter", "userId": "audit-user", "projectId": "audit-project", "exp": int(time.time()) + 900}).encode()).decode().rstrip("=")
        token.write_text("test-header." + payload + ".test-signature")
        token.chmod(0o600)
        data_root = self.root / "shared-data"
        owned = data_root / "users/audit-user/projects/audit-project/workspace"
        owned.mkdir(parents=True)
        args = SimpleNamespace(mr_adapter_url="", adapter_token_file=str(token), adapter_user="audit-user", adapter_project="audit-project", adapter_data_root=data_root)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(hosted.ReceiptError, "isolated_mr_adapter_url_required"):
                driver.adapter_context(args, owned)
            args.mr_adapter_url = "https://adapter.invalid/api/v1/evimed/mendelian-randomization"
            with self.assertRaisesRegex(hosted.ReceiptError, "workspace_not_owned"):
                driver.adapter_context(args, self.workspace)
            self.assertEqual(driver.adapter_context(args, owned), self.scope)
            self.assertEqual(os.environ["EVIMED_MR_ANALYSIS_URL"], args.mr_adapter_url)
            self.assertNotIn("test-signature", json.dumps(self.scope))

    def test_driver_does_not_certify_a_real_status_only_adapter_response(self):
        server = SimpleNamespace(call_tool=lambda _tool, args: {"status": "success", "data": {"jobId": "mr-fixture-12345", "jobStatus": "succeeded"}})
        with patch.object(driver.time, "sleep", return_value=None):
            result = driver.run_one(server, "mendelian_randomization", self.request, 1, workspace=self.workspace, scope=self.scope)
        self.assertEqual(result["outcome"], "uncertified")
        self.assertEqual(result["detail"], "hosted_receipt_missing:auditReceipt")

    def test_reversed_mr_roles_cannot_certify_the_public_fixture(self):
        self.request["exposure"], self.request["outcome"] = self.request["outcome"], self.request["exposure"]
        self.request["exposureSource"], self.request["outcomeSource"] = self.request["outcomeSource"], self.request["exposureSource"]
        self.proof["requestSha256"] = hosted.digest(hosted.canonical(self.request))
        with self.assertRaises(hosted.ReceiptError):
            self.capture()

    def test_status_for_another_job_cannot_certify_the_started_job(self):
        def call(_tool, arguments):
            if arguments["action"] == "start":
                return {"status": "success", "data": {"jobId": "mr-started-00001"}}
            self.sign(self.proof)
            return self.response
        with patch.object(driver.time, "sleep", return_value=None), patch.object(hosted, "current_evidence", return_value=self.expected):
            result = driver.run_one(SimpleNamespace(call_tool=call), "mendelian_randomization", self.request, 1,
                workspace=self.workspace, scope=self.scope)
        self.assertEqual(result["outcome"], "uncertified")
        self.assertEqual(result["detail"], "hosted_receipt_started_job_mismatch")

    def signed_value(self):
        self.sign(self.proof)
        return {"schemaVersion": 1, "kind": "isolated-specialist-receipt", "tool": "mendelian_randomization",
            "startedJobId": self.proof["jobId"], "scope": copy.deepcopy(self.scope), "request": copy.deepcopy(self.request),
            "proof": copy.deepcopy(self.proof), "response": {"status": "success", "jobId": self.proof["jobId"],
                "jobStatus": "succeeded", "artifacts": [self.artifact]}}

    def validate(self, value, key=None):
        return hosted.validate_receipt(value, self.workspace, "mendelian_randomization", 14,
            expected=self.expected, trustedPublicKey=key or self.public_pem)

    def test_each_public_request_field_is_bound_even_when_the_wrong_request_is_signed(self):
        changes = [("exposure", None, "coronary heart disease"), ("outcome", None, "diabetes"),
            ("analysisDirection", None, "bidirectional"), ("outputLanguage", None, "zh")]
        for role in ("exposureSource", "outcomeSource"):
            changes.extend([(role, "path", "data/another.csv"), (role, "type", "opengwas"),
                (role, "instrumentsPreclumped", not self.request[role]["instrumentsPreclumped"]),
                (role, "clumpingProvenance", "Independence was verified elsewhere."), (role, "sampleSize", 123)])
            for column in public_mr.MAPPING:
                changes.append((role, ("columnMapping", column), "wrong_header"))
        for field, nested, changed in changes:
            with self.subTest(field=field, nested=nested):
                value = self.signed_value()
                if isinstance(nested, tuple):
                    value["request"][field][nested[0]][nested[1]] = changed
                elif nested:
                    value["request"][field][nested] = changed
                else:
                    value["request"][field] = changed
                value["proof"]["requestSha256"] = hosted.digest(hosted.canonical(value["request"]))
                self.sign(value["proof"])
                with self.assertRaises(hosted.ReceiptError):
                    self.validate(value)

    def test_manifest_inputs_and_every_raw_source_and_license_are_bound(self):
        value = self.signed_value()
        value["proof"]["fixture"]["manifestSha256"] = "0" * 64
        self.sign(value["proof"])
        with self.assertRaisesRegex(hosted.ReceiptError, "fixture_provenance"):
            self.validate(value)
        for index in range(len(self.manifest["files"])):
            for field, replacement in (("url", "https://example.invalid/replacement"), ("bytes", 1), ("sha256", "f" * 64), ("path", "another/source")):
                with self.subTest(source=index, field=field):
                    value = self.signed_value()
                    value["proof"]["fixture"]["sources"][index][field] = replacement
                    self.sign(value["proof"])
                    with self.assertRaisesRegex(hosted.ReceiptError, "fixture_provenance"):
                        self.validate(value)
        for index in range(2):
            for field, replacement in (("bytes", 1), ("sha256", "0" * 64), ("path", "data/other.csv")):
                with self.subTest(input=index, field=field):
                    changed = self.signed_value()
                    changed["proof"]["inputs"][index][field] = replacement
                    self.sign(changed["proof"])
                    with self.assertRaises(hosted.ReceiptError):
                        self.validate(changed)
            value = self.signed_value()
            path = value["proof"]["inputs"][index]["path"]
            original = (self.workspace / path).read_bytes()
            (self.workspace / path).write_bytes(b"different but honestly hashed input")
            value["proof"]["inputs"][index] = hosted.file_receipt(self.workspace, path)
            self.sign(value["proof"])
            with self.assertRaisesRegex(hosted.ReceiptError, "fixture_input"):
                self.validate(value)
            (self.workspace / path).write_bytes(original)
        source = public_mr.fixture_binding(self.manifest)["sources"][0]["path"]
        (self.workspace / source).write_bytes(b"changed raw cache")
        with self.assertRaisesRegex(hosted.ReceiptError, "fixture_source_changed"):
            self.validate(self.signed_value())

    def test_ed25519_tampering_wrong_key_and_unsigned_receipts_fail(self):
        value = self.signed_value()
        self.validate(value)
        for change in ("proof", "signature", "keyId", "algorithm", "embedded_key", "missing"):
            with self.subTest(change=change):
                altered = copy.deepcopy(value)
                if change == "proof":
                    altered["proof"]["completedAt"] = "2000-01-01T00:00:00Z"
                elif change == "missing":
                    del altered["proof"]["attestation"]
                elif change == "embedded_key":
                    altered["proof"]["attestation"]["publicKey"] = self.public_pem.decode()
                else:
                    altered["proof"]["attestation"][change] = "invalid"
                with self.assertRaises(hosted.ReceiptError):
                    self.validate(altered)
        wrong = Ed25519PrivateKey.from_private_bytes(bytes(reversed(range(32)))).public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        with self.assertRaises(hosted.ReceiptError):
            self.validate(value, wrong)

    def test_default_trust_anchor_is_pinned_and_missing_or_changed_keys_fail_closed(self):
        actual = self.default_key_loader()
        self.assertEqual(hosted.digest(actual), hosted.TRUSTED_PUBLIC_KEY_SHA256)
        with patch.object(hosted, "trusted_public_key", self.default_key_loader), patch.object(hosted, "TRUSTED_PUBLIC_KEY_FILE", self.root / "absent.pem"):
            with self.assertRaisesRegex(hosted.ReceiptError, "trusted_key_missing"):
                hosted.validate_receipt(self.signed_value(), self.workspace, "mendelian_randomization", 14, expected=self.expected)
        other = self.root / "other-public.pem"
        other.write_bytes(self.public_pem)
        with patch.object(hosted, "TRUSTED_PUBLIC_KEY_FILE", other):
            with self.assertRaisesRegex(hosted.ReceiptError, "trusted_key_digest_mismatch"):
                self.default_key_loader()

    def legacy_release_case(self, tool):
        job_id = "mr-legacy-00001" if tool == "mendelian_randomization" else "topic-legacy-00001"
        source_name = "孟德尔随机化" if tool == "mendelian_randomization" else "科研选题"
        source = self.root / "项目代码" / source_name
        source.mkdir(parents=True, exist_ok=True)
        state = {"jobId": job_id, "status": "succeeded", "root": source_name, "executionEvidence": {"legacy": "current"}, "artifacts": [self.artifact]}
        path = "job-state/" + job_id + ".json"
        hosted.write_new(self.workspace, path, hosted.canonical(state))
        result = {"tool": tool, "probeType": "completed_managed_job", "operation": "start_then_poll_to_terminal", "operational": True,
            "status": "success", "jobId": job_id, "jobStatus": "succeeded", "releaseStatus": None, "publicationReady": True,
            "executedAt": datetime.now(timezone.utc).isoformat(), "executionEvidence": state["executionEvidence"],
            "artifacts": [hosted.file_receipt(self.workspace, self.artifact)], "artifactCount": 1}
        document = {"schemaVersion": 3, "probedAt": result["executedAt"], "registered": 1, "executionCertified": 1,
            "operational": 1, "unverified": 0, "errors": 0, "results": [result]}
        registry = SimpleNamespace(TOOL_DEFINITIONS=[{"name": tool}], OPTIONAL_TOOLS=[], execution_evidence=lambda *_: state["executionEvidence"])
        return state, path, result, document, registry

    def test_release_verifier_rejects_fresh_legacy_mr_before_the_legacy_branch(self):
        _state, _path, _result, document, registry = self.legacy_release_case("mendelian_randomization")
        with patch.object(release, "read", return_value=document), patch.object(release, "EVIDENCE", self.workspace.resolve()), patch.object(release, "JOB_STATE", self.workspace / "job-state"), patch.object(release, "load_module", return_value=registry), patch.object(release, "SPECIALIST_SOURCES", self.root / "项目代码"):
            with self.assertRaisesRegex(SystemExit, "MR requires an attested"):
                release.verify_tools()

    def test_legacy_state_artifacts_cannot_be_swapped_omitted_or_extended(self):
        state, path, result, document, registry = self.legacy_release_case("research_topic_selection")
        with patch.object(release, "read", return_value=document), patch.object(release, "EVIDENCE", self.workspace.resolve()), patch.object(release, "JOB_STATE", self.workspace / "job-state"), patch.object(release, "load_module", return_value=registry), patch.object(release, "SPECIALIST_SOURCES", self.root / "项目代码"):
            release.verify_tools()
            for declared in (None, [], [self.exposure_path], [self.artifact, self.exposure_path]):
                with self.subTest(declared=declared):
                    changed = {**state, "artifacts": declared}
                    (self.workspace / path).write_bytes(hosted.canonical(changed))
                    with self.assertRaises(SystemExit):
                        release.verify_tools()
            (self.workspace / path).write_bytes(hosted.canonical(state))
            result["artifacts"] = [hosted.file_receipt(self.workspace, self.exposure_path)]
            with self.assertRaises(SystemExit):
                release.verify_tools()


class ExplicitMetaRequestTests(unittest.TestCase):
    def test_new_request_cannot_reuse_a_terminal_job_for_the_default_topic(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary).resolve()
            topic = "Replicate two prespecified randomized trials; do not substitute another trial."
            before = copy.deepcopy(driver.BRIEFS)
            argv = ["driver", "--probe-workspace", str(repo / "audit"), "--tool", "meta_analysis", "--meta-topic", topic]
            with patch.object(sys, "argv", argv), patch.object(driver, "REPO", repo), \
                    patch.object(driver, "load_server", return_value=object()), \
                    patch.object(driver, "fresh_terminal_job", return_value={"jobId": "old-topic-job"}) as fresh, \
                    patch.object(driver, "run_one", return_value={"tool": "meta_analysis", "outcome": "blocked", "jobId": "new-request-job"}) as run, \
                    patch.dict(os.environ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as done:
                    driver.main()
                self.assertEqual(done.exception.code, 0)
                fresh.assert_not_called()
                self.assertEqual(run.call_args.args[2], {"topic": topic, "outputLanguage": "zh"})
                self.assertEqual(driver.BRIEFS, before)

    def test_invalid_or_unselected_meta_request_stops_before_loading_a_server(self):
        for value, tool in [(" ", "meta_analysis"), ("x" * 10001, "meta_analysis"), ("Explicit request", "peer_review")]:
            with self.subTest(tool=tool, length=len(value)), patch.object(sys, "argv", ["driver", "--probe-workspace", "/unused", "--tool", tool, "--meta-topic", value]), \
                    patch.object(driver, "load_server") as load, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as stopped:
                    driver.main()
                self.assertEqual(stopped.exception.code, 2)
                load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
